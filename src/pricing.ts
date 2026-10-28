import type Anthropic from "@anthropic-ai/sdk";
import { ByokError } from "./errors.js";

/** US dollars per million tokens for each kind of token a request is billed for. */
export interface PriceRates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface ModelPrice extends PriceRates {
  /**
   * Higher rates for long prompts (Claude Haiku 5.5). A request whose prompt is
   * over `aboveTokens`, counting cache reads and writes, pays these instead.
   */
  longPrompt?: { aboveTokens: number; rates: PriceRates };
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** When PRICES was last checked against https://platform.claude.com/docs/en/about-claude/pricing */
export const PRICES_CHECKED = "2026-10-28";

const opus5Rates: ModelPrice = { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 };
const sonnet45Rates: ModelPrice = { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 };

/**
 * Claude API (first-party) list prices in USD per million tokens. Batch, fast
 * mode and US-only inference change these; the kit uses none of them.
 */
export const PRICES: PriceTable = {
  "claude-fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "claude-fable-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  "claude-opus-5-5": { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
  "claude-opus-5": opus5Rates,
  "claude-opus-4-8": opus5Rates,
  "claude-opus-4-7": opus5Rates,
  "claude-opus-4-6": opus5Rates,
  "claude-opus-4-5": opus5Rates,
  "claude-sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  "claude-sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  "claude-sonnet-4-6": sonnet45Rates,
  "claude-sonnet-4-5": sonnet45Rates,
  "claude-haiku-5-5": {
    input: 0.1,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    output: 0.5,
    longPrompt: {
      aboveTokens: 100_000,
      rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    },
  },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
};

/** Web search is billed per search on top of tokens: $10 per 1,000. */
export const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string, prices: PriceTable = PRICES): ModelPrice {
  const price = prices[model];
  if (!price) {
    throw new ByokError("bad_config", `No price is known for model "${model}". Add it to the site's prices.`);
  }
  return price;
}

function ratesForPrompt(price: ModelPrice, promptTokens: number): PriceRates {
  return price.longPrompt && promptTokens > price.longPrompt.aboveTokens ? price.longPrompt.rates : price;
}

/** A dollar amount for `tokens` at `perMillion` dollars per million tokens. */
function dollars(tokens: number, perMillion: number): number {
  return (tokens * perMillion) / 1_000_000;
}

/**
 * The cost in USD of one response, from its `usage`. Nullable fields count as
 * zero. Cache writes without a TTL breakdown are priced at the 5-minute rate,
 * the API's default; any part of the total the breakdown doesn't explain is
 * priced at the dearer 1-hour rate.
 */
export function costOfUsage(model: string, usage: Anthropic.Usage, prices: PriceTable = PRICES): number {
  const price = priceFor(model, prices);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const rates = ratesForPrompt(price, usage.input_tokens + cacheWrite + cacheRead);

  let writeCost: number;
  if (usage.cache_creation) {
    const { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h } = usage.cache_creation;
    const unexplained = Math.max(0, cacheWrite - w5m - w1h);
    writeCost = dollars(w5m, rates.cacheWrite5m) + dollars(w1h + unexplained, rates.cacheWrite1h);
  } else {
    writeCost = dollars(cacheWrite, rates.cacheWrite5m);
  }

  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    dollars(usage.input_tokens, rates.input) +
    writeCost +
    dollars(cacheRead, rates.cacheRead) +
    dollars(usage.output_tokens, rates.output) +
    searches * WEB_SEARCH_USD
  );
}

/**
 * The most a request can cost: every prompt token at the dearest input rate
 * (a 1-hour cache write) and the full `max_tokens` of output.
 */
export function worstCaseCost(
  model: string,
  promptTokens: number,
  maxTokens: number,
  prices: PriceTable = PRICES,
): number {
  const rates = ratesForPrompt(priceFor(model, prices), promptTokens);
  const dearestInput = Math.max(rates.input, rates.cacheWrite5m, rates.cacheWrite1h);
  return dollars(promptTokens, dearestInput) + dollars(maxTokens, rates.output);
}

/** Room for the tokens the API adds around messages (role markers and the like). */
const PROMPT_OVERHEAD_TOKENS = 1024;

/**
 * A deliberately high estimate of a request's prompt tokens: one token per
 * UTF-8 byte of its text, plus a fixed allowance. Real counts are usually a
 * quarter to a third of this, so the budget errs towards stopping early.
 */
export function estimatePromptTokens(parts: { system?: string; messages: readonly Anthropic.MessageParam[] }): number {
  const text = JSON.stringify([parts.system ?? "", parts.messages]);
  return new TextEncoder().encode(text).length + PROMPT_OVERHEAD_TOKENS;
}
