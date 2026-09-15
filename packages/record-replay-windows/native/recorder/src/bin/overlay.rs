use anyhow::{anyhow, Result};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::io::{self, BufRead, Write};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, Ellipse, EndPaint, FillRect,
    GetStockObject, Rectangle, RedrawWindow, SelectObject, SetBkMode, SetTextColor, HBRUSH,
    HGDIOBJ, NULL_BRUSH, PAINTSTRUCT, PS_SOLID, RDW_ERASE, RDW_INVALIDATE, RDW_UPDATENOW,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetSystemMetrics, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, CS_HREDRAW,
    CS_VREDRAW, HTTRANSPARENT, HWND_TOPMOST, IDC_ARROW, LWA_COLORKEY, MSG, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WM_APP, WM_DESTROY, WM_ERASEBKGND,
    WM_HOTKEY, WM_NCHITTEST, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

const WM_OVERLAY_INPUT: u32 = WM_APP + 41;
const TIMER_HIDE: usize = 1;
const HOTKEY_PAUSE: i32 = 4101;
const HOTKEY_STOP: i32 = 4102;

static QUEUE: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();
static STATE: OnceLock<Mutex<OverlayState>> = OnceLock::new();
static STDOUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct OverlayState {
    event: Option<Value>,
    received_at: Option<Instant>,
    virtual_left: i32,
    virtual_top: i32,
    visible: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            event: None,
            received_at: None,
            virtual_left: 0,
            virtual_top: 0,
            visible: false,
        }
    }
}

fn emit(message: Value) {
    let _guard = STDOUT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{message}");
    let _ = stdout.flush();
}

fn color_for(value: &str) -> COLORREF {
    let hash = value.bytes().fold(2166136261u32, |current, byte| {
        (current ^ byte as u32).wrapping_mul(16777619)
    });
    let red = 80 + ((hash >> 16) & 0x7f);
    let green = 100 + ((hash >> 8) & 0x6f);
    let blue = 140 + (hash & 0x6f);
    COLORREF(red | (green << 8) | (blue << 16))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

fn event_point(event: &Value) -> Option<(i32, i32)> {
    let target = event.get("target")?;
    let x = target
        .get("x")
        .or_else(|| target.get("toX"))
        .and_then(Value::as_i64)? as i32;
    let y = target
        .get("y")
        .or_else(|| target.get("toY"))
        .and_then(Value::as_i64)? as i32;
    Some((x, y))
}

unsafe fn draw_overlay(hwnd: HWND) {
    let mut paint = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut paint);
    let mut rendered_event = None;
    if let Some(state_lock) = STATE.get() {
        let state = state_lock.lock().unwrap_or_else(|error| error.into_inner());
        let background = CreateSolidBrush(COLORREF(0));
        let _ = FillRect(hdc, &paint.rcPaint, background);
        let _ = DeleteObject(HGDIOBJ(background.0));
        if let Some(event) = state.event.as_ref() {
            let session = event
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("atria");
            let color = color_for(session);
            let pen = CreatePen(PS_SOLID, 4, color);
            let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
            let stock_brush = GetStockObject(NULL_BRUSH);
            let old_brush = SelectObject(hdc, stock_brush);

            if let Some((x, y)) = event_point(event) {
                let local_x = x - state.virtual_left;
                let local_y = y - state.virtual_top;
                let action = event.get("action").and_then(Value::as_str).unwrap_or("");
                let radius = if action == "click" { 28 } else { 20 };
                let _ = Ellipse(
                    hdc,
                    local_x - radius,
                    local_y - radius,
                    local_x + radius,
                    local_y + radius,
                );
                if action == "click" {
                    let _ = Ellipse(
                        hdc,
                        local_x - radius - 10,
                        local_y - radius - 10,
                        local_x + radius + 10,
                        local_y + radius + 10,
                    );
                }
                if let Some(target) = event.get("target") {
                    let from_x = target.get("fromX").and_then(Value::as_i64);
                    let from_y = target.get("fromY").and_then(Value::as_i64);
                    let to_x = target.get("toX").and_then(Value::as_i64);
                    let to_y = target.get("toY").and_then(Value::as_i64);
                    if let (Some(fx), Some(fy), Some(tx), Some(ty)) = (from_x, from_y, to_x, to_y) {
                        let left = fx.min(tx) as i32 - state.virtual_left;
                        let top = fy.min(ty) as i32 - state.virtual_top;
                        let right = fx.max(tx) as i32 - state.virtual_left;
                        let bottom = fy.max(ty) as i32 - state.virtual_top;
                        let _ = Rectangle(hdc, left, top, right, bottom);
                    }
                }
            }

            let _ = SelectObject(hdc, old_pen);
            let _ = SelectObject(hdc, old_brush);
            let _ = DeleteObject(HGDIOBJ(pen.0));

            let action = event
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("action");
            let phase = event
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("running");
            let label = format!("Atria  {action}  {phase}");
            let status_brush = CreateSolidBrush(color);
            let status_rect = RECT {
                left: 24,
                top: 24,
                right: 340,
                bottom: 64,
            };
            let _ = FillRect(hdc, &status_rect, status_brush);
            let _ = DeleteObject(HGDIOBJ(status_brush.0));
            let _ = SetBkMode(hdc, TRANSPARENT);
            let _ = SetTextColor(hdc, COLORREF(0x00ffffff));
            let mut text_rect = RECT {
                left: 38,
                top: 34,
                right: 330,
                bottom: 60,
            };
            let mut text = wide(&label);
            let _ = DrawTextW(hdc, &mut text, &mut text_rect, Default::default());
            rendered_event = Some(json!({
                "type": "rendered",
                "operationId": event.get("operationId").and_then(Value::as_str),
                "sequence": event.get("sequence").and_then(Value::as_u64),
                "eventTimestamp": event.get("timestamp").and_then(Value::as_str),
                "renderedAt": Utc::now().to_rfc3339(),
            }));
        }
    }
    let _ = EndPaint(hwnd, &paint);
    if let Some(message) = rendered_event {
        emit(message);
    }
}

unsafe fn apply_input(hwnd: HWND) {
    let Some(queue_lock) = QUEUE.get() else {
        return;
    };
    loop {
        let message = queue_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pop_front();
        let Some(message) = message else {
            break;
        };
        if message.get("type").and_then(Value::as_str) == Some("command") {
            match message.get("command").and_then(Value::as_str).unwrap_or("") {
                "shutdown" => {
                    let _ = DestroyWindow(hwnd);
                    return;
                }
                "hide" => {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    if let Some(state) = STATE.get() {
                        state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .visible = false;
                    }
                }
                "status" => {
                    emit(json!({ "type": "status", "ready": true, "pid": std::process::id() }))
                }
                _ => {}
            }
            continue;
        }
        let event = message.get("event").cloned().unwrap_or(message);
        if event.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            emit(json!({ "type": "rejected", "code": "EVENT_SCHEMA_UNSUPPORTED" }));
            continue;
        }
        if let Some(state) = STATE.get() {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            state.event = Some(event);
            state.received_at = Some(Instant::now());
            state.visible = true;
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetTimer(Some(hwnd), TIMER_HIDE, 100, None);
        let _ = RedrawWindow(
            Some(hwnd),
            None,
            None,
            RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW,
        );
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_OVERLAY_INPUT => {
            apply_input(hwnd);
            LRESULT(0)
        }
        WM_PAINT => {
            draw_overlay(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            let should_hide = STATE
                .get()
                .and_then(|state| state.lock().ok())
                .and_then(|state| state.received_at)
                .is_some_and(|received| received.elapsed() >= Duration::from_millis(1400));
            if should_hide {
                let _ = KillTimer(Some(hwnd), TIMER_HIDE);
                let _ = ShowWindow(hwnd, SW_HIDE);
                if let Some(state) = STATE.get() {
                    state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .visible = false;
                }
                emit(json!({ "type": "hidden", "timestamp": Utc::now().to_rfc3339() }));
            }
            LRESULT(0)
        }
        WM_HOTKEY => {
            let id = wparam.0 as i32;
            if id == HOTKEY_PAUSE {
                emit(json!({ "type": "control", "command": "toggle_pause" }));
            } else if id == HOTKEY_STOP {
                emit(json!({ "type": "control", "command": "stop" }));
            }
            LRESULT(0)
        }
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_ERASEBKGND => LRESULT(1),
        WM_DESTROY => {
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_PAUSE);
            let _ = UnregisterHotKey(Some(hwnd), HOTKEY_STOP);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|argument| argument == "--stdio") {
        println!("Atria visual overlay. Run with --stdio.");
        return Ok(());
    }
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()));
    STATE.get_or_init(|| Mutex::new(OverlayState::default()));
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let module = GetModuleHandleW(PCWSTR::null())?;
        let instance = HINSTANCE(module.0);
        let class_name = w!("AtriaVisualOverlayV1");
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: HBRUSH::default(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err(anyhow!("RegisterClassW failed"));
        }

        let left = GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 {
            return Err(anyhow!("invalid virtual desktop dimensions"));
        }
        if let Some(state) = STATE.get() {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            state.virtual_left = left;
            state.virtual_top = top;
        }

        let ex_style: WINDOW_EX_STYLE =
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let hwnd = CreateWindowExW(
            ex_style,
            class_name,
            w!("Atria Visual Feedback"),
            WS_POPUP,
            left,
            top,
            width,
            height,
            None,
            None,
            Some(instance),
            None,
        )?;
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_COLORKEY)?;
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            left,
            top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )?;
        let _ = ShowWindow(hwnd, SW_HIDE);
        let pause_hotkey = RegisterHotKey(
            Some(hwnd),
            HOTKEY_PAUSE,
            MOD_CONTROL | MOD_ALT | MOD_SHIFT,
            b'P' as u32,
        )
        .is_ok();
        let stop_hotkey = RegisterHotKey(
            Some(hwnd),
            HOTKEY_STOP,
            MOD_CONTROL | MOD_ALT | MOD_SHIFT,
            b'S' as u32,
        )
        .is_ok();

        let hwnd_value = hwnd.0 as isize;
        thread::spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        if let Some(queue) = QUEUE.get() {
                            queue
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .push_back(message);
                            let target = HWND(hwnd_value as *mut c_void);
                            let _ =
                                PostMessageW(Some(target), WM_OVERLAY_INPUT, WPARAM(0), LPARAM(0));
                        }
                    }
                    Err(_) => emit(json!({ "type": "rejected", "code": "INVALID_JSON" })),
                }
            }
            let target = HWND(hwnd_value as *mut c_void);
            let _ = PostMessageW(Some(target), WM_DESTROY, WPARAM(0), LPARAM(0));
        });

        emit(json!({
            "type": "renderer-ready",
            "schemaVersion": 1,
            "pid": std::process::id(),
            "coordinateSpace": "desktop_physical",
            "virtualDesktop": { "left": left, "top": top, "width": width, "height": height },
            "hotkeys": { "pause": pause_hotkey, "stop": stop_hotkey },
            "timestamp": Utc::now().to_rfc3339(),
        }));

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}
