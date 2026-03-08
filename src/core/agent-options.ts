export interface BaseAgentOptions {
  cmd?: string;
  args?: string[];
  workDir?: string;
  model?: string;
  env?: Record<string, string>;
  promptArg?: string;
  stdinPrompt?: boolean;
  [key: string]: unknown;
}
