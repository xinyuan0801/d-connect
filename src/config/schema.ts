import { z } from "zod";

const logSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict()
  .default({ level: "info" });

const cronSchema = z
  .object({
    silent: z.boolean().default(false),
  })
  .strict()
  .default({ silent: false });

const agentSchema = z.object({
  type: z.enum(["claudecode", "qoder", "iflow"]),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

const platformSchema = z.object({
  type: z.literal("dingtalk"),
  options: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    allowFrom: z.string().default("*"),
  }).strict(),
}).strict();

const feishuPlatformSchema = z.object({
  type: z.literal("feishu"),
  options: z.object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    allowFrom: z.string().default("*"),
    groupReplyAll: z.boolean().default(false),
    reactionEmoji: z.string().default("OnIt"),
  }).strict(),
}).strict();

const projectSchema = z.object({
  name: z.string().min(1),
  agent: agentSchema,
  platforms: z.array(z.discriminatedUnion("type", [platformSchema, feishuPlatformSchema])).min(1),
}).strict();

export const configSchema = z.object({
  configVersion: z.number().int().positive().default(1),
  dataDir: z.string().optional(),
  log: logSchema,
  cron: cronSchema,
  projects: z.array(projectSchema).min(1),
}).strict();

export type AppConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
