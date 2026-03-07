import { createWriteStream, type WriteStream } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private static fileStream?: WriteStream;

  constructor(private readonly level: LogLevel = "info", private readonly scope?: string) {}

  static async configureFile(filePath: string): Promise<void> {
    await Logger.closeFile();

    const stream = createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", (error) => {
      console.error(`${new Date().toISOString()} ERROR [logger] file sink failed ${JSON.stringify({ error: error.message, filePath })}`);
    });
    Logger.fileStream = stream;
  }

  static async closeFile(): Promise<void> {
    const stream = Logger.fileStream;
    Logger.fileStream = undefined;
    if (!stream) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(() => resolve());
    });
  }

  private canLog(target: LogLevel): boolean {
    return levelWeight[target] >= levelWeight[this.level];
  }

  private fmt(target: LogLevel, msg: string, meta?: Record<string, unknown>): string {
    const prefix = this.scope ? `[${this.scope}] ` : "";
    const head = `${new Date().toISOString()} ${target.toUpperCase()}`;
    if (!meta || Object.keys(meta).length === 0) {
      return `${head} ${prefix}${msg}`;
    }
    return `${head} ${prefix}${msg} ${JSON.stringify(meta)}`;
  }

  private write(target: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (!this.canLog(target)) return;

    const line = this.fmt(target, msg, meta);
    Logger.fileStream?.write(`${line}\n`);

    switch (target) {
      case "debug":
        console.debug(line);
        break;
      case "info":
        console.info(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
  }

  child(scope: string): Logger {
    const nextScope = this.scope ? `${this.scope}:${scope}` : scope;
    return new Logger(this.level, nextScope);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.write("error", msg, meta);
  }
}
