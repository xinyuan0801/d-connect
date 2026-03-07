import { join } from "node:path";
import { homedir } from "node:os";
import { type AppConfig } from "./schema.js";

export function validateConfigBusinessRules(config: AppConfig): AppConfig {
  const projectNames = new Set<string>();
  for (const project of config.projects) {
    if (projectNames.has(project.name)) {
      throw new Error(`config validation error: duplicate project name "${project.name}"`);
    }
    projectNames.add(project.name);
  }

  return {
    ...config,
    dataDir: config.dataDir ?? join(homedir(), ".d-connect"),
  };
}

