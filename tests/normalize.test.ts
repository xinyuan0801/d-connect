import { describe, expect, test } from "vitest";
import { normalizeConfig, resolveDataDir } from "../src/config/normalize.js";

describe("config normalization", () => {
  test("uses provided config directory directly when inside .d-connect", () => {
    expect(resolveDataDir("/workspace/.d-connect/config.json")).toBe("/workspace/.d-connect");
  });

  test("keeps discord platform config when normalizing", () => {
    const config = {
      configVersion: 1,
      log: {
        level: "info",
      },
      loop: {
        silent: false,
      },
      projects: [
        {
          name: "demo",
          agent: {
            type: "qoder",
            options: {},
          },
          guard: {
            enabled: false,
          },
          platforms: [
            {
              type: "discord",
              options: {
                botToken: "discord-token",
                allowFrom: "a,b",
                requireMention: false,
              },
            },
          ],
        },
      ],
    } as any;

    const normalized = normalizeConfig(config);
    expect(normalized.projects[0].platforms[0]).toEqual({
      type: "discord",
      options: {
        botToken: "discord-token",
        allowFrom: "a,b",
        requireMention: false,
      },
    });
  });

  test("supports explicit unknown platform type fallback branch", () => {
    const config = {
      configVersion: 1,
      log: {
        level: "info",
      },
      loop: {
        silent: false,
      },
      projects: [
        {
          name: "demo",
          agent: {
            type: "qoder",
            options: {
              cmd: "qodercli",
            },
          },
          guard: {
            enabled: false,
          },
          platforms: [
            {
              type: "unknown",
              options: {},
            },
          ],
        },
      ],
    } as any;

    expect(() => normalizeConfig(config)).toThrow("unsupported platform type: unknown");
  });

  test("keeps dingtalk platform config when normalizing", () => {
    const config = {
      configVersion: 1,
      log: {
        level: "info",
      },
      loop: {
        silent: false,
      },
      projects: [
        {
          name: "demo",
          agent: {
            type: "qoder",
            options: {
              cmd: "qodercli",
            },
          },
          guard: {
            enabled: false,
          },
          platforms: [
            {
              type: "dingtalk",
              options: {
                clientId: "ding-id",
                clientSecret: "ding-secret",
              },
            },
          ],
        },
      ],
    } as any;

    const normalized = normalizeConfig(config);
    expect(normalized.projects[0].platforms[0]).toEqual({
      type: "dingtalk",
      options: {
        clientId: "ding-id",
        clientSecret: "ding-secret",
      },
    });
  });
});
