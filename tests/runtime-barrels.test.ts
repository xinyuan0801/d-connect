import { describe, expect, test } from "vitest";

describe("runtime barrel exports", () => {
  test("loads runtime module exports", async () => {
    const runtime = await import("../src/runtime/index.js");

    expect(typeof runtime.RuntimeEngine).toBe("function");
    expect(typeof runtime.SessionStore).toBe("function");
    expect(typeof runtime.createSessionStore).toBe("function");
    expect(typeof runtime.splitResponseMessages).toBe("function");
    expect(typeof runtime.summarizeToolMessages).toBe("function");
    expect(typeof runtime.formatResponseFromEvents).toBe("function");
  });

  test("loads runtime types module exports", async () => {
    const runtimeTypes = await import("../src/runtime/types.js");

    expect(runtimeTypes).toBeDefined();
    expect(runtimeTypes).toBeTypeOf("object");
  });
});
