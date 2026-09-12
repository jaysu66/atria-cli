import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["./mcp/server.mjs"],
  cwd: pluginRoot,
});

const client = new Client({ name: "record-replay-probe", version: "0.1.0" });
await client.connect(transport);
try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const expectedTools = [
    "event_stream_generate_skill",
    "event_stream_panel",
    "event_stream_start",
    "event_stream_status",
    "event_stream_stop",
  ];
  for (const name of expectedTools) {
    if (!toolNames.includes(name)) {
      throw new Error(`Missing MCP tool: ${name}`);
    }
  }

  const panel = await client.callTool({
    name: "event_stream_panel",
    arguments: {},
  });
  if (panel?._meta?.["openai/outputTemplate"] !== "ui://widget/record-replay-windows-status-panel.html") {
    throw new Error("event_stream_panel did not return the status panel outputTemplate.");
  }
  if (!panel?._meta?.widgetData || typeof panel._meta.widgetData !== "object") {
    throw new Error("event_stream_panel did not return widgetData.");
  }

  console.log(JSON.stringify({
    tools: toolNames,
    panelTemplate: panel._meta["openai/outputTemplate"],
    hasWidgetData: true,
  }, null, 2));
} finally {
  await client.close();
}
