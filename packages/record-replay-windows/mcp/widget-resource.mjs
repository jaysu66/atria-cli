import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";

const require = createRequire(import.meta.url);
let cachedAppsBundle = "";

export function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

export function inlineWidget({ html, css, js, config = null }) {
  return injectHostBridge(
    html
      .replace("/* __STATUS_PANEL_CSS__ */", () => css)
      .replace("/* __STATUS_PANEL_JS__ */", () => js),
    config,
  );
}

export function registerWidgetResource(
  server,
  { name, uri, title, description, html, prefersBorder = false, csp = null },
) {
  const resourceCsp = csp || {
    connectDomains: [],
    resourceDomains: [],
  };
  const metadata = {
    ui: {
      prefersBorder,
      csp: resourceCsp,
    },
    "openai/widgetDescription": description,
    "openai/widgetPrefersBorder": prefersBorder,
    "openai/widgetAccessible": true,
    "openai/widgetCSP": {
      connect_domains: resourceCsp.connectDomains || [],
      resource_domains: resourceCsp.resourceDomains || [],
    },
  };

  registerAppResource(
    server,
    name,
    uri,
    {
      title,
      description,
      _meta: metadata,
    },
    async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: metadata,
        },
      ],
    }),
  );
}

function injectHostBridge(html, config = null) {
  const bridge = [
    '<script id="recordReplayPanelConfig">',
    `window.__RECORD_REPLAY_PANEL_CONTROL__=${escapeJsonScript(config || null)};`,
    "</script>",
    '<script id="recordReplayMcpAppsBundle">',
    escapeInlineScript(mcpAppsBundle()),
    "</script>",
    '<script id="recordReplayMcpHostBridge">',
    hostBridgeScript(),
    "</script>",
  ].join("\n");

  if (html.includes("</head>")) {
    return html.replace("</head>", () => `${bridge}\n</head>`);
  }
  return `${bridge}\n${html}`;
}

function mcpAppsBundle() {
  if (cachedAppsBundle) return cachedAppsBundle;

  const source = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  );
  const exportStart = source.lastIndexOf("export{");
  if (exportStart === -1) {
    throw new Error("Could not find ext-apps browser export block.");
  }

  const exportBlock = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!exportBlock) {
    throw new Error("Could not parse ext-apps browser export block.");
  }

  const exportMap = parseExportMap(exportBlock[1]);
  const requiredExports = [
    "App",
    "applyDocumentTheme",
    "applyHostFonts",
    "applyHostStyleVariables",
  ];
  for (const name of requiredExports) {
    if (!exportMap.has(name)) {
      throw new Error(`Missing ext-apps browser export: ${name}`);
    }
  }

  cachedAppsBundle = [
    source.slice(0, exportStart),
    ";globalThis.__RECORD_REPLAY_MCP_APPS__={",
    requiredExports
      .map((name) => `${JSON.stringify(name)}:${exportMap.get(name)}`)
      .join(","),
    "};",
  ].join("");
  return cachedAppsBundle;
}

function parseExportMap(body) {
  const exportMap = new Map();
  for (const rawEntry of body.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    const local = parts[0]?.trim();
    const exported = (parts[1] || parts[0])?.trim();
    if (local && exported) exportMap.set(exported, local);
  }
  return exportMap;
}

function escapeInlineScript(source) {
  return source
    .replaceAll("</script", "<\\/script")
    .replaceAll("</SCRIPT", "<\\/SCRIPT");
}

function escapeJsonScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function hostBridgeScript() {
  return `(() => {
  "use strict";

  const apps = globalThis.__RECORD_REPLAY_MCP_APPS__;
  let mcpApp = null;
  let preferredDisplayModeRequested = false;

  function toBridgeError(error) {
    if (error instanceof Error) return error;
    return new Error(String(error || "Host bridge unavailable."));
  }

  function ensureApi() {
    const api = window.recordReplayMcp || {};
    window.recordReplayMcp = api;
    if (typeof api.getBridgeState !== "function") {
      api.getBridgeState = () => Object.assign({}, api.bridgeState || {});
    }
    if (typeof api.notifyResize !== "function") {
      api.notifyResize = () => {};
    }
    return api;
  }

  function publishBridgeState(update) {
    const api = ensureApi();
    api.bridgeState = Object.assign({}, api.bridgeState || {}, update, {
      updatedAt: new Date().toISOString(),
    });
    window.dispatchEvent(new CustomEvent("recordReplayMcp:bridge-state", {
      detail: api.getBridgeState(),
    }));
    publishHostGlobals({ recordReplayBridge: api.getBridgeState() });
  }

  function installUnavailableApi(error) {
    const bridgeError = toBridgeError(error);
    const api = ensureApi();
    api.callServerTool = async () => {
      throw bridgeError;
    };
    publishBridgeState({
      ready: false,
      connected: false,
      serverTools: false,
      serverResources: false,
      error: bridgeError.message,
    });
  }

  function publishHostGlobals(globals) {
    window.openai = Object.assign(window.openai || {}, globals);
    window.dispatchEvent(new CustomEvent("openai:set_globals", {
      detail: { globals: window.openai },
    }));
  }

  function applyHostContext(context) {
    if (!context) return;
    try {
      if (context.theme && typeof apps.applyDocumentTheme === "function") {
        apps.applyDocumentTheme(context.theme);
      }
      if (context.styles?.variables && typeof apps.applyHostStyleVariables === "function") {
        apps.applyHostStyleVariables(context.styles.variables);
      }
      if (context.styles?.css?.fonts && typeof apps.applyHostFonts === "function") {
        apps.applyHostFonts(context.styles.css.fonts);
      }
    } catch (_error) {
    }
    publishHostGlobals({
      hostContext: context,
      displayMode: context.displayMode,
      availableDisplayModes: context.availableDisplayModes,
    });
    requestPreferredDisplayMode();
  }

  async function requestPreferredDisplayMode() {
    if (preferredDisplayModeRequested || !mcpApp || typeof mcpApp.requestDisplayMode !== "function") return;
    const config = window.__RECORD_REPLAY_PANEL_CONTROL__;
    const preferred = config && typeof config.preferredDisplayMode === "string" ? config.preferredDisplayMode : "";
    if (!preferred) return;
    const context = typeof mcpApp.getHostContext === "function" ? mcpApp.getHostContext() : window.openai?.hostContext;
    const available = Array.isArray(context?.availableDisplayModes) ? context.availableDisplayModes : [];
    if (context?.displayMode === preferred || !available.includes(preferred)) return;
    preferredDisplayModeRequested = true;
    try {
      await withTimeout(mcpApp.requestDisplayMode({ mode: preferred }), 4000, "Display mode request did not return.");
      publishBridgeState({ preferredDisplayMode: preferred, displayModeRequestError: "" });
    } catch (error) {
      publishBridgeState({
        preferredDisplayMode: preferred,
        displayModeRequestError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!apps || typeof apps.App !== "function") {
    installUnavailableApi("MCP Apps browser bundle did not load.");
    return;
  }

  function currentSize() {
    const root = document.documentElement;
    const body = document.body;
    return {
      width: Math.ceil(window.innerWidth || root.clientWidth || 0),
      height: Math.ceil(Math.max(
        root.scrollHeight || 0,
        root.offsetHeight || 0,
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
      )),
    };
  }

  function sendCurrentSize() {
    if (!mcpApp || typeof mcpApp.sendSizeChanged !== "function") return;
    try {
      mcpApp.sendSizeChanged(currentSize());
    } catch (_error) {
    }
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function installApi(app) {
    const api = ensureApi();

    api.callServerTool = async (request) => {
      try {
        if (!request || typeof request !== "object") throw new Error("Missing tool request.");
        if (!request.name) throw new Error("Missing tool name.");
        if (!app || typeof app.callServerTool !== "function") throw new Error("Host bridge unavailable.");
        if (app.ready) await withTimeout(app.ready, 4000, "Host bridge did not become ready.");
        if (globalThis.__RECORD_REPLAY_MCP_HOST_ERROR__) {
          throw toBridgeError(globalThis.__RECORD_REPLAY_MCP_HOST_ERROR__);
        }
        const capabilities = typeof app.getHostCapabilities === "function" ? app.getHostCapabilities() : undefined;
        if (capabilities && !capabilities.serverTools) {
          throw new Error("Host bridge is connected, but server tool calls are not available in this view.");
        }
        const result = await withTimeout(app.callServerTool({
          name: String(request.name),
          arguments: request.arguments && typeof request.arguments === "object" ? request.arguments : {},
        }), 65000, "Server tool did not return.");
        if (result?.isError) throw new Error("Server tool returned an error.");
        return result || {};
      } catch (error) {
        throw toBridgeError(error);
      }
    };

    api.sendUserMessage = async (request) => {
      try {
        const text = String(request?.text || "").trim();
        if (!text) throw new Error("Missing message text.");
        if (!app || typeof app.sendMessage !== "function") throw new Error("Host message bridge unavailable.");
        if (app.ready) await withTimeout(app.ready, 4000, "Host bridge did not become ready.");
        const capabilities = typeof app.getHostCapabilities === "function" ? app.getHostCapabilities() : undefined;
        if (
          request?.context &&
          typeof app.updateModelContext === "function" &&
          (!capabilities || capabilities.updateModelContext)
        ) {
          await withTimeout(app.updateModelContext({
            content: [{ type: "text", text: String(request.context) }],
            structuredContent: request.structuredContent && typeof request.structuredContent === "object"
              ? request.structuredContent
              : undefined,
          }), 8000, "Model context update did not return.");
        }
        const result = await withTimeout(app.sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        }), 15000, "Host message did not return.");
        if (result?.isError) throw new Error("Host rejected the message.");
        return result || {};
      } catch (error) {
        throw toBridgeError(error);
      }
    };

    api.notifyResize = sendCurrentSize;
    api.requestDisplayMode = async (mode) => {
      if (!app || typeof app.requestDisplayMode !== "function") throw new Error("Host display mode bridge unavailable.");
      if (app.ready) await withTimeout(app.ready, 4000, "Host bridge did not become ready.");
      return app.requestDisplayMode({ mode: String(mode || "inline") });
    };
    publishBridgeState({
      ready: false,
      connected: false,
      error: "",
    });
  }

  function normalizeToolPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    if (payload._meta?.widgetData) return payload._meta.widgetData;
    if (payload.structuredContent && (payload.content || payload._meta || payload.isError !== undefined)) {
      return payload.structuredContent;
    }
    return payload;
  }

  function handleToolResult(result) {
    const metadata = result && typeof result === "object" ? result._meta || {} : {};
    const payload = metadata.widgetData || normalizeToolPayload(result) || {};
    publishHostGlobals({
      rawToolResult: result,
      toolOutput: payload,
      toolResponseMetadata: metadata,
    });
    sendCurrentSize();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.method === "ui/notifications/tool-result") {
      const result = event.data?.params?.result || event.data?.params;
      handleToolResult(result);
    }
  });

  try {
    mcpApp = new apps.App(
      { name: "record-replay-windows-panel", version: "0.1.0" },
      { availableDisplayModes: ["inline", "fullscreen"] },
      { autoResize: true },
    );
    globalThis.__RECORD_REPLAY_MCP_APP__ = mcpApp;
    installApi(mcpApp);
    mcpApp.addEventListener("hostcontextchanged", applyHostContext);
    mcpApp.addEventListener("toolresult", handleToolResult);
    mcpApp.ready = mcpApp.connect()
      .then(() => {
        installApi(mcpApp);
        const capabilities = typeof mcpApp.getHostCapabilities === "function" ? mcpApp.getHostCapabilities() : {};
        const hasServerTools = Boolean(capabilities?.serverTools);
        const hasServerResources = Boolean(capabilities?.serverResources);
        publishBridgeState({
          ready: true,
          connected: true,
          serverTools: hasServerTools,
          serverResources: hasServerResources,
          message: Boolean(capabilities?.message),
          updateModelContext: Boolean(capabilities?.updateModelContext),
          error: "",
        });
        applyHostContext(mcpApp.getHostContext && mcpApp.getHostContext());
        requestPreferredDisplayMode();
        sendCurrentSize();
      })
      .catch((error) => {
        globalThis.__RECORD_REPLAY_MCP_HOST_ERROR__ = error;
        installUnavailableApi(error);
      });
  } catch (error) {
    globalThis.__RECORD_REPLAY_MCP_HOST_ERROR__ = error;
    installUnavailableApi(error);
  }
})();`;
}
