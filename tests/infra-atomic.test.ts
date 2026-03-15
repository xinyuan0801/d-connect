import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeJsonAtomic } from "../src/infra/store-json/atomic.js";

describe("atomic JSON write", () => {
  test("creates missing directories and writes formatted JSON with trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-connect-store-json-"));
    const targetPath = join(root, "nested", "state", "sessions.json");

    const payload = {
      app: "d-connect",
      nested: {
        enabled: true,
      },
    };

    await writeJsonAtomic(targetPath, payload);

    const actual = await readFile(targetPath, "utf8");
    expect(actual).toBe(`${JSON.stringify(payload, null, 2)}\n`);

    const files = await readdir(join(root, "nested", "state"));
    expect(files).toEqual(["sessions.json"]);
  });
});
