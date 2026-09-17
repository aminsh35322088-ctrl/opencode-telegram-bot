use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::Cursor,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    ColorType, ImageEncoder,
};
use librustdesk::headless_controller::{
    HeadlessFileDirectory, HeadlessFileJobEvent, HeadlessFrame, HeadlessHandler,
    HeadlessServerConfig, HeadlessSession, HeadlessTerminalEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const DEFAULT_BIND: &str = "127.0.0.1:21119";
const CREDENTIAL_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ServerProfileKind {
    Public,
    Custom,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerProfileConfig {
    id: String,
    name: String,
    kind: ServerProfileKind,
    #[serde(default)]
    id_server: Option<String>,
    #[serde(default)]
    relay_server: Option<String>,
    #[serde(default)]
    api_server: Option<String>,
    #[serde(default)]
    server_key_env: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum TemporaryServerSelection {
    Public,
    SavedCustom {
        #[serde(rename = "serverProfileId")]
        server_profile_id: String,
    },
    OneTimeCustom {
        #[serde(rename = "idServer")]
        id_server: String,
        #[serde(default, rename = "relayServer")]
        relay_server: Option<String>,
        #[serde(default, rename = "apiServer")]
        api_server: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceConfig {
    id: String,
    #[serde(default)]
    name: Option<String>,
    rustdesk_id: String,
    password_env: String,
    server_profile_id: String,
    #[serde(default)]
    force_relay: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfigFile {
    #[serde(default)]
    server_profiles: Vec<ServerProfileConfig>,
    #[serde(default)]
    devices: Vec<DeviceConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionRequest {
    action: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    rustdesk_id: Option<String>,
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(default)]
    server: Option<TemporaryServerSelection>,
    #[serde(default)]
    server_profile_id: Option<String>,
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
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    display_index: Option<usize>,
    #[serde(default)]
    image_format: Option<String>,
    #[serde(default)]
    quality: Option<u8>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    from_x: Option<i32>,
    #[serde(default)]
    from_y: Option<i32>,
    #[serde(default)]
    to_x: Option<i32>,
    #[serde(default)]
    to_y: Option<i32>,
    #[serde(default)]
    delta_x: Option<i32>,
    #[serde(default)]
    delta_y: Option<i32>,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    remote_path: Option<String>,
    #[serde(default)]
    content_base64: Option<String>,
    #[serde(default)]
    include_hidden: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialSubmitRequest {
    credential_request_id: String,
    credential: String,
    #[serde(default)]
    trust_this_device: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDevice {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    rustdesk_id: String,
    server_profile_id: String,
    credential_configured: bool,
    online: Option<bool>,
    capabilities: Value,
}

enum ConnectionRuntime {
    PendingPassword {
        server: Option<HeadlessServerConfig>,
        force_relay: bool,
    },
    Active {
        session: HeadlessSession,
        handler: HeadlessHandler,
    },
}

struct ConnectionEntry {
    kind: String,
    device_id: Option<String>,
    rustdesk_id: String,
    server_profile_id: Option<String>,
    server_kind: String,
    auth_mode: String,
    runtime: ConnectionRuntime,
    credential_request_id: Option<String>,
    credential_kind: Option<String>,
    credential_expires_at: Option<Instant>,
    next_terminal_id: i32,
    next_file_job_id: i32,
    pending: HashMap<i32, VecDeque<HeadlessTerminalEvent>>,
    file_pending: HashMap<i32, VecDeque<HeadlessFileJobEvent>>,
}

impl ConnectionEntry {
    fn handler(&self) -> Option<&HeadlessHandler> {
        match &self.runtime {
            ConnectionRuntime::Active { handler, .. } => Some(handler),
            ConnectionRuntime::PendingPassword { .. } => None,
        }
    }

    fn session(&self) -> Option<&HeadlessSession> {
        match &self.runtime {
            ConnectionRuntime::Active { session, .. } => Some(session),
            ConnectionRuntime::PendingPassword { .. } => None,
        }
    }

    fn status(&self) -> &'static str {
        let ConnectionRuntime::Active { handler, .. } = &self.runtime else {
            return "credential_required";
        };
        if handler.is_connected() {
            return "connected";
        }
        if handler.last_error().is_some() {
            return "failed";
        }
        match handler.auth_prompt().as_deref() {
            Some("input-password") => match self.auth_mode.as_str() {
                "manual-approval" | "password-or-approval" => "waiting_remote_approval",
                _ => "credential_required",
            },
            Some("re-input-password") if self.kind == "permanent" => "failed",
            Some("re-input-password") | Some("input-2fa") => "credential_required",
            _ => "connecting",
        }
    }

    fn ensure_credential_request(&mut self, kind: &str) -> String {
        let reusable = self.credential_kind.as_deref() == Some(kind)
            && self
                .credential_expires_at
                .map(|expires| expires > Instant::now())
                .unwrap_or(false);
        if reusable {
            return self.credential_request_id.clone().unwrap_or_default();
        }
        let id = format!("credreq_{}", Uuid::new_v4());
        self.credential_request_id = Some(id.clone());
        self.credential_kind = Some(kind.to_owned());
        self.credential_expires_at = Some(Instant::now() + CREDENTIAL_TTL);
        id
    }

    fn clear_credential_request(&mut self) {
        self.credential_request_id = None;
        self.credential_kind = None;
        self.credential_expires_at = None;
    }

    fn refresh_auth_challenge(&mut self) {
        if self
            .credential_expires_at
            .map(|expires| expires <= Instant::now())
            .unwrap_or(false)
        {
            self.clear_credential_request();
        }
        if matches!(self.runtime, ConnectionRuntime::PendingPassword { .. }) {
            self.ensure_credential_request("rustdesk-password");
            return;
        }
        let connected = self
            .handler()
            .map(HeadlessHandler::is_connected)
            .unwrap_or(false);
        if connected {
            self.clear_credential_request();
            return;
        }
        let prompt = self.handler().and_then(HeadlessHandler::auth_prompt);
        match prompt.as_deref() {
            Some("input-2fa") => {
                self.ensure_credential_request("rustdesk-2fa");
            }
            Some("re-input-password") if self.kind != "permanent" => {
                self.ensure_credential_request("rustdesk-password");
            }
            Some("input-password") if self.auth_mode == "password-or-approval" => {
                self.ensure_credential_request("rustdesk-password");
            }
            _ => {}
        }
    }

    fn credential_metadata(&self) -> (Option<String>, Option<String>) {
        let valid = self
            .credential_expires_at
            .map(|expires| expires > Instant::now())
            .unwrap_or(false);
        if valid {
            (
                self.credential_request_id.clone(),
                self.credential_kind.clone(),
            )
        } else {
            (None, None)
        }
    }

    fn allocate_terminal_id(&mut self) -> i32 {
        let id = self.next_terminal_id.max(1);
        self.next_terminal_id = id.saturating_add(1).max(1);
        id
    }

    fn allocate_file_job_id(&mut self) -> i32 {
        let id = self.next_file_job_id.max(1);
        self.next_file_job_id = id.saturating_add(1).max(1);
        id
    }

    fn harvest_terminal_events(&mut self) {
        let events = self
            .handler()
            .map(HeadlessHandler::drain_terminal_events)
            .unwrap_or_default();
        for event in events {
            let terminal_id = terminal_event_id(&event);
            self.pending
                .entry(terminal_id)
                .or_default()
                .push_back(event);
        }
    }

    fn harvest_file_events(&mut self) {
        let events = self
            .handler()
            .map(HeadlessHandler::drain_file_job_events)
            .unwrap_or_default();
        for event in events {
            let job_id = file_job_event_id(&event);
            self.file_pending
                .entry(job_id)
                .or_default()
                .push_back(event);
        }
    }
}

#[derive(Clone)]
struct BridgeState {
    token: Option<String>,
    servers: Arc<HashMap<String, ServerProfileConfig>>,
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

fn file_job_event_id(event: &HeadlessFileJobEvent) -> i32 {
    match event {
        HeadlessFileJobEvent::Done { id, .. }
        | HeadlessFileJobEvent::Error { id, .. }
        | HeadlessFileJobEvent::Progress { id, .. }
        | HeadlessFileJobEvent::OverrideRequired { id, .. } => *id,
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

fn capabilities_for(connection: &ConnectionEntry) -> Value {
    let Some(handler) = connection.handler() else {
        return json!({
            "terminal": false, "screen": false, "mouse": false, "keyboard": false,
            "touch": false, "clipboard": false, "files": false, "restart": false
        });
    };
    let permissions = handler.permissions();
    let peer = handler.peer_info();
    let terminal = peer
        .as_ref()
        .and_then(|pi| pi.features.as_ref())
        .map(|features| features.terminal)
        .unwrap_or(false);
    let screen = peer
        .as_ref()
        .map(|pi| !pi.displays.is_empty())
        .unwrap_or(false);
    let keyboard = permissions.get("keyboard").copied().unwrap_or(false);
    let mobile_touch = peer
        .as_ref()
        .map(|pi| {
            let platform = pi.platform.to_ascii_lowercase();
            platform.contains("android") || platform.contains("ios")
        })
        .unwrap_or(false);
    json!({
        "terminal": terminal,
        "screen": screen,
        "mouse": screen && keyboard,
        "keyboard": keyboard,
        "touch": screen && keyboard && mobile_touch,
        "clipboard": permissions.get("clipboard").copied().unwrap_or(false),
        "files": permissions.get("file").copied().unwrap_or(false),
        "restart": permissions.get("restart").copied().unwrap_or(false),
    })
}

fn capability_enabled(connection: &ConnectionEntry, name: &str) -> bool {
    capabilities_for(connection)
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn require_capability(connection: &ConnectionEntry, name: &str) -> Result<(), ApiError> {
    if connection.status() != "connected" {
        return Err(api_error(
            StatusCode::CONFLICT,
            "connection_not_ready",
            "connection is not connected",
        ));
    }
    if !capability_enabled(connection, name) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "capability_unavailable",
            format!("remote capability {name} is not available or permitted"),
        ));
    }
    Ok(())
}

fn peer_metadata(connection: &ConnectionEntry) -> Value {
    let Some(handler) = connection.handler() else {
        return Value::Null;
    };
    let Some(peer) = handler.peer_info() else {
        return Value::Null;
    };
    json!({
        "username": peer.username,
        "hostname": peer.hostname,
        "platform": peer.platform,
        "version": peer.version,
        "currentDisplay": peer.current_display,
        "displays": peer.displays.iter().enumerate().map(|(index, display)| json!({
            "index": index,
            "x": display.x, "y": display.y, "width": display.width, "height": display.height,
            "scale": display.scale, "cursorEmbedded": display.cursor_embedded,
        })).collect::<Vec<_>>(),
        "platformAdditions": handler.platform_additions(),
        "connectionType": handler.connection_type().map(|(secured, direct, stream)| json!({
            "secured": secured, "direct": direct, "streamType": stream
        })),
        "targetPermissions": handler.permissions(),
    })
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

fn builtin_public_server() -> ServerProfileConfig {
    ServerProfileConfig {
        id: "rustdesk-public".to_owned(),
        name: "RustDesk Public".to_owned(),
        kind: ServerProfileKind::Public,
        id_server: None,
        relay_server: None,
        api_server: None,
        server_key_env: None,
    }
}

fn load_bridge_config() -> Result<
    (
        HashMap<String, ServerProfileConfig>,
        HashMap<String, DeviceConfig>,
    ),
    String,
> {
    let path = env::var("RUSTDESK_BRIDGE_CONFIG_FILE")
        .or_else(|_| env::var("RUSTDESK_BRIDGE_DEVICES_FILE"))
        .map_err(|_| {
            "RUSTDESK_BRIDGE_CONFIG_FILE is required (legacy RUSTDESK_BRIDGE_DEVICES_FILE is also accepted)"
                .to_string()
        })?;
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read bridge config: {error}"))?;
    let config: BridgeConfigFile = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid bridge config JSON: {error}"))?;

    let mut servers = HashMap::new();
    servers.insert("rustdesk-public".to_owned(), builtin_public_server());
    for server in config.server_profiles {
        if server.id.trim().is_empty() || server.name.trim().is_empty() {
            return Err("server profile id and name must be non-empty".to_string());
        }
        if server.id == "rustdesk-public" && server.kind != ServerProfileKind::Public {
            return Err("rustdesk-public is reserved for the built-in public profile".to_string());
        }
        if server.kind == ServerProfileKind::Custom
            && server
                .id_server
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            return Err(format!(
                "custom server profile {} requires idServer",
                server.id
            ));
        }
        if server.id == "rustdesk-public" {
            continue;
        }
        if servers.insert(server.id.clone(), server).is_some() {
            return Err("duplicate server profile id in bridge config".to_string());
        }
    }

    let mut devices = HashMap::new();
    for device in config.devices {
        if device.id.trim().is_empty()
            || device.rustdesk_id.trim().is_empty()
            || device.password_env.trim().is_empty()
            || device.server_profile_id.trim().is_empty()
        {
            return Err(
                "device id, rustdeskId, passwordEnv, and serverProfileId must be non-empty"
                    .to_string(),
            );
        }
        if !servers.contains_key(&device.server_profile_id) {
            return Err(format!(
                "device {} references unknown server profile {}",
                device.id, device.server_profile_id
            ));
        }
        if devices.insert(device.id.clone(), device).is_some() {
            return Err("duplicate device id in bridge config".to_string());
        }
    }

    Ok((servers, devices))
}

fn server_profile_json(server: &ServerProfileConfig) -> Value {
    let key_configured = server
        .server_key_env
        .as_deref()
        .and_then(|name| env::var_os(name))
        .is_some();
    json!({
        "id": server.id,
        "name": server.name,
        "kind": server.kind,
        "idServer": server.id_server,
        "relayServer": server.relay_server,
        "apiServer": server.api_server,
        "keyConfigured": key_configured,
    })
}

fn resolve_server_config(server: &ServerProfileConfig) -> Result<HeadlessServerConfig, ApiError> {
    match server.kind {
        ServerProfileKind::Public => Ok(HeadlessServerConfig {
            id_server: "public".to_owned(),
            relay_server: None,
            server_key: String::new(),
        }),
        ServerProfileKind::Custom => {
            let id_server = server
                .id_server
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    api_error(
                        StatusCode::CONFLICT,
                        "server_profile_invalid",
                        "custom server profile is missing idServer",
                    )
                })?;
            let server_key = server
                .server_key_env
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .and_then(|name| env::var(name).ok())
                .unwrap_or_default();
            Ok(HeadlessServerConfig {
                id_server: id_server.to_owned(),
                relay_server: server
                    .relay_server
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
                server_key,
            })
        }
    }
}

async fn credential_submit(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(mut request): Json<CredentialSubmitRequest>,
) -> ApiResult {
    check_auth(&headers, &state)?;
    if request.credential_request_id.trim().is_empty() || request.credential.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_credential_submission",
            "credentialRequestId and credential are required",
        ));
    }

    let mut connections = state.connections.lock().unwrap();
    let Some((connection_id, connection)) = connections.iter_mut().find(|(_, connection)| {
        connection.credential_request_id.as_deref() == Some(request.credential_request_id.as_str())
    }) else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "credential_request_not_found",
            "credential request was not found or has already been consumed",
        ));
    };

    if connection
        .credential_expires_at
        .map(|expires| expires <= Instant::now())
        .unwrap_or(true)
    {
        connection.clear_credential_request();
        return Err(api_error(
            StatusCode::GONE,
            "credential_request_expired",
            "credential request has expired",
        ));
    }

    let credential_kind = connection.credential_kind.clone().ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "credential_request_invalid",
            "credential request has no credential kind",
        )
    })?;
    let secret = std::mem::take(&mut request.credential);

    match credential_kind.as_str() {
        "rustdesk-password" => {
            let pending = match &mut connection.runtime {
                ConnectionRuntime::PendingPassword {
                    server,
                    force_relay,
                } => Some((server.take(), *force_relay)),
                ConnectionRuntime::Active { .. } => None,
            };
            if let Some((server, force_relay)) = pending {
                let server = server.ok_or_else(|| {
                    api_error(
                        StatusCode::CONFLICT,
                        "connection_transition_invalid",
                        "pending connection is missing server routing state",
                    )
                })?;
                let session = HeadlessSession::remote_with_server(
                    connection.rustdesk_id.clone(),
                    secret,
                    force_relay,
                    Some(server),
                );
                let handler = session.handler();
                session.start();
                connection.runtime = ConnectionRuntime::Active { session, handler };
            } else {
                let (session, prompt) = match &connection.runtime {
                    ConnectionRuntime::Active { session, handler } => {
                        (session.clone(), handler.auth_prompt())
                    }
                    ConnectionRuntime::PendingPassword { .. } => unreachable!(),
                };
                if !matches!(
                    prompt.as_deref(),
                    Some("input-password" | "re-input-password")
                ) {
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "credential_not_ready",
                        "remote authentication has not requested a password yet",
                    ));
                }
                session.submit_password(secret);
            }
        }
        "rustdesk-2fa" => {
            let (session, prompt) = match &connection.runtime {
                ConnectionRuntime::Active { session, handler } => {
                    (session.clone(), handler.auth_prompt())
                }
                ConnectionRuntime::PendingPassword { .. } => {
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "credential_not_ready",
                        "2FA cannot be submitted before the RustDesk connection starts",
                    ));
                }
            };
            if prompt.as_deref() != Some("input-2fa") {
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "credential_not_ready",
                    "remote authentication has not requested 2FA yet",
                ));
            }
            session.submit_2fa(secret, request.trust_this_device);
        }
        _ => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "unsupported_credential_kind",
                "credential kind is not supported by this bridge milestone",
            ));
        }
    }

    connection.clear_credential_request();
    Ok(Json(json!({
        "ok": true,
        "connectionId": connection_id,
        "status": connection.status(),
    })))
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
        "servers.list" => servers_list(&state),
        "servers.get" => servers_get(&state, &request),
        "servers.test" => servers_test(&state, &request).await,
        "devices.list" => devices_list(&state),
        "devices.get" => devices_get(&state, &request),
        "devices.connect" => devices_connect(&state, &request),
        "session.connectTemporary" => session_connect_temporary(&state, &request),
        "connection.status" => connection_status(&state, &request),
        "connection.disconnect" => connection_disconnect(&state, &request),
        "system.info" => system_info(&state, &request),
        "system.restart" => system_restart(&state, &request),
        "screen.capture" => screen_capture(&state, &request),
        "mouse.move" => mouse_move(&state, &request),
        "mouse.click" => mouse_click(&state, &request).await,
        "mouse.doubleClick" => mouse_double_click(&state, &request).await,
        "mouse.drag" => mouse_drag(&state, &request).await,
        "mouse.scroll" => mouse_scroll(&state, &request),
        "keyboard.type" => keyboard_type(&state, &request),
        "keyboard.press" => keyboard_press(&state, &request),
        "touch.tap" => touch_tap(&state, &request).await,
        "touch.longPress" => touch_long_press(&state, &request).await,
        "touch.swipe" => touch_swipe(&state, &request).await,
        "clipboard.read" => clipboard_read(&state, &request),
        "clipboard.write" => clipboard_write(&state, &request),
        "files.list" => files_list(&state, &request).await,
        "files.read" => files_read(&state, &request).await,
        "files.upload" => files_upload(&state, &request).await,
        "files.download" => files_download(&state, &request).await,
        "terminal.exec" => terminal_exec(&state, &request).await,
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

fn servers_list(state: &BridgeState) -> ApiResult {
    let mut servers = state
        .servers
        .values()
        .map(server_profile_json)
        .collect::<Vec<_>>();
    servers.sort_by(|a, b| {
        let a = a.get("name").and_then(Value::as_str).unwrap_or_default();
        let b = b.get("name").and_then(Value::as_str).unwrap_or_default();
        a.cmp(b)
    });
    Ok(Json(json!({ "ok": true, "servers": servers })))
}

fn servers_get(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.server_profile_id, "serverProfileId")?;
    let server = state.servers.get(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "server_profile_not_found",
            "server profile not found",
        )
    })?;
    Ok(Json(json!({
        "ok": true,
        "server": server_profile_json(server),
    })))
}

fn rendezvous_target(server: &str) -> Result<String, ApiError> {
    let server = server.trim();
    if server.is_empty() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "server_profile_invalid",
            "rendezvous server is empty",
        ));
    }
    if let Ok(ip) = server.parse::<std::net::IpAddr>() {
        return Ok(match ip {
            std::net::IpAddr::V4(_) => format!("{server}:21116"),
            std::net::IpAddr::V6(_) => format!("[{server}]:21116"),
        });
    }
    if server.starts_with('[') && server.contains("]:") {
        return Ok(server.to_owned());
    }
    if let Some((_, port)) = server.rsplit_once(':') {
        if port.parse::<u16>().is_ok() {
            return Ok(server.to_owned());
        }
    }
    Ok(format!("{server}:21116"))
}

async fn tcp_probe(target: String) -> Value {
    let started = Instant::now();
    let result = timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(&target),
    )
    .await;
    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    match result {
        Ok(Ok(stream)) => json!({
            "reachable": true,
            "latencyMs": latency_ms,
            "target": target,
            "resolvedPeer": stream.peer_addr().ok().map(|addr| addr.to_string()),
        }),
        Ok(Err(error)) => json!({
            "reachable": false,
            "latencyMs": latency_ms,
            "target": target,
            "errorCode": "connect_failed",
            "error": error.to_string(),
        }),
        Err(_) => json!({
            "reachable": false,
            "latencyMs": latency_ms,
            "target": target,
            "errorCode": "timeout",
        }),
    }
}

fn relay_target(server: &str) -> Result<String, ApiError> {
    let server = server.trim();
    if server.is_empty() {
        return Err(api_error(
            StatusCode::CONFLICT,
            "server_profile_invalid",
            "relay server is empty",
        ));
    }
    if let Ok(ip) = server.parse::<std::net::IpAddr>() {
        return Ok(match ip {
            std::net::IpAddr::V4(_) => format!("{server}:21117"),
            std::net::IpAddr::V6(_) => format!("[{server}]:21117"),
        });
    }
    if server.starts_with('[') && server.contains("]:") {
        return Ok(server.to_owned());
    }
    if let Some((_, port)) = server.rsplit_once(':') {
        if port.parse::<u16>().is_ok() {
            return Ok(server.to_owned());
        }
    }
    Ok(format!("{server}:21117"))
}

async fn servers_test(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let (profile_id, kind, rendezvous, relay, key_configured) = match (
        request
            .server_profile_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.server.as_ref(),
    ) {
        (Some(id), None) => {
            let server = state.servers.get(id).ok_or_else(|| {
                api_error(
                    StatusCode::NOT_FOUND,
                    "server_profile_not_found",
                    "server profile not found",
                )
            })?;
            let rendezvous = match server.kind {
                ServerProfileKind::Public => "rs-ny.rustdesk.com".to_owned(),
                ServerProfileKind::Custom => server.id_server.clone().ok_or_else(|| {
                    api_error(
                        StatusCode::CONFLICT,
                        "server_profile_invalid",
                        "custom server profile is missing idServer",
                    )
                })?,
            };
            let kind = match server.kind {
                ServerProfileKind::Public => "public",
                ServerProfileKind::Custom => "saved-custom",
            };
            let key_configured = server
                .server_key_env
                .as_deref()
                .and_then(|name| env::var_os(name))
                .is_some();
            (
                Some(server.id.clone()),
                kind.to_owned(),
                rendezvous,
                server.relay_server.clone(),
                key_configured,
            )
        }
        (None, Some(TemporaryServerSelection::Public)) => (
            Some("rustdesk-public".to_owned()),
            "public".to_owned(),
            "rs-ny.rustdesk.com".to_owned(),
            None,
            false,
        ),
        (None, Some(TemporaryServerSelection::SavedCustom { server_profile_id })) => {
            let server = state.servers.get(server_profile_id).ok_or_else(|| {
                api_error(
                    StatusCode::NOT_FOUND,
                    "server_profile_not_found",
                    "saved server profile not found",
                )
            })?;
            if server.kind != ServerProfileKind::Custom {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_server_selection",
                    "saved-custom requires a custom server profile",
                ));
            }
            let rendezvous = server.id_server.clone().ok_or_else(|| {
                api_error(
                    StatusCode::CONFLICT,
                    "server_profile_invalid",
                    "custom server profile is missing idServer",
                )
            })?;
            let key_configured = server
                .server_key_env
                .as_deref()
                .and_then(|name| env::var_os(name))
                .is_some();
            (
                Some(server.id.clone()),
                "saved-custom".to_owned(),
                rendezvous,
                server.relay_server.clone(),
                key_configured,
            )
        }
        (
            None,
            Some(TemporaryServerSelection::OneTimeCustom {
                id_server,
                relay_server,
                ..
            }),
        ) => {
            let rendezvous = id_server.trim();
            if rendezvous.is_empty() {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_server_selection",
                    "one-time custom server requires idServer",
                ));
            }
            (
                None,
                "one-time-custom".to_owned(),
                rendezvous.to_owned(),
                relay_server.clone(),
                false,
            )
        }
        _ => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "servers.test requires exactly one of serverProfileId or server",
            ));
        }
    };

    let id_target = rendezvous_target(&rendezvous)?;
    let id_test = tcp_probe(id_target.clone()).await;
    let relay_test = match relay
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(server) => Some(tcp_probe(relay_target(server)?).await),
        None => None,
    };
    let id_reachable = id_test
        .get("reachable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let relay_reachable = relay_test
        .as_ref()
        .and_then(|test| test.get("reachable"))
        .and_then(Value::as_bool);
    let reachable = id_reachable && relay_reachable.unwrap_or(true);

    Ok(Json(json!({
        "ok": true,
        "test": {
            "serverProfileId": profile_id,
            "kind": kind,
            "reachable": reachable,
            "keyConfigured": key_configured,
            "idServer": id_test,
            "relayServer": relay_test,
            // Backward-compatible summary of the ID/rendezvous endpoint.
            "target": id_target,
            "latencyMs": id_test.get("latencyMs").cloned().unwrap_or(Value::Null),
        }
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
        server_profile_id: device.server_profile_id.clone(),
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
    let server_profile = state
        .servers
        .get(&device.server_profile_id)
        .ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "server_profile_not_found",
                "saved device server profile is unavailable",
            )
        })?
        .clone();
    let server = resolve_server_config(&server_profile)?;
    let server_kind = match server_profile.kind {
        ServerProfileKind::Public => "public",
        ServerProfileKind::Custom => "saved-custom",
    };

    let session = HeadlessSession::remote_with_server(
        device.rustdesk_id.clone(),
        password,
        device.force_relay,
        Some(server),
    );
    let handler = session.handler();
    session.start();

    let connection_id = Uuid::new_v4().to_string();
    state.connections.lock().unwrap().insert(
        connection_id.clone(),
        ConnectionEntry {
            kind: "permanent".to_owned(),
            device_id: Some(device.id.clone()),
            rustdesk_id: device.rustdesk_id.clone(),
            server_profile_id: Some(device.server_profile_id.clone()),
            server_kind: server_kind.to_owned(),
            auth_mode: "permanent-password".to_owned(),
            runtime: ConnectionRuntime::Active { session, handler },
            credential_request_id: None,
            credential_kind: None,
            credential_expires_at: None,
            next_terminal_id: 1,
            next_file_job_id: 1,
            pending: HashMap::new(),
            file_pending: HashMap::new(),
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
            "serverProfileId": device.server_profile_id,
            "serverKind": server_kind,
            "authMode": "permanent-password",
            "capabilities": {
                "terminal": false, "screen": false, "mouse": false, "keyboard": false,
                "touch": false, "clipboard": false, "files": false, "restart": false
            },
        }
    })))
}

fn resolve_temporary_server(
    state: &BridgeState,
    selection: &TemporaryServerSelection,
) -> Result<(HeadlessServerConfig, Option<String>, String), ApiError> {
    match selection {
        TemporaryServerSelection::Public => Ok((
            HeadlessServerConfig {
                id_server: "public".to_owned(),
                relay_server: None,
                server_key: String::new(),
            },
            Some("rustdesk-public".to_owned()),
            "public".to_owned(),
        )),
        TemporaryServerSelection::SavedCustom { server_profile_id } => {
            let profile = state.servers.get(server_profile_id).ok_or_else(|| {
                api_error(
                    StatusCode::NOT_FOUND,
                    "server_profile_not_found",
                    "saved server profile not found",
                )
            })?;
            if profile.kind != ServerProfileKind::Custom {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_server_selection",
                    "saved-custom requires a custom server profile",
                ));
            }
            Ok((
                resolve_server_config(profile)?,
                Some(profile.id.clone()),
                "saved-custom".to_owned(),
            ))
        }
        TemporaryServerSelection::OneTimeCustom {
            id_server,
            relay_server,
            api_server,
        } => {
            let id_server = id_server.trim();
            if id_server.is_empty() {
                return Err(api_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_server_selection",
                    "one-time custom server requires idServer",
                ));
            }
            // relayServer/apiServer remain connection-scoped routing metadata. The current
            // RustDesk controller receives relay routing from the selected rendezvous server;
            // no raw server key is accepted through the model-facing action payload.
            let _ = api_server;
            Ok((
                HeadlessServerConfig {
                    id_server: id_server.to_owned(),
                    relay_server: relay_server
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned),
                    server_key: String::new(),
                },
                None,
                "one-time-custom".to_owned(),
            ))
        }
    }
}

fn session_connect_temporary(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let rustdesk_id = require(&request.rustdesk_id, "rustdeskId")?
        .trim()
        .to_owned();
    let auth_mode = require(&request.auth_mode, "authMode")?;
    if !matches!(
        auth_mode,
        "temporary-password" | "manual-approval" | "password-or-approval"
    ) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_auth_mode",
            "temporary authMode must be temporary-password, manual-approval, or password-or-approval",
        ));
    }
    let selection = request.server.as_ref().ok_or_else(|| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "missing server selection",
        )
    })?;
    let (server, server_profile_id, server_kind) = resolve_temporary_server(state, selection)?;
    let connection_id = Uuid::new_v4().to_string();

    let mut entry = ConnectionEntry {
        kind: "temporary".to_owned(),
        device_id: None,
        rustdesk_id: rustdesk_id.clone(),
        server_profile_id: server_profile_id.clone(),
        server_kind: server_kind.clone(),
        auth_mode: auth_mode.to_owned(),
        runtime: ConnectionRuntime::PendingPassword {
            server: Some(server.clone()),
            force_relay: false,
        },
        credential_request_id: None,
        credential_kind: None,
        credential_expires_at: None,
        next_terminal_id: 1,
        next_file_job_id: 1,
        pending: HashMap::new(),
        file_pending: HashMap::new(),
    };

    let (status, credential_request_id, credential_kind) = match auth_mode {
        "temporary-password" => {
            let credential_request_id = entry.ensure_credential_request("rustdesk-password");
            (
                "credential_required",
                Some(credential_request_id),
                Some("rustdesk-password".to_owned()),
            )
        }
        "manual-approval" | "password-or-approval" => {
            let session = HeadlessSession::remote_with_server(
                rustdesk_id.clone(),
                String::new(),
                false,
                Some(server),
            );
            let handler = session.handler();
            session.start();
            entry.runtime = ConnectionRuntime::Active { session, handler };
            if auth_mode == "password-or-approval" {
                let credential_request_id = entry.ensure_credential_request("rustdesk-password");
                (
                    "connecting",
                    Some(credential_request_id),
                    Some("rustdesk-password".to_owned()),
                )
            } else {
                ("connecting", None, None)
            }
        }
        _ => unreachable!(),
    };

    state
        .connections
        .lock()
        .unwrap()
        .insert(connection_id.clone(), entry);

    Ok(Json(json!({
        "ok": true,
        "connection": {
            "connectionId": connection_id,
            "kind": "temporary",
            "status": status,
            "rustdeskId": rustdesk_id,
            "serverProfileId": server_profile_id,
            "serverKind": server_kind,
            "authMode": auth_mode,
            "credentialRequestId": credential_request_id,
            "credentialKind": credential_kind,
            "capabilities": {
                "terminal": false, "screen": false, "mouse": false, "keyboard": false,
                "touch": false, "clipboard": false, "files": false, "restart": false
            },
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
        connection.refresh_auth_challenge();
        let status = connection.status();
        let (last_error, messages) = connection
            .handler()
            .map(|handler| (handler.last_error(), handler.drain_messages()))
            .unwrap_or_else(|| (None, Vec::new()));
        let (credential_request_id, credential_kind) = connection.credential_metadata();
        Ok(Json(json!({
            "ok": true,
            "connection": {
                "connectionId": require(&request.connection_id, "connectionId")?,
                "kind": connection.kind.clone(),
                "deviceId": connection.device_id.clone(),
                "rustdeskId": connection.rustdesk_id.clone(),
                "serverProfileId": connection.server_profile_id.clone(),
                "serverKind": connection.server_kind.clone(),
                "authMode": connection.auth_mode.clone(),
                "status": status,
                "credentialRequestId": credential_request_id,
                "credentialKind": credential_kind,
                "error": last_error,
                "messages": messages,
                "peer": peer_metadata(connection),
                "capabilities": capabilities_for(connection),
            }
        })))
    })
}

fn connection_disconnect(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.connection_id, "connectionId")?.to_owned();
    let mut connection = state
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
    if let ConnectionRuntime::Active { session, .. } = &connection.runtime {
        session.close();
    }
    connection.clear_credential_request();
    Ok(Json(json!({
        "ok": true,
        "connectionId": id,
        "status": "disconnected",
        "temporaryStateDestroyed": connection.kind == "temporary",
    })))
}

fn active_session_for_capability(
    state: &BridgeState,
    request: &ActionRequest,
    capability: &str,
) -> Result<HeadlessSession, ApiError> {
    let id = require(&request.connection_id, "connectionId")?;
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    require_capability(connection, capability)?;
    connection.session().cloned().ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "connection_not_ready",
            "connection runtime is not active",
        )
    })
}

fn parse_xy(request: &ActionRequest) -> Result<(i32, i32), ApiError> {
    let x = request
        .x
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing x"))?;
    let y = request
        .y
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing y"))?;
    if !(-100_000..=100_000).contains(&x) || !(-100_000..=100_000).contains(&y) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "coordinate_out_of_range",
            "coordinates must be between -100000 and 100000",
        ));
    }
    Ok((x, y))
}

fn system_info(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    with_connection_mut(state, request, |connection| {
        if connection.status() != "connected" {
            return Err(api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection is not connected",
            ));
        }
        Ok(Json(json!({
            "ok": true,
            "peer": peer_metadata(connection),
            "capabilities": capabilities_for(connection),
        })))
    })
}

fn system_restart(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "restart")?;
    session.restart_remote_device();
    Ok(Json(json!({ "ok": true, "status": "restart_requested" })))
}

fn rgba_bytes(frame: &HeadlessFrame) -> Result<Vec<u8>, ApiError> {
    if frame.width == 0 || frame.height == 0 {
        return Err(api_error(
            StatusCode::CONFLICT,
            "frame_invalid",
            "latest frame has invalid dimensions",
        ));
    }
    let bpp = if frame.format == "raw" { 3 } else { 4 };
    let min_stride = frame.width.checked_mul(bpp).ok_or_else(|| {
        api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frame_too_large",
            "frame is too large",
        )
    })?;
    let stride = frame.data.len() / frame.height;
    if stride < min_stride || stride.checked_mul(frame.height) != Some(frame.data.len()) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "frame_invalid",
            "latest frame has an unsupported stride",
        ));
    }
    let pixels = frame.width.checked_mul(frame.height).ok_or_else(|| {
        api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frame_too_large",
            "frame is too large",
        )
    })?;
    let mut out = Vec::with_capacity(pixels * 4);
    for row in frame.data.chunks(stride).take(frame.height) {
        for px in row[..min_stride].chunks_exact(bpp) {
            match frame.format.as_str() {
                // libyuv ARGB is BGRA in byte-addressed memory.
                "argb" => out.extend_from_slice(&[px[2], px[1], px[0], px[3]]),
                // libyuv ABGR is RGBA in byte-addressed memory.
                "abgr" => out.extend_from_slice(&[px[0], px[1], px[2], px[3]]),
                "raw" => out.extend_from_slice(&[px[0], px[1], px[2], 255]),
                _ => {
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "frame_format_unsupported",
                        "latest frame format is unsupported",
                    ));
                }
            }
        }
    }
    Ok(out)
}

fn encode_frame(
    frame: &HeadlessFrame,
    format: &str,
    quality: u8,
) -> Result<(String, Vec<u8>), ApiError> {
    let rgba = rgba_bytes(frame)?;
    let width = u32::try_from(frame.width).map_err(|_| {
        api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frame_too_large",
            "frame width is too large",
        )
    })?;
    let height = u32::try_from(frame.height).map_err(|_| {
        api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frame_too_large",
            "frame height is too large",
        )
    })?;
    let mut output = Cursor::new(Vec::new());
    match format {
        "jpeg" | "jpg" => {
            let mut rgb = Vec::with_capacity(frame.width * frame.height * 3);
            for px in rgba.chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
            JpegEncoder::new_with_quality(&mut output, quality.clamp(1, 100))
                .encode(&rgb, width, height, ColorType::Rgb8)
                .map_err(|error| {
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "image_encode_failed",
                        error.to_string(),
                    )
                })?;
            Ok(("image/jpeg".to_owned(), output.into_inner()))
        }
        "png" => {
            PngEncoder::new(&mut output)
                .write_image(&rgba, width, height, ColorType::Rgba8)
                .map_err(|error| {
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "image_encode_failed",
                        error.to_string(),
                    )
                })?;
            Ok(("image/png".to_owned(), output.into_inner()))
        }
        "webp" => {
            WebPEncoder::new_lossless(&mut output)
                .write_image(&rgba, width, height, ColorType::Rgba8)
                .map_err(|error| {
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "image_encode_failed",
                        error.to_string(),
                    )
                })?;
            Ok(("image/webp".to_owned(), output.into_inner()))
        }
        _ => Err(api_error(
            StatusCode::BAD_REQUEST,
            "image_format_unsupported",
            "screen format must be png, jpeg, jpg, or webp",
        )),
    }
}

fn screen_capture(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.connection_id, "connectionId")?;
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    require_capability(connection, "screen")?;
    let handler = connection.handler().ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "connection_not_ready",
            "connection runtime is not active",
        )
    })?;
    let display = request.display_index.unwrap_or(0);
    let frame = handler.latest_frame(display).ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "frame_not_ready",
            "no decoded frame is available yet",
        )
    })?;
    let format = request
        .image_format
        .as_deref()
        .unwrap_or("png")
        .to_ascii_lowercase();
    let (mime, encoded) = encode_frame(&frame, &format, request.quality.unwrap_or(85))?;
    if encoded.len() > 16 * 1024 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "capture_too_large",
            "encoded screen capture exceeds 16 MiB",
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "display": display,
        "width": frame.width,
        "height": frame.height,
        "mimeType": mime,
        "size": encoded.len(),
        "imageBase64": BASE64.encode(encoded),
    })))
}

fn mouse_move(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "mouse")?;
    let (x, y) = parse_xy(request)?;
    session.mouse_move(x, y);
    Ok(Json(json!({ "ok": true, "x": x, "y": y })))
}

async fn mouse_click(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "mouse")?;
    let (x, y) = parse_xy(request)?;
    let button = request.button.as_deref().unwrap_or("left");
    session.mouse_move(x, y);
    session.mouse_button(button, true, x, y);
    tokio::time::sleep(Duration::from_millis(35)).await;
    session.mouse_button(button, false, x, y);
    Ok(Json(
        json!({ "ok": true, "x": x, "y": y, "button": button }),
    ))
}

async fn mouse_double_click(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "mouse")?;
    let (x, y) = parse_xy(request)?;
    let button = request.button.as_deref().unwrap_or("left");
    session.mouse_move(x, y);
    for index in 0..2 {
        session.mouse_button(button, true, x, y);
        tokio::time::sleep(Duration::from_millis(30)).await;
        session.mouse_button(button, false, x, y);
        if index == 0 {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    Ok(Json(
        json!({ "ok": true, "x": x, "y": y, "button": button }),
    ))
}

async fn mouse_drag(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "mouse")?;
    let x = request
        .from_x
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing fromX"))?;
    let y = request
        .from_y
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing fromY"))?;
    let x2 = request
        .to_x
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing toX"))?;
    let y2 = request
        .to_y
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing toY"))?;
    let button = request.button.as_deref().unwrap_or("left");
    let duration = request.duration_ms.unwrap_or(250).clamp(10, 5_000);
    session.mouse_move(x, y);
    session.mouse_button(button, true, x, y);
    let steps = ((duration / 25).clamp(1, 100)) as i64;
    for step in 1..=steps {
        let nx = x as i64 + ((x2 as i64 - x as i64) * step / steps);
        let ny = y as i64 + ((y2 as i64 - y as i64) * step / steps);
        session.mouse_move(nx as i32, ny as i32);
        tokio::time::sleep(Duration::from_millis((duration / steps as u64).max(1))).await;
    }
    session.mouse_button(button, false, x2, y2);
    Ok(Json(
        json!({ "ok": true, "from": {"x": x, "y": y}, "to": {"x": x2, "y": y2}, "button": button }),
    ))
}

fn mouse_scroll(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "mouse")?;
    let dx = request.delta_x.unwrap_or(0).clamp(-20_000, 20_000);
    let dy = request.delta_y.unwrap_or(0).clamp(-20_000, 20_000);
    session.mouse_scroll(dx, dy);
    Ok(Json(json!({ "ok": true, "deltaX": dx, "deltaY": dy })))
}

fn modifier_flags(modifiers: &[String]) -> (bool, bool, bool, bool) {
    let has = |name: &str| {
        modifiers
            .iter()
            .any(|value| value.eq_ignore_ascii_case(name))
    };
    (
        has("alt"),
        has("ctrl") || has("control"),
        has("shift"),
        has("meta") || has("command") || has("super"),
    )
}

fn normalize_key(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => "VK_RETURN".to_owned(),
        "escape" | "esc" => "VK_ESCAPE".to_owned(),
        "tab" => "VK_TAB".to_owned(),
        "backspace" => "VK_BACK".to_owned(),
        "delete" | "del" => "VK_DELETE".to_owned(),
        "left" | "arrowleft" => "VK_LEFT".to_owned(),
        "right" | "arrowright" => "VK_RIGHT".to_owned(),
        "up" | "arrowup" => "VK_UP".to_owned(),
        "down" | "arrowdown" => "VK_DOWN".to_owned(),
        "home" => "VK_HOME".to_owned(),
        "end" => "VK_END".to_owned(),
        "pageup" => "VK_PRIOR".to_owned(),
        "pagedown" => "VK_NEXT".to_owned(),
        other
            if other.starts_with('f')
                && other[1..]
                    .parse::<u8>()
                    .map(|n| (1..=12).contains(&n))
                    .unwrap_or(false) =>
        {
            format!("VK_{}", other.to_ascii_uppercase())
        }
        _ => key.to_owned(),
    }
}

fn keyboard_type(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "keyboard")?;
    let text = request
        .text
        .as_deref()
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing text"))?;
    if text.len() > 256 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "keyboard_input_too_large",
            "keyboard type is limited to 256 KiB",
        ));
    }
    session.keyboard_type(text);
    Ok(Json(json!({ "ok": true, "chars": text.chars().count() })))
}

fn keyboard_press(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "keyboard")?;
    if request.keys.is_empty() || request.keys.iter().any(|key| key.trim().is_empty()) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "keyboard.press requires one or more keys",
        ));
    }
    let mut modifiers = Vec::new();
    let mut normal_keys = Vec::new();
    for key in &request.keys {
        match key.to_ascii_lowercase().as_str() {
            "alt" | "ctrl" | "control" | "shift" | "meta" | "command" | "super" => {
                modifiers.push(key.clone())
            }
            _ => normal_keys.push(key.clone()),
        }
    }
    if normal_keys.is_empty() {
        normal_keys = request.keys.clone();
        modifiers.clear();
    }
    let (alt, ctrl, shift, command) = modifier_flags(&modifiers);
    let normalized = normal_keys
        .iter()
        .map(|key| normalize_key(key))
        .collect::<Vec<_>>();
    for key in &normalized {
        session.keyboard_press(key, alt, ctrl, shift, command);
    }
    Ok(Json(
        json!({ "ok": true, "keys": request.keys, "normalizedKeys": normalized }),
    ))
}

async fn touch_tap(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "touch")?;
    let (x, y) = parse_xy(request)?;
    session.touch_pan("pan_start", x, y);
    tokio::time::sleep(Duration::from_millis(40)).await;
    session.touch_pan("pan_end", x, y);
    Ok(Json(json!({ "ok": true, "x": x, "y": y })))
}

async fn touch_long_press(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "touch")?;
    let (x, y) = parse_xy(request)?;
    let duration = request.duration_ms.unwrap_or(650).clamp(100, 5_000);
    session.touch_pan("pan_start", x, y);
    tokio::time::sleep(Duration::from_millis(duration)).await;
    session.touch_pan("pan_end", x, y);
    Ok(Json(
        json!({ "ok": true, "x": x, "y": y, "durationMs": duration }),
    ))
}

async fn touch_swipe(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "touch")?;
    let x = request
        .from_x
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing fromX"))?;
    let y = request
        .from_y
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing fromY"))?;
    let x2 = request
        .to_x
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing toX"))?;
    let y2 = request
        .to_y
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing toY"))?;
    let duration = request.duration_ms.unwrap_or(350).clamp(50, 5_000);
    session.touch_pan("pan_start", x, y);
    let steps = ((duration / 30).clamp(1, 60)) as i32;
    let mut last_x = x;
    let mut last_y = y;
    for step in 1..=steps {
        let nx = x + ((x2 - x) * step / steps);
        let ny = y + ((y2 - y) * step / steps);
        session.touch_pan("pan_update", nx - last_x, ny - last_y);
        last_x = nx;
        last_y = ny;
        tokio::time::sleep(Duration::from_millis((duration / steps as u64).max(1))).await;
    }
    session.touch_pan("pan_end", x2, y2);
    Ok(Json(
        json!({ "ok": true, "from": {"x": x, "y": y}, "to": {"x": x2, "y": y2}, "durationMs": duration }),
    ))
}

fn clipboard_read(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let id = require(&request.connection_id, "connectionId")?;
    let connections = state.connections.lock().unwrap();
    let connection = connections.get(id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    require_capability(connection, "clipboard")?;
    let text = connection
        .handler()
        .and_then(HeadlessHandler::clipboard_text);
    Ok(Json(json!({ "ok": true, "text": text })))
}

fn clipboard_write(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "clipboard")?;
    let text = request
        .text
        .as_ref()
        .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "invalid_request", "missing text"))?;
    if text.len() > 1024 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "clipboard_too_large",
            "clipboard text is limited to 1 MiB",
        ));
    }
    session.write_clipboard_text(text.clone());
    Ok(Json(json!({ "ok": true, "bytes": text.len() })))
}

fn file_directory_json(directory: HeadlessFileDirectory) -> Value {
    json!({
        "path": directory.path,
        "entries": directory.entries.into_iter().map(|entry| json!({
            "type": entry.entry_type,
            "name": entry.name,
            "hidden": entry.hidden,
            "size": entry.size,
            "modifiedTime": entry.modified_time,
        })).collect::<Vec<_>>()
    })
}

async fn files_list(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let session = active_session_for_capability(state, request, "files")?;
    let path = require(&request.path, "path")?.to_owned();
    if path.len() > 4096 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "path_too_long",
            "remote path is too long",
        ));
    }
    let id = require(&request.connection_id, "connectionId")?.to_owned();
    let handler = {
        let connections = state.connections.lock().unwrap();
        connections
            .get(&id)
            .and_then(ConnectionEntry::handler)
            .cloned()
            .ok_or_else(|| {
                api_error(
                    StatusCode::CONFLICT,
                    "connection_not_ready",
                    "connection runtime is not active",
                )
            })?
    };
    handler.drain_file_directories();
    session.read_remote_dir(path.clone(), request.include_hidden.unwrap_or(false));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        for directory in handler.drain_file_directories() {
            if directory.path == path {
                if directory.entries.len() > 10_000 {
                    return Err(api_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "directory_too_large",
                        "remote directory contains too many entries",
                    ));
                }
                return Ok(Json(
                    json!({ "ok": true, "directory": file_directory_json(directory) }),
                ));
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(api_error(
        StatusCode::GATEWAY_TIMEOUT,
        "file_list_timeout",
        "timed out waiting for remote directory listing",
    ))
}

fn take_file_events(
    state: &BridgeState,
    connection_id: &str,
    job_id: i32,
) -> Result<Vec<HeadlessFileJobEvent>, ApiError> {
    let mut connections = state.connections.lock().unwrap();
    let connection = connections.get_mut(connection_id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    connection.harvest_file_events();
    Ok(connection
        .file_pending
        .entry(job_id)
        .or_default()
        .drain(..)
        .collect())
}

fn split_remote_file_path(path: &str, platform: &str) -> Result<(String, String), ApiError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "remote path is empty",
        ));
    }
    let windows = platform.to_ascii_lowercase().contains("windows") || path.contains('\\');
    let separator = if windows { ['\\', '/'] } else { ['/', '/'] };
    let index = path
        .char_indices()
        .rev()
        .find(|(_, ch)| *ch == separator[0] || *ch == separator[1])
        .map(|(index, _)| index);
    let (parent, name) = match index {
        Some(index) => {
            let name = &path[index + 1..];
            let parent = if index == 0 {
                &path[..1]
            } else if windows && index == 2 && path.as_bytes().get(1) == Some(&b':') {
                &path[..=index]
            } else {
                &path[..index]
            };
            (parent.to_owned(), name.to_owned())
        }
        None => (".".to_owned(), path.to_owned()),
    };
    if name.is_empty() || name == "." || name == ".." {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_remote_file_path",
            "remote path must identify a file",
        ));
    }
    Ok((parent, name))
}

fn transfer_limit(request: &ActionRequest) -> usize {
    request
        .max_bytes
        .unwrap_or(8 * 1024 * 1024)
        .clamp(1024, 64 * 1024 * 1024)
}

fn file_transfer_context(
    state: &BridgeState,
    request: &ActionRequest,
) -> Result<(String, HeadlessSession, HeadlessHandler, String, i32), ApiError> {
    let connection_id = require(&request.connection_id, "connectionId")?.to_owned();
    let mut connections = state.connections.lock().unwrap();
    let connection = connections.get_mut(&connection_id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    require_capability(connection, "files")?;
    let session = connection.session().cloned().ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "connection_not_ready",
            "connection runtime is not active",
        )
    })?;
    let handler = connection.handler().cloned().ok_or_else(|| {
        api_error(
            StatusCode::CONFLICT,
            "connection_not_ready",
            "connection runtime is not active",
        )
    })?;
    let platform = handler
        .peer_info()
        .map(|peer| peer.platform)
        .unwrap_or_default();
    let job_id = connection.allocate_file_job_id();
    Ok((connection_id, session, handler, platform, job_id))
}

async fn await_file_job(
    state: &BridgeState,
    connection_id: &str,
    session: &HeadlessSession,
    job_id: i32,
    timeout_ms: u64,
    max_bytes: usize,
    is_upload: bool,
) -> Result<(), ApiError> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    loop {
        for event in take_file_events(state, connection_id, job_id)? {
            match event {
                HeadlessFileJobEvent::Done { .. } => return Ok(()),
                HeadlessFileJobEvent::Error { message, .. } => {
                    session.cancel_file_job(job_id);
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "file_transfer_failed",
                        message,
                    ));
                }
                HeadlessFileJobEvent::Progress { finished_size, .. } => {
                    if finished_size > max_bytes as u64 {
                        session.cancel_file_job(job_id);
                        return Err(api_error(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "file_too_large",
                            format!("remote transfer exceeds {max_bytes} bytes"),
                        ));
                    }
                }
                HeadlessFileJobEvent::OverrideRequired {
                    file_num,
                    is_upload: remote_reports_upload,
                    ..
                } => {
                    session.confirm_file_override(
                        job_id,
                        file_num,
                        true,
                        false,
                        is_upload || remote_reports_upload,
                    );
                }
            }
        }
        if Instant::now() >= deadline {
            session.cancel_file_job(job_id);
            return Err(api_error(
                StatusCode::GATEWAY_TIMEOUT,
                "file_transfer_timeout",
                "timed out waiting for RustDesk file transfer",
            ));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn download_remote_file_bytes(
    state: &BridgeState,
    request: &ActionRequest,
    remote_path: String,
) -> Result<Vec<u8>, ApiError> {
    if remote_path.len() > 4096 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "path_too_long",
            "remote path is too long",
        ));
    }
    let (connection_id, session, _handler, platform, job_id) =
        file_transfer_context(state, request)?;
    let (_, file_name) = split_remote_file_path(&remote_path, &platform)?;
    let temp_dir = env::temp_dir().join(format!("rustdesk-bridge-download-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "temp_dir_failed",
            error.to_string(),
        )
    })?;
    let destination = temp_dir.to_string_lossy().to_string();
    session.transfer_file(job_id, remote_path, destination, true);
    let max_bytes = transfer_limit(request);
    let result = await_file_job(
        state,
        &connection_id,
        &session,
        job_id,
        request.timeout_ms.unwrap_or(30_000),
        max_bytes,
        false,
    )
    .await;
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(error);
    }
    let local_path = temp_dir.join(file_name);
    let metadata = fs::metadata(&local_path).map_err(|error| {
        let _ = fs::remove_dir_all(&temp_dir);
        api_error(
            StatusCode::CONFLICT,
            "download_result_missing",
            format!("RustDesk transfer completed but downloaded file is unavailable: {error}"),
        )
    })?;
    if !metadata.is_file() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "remote_path_not_file",
            "requested remote path did not resolve to a regular file",
        ));
    }
    if metadata.len() > max_bytes as u64 {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            format!("remote file exceeds {max_bytes} bytes"),
        ));
    }
    let bytes = fs::read(&local_path).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "download_read_failed",
            error.to_string(),
        )
    })?;
    let _ = fs::remove_dir_all(&temp_dir);
    Ok(bytes)
}

async fn files_read(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let remote_path = require(&request.path, "path")?.to_owned();
    let bytes = download_remote_file_bytes(state, request, remote_path.clone()).await?;
    let text = String::from_utf8(bytes.clone()).ok();
    Ok(Json(json!({
        "ok": true,
        "path": remote_path,
        "bytes": bytes.len(),
        "text": text,
        "contentBase64": BASE64.encode(bytes),
    })))
}

async fn files_download(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let remote_path = require(&request.remote_path, "remotePath")?.to_owned();
    let bytes = download_remote_file_bytes(state, request, remote_path.clone()).await?;
    Ok(Json(json!({
        "ok": true,
        "remotePath": remote_path,
        "bytes": bytes.len(),
        "contentBase64": BASE64.encode(bytes),
    })))
}

async fn files_upload(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let remote_path = require(&request.remote_path, "remotePath")?.to_owned();
    if remote_path.len() > 4096 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "path_too_long",
            "remote path is too long",
        ));
    }
    let encoded = require(&request.content_base64, "contentBase64")?;
    let max_bytes = transfer_limit(request);
    let bytes = BASE64.decode(encoded).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "invalid_base64",
            "contentBase64 is not valid base64",
        )
    })?;
    if bytes.len() > max_bytes {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            format!("upload exceeds {max_bytes} bytes"),
        ));
    }

    let (connection_id, session, _handler, platform, job_id) =
        file_transfer_context(state, request)?;
    let (remote_parent, remote_name) = split_remote_file_path(&remote_path, &platform)?;
    let temp_dir = env::temp_dir().join(format!("rustdesk-bridge-upload-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|error| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "temp_dir_failed",
            error.to_string(),
        )
    })?;
    let local_path = temp_dir.join(&remote_name);
    fs::write(&local_path, &bytes).map_err(|error| {
        let _ = fs::remove_dir_all(&temp_dir);
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "temp_file_failed",
            error.to_string(),
        )
    })?;
    session.transfer_file(
        job_id,
        local_path.to_string_lossy().to_string(),
        remote_parent,
        false,
    );
    let result = await_file_job(
        state,
        &connection_id,
        &session,
        job_id,
        request.timeout_ms.unwrap_or(30_000),
        max_bytes,
        true,
    )
    .await;
    let _ = fs::remove_dir_all(&temp_dir);
    result?;
    Ok(Json(json!({
        "ok": true,
        "remotePath": remote_path,
        "bytes": bytes.len(),
    })))
}

fn take_terminal_events(
    state: &BridgeState,
    connection_id: &str,
    terminal_id: i32,
) -> Result<Vec<HeadlessTerminalEvent>, ApiError> {
    let mut connections = state.connections.lock().unwrap();
    let connection = connections.get_mut(connection_id).ok_or_else(|| {
        api_error(
            StatusCode::NOT_FOUND,
            "connection_not_found",
            "connection not found",
        )
    })?;
    connection.harvest_terminal_events();
    Ok(connection
        .pending
        .entry(terminal_id)
        .or_default()
        .drain(..)
        .collect())
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| offset + from)
}

fn parse_exec_completion(
    buffer: &[u8],
    start_marker: &[u8],
    end_marker: &[u8],
) -> Option<(usize, usize, i32)> {
    let start = find_bytes(buffer, start_marker, 0)? + start_marker.len();
    let end = find_bytes(buffer, end_marker, start)?;
    let mut code_start = end + end_marker.len();
    if buffer.get(code_start) != Some(&b':') {
        return None;
    }
    code_start += 1;
    let code_end = buffer[code_start..]
        .iter()
        .position(|byte| *byte == b'\r' || *byte == b'\n')
        .map(|offset| code_start + offset)
        .unwrap_or(buffer.len());
    let code = std::str::from_utf8(&buffer[code_start..code_end])
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()?;
    let mut output_start = start;
    while matches!(buffer.get(output_start), Some(b'\r' | b'\n')) {
        output_start += 1;
    }
    let mut output_end = end;
    while output_end > output_start && matches!(buffer.get(output_end - 1), Some(b'\r' | b'\n')) {
        output_end -= 1;
    }
    Some((output_start, output_end, code))
}

fn exec_framed_command(command: &str, platform: &str, marker: &str) -> String {
    let split = marker.len() / 2;
    let (a, b) = marker.split_at(split);
    if platform.to_ascii_lowercase().contains("windows") {
        format!(
            "$__rd_m='{a}'+'{b}'; Write-Output ($__rd_m+'_START'); & {{ {command} }}; $__rd_ec = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}; Write-Output ($__rd_m+'_END:' + $__rd_ec)\r\n"
        )
    } else {
        format!(
            "__rd_m='{a}''{b}'; printf '\\n%s\\n' \"${{__rd_m}}_START\"; {{ {command}\n}}; __rd_ec=$?; printf '\\n%s:%s\\n' \"${{__rd_m}}_END\" \"$__rd_ec\"\n"
        )
    }
}

async fn terminal_exec(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let connection_id = require(&request.connection_id, "connectionId")?.to_owned();
    let command = require(&request.command, "command")?.to_owned();
    if command.len() > 256 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "command_too_large",
            "terminal command is limited to 256 KiB",
        ));
    }
    let timeout_ms = request.timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000);
    let max_bytes = request
        .max_bytes
        .unwrap_or(512 * 1024)
        .clamp(1024, 4 * 1024 * 1024);

    let (session, terminal_id, platform) = {
        let mut connections = state.connections.lock().unwrap();
        let connection = connections.get_mut(&connection_id).ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "connection_not_found",
                "connection not found",
            )
        })?;
        require_capability(connection, "terminal")?;
        let session = connection.session().cloned().ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            )
        })?;
        let terminal_id = connection.allocate_terminal_id();
        let platform = connection
            .handler()
            .and_then(HeadlessHandler::peer_info)
            .map(|peer| peer.platform)
            .unwrap_or_default();
        (session, terminal_id, platform)
    };

    session.open_terminal(terminal_id, 24, 120);
    let open_deadline = Instant::now() + Duration::from_secs(10);
    let mut opened = false;
    while Instant::now() < open_deadline {
        for event in take_terminal_events(state, &connection_id, terminal_id)? {
            match event {
                HeadlessTerminalEvent::Opened {
                    success, message, ..
                } => {
                    if !success {
                        session.close_terminal(terminal_id);
                        return Err(api_error(
                            StatusCode::CONFLICT,
                            "terminal_open_failed",
                            message,
                        ));
                    }
                    opened = true;
                }
                HeadlessTerminalEvent::Error { message, .. } => {
                    session.close_terminal(terminal_id);
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "terminal_open_failed",
                        message,
                    ));
                }
                _ => {}
            }
        }
        if opened {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    if !opened {
        session.close_terminal(terminal_id);
        return Err(api_error(
            StatusCode::GATEWAY_TIMEOUT,
            "terminal_open_timeout",
            "timed out opening remote terminal",
        ));
    }

    let marker = format!("__RDB_{}", Uuid::new_v4().simple());
    let start_marker = format!("{marker}_START");
    let end_marker = format!("{marker}_END");
    session.write_terminal(
        terminal_id,
        exec_framed_command(&command, &platform, &marker),
    );

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let hard_buffer_limit = max_bytes.saturating_add(128 * 1024);
    let mut buffer = Vec::new();
    let mut remote_closed: Option<i32> = None;
    loop {
        for event in take_terminal_events(state, &connection_id, terminal_id)? {
            match event {
                HeadlessTerminalEvent::Data { data, .. } => {
                    if buffer.len().saturating_add(data.len()) > hard_buffer_limit {
                        session.close_terminal(terminal_id);
                        let output =
                            String::from_utf8_lossy(&buffer[..buffer.len().min(max_bytes)])
                                .to_string();
                        return Ok(Json(json!({
                            "ok": true,
                            "terminalId": terminal_id.to_string(),
                            "output": output,
                            "exitCode": Value::Null,
                            "timedOut": false,
                            "truncated": true,
                            "errorCode": "output_limit",
                        })));
                    }
                    buffer.extend_from_slice(&data);
                }
                HeadlessTerminalEvent::Closed { exit_code, .. } => remote_closed = Some(exit_code),
                HeadlessTerminalEvent::Error { message, .. } => {
                    session.close_terminal(terminal_id);
                    return Err(api_error(
                        StatusCode::CONFLICT,
                        "terminal_exec_failed",
                        message,
                    ));
                }
                _ => {}
            }
        }

        if let Some((output_start, output_end, exit_code)) =
            parse_exec_completion(&buffer, start_marker.as_bytes(), end_marker.as_bytes())
        {
            let raw_output = &buffer[output_start..output_end];
            let truncated = raw_output.len() > max_bytes;
            let output =
                String::from_utf8_lossy(&raw_output[..raw_output.len().min(max_bytes)]).to_string();
            session.close_terminal(terminal_id);
            return Ok(Json(json!({
                "ok": true,
                "terminalId": terminal_id.to_string(),
                "output": output,
                "exitCode": exit_code,
                "timedOut": false,
                "truncated": truncated,
            })));
        }

        if let Some(exit_code) = remote_closed {
            let output =
                String::from_utf8_lossy(&buffer[..buffer.len().min(max_bytes)]).to_string();
            return Ok(Json(json!({
                "ok": true,
                "terminalId": terminal_id.to_string(),
                "output": output,
                "exitCode": exit_code,
                "timedOut": false,
                "truncated": buffer.len() > max_bytes,
                "framingComplete": false,
            })));
        }

        if Instant::now() >= deadline {
            session.close_terminal(terminal_id);
            let output =
                String::from_utf8_lossy(&buffer[..buffer.len().min(max_bytes)]).to_string();
            return Ok(Json(json!({
                "ok": true,
                "terminalId": terminal_id.to_string(),
                "output": output,
                "exitCode": Value::Null,
                "timedOut": true,
                "truncated": buffer.len() > max_bytes,
            })));
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn terminal_open(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    with_connection_mut(state, request, |connection| {
        require_capability(connection, "terminal")?;
        let session = connection.session().cloned().ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            )
        })?;
        let terminal_id = connection.allocate_terminal_id();
        let rows = request.rows.unwrap_or(24).clamp(1, 500);
        let cols = request.cols.unwrap_or(80).clamp(1, 500);
        session.open_terminal(terminal_id, rows, cols);
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
    if text.len() > 256 * 1024 {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "terminal_input_too_large",
            "terminal write is limited to 256 KiB",
        ));
    }
    with_connection_mut(state, request, |connection| {
        let session = connection.session().cloned().ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            )
        })?;
        session.write_terminal(terminal_id, text);
        Ok(Json(json!({
            "ok": true,
            "terminalId": terminal_id.to_string(),
        })))
    })
}

fn terminal_read(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    with_connection_mut(state, request, |connection| {
        if connection.session().is_none() {
            return Err(api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            ));
        }
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
    let rows = request
        .rows
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "rows must be between 1 and 500",
            )
        })?;
    let cols = request
        .cols
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "cols must be between 1 and 500",
            )
        })?;
    with_connection_mut(state, request, |connection| {
        let session = connection.session().cloned().ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            )
        })?;
        session.resize_terminal(terminal_id, rows, cols);
        Ok(Json(json!({
            "ok": true,
            "terminalId": terminal_id.to_string(),
            "rows": rows,
            "cols": cols,
        })))
    })
}

fn terminal_close(state: &BridgeState, request: &ActionRequest) -> ApiResult {
    let terminal_id = parse_terminal_id(&request.terminal_id)?;
    with_connection_mut(state, request, |connection| {
        let session = connection.session().cloned().ok_or_else(|| {
            api_error(
                StatusCode::CONFLICT,
                "connection_not_ready",
                "connection runtime is not active",
            )
        })?;
        session.close_terminal(terminal_id);
        connection.pending.remove(&terminal_id);
        Ok(Json(json!({
            "ok": true,
            "terminalId": terminal_id.to_string(),
            "status": "closing",
        })))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_posix_and_windows_remote_file_paths() {
        assert_eq!(
            split_remote_file_path("/var/log/app.log", "Linux").unwrap(),
            ("/var/log".to_owned(), "app.log".to_owned())
        );
        assert_eq!(
            split_remote_file_path("/app.log", "Linux").unwrap(),
            ("/".to_owned(), "app.log".to_owned())
        );
        assert_eq!(
            split_remote_file_path(r"C:\Users\me\note.txt", "Windows").unwrap(),
            (r"C:\Users\me".to_owned(), "note.txt".to_owned())
        );
        assert_eq!(
            split_remote_file_path(r"C:\note.txt", "Windows").unwrap(),
            (r"C:\".to_owned(), "note.txt".to_owned())
        );
    }

    #[test]
    fn rejects_remote_directory_as_file_path() {
        assert!(split_remote_file_path("/", "Linux").is_err());
        assert!(split_remote_file_path(r"C:\", "Windows").is_err());
    }

    #[test]
    fn parses_terminal_exec_completion() {
        let data = b"noise\r\nMARK_START\r\nhello\r\nMARK_END:7\r\n";
        let (start, end, code) = parse_exec_completion(data, b"MARK_START", b"MARK_END").unwrap();
        assert_eq!(&data[start..end], b"hello");
        assert_eq!(code, 7);
    }

    #[test]
    fn framed_command_keeps_marker_split_from_user_command() {
        let marker = "__RDB_abcdef012345";
        let posix = exec_framed_command("printf test", "Linux", marker);
        let windows = exec_framed_command("Write-Output test", "Windows", marker);
        assert!(!posix.contains(&format!("'{marker}'")));
        assert!(!windows.contains(&format!("'{marker}'")));
        assert!(posix.contains("_START"));
        assert!(windows.contains("_END:"));
    }

    #[test]
    fn rendezvous_target_adds_default_port() {
        assert_eq!(
            rendezvous_target("example.test").unwrap(),
            "example.test:21116"
        );
        assert_eq!(
            rendezvous_target("example.test:22116").unwrap(),
            "example.test:22116"
        );
        assert_eq!(rendezvous_target("127.0.0.1").unwrap(), "127.0.0.1:21116");
    }

    #[test]
    fn relay_target_adds_default_port() {
        assert_eq!(
            relay_target("relay.example.test").unwrap(),
            "relay.example.test:21117"
        );
        assert_eq!(
            relay_target("relay.example.test:22117").unwrap(),
            "relay.example.test:22117"
        );
        assert_eq!(relay_target("127.0.0.1").unwrap(), "127.0.0.1:21117");
    }

    #[test]
    fn encodes_tiny_frame_to_supported_formats() {
        let frame = HeadlessFrame {
            display: 0,
            width: 1,
            height: 1,
            format: "abgr".to_owned(),
            align: 1,
            data: vec![10, 20, 30, 255],
        };
        for format in ["png", "jpeg", "webp"] {
            let (mime, bytes) = encode_frame(&frame, format, 80).unwrap();
            assert!(mime.starts_with("image/"));
            assert!(!bytes.is_empty());
        }
    }
}

#[tokio::main]
async fn main() {
    let (servers, devices) = match load_bridge_config() {
        Ok(config) => config,
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
        servers: Arc::new(servers),
        devices: Arc::new(devices),
        connections: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/action", post(action))
        .route("/v1/credential", post(credential_submit))
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