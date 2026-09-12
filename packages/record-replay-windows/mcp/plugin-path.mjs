import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function pluginPath(...parts) {
  return path.join(pluginRoot, ...parts);
}
