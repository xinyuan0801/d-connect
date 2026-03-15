import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Logger } from "../src/infra/logging/logger.js";

describe("logger", () => {
  let tmpRoot: string | undefined;

  afterEach(async () => {
    await Logger.closeFile();
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
    vi.restoreAllMocks();
  });

  test("filters messages lower than configured level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new Logger("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("adds scope to child logger output", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = new Logger("info", "runtime");
    logger.child("loop").warn("loop tick");

    const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[runtime:loop]");
    expect(message).toContain("loop tick");
  });

  test("writes debug logs when logger level is debug", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = new Logger("debug");
    logger.debug("debug message");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0]?.[0] ?? "")).toContain("debug message");
  });

  test("writes logs to configured file", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "d-connect-logger-"));
    const logPath = join(tmpRoot, "d-connect.log");

    await Logger.configureFile(logPath);
    const logger = new Logger("info", "daemon");
    logger.info("startup complete", { project: "demo" });
    await Logger.closeFile();

    const actual = await readFile(logPath, "utf8");
    expect(actual).toContain("INFO");
    expect(actual).toContain("startup complete");
    expect(actual).toContain('"project":"demo"');
    expect(actual).toContain("[daemon]");
  });
});
