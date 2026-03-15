import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSessionStore } from "../src/runtime/session-store.js";

describe("session store", () => {
  test("lock semantics and persistence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-session-"));
    const store = await createSessionStore(dataDir);

    const session = store.getOrCreateActive("project:user");
    expect(store.tryLock(session)).toBe(true);
    expect(store.tryLock(session)).toBe(false);

    store.unlock(session);
    expect(store.tryLock(session)).toBe(true);
    store.unlock(session);

    store.addHistory(session, "user", "hello");
    store.addHistory(session, "assistant", "world");
    store.setDeliveryTarget("project:user", {
      platform: "dingtalk",
      payload: {
        chatId: "oc_123",
      },
    });
    await store.save();

    const restored = await createSessionStore(dataDir);
    const loaded = restored.getOrCreateActive("project:user");
    expect(loaded.history).toHaveLength(2);
    expect(loaded.history[0]?.content).toBe("hello");
    expect(loaded.history[1]?.content).toBe("world");
    expect(restored.getDeliveryTarget("project:user")).toEqual({
      platform: "dingtalk",
      payload: {
        chatId: "oc_123",
      },
    });
  });

  test("returns sessions by id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "d-connect-session-id-"));
    const store = await createSessionStore(dataDir);

    const session = store.getOrCreateActive("project:user");
    expect(store.getById(session.id)).toBe(session);
    expect(store.getById("missing")).toBeUndefined();
  });
});
