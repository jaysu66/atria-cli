import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function userIdentity() {
  let username = process.env.USERNAME || process.env.USER || "local-user";
  try { username = os.userInfo().username || username; } catch (_error) {}
  const uid = typeof process.getuid === "function" ? process.getuid() : "windows";
  return `${username}\0${os.homedir()}\0${uid}`;
}

export function defaultVisualIpc() {
  const userHash = crypto.createHash("sha256").update(userIdentity()).digest("hex").slice(0, 20);
  const stateDir = path.join(os.tmpdir(), `atria-record-replay-${userHash}`);
  return {
    stateDir,
    tokenPath: path.join(stateDir, "visual-broker.token"),
    pipePath: process.platform === "win32"
      ? `\\\\.\\pipe\\atria-record-replay-visual-${userHash}`
      : path.join(stateDir, "visual-broker.sock"),
  };
}

export function ensureVisualBrokerToken(tokenPath = defaultVisualIpc().tokenPath) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(tokenPath), 0o700); } catch (_error) {}
  try {
    const fd = fs.openSync(tokenPath, "wx", 0o600);
    try { fs.writeFileSync(fd, `${crypto.randomBytes(32).toString("hex")}\n`, "utf8"); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  try { fs.chmodSync(tokenPath, 0o600); } catch (_error) {}
  // Another host may observe the new file between open("wx") and the first
  // writer's flush. Keep this bounded and synchronous because construction is
  // otherwise synchronous and the race only exists during first use.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(token)) return token;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("Visual broker token file is invalid.");
}
