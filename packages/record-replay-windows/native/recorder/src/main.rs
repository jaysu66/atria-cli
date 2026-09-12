use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use uiautomation::types::Point;
use uiautomation::UIAutomation;
use uuid::Uuid;
use windows::core::PWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyNameTextW, MapVirtualKeyW, MAP_VIRTUAL_KEY_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW,
    GetSystemMetrics as GetUiSystemMetrics, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN,
};

static ACTIVE: OnceLock<Arc<Mutex<Option<RecordingState>>>> = OnceLock::new();

fn active() -> &'static Arc<Mutex<Option<RecordingState>>> {
    ACTIVE.get_or_init(|| Arc::new(Mutex::new(None)))
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    session_root: PathBuf,
    #[serde(default = "default_max_duration")]
    max_duration_seconds: u64,
    #[serde(default = "default_capture_policy")]
    capture_policy: String,
    #[serde(default = "default_true")]
    install_skill_on_stop: bool,
    #[serde(default = "default_true")]
    redact_text: bool,
    #[serde(default)]
    exclude_apps: Vec<String>,
}

fn default_max_duration() -> u64 {
    1800
}

fn default_capture_policy() -> String {
    "key_events".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug)]
struct RecordingState {
    session_id: String,
    session_dir: PathBuf,
    events_path: PathBuf,
    metadata_path: PathBuf,
    suppressed_events_path: PathBuf,
    captures_dir: PathBuf,
    max_duration_seconds: u64,
    capture_policy: String,
    install_skill_on_stop: bool,
    redact_text: bool,
    exclude_apps: Vec<String>,
    started_at: DateTime<Utc>,
    started_instant: Instant,
    event_count: u64,
    suppressed_count: u64,
    last_event_at: Option<DateTime<Utc>>,
    events_file: File,
    suppressed_file: File,
    hook_thread_id: Option<u32>,
    hook_thread: Option<JoinHandle<()>>,
    stop_reason: Option<String>,
}

impl RecordingState {
    fn public_status(&self) -> Value {
        json!({
            "isRecording": true,
            "sessionID": self.session_id,
            "sessionDirectoryPath": self.session_dir,
            "eventsPath": self.events_path,
            "metadataPath": self.metadata_path,
            "suppressedEventsPath": self.suppressed_events_path,
            "capturesDirectoryPath": self.captures_dir,
            "maxDurationSeconds": self.max_duration_seconds,
            "capturePolicy": self.capture_policy,
            "installSkillOnStop": self.install_skill_on_stop,
            "redactText": self.redact_text,
            "eventCount": self.event_count,
            "suppressedEventCount": self.suppressed_count,
            "lastEventAt": self.last_event_at.map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true)),
            "startedAt": self.started_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--stdio") {
        println!("record-replay-windows native recorder. Run with --stdio.");
        return Ok(());
    }

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: RpcRequest = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                writeln!(
                    io::stdout(),
                    "{}",
                    serde_json::to_string(&RpcResponse {
                        id: "parse-error",
                        ok: false,
                        result: None,
                        error: Some(error.to_string()),
                    })?
                )?;
                io::stdout().flush()?;
                continue;
            }
        };
        let response = match handle_request(&request) {
            Ok(result) => RpcResponse {
                id: &request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => RpcResponse {
                id: &request.id,
                ok: false,
                result: None,
                error: Some(format!("{error:#}")),
            },
        };
        writeln!(io::stdout(), "{}", serde_json::to_string(&response)?)?;
        io::stdout().flush()?;
    }
    Ok(())
}

fn handle_request(request: &RpcRequest) -> Result<Value> {
    match request.method.as_str() {
        "start" => start_recording(serde_json::from_value(request.params.clone())?),
        "status" => status_recording(),
        "stop" => stop_recording("tool_stopped"),
        other => Err(anyhow!("unknown method: {other}")),
    }
}

fn start_recording(params: StartParams) -> Result<Value> {
    let mut guard = active().lock().unwrap();
    if let Some(state) = guard.as_ref() {
        return Ok(state.public_status());
    }

    fs::create_dir_all(&params.session_root)?;
    let session_id = format!(
        "{}-{}",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().to_string()[..8]
    );
    let session_dir = params.session_root.join(&session_id);
    let captures_dir = session_dir.join("captures");
    fs::create_dir_all(&captures_dir)?;

    let events_path = session_dir.join("events.jsonl");
    let metadata_path = session_dir.join("metadata.json");
    let suppressed_events_path = session_dir.join("suppressed_events.jsonl");
    let events_file = OpenOptions::new().create(true).append(true).open(&events_path)?;
    let suppressed_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&suppressed_events_path)?;

    let state = RecordingState {
        session_id,
        session_dir,
        events_path,
        metadata_path,
        suppressed_events_path,
        captures_dir,
        max_duration_seconds: params.max_duration_seconds,
        capture_policy: params.capture_policy,
        install_skill_on_stop: params.install_skill_on_stop,
        redact_text: params.redact_text,
        exclude_apps: params.exclude_apps.into_iter().map(|s| s.to_lowercase()).collect(),
        started_at: Utc::now(),
        started_instant: Instant::now(),
        event_count: 0,
        suppressed_count: 0,
        last_event_at: None,
        events_file,
        suppressed_file,
        hook_thread_id: None,
        hook_thread: None,
        stop_reason: None,
    };
    write_metadata(&state, false)?;
    *guard = Some(state);

    let handle = thread::spawn(|| unsafe {
        hook_thread_main();
    });
    thread::sleep(Duration::from_millis(200));
    let state = guard.as_mut().expect("recording state should exist after start");
    state.hook_thread = Some(handle);
    let watchdog_session_id = state.session_id.clone();
    let watchdog_duration = state.max_duration_seconds;
    let result = state.public_status();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(watchdog_duration));
        let _ = stop_recording_if_session(&watchdog_session_id, "max_duration_reached");
    });
    Ok(result)
}

fn status_recording() -> Result<Value> {
    let guard = active().lock().unwrap();
    if let Some(state) = guard.as_ref() {
        Ok(state.public_status())
    } else {
        Ok(json!({
            "isRecording": false,
            "maxDurationSeconds": default_max_duration(),
        }))
    }
}

fn stop_recording_if_session(session_id: &str, reason: &str) -> Result<Value> {
    let should_stop = {
        let guard = active().lock().unwrap();
        guard
            .as_ref()
            .map(|state| state.session_id == session_id)
            .unwrap_or(false)
    };
    if should_stop {
        stop_recording(reason)
    } else {
        Ok(json!({
            "isRecording": false,
            "endReason": "not_active",
            "maxDurationSeconds": default_max_duration(),
        }))
    }
}

fn stop_recording(reason: &str) -> Result<Value> {
    let mut state = {
        let mut guard = active().lock().unwrap();
        guard.take()
    };
    let Some(mut state) = state.take() else {
        return Ok(json!({
            "isRecording": false,
            "endReason": "no_active_recording",
            "maxDurationSeconds": default_max_duration(),
        }));
    };

    state.stop_reason = Some(reason.to_string());
    if let Some(thread_id) = state.hook_thread_id {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    if let Some(handle) = state.hook_thread.take() {
        let _ = handle.join();
    }
    write_metadata(&state, true)?;
    state.events_file.flush()?;
    state.suppressed_file.flush()?;

    Ok(json!({
        "isRecording": false,
        "sessionID": state.session_id,
        "sessionDirectoryPath": state.session_dir,
        "eventsPath": state.events_path,
        "metadataPath": state.metadata_path,
        "suppressedEventsPath": state.suppressed_events_path,
        "capturesDirectoryPath": state.captures_dir,
        "eventCount": state.event_count,
        "suppressedEventCount": state.suppressed_count,
        "lastEventAt": state.last_event_at.map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true)),
        "endReason": reason,
        "installSkillOnStop": state.install_skill_on_stop,
    }))
}

fn write_metadata(state: &RecordingState, stopped: bool) -> Result<()> {
    let metadata = json!({
        "sessionID": state.session_id,
        "startedAt": state.started_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "stopped": stopped,
        "endReason": state.stop_reason,
        "maxDurationSeconds": state.max_duration_seconds,
        "capturePolicy": state.capture_policy,
        "redactText": state.redact_text,
        "installSkillOnStop": state.install_skill_on_stop,
        "eventCount": state.event_count,
        "suppressedEventCount": state.suppressed_count,
        "eventsPath": state.events_path,
        "suppressedEventsPath": state.suppressed_events_path,
        "capturesDirectoryPath": state.captures_dir,
        "schema": {
            "eventID": "uuid",
            "type": "mouse.click | keyboard.key | window.changed | recorder.notice",
            "application": "foreground process context",
            "window": "foreground window context",
            "target.uia": "best-effort Microsoft UI Automation target",
            "capturePath": "optional key-event PNG screenshot path"
        }
    });
    fs::write(&state.metadata_path, serde_json::to_string_pretty(&metadata)?)?;
    Ok(())
}

unsafe fn hook_thread_main() {
    let thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
    if let Ok(mut guard) = active().lock() {
        if let Some(state) = guard.as_mut() {
            state.hook_thread_id = Some(thread_id);
        }
    }

    let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0);
    let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0);
    record_notice("recorder.notice", json!({
        "message": "hooks_installed",
        "mouseHook": mouse_hook.is_ok(),
        "keyboardHook": keyboard_hook.is_ok(),
    }));

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let timed_out = {
            let guard = active().lock().unwrap();
            guard
                .as_ref()
                .map(|state| state.started_instant.elapsed().as_secs() >= state.max_duration_seconds)
                .unwrap_or(true)
        };
        if timed_out {
            break;
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if let Ok(hook) = mouse_hook {
        let _ = UnhookWindowsHookEx(hook);
    }
    if let Ok(hook) = keyboard_hook {
        let _ = UnhookWindowsHookEx(hook);
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if matches!(
            message,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL
        ) {
            let info = *(lparam.0 as *const MSLLHOOKSTRUCT);
            let event_type = match message {
                WM_LBUTTONDOWN => "mouse.click",
                WM_RBUTTONDOWN => "mouse.context_menu",
                WM_MBUTTONDOWN => "mouse.middle_click",
                WM_MOUSEWHEEL => "mouse.wheel",
                _ => "mouse.event",
            };
            record_input_event(event_type, Some(info.pt), json!({
                "button": match message {
                    WM_LBUTTONDOWN => "left",
                    WM_RBUTTONDOWN => "right",
                    WM_MBUTTONDOWN => "middle",
                    WM_MOUSEWHEEL => "wheel",
                    _ => "unknown"
                },
                "x": info.pt.x,
                "y": info.pt.y,
            }));
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN) {
            let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let key_name = key_name(info.vkCode);
            let redacted = should_redact_key(&key_name);
            if redacted {
                record_suppressed_event("keyboard.key", json!({
                    "reason": "sensitive_or_text_input_redacted",
                    "vkCode": info.vkCode,
                    "keyName": key_name,
                }));
            } else {
                record_input_event("keyboard.key", None, json!({
                    "vkCode": info.vkCode,
                    "keyName": key_name,
                }));
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn should_redact_key(key_name: &str) -> bool {
    let key = key_name.to_lowercase();
    key.len() == 1 || key.contains("password") || key.contains("otp") || key.contains("token")
}

fn key_name(vk_code: u32) -> String {
    unsafe {
        let scan_code = MapVirtualKeyW(vk_code, MAP_VIRTUAL_KEY_TYPE(0));
        let lparam = (scan_code << 16) as i32;
        let mut buffer = [0u16; 64];
        let len = GetKeyNameTextW(lparam, &mut buffer);
        if len > 0 {
            String::from_utf16_lossy(&buffer[..len as usize])
        } else {
            format!("VK_{vk_code}")
        }
    }
}

fn record_notice(event_type: &str, details: Value) {
    record_event(event_type, None, details, false);
}

fn record_input_event(event_type: &str, point: Option<POINT>, input: Value) {
    record_event(event_type, point, input, should_capture_event(event_type));
}

fn should_capture_event(event_type: &str) -> bool {
    event_type == "keyboard.key"
}

fn record_event(event_type: &str, point: Option<POINT>, input: Value, capture: bool) {
    let Some((session_id, exclude_apps, capture_policy, captures_dir)) = ({
        let guard = active().lock().unwrap();
        guard.as_ref().map(|state| {
            (
                state.session_id.clone(),
                state.exclude_apps.clone(),
                state.capture_policy.clone(),
                state.captures_dir.clone(),
            )
        })
    }) else {
        return;
    };

    let window = foreground_window_context();
    let app_name = window
        .get("processName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if exclude_apps.iter().any(|excluded| app_name.contains(excluded)) {
        let suppressed = json!({
            "eventID": Uuid::new_v4(),
            "type": event_type,
            "timestamp": now_string(),
            "reason": "excluded_app",
            "application": window,
        });
        let mut guard = active().lock().unwrap();
        let Some(state) = guard.as_mut() else {
            return;
        };
        if state.session_id != session_id {
            return;
        }
        state.suppressed_count += 1;
        let _ = writeln!(
            state.suppressed_file,
            "{}",
            suppressed
        );
        return;
    }

    let event_id = Uuid::new_v4().to_string();
    let capture_path = if capture && capture_policy == "key_events" {
        capture_screen(&captures_dir, &event_id).ok()
    } else {
        None
    };
    let uia = point.and_then(|pt| uia_target(pt).ok());
    let now = Utc::now();
    let event = json!({
        "eventID": event_id,
        "type": event_type,
        "timestamp": now.to_rfc3339_opts(SecondsFormat::Millis, true),
        "application": window,
        "window": {
            "title": window.get("windowTitle").cloned().unwrap_or(Value::Null),
            "hwnd": window.get("hwnd").cloned().unwrap_or(Value::Null),
        },
        "monitor": {
            "virtualScreen": virtual_screen_rect(),
        },
        "dpi": {
            "windowDpi": window.get("dpi").cloned().unwrap_or(Value::Null),
        },
        "target": {
            "uia": uia,
        },
        "input": input,
        "capturePath": capture_path,
        "diffFromPrevious": Value::Null,
        "redaction": {
            "redacted": false,
        }
    });
    let mut guard = active().lock().unwrap();
    let Some(state) = guard.as_mut() else {
        return;
    };
    if state.session_id != session_id {
        return;
    }
    if writeln!(state.events_file, "{}", event).is_ok() {
        state.event_count += 1;
        state.last_event_at = Some(now);
    }
}

fn record_suppressed_event(event_type: &str, details: Value) {
    let mut guard = active().lock().unwrap();
    let Some(state) = guard.as_mut() else {
        return;
    };
    state.suppressed_count += 1;
    let _ = writeln!(
        state.suppressed_file,
        "{}",
        json!({
            "eventID": Uuid::new_v4(),
            "type": event_type,
            "timestamp": now_string(),
            "details": details,
            "redaction": {
                "redacted": true,
            }
        })
    );
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn foreground_window_context() -> Value {
    unsafe {
        let hwnd = GetForegroundWindow();
        let title = window_title(hwnd);
        let mut pid = 0u32;
        let thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let exe = process_path(pid).unwrap_or_default();
        let process_name = Path::new(&exe)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let dpi = if !hwnd.0.is_null() { GetDpiForWindow(hwnd) } else { 0 };
        json!({
            "hwnd": hwnd.0 as isize,
            "threadId": thread_id,
            "pid": pid,
            "processName": process_name,
            "processPath": exe,
            "windowTitle": title,
            "dpi": dpi,
        })
    }
}

unsafe fn window_title(hwnd: HWND) -> String {
    if hwnd.0.is_null() {
        return String::new();
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..copied as usize])
}

unsafe fn process_path(pid: u32) -> Result<String> {
    if pid == 0 {
        return Ok(String::new());
    }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(buffer.as_mut_ptr()),
        &mut len,
    )?;
    Ok(OsString::from_wide(&buffer[..len as usize])
        .to_string_lossy()
        .to_string())
}

fn virtual_screen_rect() -> Value {
    unsafe {
        json!({
            "x": GetUiSystemMetrics(SM_XVIRTUALSCREEN),
            "y": GetUiSystemMetrics(SM_YVIRTUALSCREEN),
            "width": GetUiSystemMetrics(SM_CXVIRTUALSCREEN),
            "height": GetUiSystemMetrics(SM_CYVIRTUALSCREEN),
        })
    }
}

fn uia_target(pt: POINT) -> Result<Value> {
    let automation = UIAutomation::new()?;
    let element = automation.element_from_point(Point::new(pt.x, pt.y))?;
    let rect = element.get_bounding_rectangle().ok();
    Ok(json!({
        "source": "uia",
        "name": element.get_name().unwrap_or_default(),
        "automationId": element.get_automation_id().unwrap_or_default(),
        "className": element.get_classname().unwrap_or_default(),
        "controlType": element.get_control_type().map(|ct| format!("{ct:?}")).unwrap_or_default(),
        "boundingRect": rect.map(|r| json!([r.get_left(), r.get_top(), r.get_right(), r.get_bottom()])),
    }))
}

fn capture_screen(captures_dir: &Path, event_id: &str) -> Result<String> {
    fs::create_dir_all(captures_dir)?;
    let file_path = captures_dir.join(format!("{event_id}.png"));
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() {
            return Err(anyhow!("GetDC failed"));
        }
        let width = GetUiSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetUiSystemMetrics(SM_CYVIRTUALSCREEN);
        let left = GetUiSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetUiSystemMetrics(SM_YVIRTUALSCREEN);
        if width <= 0 || height <= 0 {
            let _ = ReleaseDC(None, screen_dc);
            return Err(anyhow!("invalid virtual screen dimensions"));
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        let old_obj = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
        let _ = BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), left, top, SRCCOPY);

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(
            mem_dc,
            HBITMAP(bitmap.0),
            0,
            height as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
        if rows == 0 {
            return Err(anyhow!("GetDIBits failed"));
        }
        for chunk in buf.chunks_exact_mut(4) {
            chunk.swap(0, 2);
            chunk[3] = 255;
        }
        let image: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_raw(width as u32, height as u32, buf)
                .context("failed to create screenshot image buffer")?;
        image.save(&file_path)?;
    }
    Ok(file_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_single_character_keys() {
        assert!(should_redact_key("A"));
        assert!(!should_redact_key("Enter"));
    }

    #[test]
    fn only_keyboard_events_trigger_capture_policy() {
        assert!(should_capture_event("keyboard.key"));
        assert!(!should_capture_event("mouse.click"));
        assert!(!should_capture_event("recorder.notice"));
    }

    #[test]
    fn virtual_screen_shape_is_available() {
        let rect = virtual_screen_rect();
        assert!(rect.get("width").is_some());
    }
}
