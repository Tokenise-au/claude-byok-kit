import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Forwarder } from "../oauth-proposal/stand-in/forwarder.js";
import { consentPage, escapeHtml } from "../oauth-proposal/stand-in/pages.js";
import { s256, verifierMatches } from "../oauth-proposal/stand-in/pkce.js";
import { createStandIn, type StandIn } from "../oauth-proposal/stand-in/server.js";
import type { RegisteredClient } from "../oauth-proposal/stand-in/store.js";
import { costOfUsage, estimatePromptTokens, worstCaseCost } from "../src/pricing.js";

const SITE = "http://127.0.0.1:5191";
const STAND_IN = "http://127.0.0.1:5192";
const CLIENT: RegisteredClient = {
  id: "demo-site",
  name: "Demo site",
  redirectUris: [`${SITE}/`],
  models: ["claude-haiku-5-5", "claude-opus-5-5"],
  suggestedLimitUsd: 2,
};

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  grant: { id: string; monthly_limit_usd: number; models: string[] };
}

let clock: number;
let opened: Anthropic.MessageStreamParams[];
let behaviour: "answer" | "break" | "refuse-key";
let standIn: StandIn;

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  };
}

const ANSWER_USAGE = usage(1000, 500);

const fakeForwarder: Forwarder = {
  simulated: true,
  open(params) {
    opened.push(params);
    const message: Anthropic.Message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: params.model,
      content: [{ type: "text", text: "Hello.", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: ANSWER_USAGE,
    };
    const mode = behaviour;
    async function* events(): AsyncGenerator<Anthropic.MessageStreamEvent> {
      await Promise.resolve();
      if (mode === "refuse-key") {
        throw new Anthropic.AuthenticationError(401, { type: "error" }, "invalid key", new Headers());
      }
      yield { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: usage(1000, 1) } };
      if (mode === "break") throw new Error("connection dropped");
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_stop" };
    }
    return { events: events(), finalMessage: () => Promise.resolve(message) };
  },
};

function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL("/oauth/authorize", STAND_IN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.id,
    redirect_uri: `${SITE}/`,
    code_challenge_method: "S256",
    state: "state-123",
    ...params,
  }).toString();
  return url.href;
}

async function startConsent(verifier: string): Promise<string> {
  const response = await standIn.handle(new Request(authorizeUrl({ code_challenge: s256(verifier) })));
  expect(response.status).toBe(200);
  const match = /name="request" value="([^"]+)"/.exec(await response.text());
  if (!match?.[1]) throw new Error("no consent request id on the page");
  return match[1];
}

function consent(fields: [string, string][], origin = STAND_IN): Promise<Response> {
  return standIn.handle(
    new Request(`${STAND_IN}/oauth/consent`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

function approve(requestId: string, limit = "2", models = CLIENT.models): Promise<Response> {
  return consent([["request", requestId], ["decision", "approve"], ["limit", limit], ...models.map((model): [string, string] => ["models", model])]);
}

function token(fields: Record<string, string>, origin = SITE): Promise<Response> {
  return standIn.handle(
    new Request(`${STAND_IN}/oauth/token`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT.id, ...fields }).toString(),
    }),
  );
}

function codeFrom(response: Response): string {
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";
}

async function connect(limit = "2", models = CLIENT.models): Promise<Tokens> {
  const verifier = newVerifier();
  const code = codeFrom(await approve(await startConsent(verifier), limit, models));
  const response = await token({ grant_type: "authorization_code", code, redirect_uri: `${SITE}/`, code_verifier: verifier });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

function ask(accessToken: string, body: Record<string, unknown> = {}, origin = SITE): Promise<Response> {
  return standIn.handle(
    new Request(`${STAND_IN}/v1/messages`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1000,
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
        ...body,
      }),
    }),
  );
}

async function grantInfo(accessToken: string): Promise<Response> {
  return standIn.handle(
    new Request(`${STAND_IN}/v1/oauth/grant`, { headers: { origin: SITE, authorization: `Bearer ${accessToken}` } }),
  );
}

async function errorType(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { type?: string } }).error?.type;
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 28, 12);
  opened = [];
  behaviour = "answer";
  standIn = createStandIn({ clients: [CLIENT], forwarder: fakeForwarder, now: () => clock });
});

describe("PKCE", () => {
  it("matches the RFC 7636 example", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(verifierMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(verifierMatches("short", s256("short"))).toBe(false);
  });
});

describe("authorization request", () => {
  it("shows an error page, without redirecting, for an unknown app", async () => {
    const response = await standIn.handle(new Request(authorizeUrl({ client_id: "nobody", code_challenge: s256(newVerifier()) })));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("never redirects to an address the app didn't register", async () => {
    const response = await standIn.handle(
      new Request(authorizeUrl({ redirect_uri: "https://attacker.example/", code_challenge: s256(newVerifier()) })),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("requires PKCE with S256", async () => {
    for (const params of [{}, { code_challenge_method: "plain", code_challenge: "x".repeat(43) }]) {
      const response = await standIn.handle(new Request(authorizeUrl(params)));
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe(SITE);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("state")).toBe("state-123");
    }
  });

  it("serves the consent page under a strict policy that can't be framed", async () => {
    const response = await standIn.handle(new Request(authorizeUrl({ code_challenge: s256(newVerifier()) })));
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // With no-referrer, browsers would send "Origin: null" and the consent form would be refused.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(await response.text()).toContain("SIMULATION");
  });

  it("escapes app details on the consent page", () => {
    const html = consentPage({
      id: "req",
      client: { ...CLIENT, name: '<script>alert("x")</script>' },
      redirectUri: `${SITE}/`,
      state: "s",
      codeChallenge: "c",
      expiresAt: 0,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml('<script>alert("x")</script>'));
  });
});

describe("consent", () => {
  it("refuses a consent post from another site", async () => {
    const requestId = await startConsent(newVerifier());
    const response = await consent([["request", requestId], ["decision", "approve"]], "https://attacker.example");
    expect(response.status).toBe(403);
  });

  it("returns access_denied with the state when the visitor denies", async () => {
    const response = await consent([["request", await startConsent(newVerifier())], ["decision", "deny"]]);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("lets the visitor allow fewer models than the app asked for, and never more", async () => {
    const tokens = await connect("2", ["claude-haiku-5-5", "claude-fable-5-1"]);
    expect(tokens.grant.models).toEqual(["claude-haiku-5-5"]);
  });

  it("rejects a limit outside $0.01 to $1,000 and keeps the request open to fix it", async () => {
    const requestId = await startConsent(newVerifier());
    expect((await approve(requestId, "0")).status).toBe(400);
    expect((await approve(requestId, "5000")).status).toBe(400);
    expect((await approve(requestId, "3")).status).toBe(303);
  });
});

describe("token endpoint", () => {
  it("issues scoped tokens for a valid code and verifier", async () => {
    const tokens = await connect("3.5");
    expect(tokens.access_token).toMatch(/^byoksim_at_/);
    expect(tokens.refresh_token).toMatch(/^byoksim_rt_/);
    expect(tokens.grant).toMatchObject({ monthly_limit_usd: 3.5, models: CLIENT.models });
  });

  it("rejects the wrong verifier, and the code can't be tried again", async () => {
    const verifier = newVerifier();
    const code = codeFrom(await approve(await startConsent(verifier)));
    const wrong = await token({ grant_type: "authorization_code", code, redirect_uri: `${SITE}/`, code_verifier: newVerifier() });
    expect(wrong.status).toBe(400);
    const retry = await token({ grant_type: "authorization_code", code, redirect_uri: `${SITE}/`, code_verifier: verifier });
    expect(((await retry.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const verifier = newVerifier();
    const code = codeFrom(await approve(await startConsent(verifier)));
    clock += 61_000;
    const response = await token({ grant_type: "authorization_code", code, redirect_uri: `${SITE}/`, code_verifier: verifier });
    expect(response.status).toBe(400);
  });

  it("rejects a code sent with a different redirect_uri", async () => {
    const verifier = newVerifier();
    const code = codeFrom(await approve(await startConsent(verifier)));
    const response = await token({ grant_type: "authorization_code", code, redirect_uri: `${SITE}/other`, code_verifier: verifier });
    expect(response.status).toBe(400);
  });

  it("allows the app's own origin to read the response", async () => {
    const response = await token({ grant_type: "authorization_code", code: "nope" });
    expect(response.headers.get("access-control-allow-origin")).toBe(SITE);
    const elsewhere = await token({ grant_type: "authorization_code", code: "nope" }, "https://attacker.example");
    expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rotates refresh tokens and revokes the connection if an old one is replayed", async () => {
    const first = await connect();
    clock += 3601_000;
    expect((await ask(first.access_token)).status).toBe(401);

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    const second = (await refreshed.json()) as Tokens;
    expect((await ask(second.access_token)).status).toBe(200);

    const replay = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(replay.status).toBe(400);
    expect((await ask(second.access_token)).status).toBe(401);
  });
});

describe("Messages API checkpoint", () => {
  it("forwards an allowed request and charges the grant from usage", async () => {
    const tokens = await connect();
    const response = await ask(tokens.access_token);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello.");
    expect(opened).toHaveLength(1);

    const info = (await (await grantInfo(tokens.access_token)).json()) as { spent_usd: number; remaining_usd: number };
    const cost = costOfUsage("claude-haiku-5-5", ANSWER_USAGE);
    expect(info.spent_usd).toBeCloseTo(cost, 12);
    expect(info.remaining_usd).toBeCloseTo(2 - cost, 12);
  });

  it("refuses a model the visitor didn't allow", async () => {
    const tokens = await connect("2", ["claude-haiku-5-5"]);
    const response = await ask(tokens.access_token, { model: "claude-opus-5-5" });
    expect(response.status).toBe(403);
    expect(await errorType(response)).toBe("permission_error");
    expect(opened).toHaveLength(0);
  });

  it("refuses a request that could pass the visitor's monthly limit", async () => {
    const tokens = await connect("0.01");
    const response = await ask(tokens.access_token, { model: "claude-opus-5-5", max_tokens: 4096 });
    expect(response.status).toBe(402);
    expect(await errorType(response)).toBe("billing_error");
    expect(opened).toHaveLength(0);
  });

  it("starts a fresh allowance when the month turns", async () => {
    const tokens = await connect();
    await (await ask(tokens.access_token)).text();
    clock = Date.UTC(2026, 10, 1, 0, 0, 1);
    const refreshed = (await (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json()) as Tokens;
    const info = (await (await grantInfo(refreshed.access_token)).json()) as { spent_usd: number; month: string };
    expect(info).toMatchObject({ spent_usd: 0, month: "2026-11" });
  });

  it("forwards only the fields whose cost it can work out", async () => {
    const tokens = await connect();
    expect((await ask(tokens.access_token, { tools: [] })).status).toBe(400);
    expect((await ask(tokens.access_token, { stream: false })).status).toBe(400);
    expect((await ask(tokens.access_token, { output_config: { effort: "low", format: {} } })).status).toBe(400);
    expect((await ask(tokens.access_token, { output_config: { effort: "low" } })).status).toBe(200);
  });

  it("refuses a token used from a website other than the app's", async () => {
    const tokens = await connect();
    const response = await ask(tokens.access_token, {}, "https://attacker.example");
    expect(response.status).toBe(403);
    expect(opened).toHaveLength(0);
  });

  it("stops working once the app disconnects", async () => {
    const tokens = await connect();
    await standIn.handle(
      new Request(`${STAND_IN}/oauth/revoke`, {
        method: "POST",
        headers: { origin: SITE },
        body: new URLSearchParams({ token: tokens.refresh_token, client_id: CLIENT.id }),
      }),
    );
    expect((await ask(tokens.access_token)).status).toBe(401);
  });

  it("stops working once the visitor revokes it on Connected apps", async () => {
    const tokens = await connect();
    const page = await standIn.handle(
      new Request(`${STAND_IN}/connected-apps/revoke`, {
        method: "POST",
        headers: { origin: STAND_IN },
        body: new URLSearchParams({ grant: tokens.grant.id }),
      }),
    );
    expect(page.status).toBe(303);
    expect((await ask(tokens.access_token)).status).toBe(401);
  });

  it("charges the worst case when an answer breaks off after it started", async () => {
    const tokens = await connect();
    behaviour = "break";
    const response = await ask(tokens.access_token);
    expect(await response.text()).toContain("event: error");
    const info = (await (await grantInfo(tokens.access_token)).json()) as { spent_usd: number };
    const worst = worstCaseCost("claude-haiku-5-5", estimatePromptTokens({ messages: [{ role: "user", content: "Hi" }] }), 1000);
    expect(info.spent_usd).toBeCloseTo(worst, 12);
  });

  it("reports the stand-in's own key problem without charging the visitor", async () => {
    const tokens = await connect();
    behaviour = "refuse-key";
    const response = await ask(tokens.access_token);
    expect(response.status).toBe(502);
    const info = (await (await grantInfo(tokens.access_token)).json()) as { spent_usd: number };
    expect(info.spent_usd).toBe(0);
  });

  it("answers CORS preflights only for the app's origin", async () => {
    const preflight = (origin: string) =>
      standIn.handle(
        new Request(`${STAND_IN}/v1/messages`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-stainless-os" },
        }),
      );
    const allowed = await preflight(SITE);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("x-stainless-os");
    expect((await preflight("https://attacker.example")).status).toBe(403);
  });
});
