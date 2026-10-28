import { formatUsd } from "../../src/budget.js";
import type { Grant, PendingAuthorization } from "./store.js";

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const banner = `<p class="banner">SIMULATION. This is a local stand-in for a sign-in flow that Anthropic does not offer. It is not an Anthropic page and never asks for a password.</p>`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<main>
${banner}
${body}
</main>
</body>
</html>`;
}

export function consentPage(pending: PendingAuthorization): string {
  const { client } = pending;
  const appOrigin = new URL(pending.redirectUri).origin;
  const models = client.models
    .map(
      (model) =>
        `<label class="check"><input type="checkbox" name="models" value="${escapeHtml(model)}" checked /> ${escapeHtml(model)}</label>`,
    )
    .join("\n");
  return page(
    `Connect ${client.name}`,
    `<h1>Let <span class="app">${escapeHtml(client.name)}</span> use Claude with your API credits?</h1>
<p class="origin">Requested by <strong>${escapeHtml(appOrigin)}</strong>. Signed in as <strong>demo visitor</strong> (simulated).</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${escapeHtml(pending.id)}" />
<h2>What it can do</h2>
<ul>
<li>Send requests to Claude, billed to your Anthropic API credits.</li>
<li>Nothing else: it can't see your keys, your other usage or your account settings.</li>
</ul>
<h2>Monthly spend limit</h2>
<label for="limit">The most this app may spend each calendar month (US dollars)</label>
<input id="limit" name="limit" type="number" min="0.01" max="1000" step="0.01" value="${pending.client.suggestedLimitUsd.toFixed(2)}" required />
<h2>Models it may use</h2>
${models}
<p class="note">You can see this connection and revoke it at any time under <a href="/connected-apps">Connected apps</a>.</p>
<div class="buttons">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</div>
</form>`,
  );
}

export function connectedAppsPage(grants: readonly Grant[], now: number): string {
  const live = grants.filter((grant) => !grant.revoked);
  const rows = live
    .map((grant) => {
      const budget = grant.budget.snapshot();
      return `<tr>
<td>${escapeHtml(grant.client.name)}</td>
<td>${escapeHtml(new Date(grant.createdAt).toISOString().slice(0, 16).replace("T", " "))} UTC</td>
<td>${escapeHtml(grant.models.join(", "))}</td>
<td>${formatUsd(budget.spentUsd)} of ${formatUsd(budget.limitUsd)}</td>
<td><form method="post" action="/connected-apps/revoke"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}" /><button type="submit" class="secondary">Revoke</button></form></td>
</tr>`;
    })
    .join("\n");
  return page(
    "Connected apps",
    `<h1>Connected apps</h1>
<p>Apps you've allowed to use Claude with your API credits. Revoking stops them at once. Shown at ${escapeHtml(new Date(now).toISOString().slice(11, 19))} UTC.</p>
${
  live.length === 0
    ? "<p><em>No connected apps.</em></p>"
    : `<table><thead><tr><th>App</th><th>Connected</th><th>Models</th><th>This month</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
}`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function homePage(forwarderSimulated: boolean): string {
  return page(
    "Stand-in for the proposed Anthropic sign-in",
    `<h1>Stand-in for the proposed Anthropic sign-in</h1>
<p>This server plays Anthropic's part in the proposed flow: the consent page, the token endpoint, the Messages API checkpoint that enforces each app's limits, and the Connected apps page.</p>
<p>Answers: <strong>${forwarderSimulated ? "simulated (no API key set)" : "real, from the Claude API"}</strong>.</p>
<p><a href="/connected-apps">Connected apps</a></p>`,
  );
}

export const STYLE = `:root { --bg: #fbfaf7; --fg: #1f1e1c; --muted: #6b6862; --line: #dedad2; --panel: #f2efe8; --accent: #2f6db5; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1b19; --fg: #ecebe7; --muted: #a19d95; --line: #3a3834; --panel: #262522; --accent: #7fb0f0; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.banner { background: #f6d55c; color: #1f1e1c; padding: 0.6rem 0.9rem; border-radius: 6px; font-weight: 600; }
h1 { font-size: 1.4rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
.origin, .note { color: var(--muted); }
label { display: block; margin: 0.4rem 0; } label.check { display: flex; gap: 0.5rem; align-items: center; }
input[type="number"] { padding: 0.45rem 0.6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; width: 10rem; }
.buttons { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
button { padding: 0.5rem 1.1rem; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; } th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
td form { margin: 0; } td button { margin: 0; padding: 0.25rem 0.7rem; }
a { color: var(--accent); }
`;
