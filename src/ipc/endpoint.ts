import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export interface ResolveIpcEndpointOptions {
  platform?: NodeJS.Platform;
}

function currentPlatform(options: ResolveIpcEndpointOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

export function isNamedPipeEndpoint(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\") || path.startsWith("\\\\?\\pipe\\");
}

function hashedPipeName(dataDir: string): string {
  const digest = createHash("sha256")
    .update(resolve(dataDir).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return `d-connect-${digest}`;
}

export function resolveIpcEndpoint(dataDir: string, options: ResolveIpcEndpointOptions = {}): string {
  if (currentPlatform(options) === "win32") {
    return `\\\\.\\pipe\\${hashedPipeName(dataDir)}`;
  }

  return join(dataDir, "ipc.sock");
}
