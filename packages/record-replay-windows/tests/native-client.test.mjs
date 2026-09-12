import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { NativeRecorderClient } from "../mcp/native-client.mjs";

const missingNativePath = path.join(process.cwd(), "missing-recorder.exe");

test("status does not start the native recorder when idle", async () => {
  const client = new NativeRecorderClient({ nativePath: missingNativePath });
  const status = await client.status();
  assert.deepEqual(status, {
    isRecording: false,
    maxDurationSeconds: 1800,
  });
});

test("idle stop does not start the native recorder", async () => {
  const client = new NativeRecorderClient({ nativePath: missingNativePath });
  const status = await client.stop();
  assert.deepEqual(status, {
    isRecording: false,
    maxDurationSeconds: 1800,
    endReason: "no_active_recording",
  });
});

test("start still requires the native recorder binary", async () => {
  const client = new NativeRecorderClient({ nativePath: missingNativePath });
  assert.throws(
    () => client.start(),
    /Native recorder not found/,
  );
});
