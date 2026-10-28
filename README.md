# claude-byok-kit

Bring your own Claude API key, for websites.

This kit lets a website offer Claude-powered features that each visitor pays for with **their own Anthropic API key**, from their own Console credits. The key stays in the visitor's browser and is sent only to `api.anthropic.com`. The site's server never receives it.

It is a small TypeScript library (no dependencies besides the official [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)), an optional React hook, and a plain-HTML example page.

> Status: 0.1.0, not yet published to npm. Not affiliated with or endorsed by Anthropic.

## Claude subscriptions can't be used here

**This kit does not, and cannot, use a Claude Free, Pro or Max subscription.** Anthropic's terms reserve subscription sign-ins for Anthropic's own apps (Claude.ai, Claude Code and the like). Its [developer terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) say third-party developers may not offer Claude.ai login in their own apps, route requests through Free, Pro or Max credentials, or collect Claude.ai credentials or session tokens. Anthropic made this explicit in early 2026, began blocking such use, and says it may enforce the rule without notice. A workaround could get your visitors' accounts banned.

So the kit refuses subscription tokens (`sk-ant-oat…`) if a visitor pastes one, and explains why.

A Claude subscription and API credits are **billed separately**. Paying for Pro or Max does not give you API credits. To use this kit, a visitor needs an Anthropic API (Console) account at [platform.claude.com](https://platform.claude.com) with prepaid credits.

## What it does

- **Holds the key in memory by default.** Keeping it in `localStorage` across reloads is opt-in twice: the site must allow it (`allowRememberKey`), and the visitor must tick "remember". `forgetKey()` clears it from memory and storage and stops any answer still streaming.
- **Calls Anthropic straight from the browser** through the SDK's documented browser mode (`dangerouslyAllowBrowser: true`, which also sends the `anthropic-dangerous-direct-browser-access: true` header the API needs for cross-origin calls). The base URL is fixed to `https://api.anthropic.com`.
- **Never sends the key to the site's server and never logs it.** The library makes no network calls of its own and has no `console` calls: a test checks both, and a lint rule bans `console`. The SDK's logger is off, and any error text that could echo the key is redacted.
- **Enforces the site's spend limits:**
  - a **per-session budget** in US dollars, tracked from each response's `usage` at Anthropic's published per-model prices;
  - a **`max_tokens` cap** no request can exceed;
  - a **model allowlist**: requests for any other model are refused before anything is sent.
  When the budget runs out it stops with a clear message.
- **Refuses dangerous pastes:** Claude subscription tokens and Admin API keys (`sk-ant-admin…`), each with a plain explanation.
- **Gives readable errors** for a bad key, no credits, rate limits, an overloaded API, a refusal, or an answer cut off by the cap.

## What it doesn't do

- **It can't protect a key from the page it's pasted into.** Every script on the page, including third-party analytics and browser extensions, can read what the visitor types. The kit is only as safe as the page around it. Read [SECURITY.md](SECURITY.md).
- **The session budget protects visitors from a site's feature running away with their money. It isn't a hard cap.** It lives in the visitor's own browser and resets on reload. The hard cap is the spend limit on the visitor's Console workspace (below).
- **Costs are list-price estimates, not a bill.** They use Anthropic's published first-party prices (checked 2026-10-28, in [`src/pricing.ts`](src/pricing.ts)). Discounts, taxes and future price changes aren't reflected. The Console's usage page is the record.
- **No tools, web search, batches, fast mode, US-only inference or automatic model fallbacks.** The kit sends only `model`, `max_tokens`, `messages`, and optionally `system` and `output_config.effort`. That keeps every request's price knowable and every model inside the allowlist.
- **Nothing on the page is secret.** The system prompt and every message are in the visitor's browser, and a visitor can read or change them. Don't put secrets, private data or prompt "moats" in a BYOK request.

## When it fits

Bring-your-own-key suits audiences who already have Anthropic API accounts: developers, researchers, power users, and sites that are free or public-good and can't fund heavy AI use themselves.

**Most visitors won't have a key.** Creating a Console account, buying credits and making a key is a lot to ask of a casual visitor. So for most sites BYOK should be an **option next to a site-paid default**: a modest free tier on the site's own server-side key, plus "use my own key" for people who want more, longer or heavier answers. Don't make it the only way in unless your audience is all developers.

It fits less well when the feature needs server-side data or secrets, when prompts must stay private, or when you need tools that run on your server. Those belong behind your own backend and your own key.

## For visitors: make a dedicated key with a spend limit

Never paste your main key into a website. Make one key per site, in its own workspace, with a monthly spend limit. Then a leaked or misused key can only cost what you allowed.

1. Sign in to the [Claude Console](https://platform.claude.com) and add API credits in its billing settings.
2. **Create a workspace** for the site: Workspaces page → *Create workspace*. Only organisation admins can do this; on a personal account, that's you.
3. **Set a spend limit on it:** on the Workspaces page, select the workspace and open *Spend limits*. Under *Monthly limit*, choose *Change limit*, and optionally add an email notification. The limit must be lower than your organisation's. **The Default workspace can't have its own spend limit**, which is why the site needs its own workspace.
4. **Create the key in that workspace:** API keys page → pick the workspace from the dropdown → *Create key*, named after the site. Keys stay in the workspace they're created in.
5. Paste it into the site. When you're finished, **delete the key in the Console**. "Forget my key" only removes it from your browser; it doesn't revoke it.

Anthropic's help article [Creating and managing workspaces](https://support.claude.com/en/articles/9796807-creating-and-managing-workspaces) covers workspaces, spend limits and keys in more detail.

## For sites: using the kit

```bash
npm install claude-byok-kit
```

```ts
import { createByokClaude } from "claude-byok-kit";

// Create one instance per page, at module level.
const claude = createByokClaude({
  models: ["claude-opus-5-5", "claude-haiku-5-5"], // the allowlist; the first is the default
  maxTokens: 4096, // the cap on output tokens per request, thinking included
  sessionBudgetUsd: 0.5, // stop after spending this much of the visitor's credits
  system: "Answer briefly and clearly.",
  effort: "low", // optional: low | medium | high | xhigh | max
  allowRememberKey: true, // optional: let visitors keep the key across reloads
});

claude.setKey(pastedKey); // memory only
// claude.setKey(pastedKey, { remember: true }); // only if allowRememberKey is on

const result = await claude.ask({
  prompt: "What does a satellite's inclination tell you?",
  onText: (_delta, soFar) => {
    answerElement.textContent = soFar; // textContent, never innerHTML
  },
});
result.text; // the answer
result.costUsd; // what this answer cost
result.notice; // a sentence to show if it was refused or cut off, else null
claude.getState().budget; // { limitUsd, spentUsd, reservedUsd, remainingUsd }

claude.forgetKey();
```

`ask()` also takes `messages` (an `Anthropic.MessageParam[]`) for a conversation, `model` (one of the allowed models), a lower `maxTokens`, and an `AbortSignal`. `subscribe(listener)` and `getState()` let any UI follow the key and budget state.

Every failure is a `ByokError` with a `code` and a message you can show the visitor as-is:

| `code` | Meaning |
| --- | --- |
| `no_key` | No key set yet. |
| `invalid_key`, `subscription_token`, `admin_key` | The pasted text isn't a usable API key. |
| `model_not_allowed` | The model isn't on the site's allowlist. Nothing was sent. |
| `budget_exceeded` | The request could pass the session budget. Nothing was sent. |
| `auth_failed` | Anthropic didn't accept the key. |
| `no_credits` | Anthropic couldn't bill the key (out of credits or at a spend limit). |
| `permission_denied`, `request_rejected` | Anthropic refused the request; Anthropic's reason is included. |
| `rate_limited`, `overloaded`, `network` | Try again later. |
| `aborted` | The request was stopped. |
| `invalid_request`, `bad_config` | A mistake in the site's code or config. |

### React

```tsx
import { createByokClaude } from "claude-byok-kit";
import { useByokClaude } from "claude-byok-kit/react";

const claude = createByokClaude({ models: ["claude-opus-5-5"], maxTokens: 4096, sessionBudgetUsd: 0.5 });

function Ask() {
  const { hasKey, setKey, forgetKey, ask, stop, answer, result, error, busy, budget } = useByokClaude(claude);
  // ...render a key field, a question box, the answer, error?.message and budget.spentUsd
}
```

### Plain HTML

[`example/`](example/) is a complete page with no framework and no build step. It loads a single ES module bundle of the kit and the SDK from its own origin. To run it:

```bash
npm install
```

```bash
npm run example
```

Then open <http://127.0.0.1:5190/>. The small server sends the Content-Security-Policy recommended in [SECURITY.md](SECURITY.md), so you can see that the page works with no network access except `api.anthropic.com`.

## How the budget works

1. **Before a request**, the kit estimates its prompt size as one token per UTF-8 byte plus 1,024 tokens. That's deliberately high; real counts are usually a quarter to a third of it. It then works out the worst case: every prompt token at the dearest input rate (a 1-hour cache write) plus the full `max_tokens` of output. That amount is reserved. If it's more than what's left, the request is refused and nothing is sent. Requests running at the same time each hold a reservation, so together they can't overshoot.
2. **After the response**, the reservation is replaced with the real cost from `response.usage`: `input_tokens`, cache writes split by 5-minute and 1-hour lifetime (`cache_creation`), `cache_read_input_tokens`, `output_tokens`, and $0.01 per web search in `server_tool_use`. Claude Haiku 5.5's higher rates apply when the prompt is over 100,000 tokens, counting cache reads and writes, as Anthropic's pricing page specifies.
3. **If an answer breaks off** after Anthropic accepted the request (a dropped connection, or the visitor pressing Stop), the final usage never arrives. The kit then counts the full reservation, because it can't know the true cost.

Current Claude models think before they answer. Thinking tokens are billed as output and count toward `max_tokens`, so leave room for them in the cap. Lower `effort` thinks less and costs less.

Prices are in [`src/pricing.ts`](src/pricing.ts) with the date they were checked. When Anthropic changes them, update the table. A site can also pass `prices` to add or override models, and models without a known price can't be allowlisted.

## Development

```bash
npm run check
```

That runs ESLint, the TypeScript checker, the Vitest suite and the build. The tests never touch the network: they run the real SDK against a stubbed `fetch`, with a made-up key. There's no real key anywhere in this repository.

## Licence

[MIT](LICENSE). The browser bundle built into `dist/browser/` includes the Anthropic TypeScript SDK, which is Apache-2.0; its licence is copied beside the bundle.

"Claude" and "Anthropic" are trademarks of Anthropic, PBC. This project is independent of Anthropic.
