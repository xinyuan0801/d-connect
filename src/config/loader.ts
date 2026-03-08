import { access, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configSchema, type AppConfig } from "./schema.js";
import { validateConfigBusinessRules } from "./validator.js";
import { ensureDir } from "../infra/store-json/atomic.js";

export interface ResolvePathOptions {
  cwd?: string;
  homeDir?: string;
}

export function resolveConfigPath(explicitPath?: string, opts: ResolvePathOptions = {}): string {
  if (explicitPath) {
    return explicitPath;
  }

  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? homedir();

  const localPath = join(cwd, "config.json");
  const homePath = join(homeDir, ".d-connect", "config.json");

  if (existsSync(localPath)) {
    return localPath;
  }
  return homePath;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrapConfig(path: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(defaultConfigTemplate(), null, 2)}\n`, "utf8");
}

function defaultConfigTemplate(): AppConfig {
  return {
    configVersion: 1,
    log: { level: "info" },
    loop: { silent: false },
    projects: [
      {
        name: "my-backend",
        agent: {
          type: "claudecode",
          options: {
            workDir: "/path/to/repo",
            mode: "default",
            model: "claude-sonnet-4-20250514",
            cmd: "claude",
          },
        },
        guard: {
          enabled: false,
        },
        platforms: [
          {
            type: "dingtalk",
            options: {
              clientId: "dingxxxx",
              clientSecret: "xxxx",
              allowFrom: "*",
              processingNotice: "处理中...",
            },
          },
        ],
      },
    ],
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config parse error: ${(error as Error).message}`);
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, "dataDir")
  ) {
    throw new Error("config validation error: \"dataDir\" is no longer supported; runtime data is stored in .d-connect automatically");
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, "cron")
  ) {
    throw new Error("config validation error: \"cron\" has been renamed to \"loop\"");
  }

  const config = configSchema.parse(parsed);
  return validateConfigBusinessRules(config);
}
