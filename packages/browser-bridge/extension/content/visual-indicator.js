(function installAtriaVisualIndicator() {
  if (window.__atriaVisualIndicatorInstalled) return;
  window.__atriaVisualIndicatorInstalled = true;

  const MAX_TRANSIENT_NODES = 8;
  const AUTO_HIDE_MS = 1600;
  const terminalPhases = new Set(["verified", "failed", "unknown", "cancelled"]);
  const host = document.createElement("div");
  host.id = "atria-agent-visual-indicator";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;contain:strict;display:block";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; pointer-events: none !important; }
    #layer { position: fixed; inset: 0; overflow: hidden; contain: strict; font: 12px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    #cursor { position: fixed; display: none; width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid var(--atria-color); border-radius: 50%; background: color-mix(in srgb,var(--atria-color) 18%,transparent); box-shadow: 0 0 0 4px color-mix(in srgb,var(--atria-color) 14%,transparent); transform: translate3d(var(--atria-x),var(--atria-y),0); }
    #cursor::after { content: ""; position: absolute; left: 7px; top: 7px; width: 4px; height: 4px; border-radius: 50%; background: var(--atria-color); }
    #target { position: fixed; display: none; border: 2px solid var(--atria-color); border-radius: 6px; background: color-mix(in srgb,var(--atria-color) 8%,transparent); box-shadow: 0 0 0 2px rgba(255,255,255,.72),0 6px 20px rgba(0,0,0,.15); }
    #status { position: fixed; left: 12px; bottom: 12px; display: none; align-items: center; gap: 8px; max-width: min(440px,calc(100vw - 24px)); padding: 7px 10px; border-radius: 999px; color: #10271d; background: rgba(236,248,241,.96); border: 1px solid color-mix(in srgb,var(--atria-color) 35%,transparent); box-shadow: 0 8px 28px rgba(0,0,0,.14); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--atria-color); box-shadow: 0 0 0 4px color-mix(in srgb,var(--atria-color) 16%,transparent); }
    #label { overflow: hidden; text-overflow: ellipsis; }
    .ripple { position: fixed; width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 2px solid var(--atria-color); border-radius: 50%; animation: atria-ripple .72s ease-out forwards; }
    @keyframes atria-ripple { from { transform: translate3d(var(--atria-x),var(--atria-y),0) scale(.55); opacity: 1; } to { transform: translate3d(var(--atria-x),var(--atria-y),0) scale(4); opacity: 0; } }
  `;

  const layer = document.createElement("div");
  layer.id = "layer";
  const cursor = document.createElement("div");
  cursor.id = "cursor";
  const target = document.createElement("div");
  target.id = "target";
  const status = document.createElement("div");
  status.id = "status";
  const dot = document.createElement("span");
  dot.id = "dot";
  const label = document.createElement("span");
  label.id = "label";
  status.append(dot, label);
  layer.append(target, cursor, status);
  shadow.append(style, layer);

  let hideTimer = null;
  const transientNodes = [];

  function ensureRoot() {
    if (!document.documentElement.contains(host)) document.documentElement.appendChild(host);
  }

  function clearHideTimer() {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hide() {
    clearHideTimer();
    cursor.style.display = "none";
    target.style.display = "none";
    status.style.display = "none";
    while (transientNodes.length) transientNodes.shift().remove();
  }

  function scheduleHide(delay = AUTO_HIDE_MS) {
    clearHideTimer();
    hideTimer = setTimeout(hide, delay);
  }

  function operationColor(operationId, active) {
    if (!active) return "#7c3aed";
    let hash = 0;
    for (const char of String(operationId || "atria")) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return ["#087f5b", "#1971c2", "#c2410c", "#9c36b5"][Math.abs(hash) % 4];
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function trustedGeometry(event) {
    if (event.coordinateSpace !== "viewport_css" || Number(event.frameId || 0) !== 0 || event.coordinatesTrusted === false) return null;
    const source = event.target && typeof event.target === "object" ? event.target : {};
    const x = finite(source.x ?? source.left ?? event.x);
    const y = finite(source.y ?? source.top ?? event.y);
    if (x === null || y === null) return null;
    const width = Math.max(0, finite(source.width) ?? 0);
    const height = Math.max(0, finite(source.height) ?? 0);
    return { x, y, width, height };
  }

  function actionLabel(event, located) {
    const names = {
      left_click: "点击", right_click: "右键点击", double_click: "双击", click_where: "点击目标",
      type: "输入", key: "按键", scroll: "滚动", scroll_until: "滚动查找", scroll_to: "滚动定位",
      act_until: "执行直到满足", screenshot: "截图", wait: "等待"
    };
    const phases = {
      prepare: "准备", running: "执行中", input_dispatched: "已发出输入", verified: "已验证",
      failed: "失败", unknown: "结果未知", cancelled: "已取消"
    };
    const count = Number(event.target?.textLength);
    const summary = event.action === "type" && Number.isFinite(count) ? ` · ${Math.max(0, Math.round(count))} 字符` : "";
    const tabMode = event.active === false ? `后台标签 #${event.tabId ?? "?"}` : `标签 #${event.tabId ?? "?"}`;
    const confidence = located ? "" : " · 仅状态";
    return `${tabMode} · ${names[event.action] || "操作"} · ${phases[event.phase] || event.phase || "状态"}${summary}${confidence}`;
  }

  function addRipple(x, y) {
    const node = document.createElement("div");
    node.className = "ripple";
    node.style.setProperty("--atria-x", `${x}px`);
    node.style.setProperty("--atria-y", `${y}px`);
    layer.appendChild(node);
    transientNodes.push(node);
    while (transientNodes.length > MAX_TRANSIENT_NODES) transientNodes.shift().remove();
    setTimeout(() => {
      const index = transientNodes.indexOf(node);
      if (index >= 0) transientNodes.splice(index, 1);
      node.remove();
    }, 850);
  }

  function render(event) {
    ensureRoot();
    clearHideTimer();
    const geometry = trustedGeometry(event);
    const color = operationColor(event.operationId, event.active !== false);
    layer.style.setProperty("--atria-color", color);
    label.textContent = actionLabel(event, Boolean(geometry));
    status.style.display = "flex";

    if (geometry) {
      cursor.style.setProperty("--atria-x", `${geometry.x}px`);
      cursor.style.setProperty("--atria-y", `${geometry.y}px`);
      cursor.style.display = "block";
      if (geometry.width > 0 && geometry.height > 0) {
        target.style.left = `${geometry.x - geometry.width / 2}px`;
        target.style.top = `${geometry.y - geometry.height / 2}px`;
        target.style.width = `${geometry.width}px`;
        target.style.height = `${geometry.height}px`;
        target.style.display = "block";
      } else {
        target.style.display = "none";
      }
      if (["left_click", "right_click", "double_click", "click_where"].includes(event.action) && event.phase === "input_dispatched") {
        addRipple(geometry.x, geometry.y);
        if (event.action === "double_click") setTimeout(() => addRipple(geometry.x, geometry.y), 100);
      }
    } else {
      cursor.style.display = "none";
      target.style.display = "none";
    }

    if (terminalPhases.has(event.phase)) scheduleHide();
    return {
      ok: true,
      renderedAt: new Date().toISOString(),
      operationId: String(event.operationId || ""),
      coordinatesRendered: Boolean(geometry),
      coordinateSpace: geometry ? "viewport_css" : null,
      transientCount: transientNodes.length
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "atria.indicator") {
      ensureRoot();
      if (message.visible) {
        label.textContent = "Atria 正在操作浏览器";
        status.style.display = "flex";
      } else {
        scheduleHide(120);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "atria.visual" && message.event && typeof message.event === "object") {
      sendResponse(render(message.event));
      return true;
    }
    if (message.type === "atria.visual.clear") {
      hide();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
