use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use librustdesk::headless_controller::{
    HeadlessHandler, HeadlessServerConfig, HeadlessSession, HeadlessTerminalEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

const DEFAULT_BIND: &str = "127.0.0.1:21119";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceConfig {
    id: String,
    #[serde(default)]
    name: Option<String>,
    rustdesk_id: String,
    password_env: String,
    #[serde(default)]
    force_relay: bool,
    #[serde(default)]
    id_server: Option<String>,
    #[serde(default)]
    server_key_env: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceRegistryFile {
    devices: Vec<DeviceConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionRequest {
    action: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    connection_id: Option<String>,
    #[serde(default)]
    terminal_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    rows: Option<u32>,
    #[serde(default)]
    cols: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDevice {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    rustdesk_id: String,
    credential_configured: bool,
    online: Option<bool>,
    capabilities: Value,
}

struct ConnectionEntry {
    device_id: String,
    rustdesk_id: String,
    session: HeadlessSession,
    handler: HeadlessHandler,
    next_terminal_id: i32,
    pending: HashMap<i32, VecDeque<HeadlessTerminalEvent>>,
}

impl ConnectionEntry {
    fn status(&self) -> &'static str {
        if self.handler.is_connected() {
            "connected"
        } else if self.handler.last_error().is_some() {
            "failed"
        } else {
            "connecting"
        }
    }

    fn allocate_terminal_id(&mut self) -> i32 {
        let id = self.next_terminal_id.max(1);
        self.next_terminal_id = id.saturating_add(1).max(1);
        id
    }

    fn harvest_terminal_events(&mut self) {
        for event in self.handler.drain_terminal_events() {
            let terminal_id = terminal_event_id(&event);
            self.pending
                .entry(terminal_id)
                .or_default()
                .push_back(event);
        }
    }
}

#[derive(Clone)]
struct BridgeState {
    token: Option<String>,
    devices: Arc<HashMap<String, DeviceConfig>>,
    connections: Arc<Mutex<HashMap<String, ConnectionEntry>>>,
}

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

fn api_error(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message.into(),
            "errorCode": code,
        })),
    )
}

fn require<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str, ApiError> {
    value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("missing {field}"),
            )
        })
}

fn check_auth(headers: &HeaderMap, state: &BridgeState) -> Result<(), ApiError> {
    let Some(expected) = state.token.as_deref() else {
        return Ok(());
    };
    let actual = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if actual == Some(expected) {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid bridge token",
        ))
    }
}

fn terminal_event_id(event: &HeadlessTerminalEvent) -> i32 {
    match event {
        HeadlessTerminalEvent::Opened { terminal_id, .. }
        | HeadlessTerminalEvent::Data { terminal_id, .. }
        | HeadlessTerminalEvent::Closed { terminal_id, .. }
        | HeadlessTerminalEvent::Error { terminal_id, .. } => *terminal_id,
    }
}

fn terminal_event_json(event: HeadlessTerminalEvent) -> Value {
    match event {
        HeadlessTerminalEvent::Opened {
            terminal_id,
            success,
            message,
            pid,
            service_id,
            persistent_sessions,
            replay_terminal_output,
        } => json!({
            "type": "opened",
            "terminalId": terminal_id.to_string(),
            "success": success,
            "message": message,
            "pid": pid,
            "serviceId": service_id,
            "persistentSessions": persistent_sessions,
            "replayTerminalOutput": replay_terminal_output,
        }),
        HeadlessTerminalEvent::Data { terminal_id, data } => {
            let text = String::from_utf8(data.clone()).ok();
            json!({
                "type": "data",
                "terminalId": terminal_id.to_string(),
                "text": text,
                "dataBase64": BASE64.encode(data),
            })
        }
        HeadlessTerminalEvent::Closed {
            terminal_id,
            exit_code,
        } => json!({
            "type": "closed",
            "terminalId": terminal_id.to_string(),
            "exitCode": exit_code,
        }),
        HeadlessTerminalEvent::Error {
            terminal_id,
            message,
        } => json!({
            "type": "error",
            "terminalId": terminal_id.to_string(),
            "message": message,
        }),
    }
}

fn parse_terminal_id(value: &Option<String>) -> Result<i32, ApiError> {
    let raw = require(value, "terminalId")?;
    raw.parse::<i32>().ok().filter(|id| *id > 0).ok_or_else(|| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_terminal_id",
            "terminalId must be a positive integer",
        )
    })
}

fn load_devices() -> Result<HashMap<String, DeviceConfig>, String> {
    let path = env::var("RUSTDESK_BRIDGE_DEVICES_FILE")
        .map_err(|_| "RUSTDESK_BRIDGE_DEVICES_FILE is required".to_string())?;
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read device registry: {error}"))?;
    let registry: DeviceRegistryFile = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid device registry JSON: {error}"))?;
    let mut devices = HashMap::new();
    for device in registry.devices {
        if device.id.trim().is_empty()
            || device.rustdesk_id.trim().is_empty()
            || device.password_env.trim().is_empty()
        {
            return Err("device id, rustdeskId, and passwordEnv must be non-empty".to_string());
        }
        if devices.insert(device.id.clone(), device).is_some() {
            return Err("duplicate device id in registry".to_string());
        }
    }
    Ok(devices)
}

async fn health(State(state): State<BridgeState>, headers: HeaderMap) -> ApiResult {
    check_auth(&headers, &state)?;
    Ok(Json(json!({
        "ok": true,
        "service": "rustdesk-controller-bridge",
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

async fn action(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(request): Json<ActionRequest>,
) -> ApiResult {
    check_auth(&headers, &state)?;

    match request.action.as_str() {
        "bridge.health" => health_payload(),
        "devices.list" => devices_list(&state),
        "devices.get" => devices_get(&state, &request),
        "devices.connect" => devices_connect(&state, &request),
        "connection.status" => connection_status(&state, &request),
        "connection.disconnect" => connection_disconnect(&state, &request),
        "terminal.open" => terminal_open(&state, &request),
        "terminal.write" => terminal_write(&state, &request),
        "terminal.read" => terminal_read(&state, &request),
        "terminal.resize" => terminal_resize(&state, &request),
        "terminal.close" => terminal_close(&state, &request),
        _ => Err(api_error(
            StatusCode::NOT_IMPLEMENTED,
            "action_not_implemented",
            format!(
                "action {} is not implemented by this bridge milestone",
                request.action
            ),
        )),
    }
}

fn health_payload() -> ApiResult {
    Ok(Json(json!({
        "ok": true,
        "service": "rustdesk-controller-bridge",
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

fn devices_list(state: &BridgeState) -> ApiResult {
    let devices = state
        .devices
        .values()
        .map(public_device)
        .collect::<Vec<_>>();
    Ok(Json(json!({ "ok": true, "devices": devices })))
}

fn devices_get(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.device_id, "deviceId")?;
    let device = state.devices.get(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "device_not_found",
            "saved device not found",
        )
    })?;
    Ok(Json(json!({ "ok": true, "device": public_device(device) })))
}

fn public_device(device: &DeviceConfig) -> PublicDevice {
    PublicDevice {
        id: device.id.clone(),
        name: device.name.clone(),
        rustdesk_id: device.rustdesk_id.clone(),
        credential_configured: env::var_os(&device.password_env).is_some(),
        online: None,
        capabilities: json!({
            "terminal": true,
            "files": false,
            "screen": false,
            "mouse": false,
            "keyboard": false,
            "touch": false,
            "clipboard": false,
            "restart": false,
        }),
    }
}

fn devices_connect(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.device_id, "deviceId")?;
    let device = state
        .devices
        .get(id)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "device_not_found",
                "saved device not found",
            )
        })?
        .clone();
    let password = env::var(&device.password_env).map_err(|_| {
        api_error(
            StatusCode::CONFLICT,
            "credential_required",
            "saved device credential is not configured in the bridge secret store",
        )
    })?;

    let server = match device.id_server.as_deref() {
        Some(id_server) if !id_server.trim().is_empty() => {
            let server_key = match device.server_key_env.as_deref() {
                Some(name) if !name.trim().is_empty() => env::var(name).unwrap_or_default(),
                _ => String::new(),
            };
            Some(HeadlessServerConfig {
                id_server: id_server.to_owned(),
                server_key,
            })
        }
        _ => None,
    };

    let session = HeadlessSession::terminal_with_server(
        device.rustdesk_id.clone(),
        password,
        device.force_relay,
        server,
    );
    let handler = session.handler();
    session.start();

    let connection_id = Uuid::new_v4().to_string();
    state.connections.lock().unwrap().insert(
        connection_id.clone(),
        ConnectionEntry {
            device_id: device.id.clone(),
            rustdesk_id: device.rustdesk_id.clone(),
            session,
            handler,
            next_terminal_id: 1,
            pending: HashMap::new(),
        },
    );

    Ok(Json(json!({
        "ok": true,
        "connection": {
            "connectionId": connection_id,
            "kind": "permanent",
            "status": "connecting",
            "deviceId": device.id,
            "rustdeskId": device.rustdesk_id,
            "authMode": "permanent-password",
            "capabilities": { "terminal": true },
        }
    })))
}

fn with_connection_mut<T>(
    state: &BridgeState,
    request: &ActionRequest,
    f: impl FnOnce(&mut ConnectionEntry) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let id = require(&request.connection_id, "connectionId")?;
    let mut connections = state.connections.lock().unwrap();
    let connection = connections.get_mut(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    f(connection)
}

fn connection_status(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    with_connection_mut(state, request, |connection| {
        let status = connection.status();
        let last_error = connection.handler.last_error();
        let messages = connection.handler.drain_messages();
        Ok(Json(json!({
            "ok": true,
            "connection": {
                "connectionId": require(&request.connection_id, "connectionId")?,
                "deviceId": connection.device_id,
                "rustdeskId": connection.rustdesk_id,
                "status": status,
                "error": last_error,
                "messages": messages,
                "capabilities": { "terminal": true },
            }
        })))
    })
}

fn connection_disconnect(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.connection_id, "connectionId")?.to_owned();
    let connection = state
        .connections
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "connection_not_found",
                "connection not found",
            )
        })?;
    connection.session.close();
    Ok(Json(
        json!({ "ok": true, "connectionId": id, "status": "disconnected" }),
    ))
}

fn terminal_open(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    with_connection_mut(state, request, |connection| {
        if !connection.handler.is_connected() {
            return Err(api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection is not ready",
            ));
        }
        let terminal_id = connection.allocate_terminal_id();
        let rows = request.rows.unwrap_or(24).max(1);
        let cols = request.cols.unwrap_or(80).max(1);
        connection.session.open_terminal(terminal_id, rows, cols);
        Ok(Json(json!({
            "ok": true,
            "terminalId": terminal_id.to_string(),
            "status": "opening",
            "rows": rows,
            "cols": cols,
        })))
    })
}

fn terminal_write(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    let text = request
        .text
        .as_ref()
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing text"))?
        .clone();
    with_connection_mut(state, request, |connection| {
        connection.session.write_terminal(terminal_id, text);
        Ok(Json(
            json!({ "ok": true, "terminalId": terminal_id.to_string() }),
        ))
    })
}

fn terminal_read(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    with_connection_mut(state, request, |connection| {
        connection.harvest_terminal_events();
        let events = connection
            .pending
            .entry(terminal_id)
            .or_default()
            .drain(..)
            .map(terminal_event_json)
            .collect::<Vec<_>>();
        let text = events
            .iter()
            .filter_map(|event| event.get("text").and_then(Value::as_str))
            .collect::<String>();
        Ok(Json(json!({
            "ok": true,
            "terminalId": terminal_id.to_string(),
            "text": text,
            "events": events,
        })))
    })
}

fn terminal_resize(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    let rows = request.rows.filter(|value| *value > 0).ok_or_else(|| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "rows must be positive",
        )
    })?;
    let cols = request.cols.filter(|value| *value > 0).ok_or_else(|| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cols must be positive",
        )
    })?;
    with_connection_mut(state, request, |connection| {
        connection.session.resize_terminal(terminal_id, rows, cols);
        Ok(Json(
            json!({ "ok": true, "terminalId": terminal_id.to_string(), "rows": rows, "cols": cols }),
        ))
    })
}

fn terminal_close(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    with_connection_mut(state, request, |connection| {
        connection.session.close_terminal(terminal_id);
        Ok(Json(
            json!({ "ok": true, "terminalId": terminal_id.to_string(), "status": "closing" }),
        ))
    })
}

#[tokio::main]
async fn main() {
    let devices = match load_devices() {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("bridge configuration error: {error}");
            std::process::exit(2);
        }
    };
    let bind = env::var("RUSTDESK_BRIDGE_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let addr: SocketAddr = match bind.parse() {
        Ok(addr) => addr,
        Err(error) => {
            eprintln!("invalid RUSTDESK_BRIDGE_BIND: {error}");
            std::process::exit(2);
        }
    };
    let token = env::var("RUSTDESK_BRIDGE_TOKEN")
        .ok()
        .filter(|value| !value.is_empty());
    if !addr.ip().is_loopback() && token.is_none() {
        eprintln!("RUSTDESK_BRIDGE_TOKEN is required for non-loopback binds");
        std::process::exit(2);
    }

    let state = BridgeState {
        token,
        devices: Arc::new(devices),
        connections: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/action", post(action))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind bridge listener: {error}");
            std::process::exit(2);
        }
    };
    eprintln!("rustdesk controller bridge listening on {addr}");
    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("bridge server failed: {error}");
        std::process::exit(1);
    }
}
