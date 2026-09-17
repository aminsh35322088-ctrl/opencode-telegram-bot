//! Machine-oriented RustDesk controller primitives for headless integrations.
//!
//! This module intentionally reuses the same generic `Session<T>` core as the
//! desktop clients while replacing UI callbacks with bounded in-memory state.
//! Secret material stays at the controller boundary; callers should expose only
//! opaque connection/device identifiers to higher-level model-facing APIs.

use std::{
    collections::{HashMap, VecDeque},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
};

use base::message_proto::*;
use hbb_common::rendezvous_proto::ConnType;

use crate::{
    client::QualityStatus,
    ui_session_interface::{InvokeUiSession, Session},
};

const MAX_TERMINAL_EVENTS: usize = 1024;
const MAX_MESSAGES: usize = 128;

/// Normalized terminal events for machine clients. Protocol-specific
/// compression is removed before `Data` reaches the bridge layer.
#[derive(Clone, Debug)]
pub enum HeadlessTerminalEvent {
    Opened {
        terminal_id: i32,
        success: bool,
        message: String,
        pid: u32,
        service_id: String,
        persistent_sessions: Vec<i32>,
        replay_terminal_output: bool,
    },
    Data {
        terminal_id: i32,
        data: Vec<u8>,
    },
    Closed {
        terminal_id: i32,
        exit_code: i32,
    },
    Error {
        terminal_id: i32,
        message: String,
    },
}

/// Per-connection rendezvous override. The server key is intentionally kept in
/// the controller process rather than returned through model-facing metadata.
#[derive(Clone, Debug)]
pub struct HeadlessServerConfig {
    pub id_server: String,
    pub server_key: String,
}

#[derive(Clone, Default)]
pub struct HeadlessHandler {
    connected: Arc<AtomicBool>,
    peer_info: Arc<RwLock<Option<PeerInfo>>>,
    permissions: Arc<RwLock<HashMap<String, bool>>>,
    terminal_events: Arc<Mutex<VecDeque<HeadlessTerminalEvent>>>,
    messages: Arc<Mutex<VecDeque<String>>>,
    last_error: Arc<RwLock<Option<String>>>,
}

impl HeadlessHandler {
    fn push_message(&self, message: String) {
        let mut messages = self.messages.lock().unwrap();
        while messages.len() >= MAX_MESSAGES {
            messages.pop_front();
        }
        messages.push_back(message);
    }

    fn push_terminal_event(&self, event: HeadlessTerminalEvent) {
        let mut events = self.terminal_events.lock().unwrap();
        while events.len() >= MAX_TERMINAL_EVENTS {
            events.pop_front();
        }
        events.push_back(event);
    }

    fn set_last_error(&self, message: String) {
        self.connected.store(false, Ordering::Relaxed);
        *self.last_error.write().unwrap() = Some(message);
    }

    fn mark_disconnected(&self) {
        self.connected.store(false, Ordering::Relaxed);
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.read().unwrap().clone()
    }

    pub fn peer_info(&self) -> Option<PeerInfo> {
        self.peer_info.read().unwrap().clone()
    }

    pub fn permissions(&self) -> HashMap<String, bool> {
        self.permissions.read().unwrap().clone()
    }

    pub fn drain_terminal_events(&self) -> Vec<HeadlessTerminalEvent> {
        self.terminal_events.lock().unwrap().drain(..).collect()
    }

    pub fn drain_messages(&self) -> Vec<String> {
        self.messages.lock().unwrap().drain(..).collect()
    }
}

impl InvokeUiSession for HeadlessHandler {
    fn set_cursor_data(&self, _cd: CursorData) {}
    fn set_cursor_id(&self, _id: String) {}
    fn set_cursor_position(&self, _cp: CursorPosition) {}
    fn set_display(&self, _x: i32, _y: i32, _w: i32, _h: i32, _cursor_embedded: bool, _scale: f64) {
    }
    fn switch_display(&self, _display: &SwitchDisplay) {}

    fn set_peer_info(&self, peer_info: &PeerInfo) {
        *self.peer_info.write().unwrap() = Some(peer_info.clone());
    }

    fn set_displays(&self, _displays: &Vec<DisplayInfo>) {}
    fn set_platform_additions(&self, _data: &str) {}

    fn on_connected(&self, _conn_type: ConnType) {
        *self.last_error.write().unwrap() = None;
        self.connected.store(true, Ordering::Relaxed);
    }

    fn update_privacy_mode(&self) {}

    fn set_permission(&self, name: &str, value: bool) {
        self.permissions
            .write()
            .unwrap()
            .insert(name.to_owned(), value);
    }

    fn close_success(&self) {
        self.mark_disconnected();
    }

    fn update_quality_status(&self, _qs: QualityStatus) {}
    fn set_connection_type(&self, _is_secured: bool, _direct: bool, _stream_type: &str) {}
    fn set_fingerprint(&self, _fingerprint: String) {}

    fn job_error(&self, id: i32, err: String, file_num: i32) {
        self.push_message(format!("file job {id}/{file_num} failed: {err}"));
    }

    fn job_done(&self, _id: i32, _file_num: i32) {}
    fn clear_all_jobs(&self) {}
    fn new_message(&self, msg: String) {
        self.push_message(msg);
    }
    fn update_transfer_list(&self) {}
    fn load_last_job(&self, _cnt: i32, _job_json: &str, _auto_start: bool) {}
    fn update_folder_files(
        &self,
        _id: i32,
        _entries: &Vec<FileEntry>,
        _path: String,
        _is_local: bool,
        _only_count: bool,
    ) {
    }
    fn confirm_delete_files(&self, _id: i32, _i: i32, _name: String) {}
    fn override_file_confirm(
        &self,
        _id: i32,
        _file_num: i32,
        _to: String,
        _is_upload: bool,
        _is_identical: bool,
    ) {
    }
    fn update_block_input_state(&self, _on: bool) {}
    fn job_progress(&self, _id: i32, _file_num: i32, _speed: f64, _finished_size: f64) {}
    fn adapt_size(&self) {}
    fn on_rgba(&self, _display: usize, _rgba: &mut scrap::ImageRgb) {}

    fn msgbox(&self, msgtype: &str, title: &str, text: &str, _link: &str, _retry: bool) {
        let message = format!("{msgtype}: {title}: {text}");
        if msgtype == "error" {
            self.set_last_error(message.clone());
        }
        self.push_message(message);
    }

    fn cancel_msgbox(&self, _tag: &str) {}
    fn switch_back(&self, _id: &str) {}
    fn portable_service_running(&self, _running: bool) {}
    fn on_voice_call_started(&self) {}
    fn on_voice_call_closed(&self, _reason: &str) {}
    fn on_voice_call_waiting(&self) {}
    fn on_voice_call_incoming(&self) {}
    fn get_rgba(&self, _display: usize) -> *const u8 {
        ptr::null()
    }
    fn next_rgba(&self, _display: usize) {}
    fn set_multiple_windows_session(&self, _sessions: Vec<WindowsSession>) {}
    fn set_current_display(&self, _disp_idx: i32) {}
    fn update_record_status(&self, _start: bool) {}
    fn printer_request(&self, _id: i32, _path: String) {}
    fn handle_screenshot_resp(&self, _sid: String, _msg: String) {}

    fn handle_terminal_response(&self, response: TerminalResponse) {
        use base::message_proto::terminal_response::Union;

        let event = match response.union {
            Some(Union::Opened(opened)) => HeadlessTerminalEvent::Opened {
                terminal_id: opened.terminal_id,
                success: opened.success,
                message: opened.message,
                pid: opened.pid,
                service_id: opened.service_id,
                persistent_sessions: opened.persistent_sessions,
                replay_terminal_output: opened.replay_terminal_output,
            },
            Some(Union::Data(data)) => HeadlessTerminalEvent::Data {
                terminal_id: data.terminal_id,
                data: if data.compressed {
                    hbb_common::compress::decompress(&data.data)
                } else {
                    data.data.to_vec()
                },
            },
            Some(Union::Closed(closed)) => HeadlessTerminalEvent::Closed {
                terminal_id: closed.terminal_id,
                exit_code: closed.exit_code,
            },
            Some(Union::Error(error)) => HeadlessTerminalEvent::Error {
                terminal_id: error.terminal_id,
                message: error.message,
            },
            None => return,
            Some(_) => return,
        };
        self.push_terminal_event(event);
    }
}

#[derive(Clone)]
pub struct HeadlessSession {
    inner: Session<HeadlessHandler>,
}

impl HeadlessSession {
    pub fn terminal(peer_id: String, password: String, force_relay: bool) -> Self {
        Self::terminal_with_server(peer_id, password, force_relay, None)
    }

    pub fn terminal_with_server(
        peer_id: String,
        password: String,
        force_relay: bool,
        server: Option<HeadlessServerConfig>,
    ) -> Self {
        let session: Session<HeadlessHandler> = Session {
            password,
            server_keyboard_enabled: Arc::new(RwLock::new(true)),
            server_file_transfer_enabled: Arc::new(RwLock::new(true)),
            server_clipboard_enabled: Arc::new(RwLock::new(true)),
            ..Default::default()
        };
        {
            let mut lc = session.lc.write().unwrap();
            lc.initialize(
                peer_id.clone(),
                ConnType::TERMINAL,
                None,
                force_relay,
                None,
                None,
                None,
            );
            if let Some(server) = server {
                lc.other_server = Some((peer_id, server.id_server, server.server_key));
            }
        }
        Self { inner: session }
    }

    pub fn start(&self) {
        self.inner.reconnect(false);
    }

    pub fn close(&self) {
        self.inner.close();
        self.inner.ui_handler.mark_disconnected();
    }

    pub fn handler(&self) -> HeadlessHandler {
        self.inner.ui_handler.clone()
    }

    pub fn open_terminal(&self, terminal_id: i32, rows: u32, cols: u32) {
        self.inner.open_terminal(terminal_id, rows, cols);
    }

    pub fn write_terminal(&self, terminal_id: i32, data: String) {
        self.inner.send_terminal_input(terminal_id, data);
    }

    pub fn resize_terminal(&self, terminal_id: i32, rows: u32, cols: u32) {
        self.inner.resize_terminal(terminal_id, rows, cols);
    }

    pub fn close_terminal(&self, terminal_id: i32) {
        self.inner.close_terminal(terminal_id);
    }
}
