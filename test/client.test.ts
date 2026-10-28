// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createByokClaude, type ByokClaudeConfig } from "../src/client.js";
import { ByokError } from "../src/errors.js";
import { DEFAULT_STORAGE_KEY } from "../src/key.js";
import { estimatePromptTokens, worstCaseCost } from "../src/pricing.js";

// A made-up key in the right shape. No real key is used anywhere in these tests,
// and the network is replaced with a stub, so nothing leaves the test process.
const KEY = "sk-ant-api03-TESTKEY-not-a-real-key-0000000000000000";

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

let sent: Sent[];
let respond: (body: Record<string, unknown>) => Response;
let consoleCalls: unknown[][];

function sse(events: object[]): Response {
  const text = events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function answer(
  body: Record<string, unknown>,
  text: string,
  { input = 12, output = 34, stop = "end_turn" }: { input?: number; output?: number; stop?: string } = {},
): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } },
    { type: "message_stop" },
  ]);
}

function apiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}

function config(overrides: Partial<ByokClaudeConfig> = {}): ByokClaudeConfig {
  return { models: ["claude-opus-5-5", "claude-haiku-5-5"], maxTokens: 2000, sessionBudgetUsd: 1, ...overrides };
}

async function caught(promise: Promise<unknown>): Promise<ByokError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ByokError);
    return error as ByokError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  sent = [];
  consoleCalls = [];
  localStorage.clear();
  respond = (body) => answer(body, "Hello from the stub.");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return request.text().then((body) => {
        sent.push({ url: request.url, headers: request.headers, body });
        return respond(JSON.parse(body) as Record<string, unknown>);
      });
    }),
  );
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  // Nothing the kit or the SDK printed may contain the key.
  expect(JSON.stringify(consoleCalls)).not.toContain(KEY);
});

describe("where the key goes", () => {
  it("sends requests only to api.anthropic.com, with the key only in the Authorization header", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const result = await claude.ask({ prompt: "Hi" });

    expect(result.text).toBe("Hello from the stub.");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(new URL(request?.url ?? "").origin).toBe("https://api.anthropic.com");
    expect(new URL(request?.url ?? "").pathname).toBe("/v1/messages");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(request?.body).not.toContain(KEY);
    const otherHeaders = [...(request?.headers.entries() ?? [])].filter(([name]) => name !== "authorization");
    expect(JSON.stringify(otherHeaders)).not.toContain(KEY);
  });

  it("keeps the key out of storage unless the visitor asks to remember it", async () => {
    const claude = createByokClaude(config({ allowRememberKey: true }));
    claude.setKey(KEY);
    await claude.ask({ prompt: "Hi" });
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify(claude.getState())).not.toContain(KEY);
  });

  it("stops using the key after forget, and sends nothing", async () => {
    const claude = createByokClaude(config({ allowRememberKey: true }));
    claude.setKey(KEY, { remember: true });
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBe(KEY);

    claude.forgetKey();
    expect(claude.getState().hasKey).toBe(false);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
    expect((await caught(claude.ask({ prompt: "Hi" }))).code).toBe("no_key");
    expect(sent).toHaveLength(0);
  });

  it("keeps the key out of error messages when Anthropic rejects it", async () => {
    respond = () => apiError(401, "authentication_error", `invalid x-api-key ${KEY}`);
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const error = await caught(claude.ask({ prompt: "Hi" }));
    expect(error.code).toBe("auth_failed");
    expect(error.message).not.toContain(KEY);
    expect(String(error)).not.toContain(KEY);
  });

  it("has no network or console calls of its own in the library source", () => {
    const dir = join(import.meta.dirname, "..", "src");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|console\./);
    }
  });
});

describe("model allowlist", () => {
  it("uses the first allowed model by default", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    await claude.ask({ prompt: "Hi" });
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("allows another listed model", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const result = await claude.ask({ prompt: "Hi", model: "claude-haiku-5-5" });
    expect(result.model).toBe("claude-haiku-5-5");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ model: "claude-haiku-5-5" });
  });

  it("refuses a model the site didn't list, before sending anything", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const error = await caught(claude.ask({ prompt: "Hi", model: "claude-fable-5-1" }));
    expect(error.code).toBe("model_not_allowed");
    expect(error.message).toContain("claude-opus-5-5, claude-haiku-5-5");
    expect(sent).toHaveLength(0);
    expect(claude.getState().budget.reservedUsd).toBe(0);
  });

  it("refuses at start-up to allow a model it can't price", () => {
    expect(() => createByokClaude(config({ models: ["claude-imaginary-9"] }))).toThrow(/No price is known/);
  });

  it("allows an extra model when the site supplies its price", () => {
    const prices = { "claude-imaginary-9": { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 1 } };
    expect(() => createByokClaude(config({ models: ["claude-imaginary-9"], prices }))).not.toThrow();
  });
});

describe("request limits", () => {
  it("sends the site's max_tokens cap by default and never more", async () => {
    const claude = createByokClaude(config({ maxTokens: 1500 }));
    claude.setKey(KEY);
    await claude.ask({ prompt: "Hi" });
    await claude.ask({ prompt: "Hi", maxTokens: 99_999 });
    await claude.ask({ prompt: "Hi", maxTokens: 300 });
    expect(sent.map((request) => (JSON.parse(request.body) as { max_tokens: number }).max_tokens)).toEqual([1500, 1500, 300]);
  });

  it("sends only the fields the kit controls", async () => {
    const claude = createByokClaude(config({ system: "Be brief.", effort: "low" }));
    claude.setKey(KEY);
    await claude.ask({ prompt: "Hi" });
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "stream", "system"]);
    expect(body).toMatchObject({ system: "Be brief.", output_config: { effort: "low" } });
  });

  it("refuses an empty question", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    expect((await caught(claude.ask({ prompt: "   " }))).code).toBe("invalid_request");
    expect(sent).toHaveLength(0);
  });
});

describe("session budget", () => {
  it("records each answer's real cost from usage", async () => {
    respond = (body) => answer(body, "ok", { input: 1000, output: 2000 });
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const result = await claude.ask({ prompt: "Hi" });
    expect(result.costUsd).toBeCloseTo(0.044, 12); // 1,000 × $4/M + 2,000 × $20/M
    expect(claude.getState().budget.spentUsd).toBeCloseTo(0.044, 12);
    expect(claude.getState().budget.reservedUsd).toBe(0);
  });

  it("stops before a request that could pass the budget, without sending it", async () => {
    respond = (body) => answer(body, "ok", { input: 10, output: 900 });
    const claude = createByokClaude(config({ models: ["claude-haiku-5-5"], maxTokens: 1000, sessionBudgetUsd: 0.001 }));
    claude.setKey(KEY);

    await claude.ask({ prompt: "Hi" });
    const error = await caught(claude.ask({ prompt: "Hi" }));
    expect(error.code).toBe("budget_exceeded");
    expect(error.message).toContain("budget is left");
    expect(sent).toHaveLength(1);
  });

  it("tells listeners when spending changes", async () => {
    const claude = createByokClaude(config());
    const listener = vi.fn();
    claude.subscribe(listener);
    claude.setKey(KEY);
    await claude.ask({ prompt: "Hi" });
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(claude.getState().budget.spentUsd).toBeGreaterThan(0);
    expect(claude.getState().busy).toBe(false);
  });

  it("frees the reservation when Anthropic refuses the request outright", async () => {
    respond = () => apiError(400, "invalid_request_error", "Your credit balance is too low.");
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const error = await caught(claude.ask({ prompt: "Hi" }));
    expect(error.code).toBe("request_rejected");
    expect(error.message).toContain("Your credit balance is too low.");
    expect(claude.getState().budget).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
  });

  it("charges the worst case when an answer breaks off after it started", async () => {
    respond = (body) => {
      const start = `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(start));
          controller.error(new Error("connection dropped"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const claude = createByokClaude(config({ maxTokens: 1000 }));
    claude.setKey(KEY);
    await caught(claude.ask({ prompt: "Hi" }));
    const worst = worstCaseCost(
      "claude-opus-5-5",
      estimatePromptTokens({ messages: [{ role: "user", content: "Hi" }] }),
      1000,
    );
    expect(claude.getState().budget.spentUsd).toBeCloseTo(worst, 12);
    expect(claude.getState().budget.reservedUsd).toBe(0);
  });
});

describe("answers and errors", () => {
  it("streams text to onText", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const seen: string[] = [];
    await claude.ask({ prompt: "Hi", onText: (_delta, soFar) => seen.push(soFar) });
    expect(seen.at(-1)).toBe("Hello from the stub.");
  });

  it("explains a refusal", async () => {
    respond = (body) => answer(body, "", { stop: "refusal" });
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const result = await claude.ask({ prompt: "Hi" });
    expect(result.stopReason).toBe("refusal");
    expect(result.notice).toBe("Claude declined to answer this request.");
  });

  it("explains an answer cut off by the cap", async () => {
    respond = (body) => answer(body, "Part of an ans", { stop: "max_tokens" });
    const claude = createByokClaude(config({ maxTokens: 500 }));
    claude.setKey(KEY);
    const result = await claude.ask({ prompt: "Hi" });
    expect(result.notice).toBe("The answer reached this site's limit of 500 tokens and was cut off.");
  });

  it("explains a billing problem", async () => {
    respond = () => apiError(402, "billing_error", "Insufficient credits.");
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const error = await caught(claude.ask({ prompt: "Hi" }));
    expect(error.code).toBe("no_credits");
    expect(error.message).toContain("out of API credits");
  });

  it("reports an overloaded API", async () => {
    respond = () => apiError(529, "overloaded_error", "Overloaded");
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    expect((await caught(claude.ask({ prompt: "Hi" }))).code).toBe("overloaded");
  });

  it("reports a stopped request", async () => {
    const claude = createByokClaude(config());
    claude.setKey(KEY);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(claude.ask({ prompt: "Hi", signal: controller.signal }));
    expect(error.code).toBe("aborted");
    expect(claude.getState().budget).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
  });
});
