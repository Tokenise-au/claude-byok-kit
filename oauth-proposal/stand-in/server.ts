import Anthropic from "@anthropic-ai/sdk";
import { SessionBudget, formatUsd } from "../../src/budget.js";
import { costOfUsage, estimatePromptTokens, priceFor, worstCaseCost } from "../../src/pricing.js";
import type { Forwarder } from "./forwarder.js";
import { STYLE, connectedAppsPage, consentPage, homePage, messagePage } from "./pages.js";
import { isValidChallenge, randomId, verifierMatches } from "./pkce.js";
import { Store, monthOf, type Grant, type RegisteredClient } from "./store.js";

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
export const CODE_SECONDS = 60;
export const PENDING_SECONDS = 10 * 60;
export const MAX_MONTHLY_LIMIT_USD = 1000;

/** The request fields the checkpoint forwards. Anything else is refused, so every request's price is knowable. */
const FORWARDED_FIELDS = new Set(["model", "max_tokens", "messages", "system", "output_config", "stream"]);

export interface StandInOptions {
  clients: readonly RegisteredClient[];
  forwarder: Forwarder;
  now?: () => number;
}

export interface StandIn {
  store: Store;
  handle(request: Request): Promise<Response>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** An error in the Claude API's own shape, so the SDK raises its usual typed errors. */
function apiError(status: number, type: string, message: string): Response {
  return json(status, { type: "error", error: { type, message } });
}

/** An error in the OAuth token endpoint's shape (RFC 6749 section 5.2). */
function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function redirectWith(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return redirect(url.href);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

export function createStandIn(options: StandInOptions): StandIn {
  const store = new Store(options.clients);
  const now = options.now ?? Date.now;
  const { forwarder } = options;
  for (const client of options.clients) for (const model of client.models) priceFor(model);

  const originsOf = (client: RegisteredClient) => new Set(client.redirectUris.map((uri) => new URL(uri).origin));
  const appOrigins = new Set(options.clients.flatMap((client) => [...originsOf(client)]));
  // Browsers apply form-action to the redirect that follows a form post, so the
  // consent form must be allowed to land back on the apps.
  const pageCsp = [
    "default-src 'none'",
    "style-src 'self'",
    `form-action 'self' ${[...appOrigins].join(" ")}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  function html(status: number, body: string): Response {
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": pageCsp,
        // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on form posts,
        // which would defeat the own-page check on the consent form.
        "referrer-policy": "same-origin",
        "cache-control": "no-store",
      },
    });
  }

  /** Form posts to the stand-in's own pages must come from its own pages. */
  function fromOwnPage(request: Request): boolean {
    return request.headers.get("origin") === new URL(request.url).origin;
  }

  function issueTokens(grant: Grant): Response {
    const access = randomId("byoksim_at");
    const refresh = randomId("byoksim_rt");
    store.tokens.set(access, { value: access, kind: "access", grantId: grant.id, expiresAt: now() + ACCESS_TOKEN_SECONDS * 1000, used: false });
    store.tokens.set(refresh, { value: refresh, kind: "refresh", grantId: grant.id, expiresAt: now() + REFRESH_TOKEN_SECONDS * 1000, used: false });
    return json(200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: "messages",
      grant: { id: grant.id, monthly_limit_usd: grant.limitUsd, models: grant.models },
    });
  }

  function authorize(url: URL): Response {
    const params = url.searchParams;
    const client = store.clients.get(params.get("client_id") ?? "");
    if (!client) return html(400, messagePage("Unknown app", "This app isn't registered."));
    const redirectUri = params.get("redirect_uri") ?? "";
    // Never redirect anywhere but an exact registered URI, even to report an error.
    if (!client.redirectUris.includes(redirectUri)) {
      return html(400, messagePage("Wrong return address", "This app asked to return to an address it didn't register."));
    }
    const state = params.get("state") ?? "";
    if (params.get("response_type") !== "code") {
      return redirectWith(redirectUri, { error: "unsupported_response_type", state });
    }
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !isValidChallenge(challenge) || state === "") {
      return redirectWith(redirectUri, {
        error: "invalid_request",
        error_description: "PKCE with S256 and a state value are required.",
        state,
      });
    }
    const pending = { id: randomId("byoksim_req"), client, redirectUri, state, codeChallenge: challenge, expiresAt: now() + PENDING_SECONDS * 1000 };
    store.pending.set(pending.id, pending);
    return html(200, consentPage(pending));
  }

  async function consent(request: Request): Promise<Response> {
    if (!fromOwnPage(request)) return html(403, messagePage("Not allowed", "This form can only be sent from its own page."));
    const form = new URLSearchParams(await request.text());
    const pending = store.pending.get(form.get("request") ?? "");
    if (!pending || pending.expiresAt < now()) {
      return html(400, messagePage("Sign-in expired", "This request has expired. Start again from the app."));
    }
    if (form.get("decision") !== "approve") {
      store.pending.delete(pending.id);
      return redirectWith(pending.redirectUri, { error: "access_denied", state: pending.state });
    }
    const limitUsd = Number(form.get("limit"));
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > MAX_MONTHLY_LIMIT_USD) {
      return html(400, messagePage("Check the limit", `Go back and set a monthly limit between $0.01 and ${formatUsd(MAX_MONTHLY_LIMIT_USD)}.`));
    }
    const models = form.getAll("models").filter((model) => pending.client.models.includes(model));
    if (models.length === 0) return html(400, messagePage("Choose a model", "Go back and allow at least one model."));

    store.pending.delete(pending.id);
    const code = randomId("byoksim_code");
    store.codes.set(code, {
      code,
      client: pending.client,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      limitUsd: Math.round(limitUsd * 100) / 100,
      models,
      expiresAt: now() + CODE_SECONDS * 1000,
    });
    return redirectWith(pending.redirectUri, { code, state: pending.state });
  }

  async function token(request: Request): Promise<Response> {
    const params = new URLSearchParams(await request.text());
    const client = store.clients.get(params.get("client_id") ?? "");
    if (!client) return oauthError(401, "invalid_client", "Unknown client_id.");

    switch (params.get("grant_type")) {
      case "authorization_code": {
        const code = store.codes.get(params.get("code") ?? "");
        // A code works once, whether or not this attempt succeeds.
        if (code) store.codes.delete(code.code);
        if (
          !code ||
          code.expiresAt < now() ||
          code.client.id !== client.id ||
          code.redirectUri !== params.get("redirect_uri") ||
          !verifierMatches(params.get("code_verifier") ?? "", code.codeChallenge)
        ) {
          return oauthError(400, "invalid_grant", "The code is invalid, expired, already used, or doesn't match the verifier.");
        }
        const grant: Grant = {
          id: randomId("byoksim_grant"),
          client,
          limitUsd: code.limitUsd,
          models: code.models,
          month: monthOf(now()),
          budget: new SessionBudget(code.limitUsd),
          createdAt: now(),
          revoked: false,
        };
        store.grants.set(grant.id, grant);
        return issueTokens(grant);
      }
      case "refresh_token": {
        const presented = store.tokens.get(params.get("refresh_token") ?? "");
        const grant = presented ? store.grants.get(presented.grantId) : undefined;
        if (!presented || presented.kind !== "refresh" || !grant || grant.revoked || grant.client.id !== client.id) {
          return oauthError(400, "invalid_grant", "The refresh token is invalid or revoked.");
        }
        if (presented.used) {
          // A refresh token used twice means someone else has a copy: cut the grant off.
          store.revokeGrant(grant.id);
          return oauthError(400, "invalid_grant", "This refresh token was already used, so the connection has been revoked.");
        }
        if (presented.expiresAt < now()) return oauthError(400, "invalid_grant", "The refresh token has expired.");
        presented.used = true;
        return issueTokens(grant);
      }
      default:
        return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
  }

  /** RFC 7009: the app disconnects itself. Always answers 200. */
  async function revoke(request: Request): Promise<Response> {
    const params = new URLSearchParams(await request.text());
    const presented = store.tokens.get(params.get("token") ?? "");
    const grant = presented ? store.grants.get(presented.grantId) : undefined;
    if (grant && grant.client.id === params.get("client_id")) store.revokeGrant(grant.id);
    return new Response(null, { status: 200 });
  }

  function authenticate(request: Request): Grant | Response {
    const presented = store.tokens.get(bearer(request) ?? "");
    const grant = presented ? store.grants.get(presented.grantId) : undefined;
    if (!presented || presented.kind !== "access" || !grant || grant.revoked) {
      return apiError(401, "authentication_error", "This connection is invalid or was revoked. Connect again.");
    }
    if (presented.expiresAt < now()) {
      return apiError(401, "authentication_error", "The access token has expired. Use the refresh token.");
    }
    // In a browser, a token only works from the app's own registered origins.
    const origin = request.headers.get("origin");
    if (origin !== null && !originsOf(grant.client).has(origin)) {
      return apiError(403, "permission_error", "This token can't be used from this website.");
    }
    return grant;
  }

  function grantInfo(request: Request): Response {
    const grant = authenticate(request);
    if (grant instanceof Response) return grant;
    const budget = store.budgetFor(grant, now()).snapshot();
    return json(200, {
      id: grant.id,
      app: grant.client.name,
      month: grant.month,
      monthly_limit_usd: grant.limitUsd,
      spent_usd: budget.spentUsd,
      remaining_usd: budget.remainingUsd,
      models: grant.models,
    });
  }

  async function messages(request: Request): Promise<Response> {
    const grant = authenticate(request);
    if (grant instanceof Response) return grant;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return apiError(400, "invalid_request_error", "The request body isn't valid JSON.");
    }
    const extra = Object.keys(body).filter((field) => !FORWARDED_FIELDS.has(field));
    const effort = (body.output_config as { effort?: unknown } | undefined)?.effort;
    if (extra.length > 0 || (body.output_config !== undefined && Object.keys(body.output_config as object).some((key) => key !== "effort"))) {
      return apiError(400, "invalid_request_error", "The stand-in forwards only model, max_tokens, messages, system and output_config.effort.");
    }
    if (body.stream !== true) {
      return apiError(400, "invalid_request_error", "The stand-in only forwards streaming requests.");
    }
    const { model, max_tokens: maxTokens, messages: history, system } = body;
    if (typeof model !== "string" || !grant.models.includes(model)) {
      return apiError(403, "permission_error", `You didn't allow ${grant.client.name} to use ${String(model)}. Allowed: ${grant.models.join(", ")}.`);
    }
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || !Array.isArray(history)) {
      return apiError(400, "invalid_request_error", "max_tokens and messages are required.");
    }
    if (system !== undefined && typeof system !== "string") {
      return apiError(400, "invalid_request_error", "The stand-in forwards only a plain-text system prompt.");
    }

    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: maxTokens,
      messages: history as Anthropic.MessageParam[],
      ...(system !== undefined && { system }),
      ...(effort !== undefined && { output_config: { effort: effort as NonNullable<Anthropic.OutputConfig["effort"]> } }),
    };

    const budget = store.budgetFor(grant, now());
    const worst = worstCaseCost(model, estimatePromptTokens(system === undefined ? { messages: params.messages } : { system, messages: params.messages }), maxTokens);
    if (worst > budget.remainingUsd) {
      return apiError(
        402,
        "billing_error",
        `This request could cost up to ${formatUsd(worst)}, but only ${formatUsd(budget.remainingUsd)} is left of the ${formatUsd(grant.limitUsd)} monthly limit you set for ${grant.client.name}.`,
      );
    }
    const reservation = budget.reserve(worst);

    const abort = new AbortController();
    const upstream = forwarder.open(params, abort.signal);
    const iterator = upstream.events[Symbol.asyncIterator]();
    let first: IteratorResult<Anthropic.MessageStreamEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      budget.release(reservation);
      return upstreamError(error);
    }

    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: { type: string }) => {
          if (!cancelled) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        try {
          for (let step = first; !step.done; step = await iterator.next()) send(step.value);
          const message = await upstream.finalMessage();
          budget.settle(reservation, costOfUsage(model, message.usage));
        } catch {
          // The answer had started, so part of it may be billed: count the worst case.
          budget.settle(reservation, reservation.amountUsd);
          send({ type: "error", error: { type: "api_error", message: "The answer was interrupted." } } as { type: string });
        } finally {
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        cancelled = true;
        abort.abort();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  function upstreamError(error: unknown): Response {
    if (error instanceof Anthropic.APIError && typeof error.status === "number") {
      const status: number = error.status;
      if (status === 401 || status === 403) {
        return apiError(502, "api_error", "Anthropic refused the stand-in's own API key. Check ANTHROPIC_API_KEY where the demo runs.");
      }
      return apiError(status, error.type ?? "api_error", error.message);
    }
    return apiError(502, "api_error", "The stand-in couldn't reach the Claude API.");
  }

  function preflight(request: Request): Response {
    const origin = request.headers.get("origin") ?? "";
    if (!appOrigins.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "authorization, content-type",
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }

  function withCors(request: Request, response: Response): Response {
    const origin = request.headers.get("origin") ?? "";
    if (appOrigins.has(origin)) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.append("vary", "Origin");
    }
    return response;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const crossOrigin = url.pathname.startsWith("/v1/") || url.pathname === "/oauth/token" || url.pathname === "/oauth/revoke";
    if (request.method === "OPTIONS" && crossOrigin) return preflight(request);

    let response: Response;
    switch (`${request.method} ${url.pathname}`) {
      case "GET /":
        response = html(200, homePage(forwarder.simulated));
        break;
      case "GET /style.css":
        response = new Response(STYLE, { headers: { "content-type": "text/css; charset=utf-8" } });
        break;
      case "GET /oauth/authorize":
        response = authorize(url);
        break;
      case "POST /oauth/consent":
        response = await consent(request);
        break;
      case "POST /oauth/token":
        response = await token(request);
        break;
      case "POST /oauth/revoke":
        response = await revoke(request);
        break;
      case "GET /v1/oauth/grant":
        response = grantInfo(request);
        break;
      case "POST /v1/messages":
        response = await messages(request);
        break;
      case "GET /connected-apps":
        response = html(200, connectedAppsPage([...store.grants.values()], now()));
        break;
      case "POST /connected-apps/revoke": {
        if (!fromOwnPage(request)) return html(403, messagePage("Not allowed", "This form can only be sent from its own page."));
        store.revokeGrant(new URLSearchParams(await request.text()).get("grant") ?? "");
        response = redirect("/connected-apps");
        break;
      }
      default:
        response = new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return crossOrigin ? withCors(request, response) : response;
  }

  return { store, handle };
}
