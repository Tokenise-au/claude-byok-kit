// The demo site: "Sign in with Anthropic" instead of pasting a key. The tokens
// live in this tab's memory only. Everything is written with textContent.
import Anthropic from "@anthropic-ai/sdk";
import { formatUsd } from "../../src/budget.js";

// Where the stand-in for Anthropic runs (see stand-in/main.ts).
const STAND_IN = `${location.protocol}//${location.hostname}:5192`;
const CLIENT_ID = "demo-site";
const REDIRECT_URI = `${location.origin}/`;
const PENDING_KEY = "oauth-pending";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  grant: { id: string; monthly_limit_usd: number; models: string[] };
}

interface GrantInfo {
  app: string;
  monthly_limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  models: string[];
}

interface Connection {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  models: string[];
  client: Anthropic;
}

let connection: Connection | null = null;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
}

const connectSection = element("connect-section");
const connectedSection = element("connected-section");
const grantLine = element("grant");
const model = element("model") as HTMLSelectElement;
const question = element("question") as HTMLTextAreaElement;
const askButton = element("ask") as HTMLButtonElement;
const answer = element("answer");
const errorBox = element("error");
(element("connected-apps") as HTMLAnchorElement).href = `${STAND_IN}/connected-apps`;

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = message === "";
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function connect(tokens: TokenResponse): void {
  connection = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    models: tokens.grant.models,
    // The same SDK and Messages API as today, with a scoped token in place of an API key.
    client: new Anthropic({ authToken: tokens.access_token, baseURL: STAND_IN, dangerouslyAllowBrowser: true, logLevel: "off" }),
  };
  model.replaceChildren(...tokens.grant.models.map((id) => new Option(id, id)));
}

function disconnectLocally(message = ""): void {
  connection = null;
  render();
  showError(message);
}

function render(): void {
  connectSection.hidden = connection !== null;
  connectedSection.hidden = connection === null;
}

async function refreshGrantLine(): Promise<void> {
  if (!connection) return;
  const info = await connection.client.get<GrantInfo>("/v1/oauth/grant");
  grantLine.textContent = `${info.app} may spend ${formatUsd(info.monthly_limit_usd)} of your credits this month: ${formatUsd(info.spent_usd)} spent, ${formatUsd(info.remaining_usd)} left. Models: ${info.models.join(", ")}.`;
}

/** OAuth calls go to the token endpoint, which the SDK doesn't cover, so they use fetch. */
async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(`${STAND_IN}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const body = (await response.json()) as TokenResponse & { error_description?: string };
  if (!response.ok) throw new Error(body.error_description ?? "The token request failed.");
  return body;
}

async function startSignIn(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  // Survives the round trip to the consent page; removed as soon as we're back.
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state }));
  const url = new URL("/oauth/authorize", STAND_IN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state,
  }).toString();
  location.assign(url.href);
}

async function finishSignIn(params: URLSearchParams): Promise<void> {
  const saved = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  // Take the code out of the address bar and history straight away.
  history.replaceState(null, "", "/");

  const error = params.get("error");
  if (error) {
    showError(error === "access_denied" ? "You didn't connect your Anthropic account." : `Sign-in failed: ${params.get("error_description") ?? error}`);
    return;
  }
  const pending = saved ? (JSON.parse(saved) as { verifier: string; state: string }) : null;
  if (!pending || pending.state !== params.get("state")) {
    showError("This sign-in didn't start on this page, so it was ignored. Try again.");
    return;
  }
  connect(await tokenRequest({ grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: REDIRECT_URI, code_verifier: pending.verifier }));
  render();
  await refreshGrantLine();
}

async function freshConnection(): Promise<Connection> {
  if (!connection) throw new Error("Not connected.");
  if (connection.expiresAt - 60_000 < Date.now()) {
    connect(await tokenRequest({ grant_type: "refresh_token", refresh_token: connection.refreshToken }));
  }
  return connection;
}

function apiMessage(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function ask(): Promise<void> {
  showError("");
  answer.textContent = "";
  askButton.disabled = true;
  try {
    const { client } = await freshConnection();
    const stream = client.messages.stream({
      model: model.value,
      max_tokens: 2048,
      system: "Answer briefly and clearly, in plain text without Markdown.",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: question.value }],
    });
    stream.on("text", (_delta, soFar) => {
      answer.textContent = soFar;
    });
    await stream.finalMessage();
    await refreshGrantLine();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      disconnectLocally("This connection was revoked or has expired. Connect again.");
    } else {
      showError(apiMessage(error));
    }
  } finally {
    askButton.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  const current = connection;
  disconnectLocally();
  if (current) {
    await fetch(`${STAND_IN}/oauth/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: current.refreshToken, client_id: CLIENT_ID }),
    });
  }
}

element("sign-in").addEventListener("click", () => {
  void startSignIn();
});
element("ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void ask();
});
element("disconnect").addEventListener("click", () => {
  void disconnect();
});

render();
const returned = new URLSearchParams(location.search);
if (returned.has("code") || returned.has("error")) {
  finishSignIn(returned).catch((error: unknown) => {
    showError(apiMessage(error));
  });
}
