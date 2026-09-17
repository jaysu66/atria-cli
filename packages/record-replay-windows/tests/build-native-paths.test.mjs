import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "build-native.ps1");

function resolvePaths(cwd, outputDir, targetDir) {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-OutputDir", outputDir,
    "-TargetDir", targetDir,
    "-ResolvePathsOnly",
  ], { cwd, encoding: "utf8", windowsHide: true });
  return result;
}

test("build-native resolves relative output and target paths under Windows PowerShell 5.1", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-native-paths-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = resolvePaths(dir, path.join("relative", "output"), path.join("relative", "target"));
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout.trim());
  assert.equal(resolved.outputDir, path.join(dir, "relative", "output"));
  assert.equal(resolved.targetDir, path.join(dir, "relative", "target"));
  assert.equal(fs.existsSync(resolved.outputDir), false);
  assert.equal(fs.existsSync(resolved.targetDir), false);
});

test("build-native preserves normalized absolute output and target paths", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atria-native-absolute-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputDir = `${dir}${path.sep}output${path.sep}..`;
  const targetDir = path.join(dir, "target");
  const result = resolvePaths(root, outputDir, targetDir);
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout.trim());
  assert.equal(resolved.outputDir, dir);
  assert.equal(resolved.targetDir, targetDir);
});

test("build-native rejects filesystem roots before any build or deletion", () => {
  const filesystemRoot = path.parse(root).root;
  const result = resolvePaths(root, filesystemRoot, path.join(root, ".tmp-unused-target"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not resolve to a filesystem root/i);
});
