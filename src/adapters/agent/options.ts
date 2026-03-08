export interface BaseAgentOptions {
  cmd?: string;
  args?: string[];
  workDir?: string;
  mode?: string;
  model?: string;
  env?: Record<string, string>;
  promptArg?: string;
  stdinPrompt?: boolean;
}
