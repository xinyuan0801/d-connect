import { describe, expect, test } from "vitest";
import { resolveIpcEndpoint } from "../src/ipc/endpoint.js";
import {
  findAllowAllWarningTargets,
  formatAllowAllWarning,
  startDaemon,
} from "../src/bootstrap/daemon.js";

const dataDir = process.platform === "win32" ? "C:\\tmp\\d-connect-test" : "/tmp/d-connect-test";

describe("start daemon helpers", () => {
  test("findAllowAllWarningTargets extracts wildcard allowlist projects", () => {
    const targets = findAllowAllWarningTargets({
      configVersion: 1,
      dataDir,
      projects: [
        {
          name: "public",
          platforms: [
            {
              type: "dingtalk",
              options: { allowFrom: "*", clientId: "id", clientSecret: "secret" },
            },
            {
              type: "discord",
              options: { allowFrom: "user-a" },
            },
          ],
          agent: { type: "qoder", options: {} },
          guard: { enabled: false },
        },
        {
          name: "closed",
          platforms: [
            {
              type: "discord",
              options: { allowFrom: "user-b" },
            },
          ],
          agent: { type: "qoder", options: {} },
          guard: { enabled: false },
        },
      ],
    });

    expect(targets).toEqual([{ projectName: "public", platformType: "dingtalk" }]);
  });

  test("formatAllowAllWarning formats only when targets exist", () => {
    expect(formatAllowAllWarning([])).toBeUndefined();
    expect(formatAllowAllWarning([{ projectName: "closed", platformType: "discord" }])).toContain(
      "closed / discord",
    );
    expect(formatAllowAllWarning([{ projectName: "demo", platformType: "dingtalk" }])).toContain("demo / dingtalk");
  });

  test("formatAllowAllWarning renders cli output for wildcard targets", () => {
    const warning = formatAllowAllWarning([
      {
        projectName: "demo",
        platformType: "dingtalk",
      },
      {
        projectName: "team",
        platformType: "discord",
      },
    ]);

    expect(warning).toContain('检测到 allowFrom = "*"');
    expect(warning).toContain("受影响的目标：");
    expect(warning).toContain("demo / dingtalk");
    expect(warning).toContain("team / discord");
  });

  test("resolveIpcEndpoint keeps platform-specific path stable", () => {
    expect(resolveIpcEndpoint(dataDir)).toContain("ipc.sock");
  });

  test("startDaemon is a callable function", () => {
    expect(typeof startDaemon).toBe("function");
    expect(startDaemon.length).toBeGreaterThanOrEqual(0);
  });
});
