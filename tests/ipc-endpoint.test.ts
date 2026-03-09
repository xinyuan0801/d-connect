import { describe, expect, test } from "vitest";
import { isNamedPipeEndpoint, resolveIpcEndpoint } from "../src/ipc/endpoint.js";

describe("ipc endpoint resolver", () => {
  test("returns unix socket path on non-windows platforms", () => {
    expect(resolveIpcEndpoint("/tmp/d-connect", { platform: "linux" })).toBe("/tmp/d-connect/ipc.sock");
    expect(resolveIpcEndpoint("/tmp/d-connect", { platform: "darwin" })).toBe("/tmp/d-connect/ipc.sock");
  });

  test("returns deterministic named pipe on windows", () => {
    const a = resolveIpcEndpoint("C:\\Work\\Repo\\.d-connect", { platform: "win32" });
    const b = resolveIpcEndpoint("C:\\Work\\Repo\\.d-connect", { platform: "win32" });

    expect(a).toMatch(/^\\\\\.\\pipe\\d-connect-[0-9a-f]{24}$/);
    expect(a).toBe(b);
  });

  test("normalizes casing when hashing windows data dir", () => {
    const upper = resolveIpcEndpoint("C:\\WORK\\REPO\\.d-connect", { platform: "win32" });
    const lower = resolveIpcEndpoint("c:\\work\\repo\\.d-connect", { platform: "win32" });
    expect(upper).toBe(lower);
  });

  test("detects named pipe endpoints", () => {
    expect(isNamedPipeEndpoint("\\\\.\\pipe\\d-connect-abc")).toBe(true);
    expect(isNamedPipeEndpoint("\\\\?\\pipe\\d-connect-abc")).toBe(true);
    expect(isNamedPipeEndpoint("/tmp/d-connect/ipc.sock")).toBe(false);
  });
});
