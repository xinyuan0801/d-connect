import { z } from "zod";

const logSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict()
  .default({ level: "info" });

const loopSchema = z
  .object({
    silent: z.boolean().default(false),
  })
  .strict()
  .default({ silent: false });

const guardSchema = z
  .object({
    enabled: z.boolean().default(false),
    rules: z.string().trim().min(1).optional(),
  })
  .strict()
  .default({ enabled: false });

export const baseAgentOptionsSchema = z
  .object({
    cmd: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    workDir: z.string().min(1).optional(),
    model: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    promptArg: z.string().min(1).optional(),
    stdinPrompt: z.boolean().optional(),
  })
  .catchall(z.unknown());

const claudecodeAgentSchema = z
  .object({
    type: z.literal("claudecode"),
    options: baseAgentOptionsSchema.default({}),
  })
  .strict();

const qoderAgentSchema = z
  .object({
    type: z.literal("qoder"),
    options: baseAgentOptionsSchema.default({}),
  })
  .strict();

const iflowAgentSchema = z
  .object({
    type: z.literal("iflow"),
    options: baseAgentOptionsSchema.default({}),
  })
  .strict();

const agentSchema = z.discriminatedUnion("type", [claudecodeAgentSchema, qoderAgentSchema, iflowAgentSchema]);

const dingtalkPlatformSchema = z.object({
  type: z.literal("dingtalk"),
  options: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    allowFrom: z.string().default("*"),
    processingNotice: z.string().default("处理中..."),
  }).strict(),
}).strict();

const discordPlatformSchema = z.object({
  type: z.literal("discord"),
  options: z.object({
    botToken: z.string().min(1),
    allowFrom: z.string().default("*"),
    requireMention: z.boolean().default(true),
  }).strict(),
}).strict();

const platformSchema = z.discriminatedUnion("type", [dingtalkPlatformSchema, discordPlatformSchema]);

const projectSchema = z.object({
  name: z.string().min(1),
  agent: agentSchema,
  guard: guardSchema,
  platforms: z.array(platformSchema).min(1),
}).strict();

export const configSchema = z.object({
  configVersion: z.number().int().positive().default(1),
  log: logSchema,
  loop: loopSchema,
  projects: z.array(projectSchema).min(1),
}).strict();

export type AppConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type BaseAgentOptionsConfig = z.infer<typeof baseAgentOptionsSchema>;
