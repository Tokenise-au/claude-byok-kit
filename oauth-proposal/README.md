# OAuth proposal and simulation

A proposal for **"Sign in with Anthropic"** for third-party apps, billed to the visitor's own API credits, with a working local simulation of the whole flow.

- **[SPEC.md](SPEC.md)** is the proposal: the flow, endpoints, consent screen, billing, revocation and security considerations.
- **This folder** runs it. A local **stand-in** plays Anthropic's part, and a **demo site** uses it in place of a pasted key.

> **Anthropic doesn't offer this today.** Everything here is a simulation on your own machine. The stand-in's pages say so on every screen, use no Anthropic branding, and never ask for a password.

## Run it

```bash
npm install
```

```bash
npm run oauth-demo
```

Then open <http://127.0.0.1:5191/> and click **Sign in with Anthropic (simulated)**:

1. The stand-in's consent page asks you to set a monthly spend limit and choose which models the site may use.
2. You're sent back to the site, which swaps the one-time code for a token (PKCE) and shows your limit and spending.
3. Ask a question. The answer streams back through the stand-in, which checks the token, model and limit before forwarding it, and charges the grant from `usage` afterwards.
4. Open **Connected apps** on the stand-in (<http://127.0.0.1:5192/connected-apps>) and revoke the connection. The site's next request is refused.

**Answers are simulated by default.** With no API key set, the stand-in returns a canned answer with made-up token counts, and nothing leaves your machine. To get real answers, start the demo with `ANTHROPIC_API_KEY` set in your own shell. The stand-in then forwards approved requests to the Claude API on that key, playing Anthropic billing the visitor.

## What's where

| Path | What it is |
| --- | --- |
| `stand-in/server.ts` | Anthropic's side: authorization request, consent, token endpoint (code and refresh grants, rotation and replay detection), revocation, grant info, and the Messages API checkpoint that enforces each grant's models and monthly limit. |
| `stand-in/pages.ts` | The consent and Connected apps pages, escaped and served under a strict Content-Security-Policy. |
| `stand-in/pkce.ts` | S256 PKCE checks and random identifiers. |
| `stand-in/forwarder.ts` | Forwards approved requests with the official SDK, or simulates answers. |
| `stand-in/main.ts` | Runs the stand-in (port 5192) and serves the demo site (port 5191). |
| `site/` | The demo site: PKCE in the browser, the token swap, and the official SDK with `authToken` in place of an API key. |
| `../test/oauth.test.ts` | Tests for PKCE, redirect URI checks, consent, one-time codes, token rotation and replay, model and limit enforcement, origin binding, revocation and CORS. |

The stand-in keeps everything in memory, so restarting it forgets every connection. It has no real sign-in: everyone who opens it counts as the same simulated visitor.
