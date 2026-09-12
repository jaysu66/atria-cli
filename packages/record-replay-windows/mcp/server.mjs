import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEventStreamServer } from "./server-core.mjs";

// CODEX_SKILLS_ROOT:宿主(如 Atria 桥)可重定向技能落点;缺省仍为 ~/.codex/skills。
const server = createEventStreamServer({
  skillsRoot: process.env.CODEX_SKILLS_ROOT || undefined,
});
const transport = new StdioServerTransport();

function closeRecorder() {
  if (typeof server.closeRecorder === "function") {
    server.closeRecorder();
  }
}

process.once("SIGINT", () => {
  closeRecorder();
  process.exit(130);
});
process.once("SIGTERM", () => {
  closeRecorder();
  process.exit(143);
});
process.once("exit", closeRecorder);

await server.connect(transport);
