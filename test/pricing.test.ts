import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ByokError } from "../src/errors.js";
import { PRICES, costOfUsage, estimatePromptTokens, worstCaseCost } from "../src/pricing.js";

function usage(fields: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...fields,
  };
}

describe("price table", () => {
  it("matches the published rates for the current models", () => {
    expect(PRICES["claude-opus-5-5"]).toEqual({ input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 });
    expect(PRICES["claude-sonnet-5-5"]).toEqual({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 });
    expect(PRICES["claude-fable-5-1"]).toEqual({ input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 });
    expect(PRICES["claude-haiku-5-5"]?.longPrompt).toEqual({
      aboveTokens: 100_000,
      rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    });
  });

  it("has only positive rates", () => {
    for (const [model, price] of Object.entries(PRICES)) {
      for (const rate of [price.input, price.cacheWrite5m, price.cacheWrite1h, price.cacheRead, price.output]) {
        expect(rate, model).toBeGreaterThan(0);
      }
    }
  });
});

describe("costOfUsage", () => {
  it("prices input and output tokens", () => {
    // 1,000 × $4/M + 2,000 × $20/M
    expect(costOfUsage("claude-opus-5-5", usage({ input_tokens: 1000, output_tokens: 2000 }))).toBeCloseTo(0.044, 12);
  });

  it("prices cache writes by TTL and cache reads", () => {
    const cost = costOfUsage(
      "claude-opus-5-5",
      usage({
        input_tokens: 100,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
        cache_read_input_tokens: 10_000,
      }),
    );
    // 100×4 + 1,000×5 + 2,000×8 + 10,000×0.2 = 23,400 per million
    expect(cost).toBeCloseTo(0.0234, 12);
  });

  it("prices cache writes with no TTL breakdown at the 5-minute rate", () => {
    expect(costOfUsage("claude-opus-5-5", usage({ cache_creation_input_tokens: 1000 }))).toBeCloseTo(0.005, 12);
  });

  it("prices cache writes the breakdown doesn't explain at the 1-hour rate", () => {
    const cost = costOfUsage(
      "claude-opus-5-5",
      usage({
        cache_creation_input_tokens: 1500,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
      }),
    );
    // 1,000×5 + 500×8
    expect(cost).toBeCloseTo(0.009, 12);
  });

  it("uses Haiku 5.5's standard rates up to a 100,000-token prompt", () => {
    const cost = costOfUsage("claude-haiku-5-5", usage({ input_tokens: 100_000, output_tokens: 1000 }));
    expect(cost).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
  });

  it("uses Haiku 5.5's long-prompt rates above 100,000 tokens, counting cache reads", () => {
    const cost = costOfUsage(
      "claude-haiku-5-5",
      usage({ input_tokens: 99_000, cache_read_input_tokens: 1001, output_tokens: 1000 }),
    );
    expect(cost).toBeCloseTo((99_000 * 0.5 + 1001 * 0.05 + 1000 * 2.5) / 1e6, 12);
  });

  it("adds $0.01 per web search", () => {
    const cost = costOfUsage(
      "claude-sonnet-5-5",
      usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } }),
    );
    expect(cost).toBeCloseTo(0.03, 12);
  });

  it("refuses a model with no known price", () => {
    expect(() => costOfUsage("claude-imaginary-9", usage({ input_tokens: 1 }))).toThrow(ByokError);
  });

  it("accepts a site-supplied price table", () => {
    const prices = { "my-model": { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 3 } };
    expect(costOfUsage("my-model", usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), prices)).toBeCloseTo(4, 12);
  });
});

describe("worstCaseCost", () => {
  it("assumes every prompt token is a 1-hour cache write and the full max_tokens of output", () => {
    // 1,000 × $8/M + 4,000 × $20/M
    expect(worstCaseCost("claude-opus-5-5", 1000, 4000)).toBeCloseTo(0.088, 12);
  });

  it("is never less than the real cost of any usage within those limits", () => {
    const promptTokens = 5000;
    const maxTokens = 2000;
    const worst = worstCaseCost("claude-opus-5-5", promptTokens, maxTokens);
    const shapes: Partial<Anthropic.Usage>[] = [
      { input_tokens: promptTokens, output_tokens: maxTokens },
      { cache_creation_input_tokens: promptTokens, output_tokens: maxTokens },
      {
        cache_creation_input_tokens: promptTokens,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: promptTokens },
        output_tokens: maxTokens,
      },
      { cache_read_input_tokens: promptTokens, output_tokens: maxTokens },
    ];
    for (const shape of shapes) {
      expect(costOfUsage("claude-opus-5-5", usage(shape))).toBeLessThanOrEqual(worst + 1e-12);
    }
  });

  it("switches Haiku 5.5 to long-prompt rates above 100,000 tokens", () => {
    expect(worstCaseCost("claude-haiku-5-5", 100_000, 0)).toBeCloseTo((100_000 * 0.2) / 1e6, 12);
    expect(worstCaseCost("claude-haiku-5-5", 100_001, 0)).toBeCloseTo((100_001 * 1) / 1e6, 12);
  });
});

describe("estimatePromptTokens", () => {
  it("counts UTF-8 bytes plus a fixed allowance, so it over-estimates", () => {
    const short = estimatePromptTokens({ messages: [{ role: "user", content: "hi" }] });
    const accented = estimatePromptTokens({ messages: [{ role: "user", content: "héé" }] });
    expect(short).toBeGreaterThan(1024);
    // Each "é" is two bytes.
    expect(accented - short).toBe(3);
  });

  it("includes the system prompt", () => {
    const without = estimatePromptTokens({ messages: [{ role: "user", content: "hi" }] });
    const withSystem = estimatePromptTokens({ system: "Be brief.", messages: [{ role: "user", content: "hi" }] });
    expect(withSystem - without).toBe("Be brief.".length);
  });
});
