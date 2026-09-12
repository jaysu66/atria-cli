// actor.rs — record-replay-windows 自有执行引擎(batch-I)。
// recorder.exe 的兄弟二进制:同 JSON-RPC over stdio 协议,负责"手"的部分
// (截屏 / 鼠标键盘注入 / 窗口聚焦 / UIA 查找与触发),替代 OpenAI bundled
// computer-use runtime,使回放不再依赖 Codex 宿主。
// 焦点硬校验:click/type_text/key 支持 expect{processName/titleContains},
// 前台窗口不匹配即拒绝执行(FOCUS_MISMATCH),绝不盲发输入。

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use image::{ImageBuffer, Rgba};
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Write};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use uiautomation::controls::ControlType;
use uiautomation::patterns::{UIInvokePattern, UIValuePattern};
use uiautomation::types::Handle;
use uiautomation::UIAutomation;
use uiautomation::UIElement;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetCursorPos, GetForegroundWindow, GetSystemMetrics,
    GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, GWL_EXSTYLE,
    IsIconic, IsWindowVisible, SetCursorPos, SetForegroundWindow, ShowWindow, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Expect {
    #[serde(default)]
    process_name: Option<String>,
    #[serde(default)]
    title_contains: Option<String>,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--stdio") {
        println!("record-replay-windows native actor. Run with --stdio.");
        return Ok(());
    }
    unsafe {
        // 坐标体系统一为物理像素(与 UIA boundingRect / recorder 事件一致)。
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let (id, outcome) = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => {
                let result = handle_request(&request);
                (request.id, result)
            }
            Err(error) => ("parse-error".to_string(), Err(anyhow!(error.to_string()))),
        };
        let response = match outcome {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": format!("{error:#}") }),
        };
        writeln!(io::stdout(), "{}", serde_json::to_string(&response)?)?;
        io::stdout().flush()?;
    }
    Ok(())
}

fn handle_request(request: &RpcRequest) -> Result<Value> {
    let p = &request.params;
    match request.method.as_str() {
        "screenshot" => screenshot(p),
        "click" => click(p),
        "mouse_move" => mouse_move(p),
        "drag" => drag(p),
        "scroll" => scroll(p),
        "type_text" => type_text(p),
        "key" => key_combo(p),
        "window_list" => window_list(),
        "window_focus" => window_focus(p),
        "uia_find" => uia_find(p),
        "uia_invoke" => uia_invoke(p),
        "ui_snapshot" => ui_snapshot(p),
        "ui_wait_for" => ui_wait_for(p),
        "cursor" => cursor_position(),
        other => Err(anyhow!("unknown method: {other}")),
    }
}

// ---------- 焦点硬校验 ----------

fn foreground_context() -> Value {
    unsafe {
        let hwnd = GetForegroundWindow();
        let title = window_title(hwnd);
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let exe = process_path(pid).unwrap_or_default();
        let process_name = Path::new(&exe)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        json!({
            "hwnd": hwnd.0 as isize,
            "pid": pid,
            "processName": process_name,
            "windowTitle": title,
        })
    }
}

fn expect_matches(expect: &Expect, process_name: &str, title: &str) -> bool {
    if let Some(want) = expect.process_name.as_deref() {
        if !process_name.to_lowercase().contains(&want.to_lowercase()) {
            return false;
        }
    }
    if let Some(want) = expect.title_contains.as_deref() {
        if !title.to_lowercase().contains(&want.to_lowercase()) {
            return false;
        }
    }
    true
}

fn enforce_expect(params: &Value) -> Result<Value> {
    let fg = foreground_context();
    let expect: Option<Expect> = params
        .get("expect")
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()?;
    if let Some(expect) = expect {
        let process_name = fg.get("processName").and_then(Value::as_str).unwrap_or("");
        let title = fg.get("windowTitle").and_then(Value::as_str).unwrap_or("");
        if !expect_matches(&expect, process_name, title) {
            return Err(anyhow!(
                "FOCUS_MISMATCH: foreground is {process_name} \"{title}\", expected {:?}",
                expect
            ));
        }
    }
    Ok(fg)
}

// ---------- screenshot ----------

fn screenshot(params: &Value) -> Result<Value> {
    let output_dir = params
        .get("outputDir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(default_screenshot_dir);
    fs::create_dir_all(&output_dir)?;
    let file_path = output_dir.join(format!(
        "actor-{}.png",
        Utc::now().format("%Y%m%d-%H%M%S%.3f")
    ));
    let (phys_w, phys_h) = capture_screen(&file_path)?;
    // batch-M:缩放到模型友好宽度(默认 1280),返回 scale=物理宽/输出宽;maxWidth=0 不缩放。
    let max_width = params.get("maxWidth").and_then(Value::as_i64).unwrap_or(1280) as u32;
    let (out_w, out_h, scale) = if max_width > 0 && (phys_w as u32) > max_width {
        let img = image::open(&file_path)?;
        let ratio = max_width as f64 / phys_w as f64;
        let out_h = (phys_h as f64 * ratio).round() as u32;
        let resized = image::imageops::resize(&img, max_width, out_h, image::imageops::FilterType::Triangle);
        resized.save(&file_path)?;
        (max_width as i32, out_h as i32, phys_w as f64 / max_width as f64)
    } else {
        (phys_w, phys_h, 1.0)
    };
    Ok(json!({
        "path": file_path.to_string_lossy(),
        "width": out_w,
        "height": out_h,
        "physicalWidth": phys_w,
        "physicalHeight": phys_h,
        "scale": scale,
        "foreground": foreground_context(),
    }))
}

fn default_screenshot_dir() -> PathBuf {
    // 宿主可指定截图落点(Atria 桥会设成自己的数据区,截图归产品而不是散落 Codex 老巢);
    // 未设置时保持原路径,独立/Codex 场景兼容不变。
    if let Some(dir) = std::env::var_os("ACTOR_SHOTS_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Codex").join("EventStream").join("actor-shots")
}

fn capture_screen(file_path: &Path) -> Result<(i32, i32)> {
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() {
            return Err(anyhow!("GetDC failed"));
        }
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
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
        image.save(file_path)?;
        Ok((width, height))
    }
}

// ---------- click ----------

fn click(params: &Value) -> Result<Value> {
    let x = params
        .get("x")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("x required"))? as i32;
    let y = params
        .get("y")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("y required"))? as i32;
    let button = params
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left");
    let double = params
        .get("double")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let clicks = params
        .get("clicks")
        .and_then(Value::as_u64)
        .unwrap_or(if double { 2 } else { 1 })
        .clamp(1, 3) as u32;
    let move_duration = params
        .get("moveDurationMs")
        .and_then(Value::as_u64)
        .unwrap_or(250);
    let fg = enforce_expect(params)?;

    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        other => return Err(anyhow!("unknown button: {other}")),
    };
    // batch-M 可视化底座:平滑移动到目标(用户能看见鼠标被"驾驶"),moveDurationMs=0 恢复瞬移。
    smooth_move(x, y, move_duration)?;
    thread::sleep(Duration::from_millis(30));
    let presses = clicks;
    for i in 0..presses {
        send_mouse(down)?;
        thread::sleep(Duration::from_millis(20));
        send_mouse(up)?;
        if i + 1 < presses {
            thread::sleep(Duration::from_millis(60));
        }
    }
    Ok(json!({ "clicked": { "x": x, "y": y, "button": button, "clicks": presses }, "foreground": fg }))
}

// 平滑插值移动(ease-out):可视化鼠标的核心体感;durationMs=0 直接瞬移。
fn smooth_move(x: i32, y: i32, duration_ms: u64) -> Result<()> {
    let mut start = windows::Win32::Foundation::POINT::default();
    unsafe { GetCursorPos(&mut start)?; }
    if duration_ms == 0 || (start.x == x && start.y == y) {
        unsafe { SetCursorPos(x, y)?; }
        return Ok(());
    }
    let frames = (duration_ms / 12).clamp(4, 60) as i32;
    for i in 1..=frames {
        let t = i as f64 / frames as f64;
        let eased = 1.0 - (1.0 - t) * (1.0 - t); // ease-out
        let cx = start.x + ((x - start.x) as f64 * eased).round() as i32;
        let cy = start.y + ((y - start.y) as f64 * eased).round() as i32;
        unsafe { SetCursorPos(cx, cy)?; }
        thread::sleep(Duration::from_millis(12));
    }
    unsafe { SetCursorPos(x, y)?; }
    Ok(())
}

fn mouse_move(params: &Value) -> Result<Value> {
    let x = params.get("x").and_then(Value::as_i64).ok_or_else(|| anyhow!("x required"))? as i32;
    let y = params.get("y").and_then(Value::as_i64).ok_or_else(|| anyhow!("y required"))? as i32;
    let duration = params.get("durationMs").and_then(Value::as_u64).unwrap_or(250);
    smooth_move(x, y, duration)?;
    Ok(json!({ "moved": { "x": x, "y": y }, "foreground": foreground_context() }))
}

// 拖拽:平滑移到起点 → 按下 → 注入式绝对移动到终点(拖拽识别更可靠)→ 抬起。
fn drag(params: &Value) -> Result<Value> {
    let fx = params.get("fromX").and_then(Value::as_i64).ok_or_else(|| anyhow!("fromX required"))? as i32;
    let fy = params.get("fromY").and_then(Value::as_i64).ok_or_else(|| anyhow!("fromY required"))? as i32;
    let tx = params.get("toX").and_then(Value::as_i64).ok_or_else(|| anyhow!("toX required"))? as i32;
    let ty = params.get("toY").and_then(Value::as_i64).ok_or_else(|| anyhow!("toY required"))? as i32;
    let duration = params.get("durationMs").and_then(Value::as_u64).unwrap_or(400);
    let button = params.get("button").and_then(Value::as_str).unwrap_or("left");
    let fg = enforce_expect(params)?;
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        other => return Err(anyhow!("unknown button: {other}")),
    };
    smooth_move(fx, fy, 200)?;
    thread::sleep(Duration::from_millis(40));
    send_mouse(down)?;
    thread::sleep(Duration::from_millis(60));
    let frames = (duration / 14).clamp(6, 50) as i32;
    for i in 1..=frames {
        let t = i as f64 / frames as f64;
        let eased = 1.0 - (1.0 - t) * (1.0 - t);
        let cx = fx + ((tx - fx) as f64 * eased).round() as i32;
        let cy = fy + ((ty - fy) as f64 * eased).round() as i32;
        send_mouse_move_abs(cx, cy)?;
        thread::sleep(Duration::from_millis(14));
    }
    send_mouse_move_abs(tx, ty)?;
    thread::sleep(Duration::from_millis(60));
    send_mouse(up)?;
    Ok(json!({ "dragged": { "fromX": fx, "fromY": fy, "toX": tx, "toY": ty, "button": button }, "foreground": fg }))
}

// 滚轮:可选先移动到坐标;amount=格数(默认 3),每格 120。
fn scroll(params: &Value) -> Result<Value> {
    let direction = params.get("direction").and_then(Value::as_str).unwrap_or("down");
    let amount = params.get("amount").and_then(Value::as_i64).unwrap_or(3).clamp(1, 20) as i32;
    let fg = enforce_expect(params)?;
    if let (Some(x), Some(y)) = (
        params.get("x").and_then(Value::as_i64),
        params.get("y").and_then(Value::as_i64),
    ) {
        smooth_move(x as i32, y as i32, 150)?;
        thread::sleep(Duration::from_millis(30));
    }
    let (flags, delta) = match direction {
        "up" => (MOUSEEVENTF_WHEEL, 120 * amount),
        "down" => (MOUSEEVENTF_WHEEL, -120 * amount),
        "left" => (MOUSEEVENTF_HWHEEL, -120 * amount),
        "right" => (MOUSEEVENTF_HWHEEL, 120 * amount),
        other => return Err(anyhow!("unknown direction: {other}")),
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!("SendInput wheel failed"));
    }
    Ok(json!({ "scrolled": { "direction": direction, "amount": amount }, "foreground": fg }))
}

// 注入式绝对移动(0-65535 归一到虚拟屏),拖拽期间比 SetCursorPos 更可靠。
fn send_mouse_move_abs(x: i32, y: i32) -> Result<()> {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if vw <= 0 || vh <= 0 {
        return Err(anyhow!("invalid virtual screen"));
    }
    let nx = ((x - vx) as f64 * 65535.0 / vw as f64).round() as i32;
    let ny = ((y - vy) as f64 * 65535.0 / vh as f64).round() as i32;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: nx,
                dy: ny,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!("SendInput move failed"));
    }
    Ok(())
}

fn send_mouse(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) -> Result<()> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!("SendInput mouse failed"));
    }
    Ok(())
}

// ---------- type_text ----------

fn type_text(params: &Value) -> Result<Value> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("text required"))?;
    let fg = enforce_expect(params)?;
    if params.get("clearFirst").and_then(Value::as_bool).unwrap_or(false) {
        send_vk(VIRTUAL_KEY(0x11), false)?; // Ctrl
        send_vk(VIRTUAL_KEY(0x41), false)?; // A
        send_vk(VIRTUAL_KEY(0x41), true)?;
        send_vk(VIRTUAL_KEY(0x11), true)?;
        thread::sleep(Duration::from_millis(40));
    }
    let mut sent_chars = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            send_vk(VIRTUAL_KEY(0x0D), false)?; // VK_RETURN
            send_vk(VIRTUAL_KEY(0x0D), true)?;
        } else if ch == '\r' {
            continue;
        } else {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                send_unicode(*unit, false)?;
                send_unicode(*unit, true)?;
            }
        }
        sent_chars += 1;
        thread::sleep(Duration::from_millis(8));
    }
    Ok(json!({ "typed": sent_chars, "foreground": fg }))
}

fn send_unicode(unit: u16, key_up: bool) -> Result<()> {
    let mut flags = KEYEVENTF_UNICODE;
    if key_up {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!("SendInput unicode failed"));
    }
    Ok(())
}

fn send_vk(vk: VIRTUAL_KEY, key_up: bool) -> Result<()> {
    let flags = if key_up {
        KEYEVENTF_KEYUP
    } else {
        Default::default()
    };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent != 1 {
        return Err(anyhow!("SendInput vk failed"));
    }
    Ok(())
}

// ---------- key combo ----------

fn key_combo(params: &Value) -> Result<Value> {
    let keys = params
        .get("keys")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("keys required (e.g. \"ctrl+s\", \"enter\")"))?;
    let fg = enforce_expect(params)?;
    let sequence = parse_keys(keys)?;
    // 修饰键按下 → 主键 down/up → 修饰键松开(逆序)。
    let (modifiers, main) = sequence.split_at(sequence.len().saturating_sub(1));
    for vk in modifiers {
        send_vk(*vk, false)?;
        thread::sleep(Duration::from_millis(10));
    }
    if let Some(vk) = main.first() {
        send_vk(*vk, false)?;
        thread::sleep(Duration::from_millis(15));
        send_vk(*vk, true)?;
    }
    for vk in modifiers.iter().rev() {
        thread::sleep(Duration::from_millis(10));
        send_vk(*vk, true)?;
    }
    Ok(json!({ "keys": keys, "foreground": fg }))
}

fn parse_keys(spec: &str) -> Result<Vec<VIRTUAL_KEY>> {
    let parts: Vec<&str> = spec
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(anyhow!("empty key spec"));
    }
    parts.iter().map(|part| key_to_vk(part)).collect()
}

fn key_to_vk(name: &str) -> Result<VIRTUAL_KEY> {
    let lower = name.to_lowercase();
    let vk = match lower.as_str() {
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" => 0x12,
        "win" | "meta" => 0x5B,
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "printscreen" => 0x2C,
        "capslock" => 0x14,
        _ => {
            if let Some(rest) = lower.strip_prefix('f') {
                if let Ok(n) = rest.parse::<u16>() {
                    if (1..=24).contains(&n) {
                        return Ok(VIRTUAL_KEY(0x6F + n));
                    }
                }
            }
            let chars: Vec<char> = name.chars().collect();
            if chars.len() == 1 {
                let scan = unsafe { VkKeyScanW(chars[0] as u16) };
                if scan == -1 {
                    return Err(anyhow!("cannot map key: {name}"));
                }
                return Ok(VIRTUAL_KEY((scan & 0xFF) as u16));
            }
            return Err(anyhow!("unknown key: {name}"));
        }
    };
    Ok(VIRTUAL_KEY(vk))
}

// ---------- window_list / window_focus ----------

fn window_list() -> Result<Value> {
    let mut windows_out: Vec<Value> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut windows_out as *mut Vec<Value> as isize),
        );
    }
    Ok(json!({ "windows": windows_out, "foreground": foreground_context() }))
}

// 叠加层/工具窗过滤:WS_EX_NOACTIVATE(点不亮前台)或 WS_EX_TOOLWINDOW(浮层/调色板类)
// 不是合法的聚焦目标。真机踩坑:Atria 的"操作指示层"是置顶点透叠加窗,按 Z 序永远排在
// 主窗前面,title:"Atria" 子串匹配先撞上它 → 要么切错窗要么 SetForegroundWindow 必败。
fn is_focus_candidate(hwnd: HWND) -> bool {
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    ex & (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) == 0
}

// title-only 轻量找窗:精确标题优先于子串包含;两档内各按 Z 序取先;跳过叠加/工具窗。
fn find_window_by_title(title_lower: &str) -> Option<isize> {
    struct Ctx {
        want: String,
        exact: Option<isize>,
        partial: Option<isize>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if IsWindowVisible(hwnd).as_bool() && is_focus_candidate(hwnd) {
            let title = window_title(hwnd).to_lowercase();
            let trimmed = title.trim();
            if !trimmed.is_empty() && title.contains(&ctx.want) {
                if trimmed == ctx.want {
                    ctx.exact = Some(hwnd.0 as isize);
                    return BOOL(0); // 精确命中即停
                }
                if ctx.partial.is_none() {
                    ctx.partial = Some(hwnd.0 as isize); // 记住首个子串命中,继续找精确
                }
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx { want: title_lower.trim().to_string(), exact: None, partial: None };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.exact.or(ctx.partial)
}

// 同进程可见顶层窗口(P0 感知域):下拉弹层/模态框多为同进程的独立顶层窗(常无标题,故不过滤标题)。
fn process_toplevel_windows(pid: u32, cap: usize) -> Vec<isize> {
    struct Ctx {
        pid: u32,
        cap: usize,
        out: Vec<isize>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if ctx.out.len() >= ctx.cap {
            return BOOL(0);
        }
        if IsWindowVisible(hwnd).as_bool() {
            let mut wpid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut wpid));
            if wpid == ctx.pid {
                ctx.out.push(hwnd.0 as isize);
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx { pid, cap, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<Value>);
    if IsWindowVisible(hwnd).as_bool() {
        let title = window_title(hwnd);
        if !title.trim().is_empty() {
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let exe = process_path(pid).unwrap_or_default();
            let process_name = Path::new(&exe)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            out.push(json!({
                "hwnd": hwnd.0 as isize,
                "title": title,
                "pid": pid,
                "processName": process_name,
                // 叠加/工具窗标记(NOACTIVATE/TOOLWINDOW):这类窗不是聚焦目标,模型选窗时应跳过
                "toolWindow": !is_focus_candidate(hwnd),
            }));
        }
    }
    BOOL(1)
}

fn window_focus(params: &Value) -> Result<Value> {
    let target = find_window(params)?
        .ok_or_else(|| anyhow!("no window matched (pass hwnd / title / processName)"))?;
    let hwnd = HWND(target as *mut std::ffi::c_void);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            thread::sleep(Duration::from_millis(120));
        }
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        let self_thread = GetCurrentThreadId();
        // AttachThreadInput 让 SetForegroundWindow 绕过前台锁定(尽力而为)。
        let attached_fg = fg_thread != self_thread
            && AttachThreadInput(self_thread, fg_thread, true).as_bool();
        let attached_target = target_thread != self_thread
            && target_thread != fg_thread
            && AttachThreadInput(self_thread, target_thread, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached_fg {
            let _ = AttachThreadInput(self_thread, fg_thread, false);
        }
        if attached_target {
            let _ = AttachThreadInput(self_thread, target_thread, false);
        }
    }
    thread::sleep(Duration::from_millis(150));
    let mut after = foreground_context();
    let mut focused = after.get("hwnd").and_then(Value::as_i64) == Some(target as i64);
    // 一次轻量重试:前台锁定/时序偶发失败时再拍一下(真机踩坑的兜底,不引入循环)
    if !focused {
        unsafe {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
        }
        thread::sleep(Duration::from_millis(150));
        after = foreground_context();
        focused = after.get("hwnd").and_then(Value::as_i64) == Some(target as i64);
    }
    // matchedTitle:让模型看见自己实际抓到了哪扇窗(标题歧义时可自纠);
    // 失败时给出可执行的下一步提示,而不是只回一个 false。
    let matched_title = unsafe { window_title(hwnd) };
    let mut out = json!({
        "requestedHwnd": target,
        "matchedTitle": matched_title,
        "focused": focused,
        "foreground": after,
    });
    if !focused {
        out["hint"] = json!("目标未成为前台窗口:多窗口应用请先 window_list 拿 hwnd 再聚焦(标题匹配已排除叠加/工具窗,但仍可能有同名窗口)");
    }
    Ok(out)
}

fn find_window(params: &Value) -> Result<Option<isize>> {
    if let Some(hwnd) = params.get("hwnd").and_then(Value::as_i64) {
        return Ok(Some(hwnd as isize));
    }
    let title_wanted = params
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let process_wanted = params
        .get("processName")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    if title_wanted.is_none() && process_wanted.is_none() {
        return Ok(None);
    }
    // 只按标题找窗时走轻量枚举(P1):window_list 每窗 OpenProcess 解析进程名是它的大头开销,
    // title-only 场景(ui_snapshot scopeTitle / window_focus title)完全不需要。
    if process_wanted.is_none() {
        if let Some(title) = &title_wanted {
            return Ok(find_window_by_title(title));
        }
    }
    let listing = window_list()?;
    let empty = Vec::new();
    let windows = listing
        .get("windows")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    // 与 find_window_by_title 同规则:精确标题优先、跳过叠加/工具窗(防"操作指示层"类误命中)
    let mut partial: Option<isize> = None;
    for win in windows {
        let hwnd_val = match win.get("hwnd").and_then(Value::as_i64) {
            Some(h) => h as isize,
            None => continue,
        };
        if !is_focus_candidate(HWND(hwnd_val as *mut std::ffi::c_void)) {
            continue;
        }
        let title = win
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let process = win
            .get("processName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let title_ok = title_wanted
            .as_deref()
            .map(|w| title.contains(w))
            .unwrap_or(true);
        let process_ok = process_wanted
            .as_deref()
            .map(|w| process.contains(w))
            .unwrap_or(true);
        if title_ok && process_ok {
            let exact = title_wanted
                .as_deref()
                .map(|w| title.trim() == w.trim())
                .unwrap_or(true);
            if exact {
                return Ok(Some(hwnd_val));
            }
            if partial.is_none() {
                partial = Some(hwnd_val);
            }
        }
    }
    Ok(partial)
}

// ---------- UIA ----------

// COM 实例复用(P0):UIAutomation::new() 每次 CoInitializeEx+CoCreateInstance,重负载下毫秒到百毫秒级;
// actor 是单线程 stdin 循环,thread_local 缓存一份、用时 clone(COM 接口克隆廉价)。
thread_local! {
    static AUTOMATION: std::cell::RefCell<Option<UIAutomation>> = const { std::cell::RefCell::new(None) };
}

fn automation() -> Result<UIAutomation> {
    AUTOMATION.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(UIAutomation::new()?);
        }
        Ok(slot.as_ref().unwrap().clone())
    })
}

fn control_type_from_str(name: &str) -> Option<ControlType> {
    match name.to_lowercase().as_str() {
        "button" => Some(ControlType::Button),
        "edit" => Some(ControlType::Edit),
        "text" => Some(ControlType::Text),
        "menuitem" => Some(ControlType::MenuItem),
        "listitem" => Some(ControlType::ListItem),
        "checkbox" => Some(ControlType::CheckBox),
        "combobox" => Some(ControlType::ComboBox),
        "treeitem" => Some(ControlType::TreeItem),
        "tabitem" => Some(ControlType::TabItem),
        "hyperlink" => Some(ControlType::Hyperlink),
        "document" => Some(ControlType::Document),
        "pane" => Some(ControlType::Pane),
        "window" => Some(ControlType::Window),
        "radiobutton" => Some(ControlType::RadioButton),
        "slider" => Some(ControlType::Slider),
        "list" => Some(ControlType::List),
        "menu" => Some(ControlType::Menu),
        "toolbar" => Some(ControlType::ToolBar),
        _ => None,
    }
}

fn element_summary(element: &UIElement) -> Value {
    let rect = element.get_bounding_rectangle().ok();
    json!({
        "name": element.get_name().unwrap_or_default(),
        "automationId": element.get_automation_id().unwrap_or_default(),
        "className": element.get_classname().unwrap_or_default(),
        "controlType": element.get_control_type().map(|ct| format!("{ct:?}")).unwrap_or_default(),
        "boundingRect": rect.map(|r| json!([r.get_left(), r.get_top(), r.get_right(), r.get_bottom()])),
        "enabled": element.is_enabled().unwrap_or(false),
    })
}

fn find_elements(params: &Value) -> Result<Vec<UIElement>> {
    let automation = automation()?;
    // 感知域(P0):默认不再从桌面根深扫(旧行为重负载下 8-15s)。
    // 无 scope 时 = 前台窗口 + 同进程其它可见顶层窗口(覆盖下拉弹层/模态框);global:true 回到全桌面。
    let mut roots: Vec<UIElement> = Vec::new();
    if let Some(scope) = params.get("scopeHwnd").and_then(Value::as_i64) {
        roots.push(automation.element_from_handle(Handle::from(scope as isize))?);
    } else if let Some(scope_title) = params.get("scopeTitle").and_then(Value::as_str) {
        let hwnd = find_window(&json!({ "title": scope_title }))?
            .ok_or_else(|| anyhow!("scopeTitle matched no window: {scope_title}"))?;
        roots.push(automation.element_from_handle(Handle::from(hwnd))?);
    } else if params.get("global").and_then(Value::as_bool).unwrap_or(false) {
        roots.push(automation.get_root_element()?);
    } else {
        unsafe {
            let fg = GetForegroundWindow();
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(fg, Some(&mut pid));
            for hwnd in process_toplevel_windows(pid, 6) {
                if let Ok(el) = automation.element_from_handle(Handle::from(hwnd)) {
                    roots.push(el);
                }
            }
            if roots.is_empty() {
                if let Ok(el) = automation.element_from_handle(Handle::from(fg.0 as isize)) {
                    roots.push(el);
                }
            }
        }
    }
    let timeout = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(3000);
    // 多 root 均分超时预算,单 root 不低于 150ms
    let per_root_timeout = if roots.len() > 1 {
        (timeout / roots.len() as u64).max(150)
    } else {
        timeout
    };
    let mut found: Vec<UIElement> = Vec::new();
    for root in roots {
        let mut matcher = automation
            .create_matcher()
            .from(root)
            .depth(18)
            .timeout(per_root_timeout);
        if let Some(name) = params.get("name").and_then(Value::as_str) {
            matcher = matcher.contains_name(name);
        }
        if let Some(class_name) = params.get("className").and_then(Value::as_str) {
            matcher = matcher.classname(class_name);
        }
        if let Some(ct) = params
            .get("controlType")
            .and_then(Value::as_str)
            .and_then(control_type_from_str)
        {
            matcher = matcher.control_type(ct);
        }
        found.extend(matcher.find_all().unwrap_or_default());
    }
    if let Some(automation_id) = params.get("automationId").and_then(Value::as_str) {
        found.retain(|el| {
            el.get_automation_id()
                .map(|id| id == automation_id)
                .unwrap_or(false)
        });
    }
    // offscreen 过滤(F10):includeOffscreen 缺省 true 保持旧语义;ui_wait_for 会显式传 false
    // ("等元素出现"不该被 Collapsed/滚出视口的元素假命中,与 ui_snapshot 口径一致)。
    if !params
        .get("includeOffscreen")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        found.retain(|el| !el.is_offscreen().unwrap_or(false));
    }
    Ok(found)
}

fn uia_find(params: &Value) -> Result<Value> {
    let max_results = params
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(10) as usize;
    let found = find_elements(params)?;
    let elements: Vec<Value> = found.iter().take(max_results).map(element_summary).collect();
    Ok(json!({ "count": found.len(), "elements": elements }))
}

fn uia_invoke(params: &Value) -> Result<Value> {
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("invoke");
    let found = find_elements(params)?;
    let element = found
        .first()
        .ok_or_else(|| anyhow!("no element matched locator"))?;
    let summary = element_summary(element);
    match action {
        "focus" => {
            element.set_focus()?;
        }
        "invoke" => {
            if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
                pattern.invoke()?;
            } else {
                element.click()?;
            }
        }
        "click" => {
            element.click()?;
        }
        "set_value" => {
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("value required for set_value"))?;
            let pattern = element.get_pattern::<UIValuePattern>()?;
            pattern.set_value(value)?;
            // 读回验证(orca 式可验证写入):写完重读,"到底成没成"有回执。
            thread::sleep(Duration::from_millis(60));
            let read_back = pattern.get_value().unwrap_or_default();
            return Ok(json!({
                "action": "set_value",
                "element": summary,
                "verified": read_back == value,
                "readBack": read_back,
            }));
        }
        other => return Err(anyhow!("unknown action: {other}")),
    }
    Ok(json!({ "action": action, "element": summary }))
}

// ---------- a11y-first(batch-M,学 Windows-MCP):无视觉模型的精准之路 ----------

// 可交互控件类型:snapshot 只收这些 + 可聚焦元素,控制 token 体积。
fn is_interactive_control(ct: &ControlType) -> bool {
    matches!(
        ct,
        ControlType::Button
            | ControlType::Edit
            | ControlType::ComboBox
            | ControlType::CheckBox
            | ControlType::RadioButton
            | ControlType::MenuItem
            | ControlType::TabItem
            | ControlType::ListItem
            | ControlType::TreeItem
            | ControlType::Hyperlink
            | ControlType::SplitButton
            | ControlType::Slider
            | ControlType::Spinner
            | ControlType::Document
    )
}

// ui_snapshot:前台(或指定)窗口的可交互元素清单——名字/类型/中心坐标由 OS 提供,
// 模型只做"从文本清单挑元素"的推理,无视觉模型也能精准点击。
fn ui_snapshot(params: &Value) -> Result<Value> {
    let automation = automation()?;
    let target_hwnd: isize = if let Some(h) = params.get("scopeHwnd").and_then(Value::as_i64) {
        h as isize
    } else if let Some(title) = params.get("scopeTitle").and_then(Value::as_str) {
        find_window(&json!({ "title": title }))?
            .ok_or_else(|| anyhow!("scopeTitle matched no window: {title}"))?
    } else {
        let fg = unsafe { GetForegroundWindow() };
        fg.0 as isize
    };
    let root = automation.element_from_handle(Handle::from(target_hwnd))?;
    let max_elements = params
        .get("maxElements")
        .and_then(Value::as_u64)
        .unwrap_or(80)
        .clamp(10, 300) as usize;
    let include_all = params
        .get("includeAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let walker = automation.get_control_view_walker()?;
    let mut out: Vec<Value> = Vec::new();
    let mut visited = 0usize;
    collect_elements(&walker, &root, 0, 14, &mut visited, 2000, max_elements, include_all, &mut out);

    let win_title = unsafe { window_title(HWND(target_hwnd as *mut std::ffi::c_void)) };
    Ok(json!({
        "window": { "hwnd": target_hwnd, "title": win_title },
        "count": out.len(),
        "truncated": out.len() >= max_elements,
        "elements": out,
        "foreground": foreground_context(),
    }))
}

#[allow(clippy::too_many_arguments)]
fn collect_elements(
    walker: &uiautomation::UITreeWalker,
    element: &UIElement,
    depth: usize,
    max_depth: usize,
    visited: &mut usize,
    max_visited: usize,
    max_out: usize,
    include_all: bool,
    out: &mut Vec<Value>,
) {
    if depth > max_depth || *visited >= max_visited || out.len() >= max_out {
        return;
    }
    *visited += 1;
    // 采集当前元素(根窗口本身跳过)
    if depth > 0 {
        let offscreen = element.is_offscreen().unwrap_or(false);
        if !offscreen {
            let ct = element.get_control_type().ok();
            let interactive = ct.as_ref().map(is_interactive_control).unwrap_or(false)
                || element.is_keyboard_focusable().unwrap_or(false);
            if interactive || include_all {
                if let Ok(rect) = element.get_bounding_rectangle() {
                    let (l, t, r, b) = (rect.get_left(), rect.get_top(), rect.get_right(), rect.get_bottom());
                    if r > l && b > t {
                        let name = element.get_name().unwrap_or_default();
                        let auto_id = element.get_automation_id().unwrap_or_default();
                        // 无名无 id 的纯容器噪声跳过(除非 includeAll)
                        if include_all || !name.is_empty() || !auto_id.is_empty() {
                            out.push(json!({
                                "i": out.len(),
                                "type": ct.map(|c| format!("{c:?}")).unwrap_or_default(),
                                "name": name,
                                "automationId": auto_id,
                                "cx": (l + r) / 2,
                                "cy": (t + b) / 2,
                                "rect": [l, t, r, b],
                                "enabled": element.is_enabled().unwrap_or(true),
                                "focusable": element.is_keyboard_focusable().unwrap_or(false),
                            }));
                        }
                    }
                }
            }
        }
    }
    // 深入子树
    if let Ok(child) = walker.get_first_child(element) {
        let mut current = child;
        loop {
            collect_elements(walker, &current, depth + 1, max_depth, visited, max_visited, max_out, include_all, out);
            if out.len() >= max_out || *visited >= max_visited {
                return;
            }
            match walker.get_next_sibling(&current) {
                Ok(next) => current = next,
                Err(_) => break,
            }
        }
    }
}

// ui_wait_for:单次调用内轮询等待元素出现(消灭"点了→截图→看→再点"的多轮往返)。
fn ui_wait_for(params: &Value) -> Result<Value> {
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(8000)
        .clamp(200, 60000);
    let interval_ms = params
        .get("intervalMs")
        .and_then(Value::as_u64)
        .unwrap_or(400)
        .clamp(100, 5000);
    let started = std::time::Instant::now();
    loop {
        // 每轮用短超时查一次(find_elements 内 matcher timeout 覆盖为轮询节拍)
        let mut probe = params.clone();
        if let Some(obj) = probe.as_object_mut() {
            obj.insert("timeoutMs".into(), json!(200));
            // F10:等待语义默认只认可见元素(Collapsed/滚出视口不算"出现"),调用方可显式覆盖
            if !obj.contains_key("includeOffscreen") {
                obj.insert("includeOffscreen".into(), json!(false));
            }
        }
        let found = find_elements(&probe).unwrap_or_default();
        if let Some(el) = found.first() {
            return Ok(json!({
                "found": true,
                "elapsedMs": started.elapsed().as_millis() as u64,
                "element": element_summary(el),
            }));
        }
        if started.elapsed().as_millis() as u64 >= timeout_ms {
            return Ok(json!({
                "found": false,
                "elapsedMs": started.elapsed().as_millis() as u64,
            }));
        }
        thread::sleep(Duration::from_millis(interval_ms));
    }
}

// ---------- cursor ----------

fn cursor_position() -> Result<Value> {
    let mut point = windows::Win32::Foundation::POINT::default();
    unsafe {
        GetCursorPos(&mut point)?;
    }
    Ok(json!({ "x": point.x, "y": point.y }))
}

// ---------- 共用(与 recorder 同源逻辑) ----------

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_named_key() {
        let keys = parse_keys("enter").unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].0, 0x0D);
    }

    #[test]
    fn parses_modifier_combo_in_order() {
        let keys = parse_keys("ctrl+shift+s").unwrap();
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0].0, 0x11);
        assert_eq!(keys[1].0, 0x10);
    }

    #[test]
    fn parses_function_keys() {
        assert_eq!(parse_keys("f5").unwrap()[0].0, 0x74);
        assert_eq!(parse_keys("F12").unwrap()[0].0, 0x7B);
    }

    #[test]
    fn rejects_unknown_key() {
        assert!(parse_keys("notakey").is_err());
    }

    #[test]
    fn expect_matching_is_case_insensitive_contains() {
        let expect = Expect {
            process_name: Some("notepad".into()),
            title_contains: Some("记事本".into()),
        };
        assert!(expect_matches(&expect, "Notepad.exe", "新建 - 记事本"));
        assert!(!expect_matches(&expect, "chrome.exe", "新建 - 记事本"));
        assert!(!expect_matches(&expect, "Notepad.exe", "wrong title"));
    }

    #[test]
    fn empty_expect_always_matches() {
        let expect = Expect::default();
        assert!(expect_matches(&expect, "anything.exe", "any title"));
    }

    #[test]
    fn control_type_mapping_covers_common_types() {
        assert!(control_type_from_str("Button").is_some());
        assert!(control_type_from_str("edit").is_some());
        assert!(control_type_from_str("nonsense").is_none());
    }
}
