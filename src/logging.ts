export type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel = "info", private readonly scope?: string) {}

  private canLog(target: LogLevel): boolean {
    return levelWeight[target] >= levelWeight[this.level];
  }

  private fmt(msg: string, meta?: Record<string, unknown>): string {
    const prefix = this.scope ? `[${this.scope}] ` : "";
    if (!meta || Object.keys(meta).length === 0) {
      return `${prefix}${msg}`;
    }
    return `${prefix}${msg} ${JSON.stringify(meta)}`;
  }

  child(scope: string): Logger {
    const nextScope = this.scope ? `${this.scope}:${scope}` : scope;
    return new Logger(this.level, nextScope);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (!this.canLog("debug")) return;
    console.debug(this.fmt(msg, meta));
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    if (!this.canLog("info")) return;
    console.info(this.fmt(msg, meta));
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (!this.canLog("warn")) return;
    console.warn(this.fmt(msg, meta));
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    if (!this.canLog("error")) return;
    console.error(this.fmt(msg, meta));
  }
}
