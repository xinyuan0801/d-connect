import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, payload, { encoding: "utf8", mode: 0o644 });
  await rename(tmp, path);
}
