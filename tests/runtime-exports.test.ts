import { describe, expect, test } from "vitest";

import * as runtimeIndex from "../src/runtime/index.js";
import * as runtimeTypes from "../src/runtime/types.js";

describe("runtime module re-exports", () => {
  test("runtime/index exports runtime modules", () => {
    expect(runtimeIndex).toHaveProperty("RuntimeEngine");
    expect(runtimeIndex).toHaveProperty("SessionStore");
    expect(runtimeIndex).toHaveProperty("createSessionStore");
    expect(runtimeIndex).toHaveProperty("formatResponseFromEvents");
    expect(runtimeIndex).toHaveProperty("splitResponseMessages");
    expect(runtimeIndex).toHaveProperty("summarizeToolMessages");
  });

  test("runtime/types re-exports core types", () => {
    expect(runtimeTypes).toBeTypeOf("object");
  });
});
