import { describe, expect, it } from "vitest";
import { SessionBudget, formatUsd } from "../src/budget.js";
import { ByokError } from "../src/errors.js";

describe("SessionBudget", () => {
  it("rejects a limit that isn't a positive number", () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SessionBudget(limit)).toThrow(ByokError);
    }
  });

  it("holds a reservation until it is settled with the real cost", () => {
    const budget = new SessionBudget(1);
    const reservation = budget.reserve(0.4);
    expect(budget.snapshot()).toEqual({ limitUsd: 1, spentUsd: 0, reservedUsd: 0.4, remainingUsd: 0.6 });

    budget.settle(reservation, 0.05);
    expect(budget.snapshot()).toEqual({ limitUsd: 1, spentUsd: 0.05, reservedUsd: 0, remainingUsd: 0.95 });
  });

  it("frees a reservation that was never billed", () => {
    const budget = new SessionBudget(1);
    budget.release(budget.reserve(0.4));
    expect(budget.spentUsd).toBe(0);
    expect(budget.remainingUsd).toBe(1);
  });

  it("refuses a request that could take spending past the limit", () => {
    const budget = new SessionBudget(0.1);
    budget.settle(budget.reserve(0.05), 0.08);
    let caught: unknown;
    try {
      budget.reserve(0.03);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ByokError);
    expect((caught as ByokError).code).toBe("budget_exceeded");
    expect((caught as ByokError).message).toContain("only $0.02 of this session's $0.10 budget is left");
  });

  it("allows a request that exactly uses up the rest", () => {
    const budget = new SessionBudget(0.5);
    budget.reserve(0.5);
    expect(budget.remainingUsd).toBe(0);
  });

  it("says plainly when the budget is used up", () => {
    const budget = new SessionBudget(0.1);
    budget.settle(budget.reserve(0.1), 0.1);
    expect(() => budget.reserve(0.001)).toThrow("This session's $0.10 budget is used up ($0.10 spent).");
  });

  it("counts requests in flight together, so they can't overshoot as a group", () => {
    const budget = new SessionBudget(1);
    budget.reserve(0.6);
    expect(() => budget.reserve(0.6)).toThrow(ByokError);
    budget.reserve(0.4);
    expect(budget.remainingUsd).toBe(0);
  });

  it("ignores a second settle of the same reservation", () => {
    const budget = new SessionBudget(1);
    const reservation = budget.reserve(0.2);
    budget.settle(reservation, 0.1);
    budget.settle(reservation, 0.1);
    expect(budget.spentUsd).toBeCloseTo(0.1, 12);
  });

  it("never reports a negative remainder", () => {
    const budget = new SessionBudget(0.1);
    budget.settle(budget.reserve(0.1), 0.15);
    expect(budget.remainingUsd).toBe(0);
  });
});

describe("formatUsd", () => {
  it("shows cents, or four decimals under a cent", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd(0.0000145)).toBe("under $0.0001");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
