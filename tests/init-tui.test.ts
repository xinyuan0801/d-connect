import { describe, expect, test } from "vitest";
import { bannerLines, formatWizardProgress, stepMood } from "../src/config/init-tui.js";

describe("init tui helpers", () => {
  test("bannerLines returns stable ascii art copy", () => {
    const first = bannerLines();
    expect(first.length).toBe(1);
    expect(first[0]).toBe("ᐡ ᐧ ﻌ ᐧ ᐡ");

    first[0] = "mutated";
    expect(bannerLines()[0]).not.toBe("mutated");
  });

  test("formatWizardProgress renders bounded progress bar", () => {
    expect(formatWizardProgress(3, 6, 10)).toBe("[█████░░░░░] 50%");
    expect(formatWizardProgress(-1, 4, 8)).toBe("[░░░░░░░░] 0%");
    expect(formatWizardProgress(10, 4, 8)).toBe("[████████] 100%");
    expect(formatWizardProgress(1, 0, 2)).toBe("[████] 100%");
  });

  test("stepMood maps different sections", () => {
    expect(stepMood("agentType")).toContain("AGENT");
    expect(stepMood("platformType")).toContain("PLATFORM");
    expect(stepMood("confirm")).toContain("FINAL");
    expect(stepMood("dataDir")).toContain("BASE");
  });
});
