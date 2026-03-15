import { describe, expect, test } from "vitest";
import { createDeliveryTarget } from "../src/adapters/platform/shared/delivery-target.js";
import { parseAllowList } from "../src/adapters/platform/shared/allow-list.js";

describe("platform allow-list parser", () => {
  test("returns null for wildcard and blank values", () => {
    expect(parseAllowList("*")).toBe(null);
    expect(parseAllowList("")).toBe(null);
    expect(parseAllowList("   ")).toEqual(new Set());
  });

  test("splits comma-separated allow list and trims whitespace", () => {
    expect(parseAllowList("u1, u2, u3")).toEqual(new Set(["u1", "u2", "u3"]));
    expect(parseAllowList("u1,,u2")).toEqual(new Set(["u1", "u2"]));
    expect(parseAllowList("a , ,  b ,")).toEqual(new Set(["a", "b"]));
  });

  test("deduplicates repeated users", () => {
    expect(parseAllowList("u1,u2,u1, u2")).toEqual(new Set(["u1", "u2"]));
  });
});

describe("delivery target factory", () => {
  test("builds a platform target payload", () => {
    expect(createDeliveryTarget("discord", { channelId: "123" })).toEqual({
      platform: "discord",
      payload: { channelId: "123" },
    });
  });
});
