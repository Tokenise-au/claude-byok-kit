# Security

A bring-your-own-key page asks visitors to trust it with a credential that spends their money. This document covers what that trust rests on and how a site can deserve it.

## Who can see the key

| Who | Can they see it? |
| --- | --- |
| The visitor's browser and Anthropic | Yes. That's how the request works. |
| **Every script running on the page** | **Yes.** Your code, your libraries, analytics, tag managers, chat widgets: anything on the page can read the key field, call the kit, or read `localStorage`. |
| Browser extensions with access to the site | Yes. No page can defend against this. |
| The site's server | Not with this kit as written. But the visitor is trusting the page's JavaScript to behave, and a site could change it. |

The kit makes sure *its own code* never sends the key anywhere except `api.anthropic.com` and never logs or serialises it. It can't stop other code on the same page. Everything below is about keeping the page around the kit clean, and about being honest with visitors.

## Cross-site scripting (XSS)

On a BYOK page, any XSS is key theft. An injected script can read the key as it's typed, read a remembered key from `localStorage`, or just call `ask()` and spend the visitor's credits.

- **Render Claude's answers as text** (`textContent`), never as HTML. Model output can be steered by whatever text went into the prompt, so treat it as untrusted. If you render Markdown, run the HTML through a sanitiser such as DOMPurify, and allow no `<script>`, event handlers, `<iframe>` or `javascript:` URLs.
- **Treat everything in the prompt as visible and editable by the visitor.** Never interpolate it into HTML.
- **Consider a separate origin** for the BYOK feature, such as `ai.example.com`. A remembered key in `localStorage` is readable by every script on its origin. Keeping the key feature away from pages with comments, user profiles or other user-generated content shrinks the area an XSS bug can reach.
- **Leave "remember my key" off unless visitors really need it.** A key in memory is gone when the tab closes. A key in `localStorage` stays until the visitor forgets it, which is exactly what an XSS bug found next month would look for.
- **Use Trusted Types** (`require-trusted-types-for 'script'`) if your code allows it. The example page runs with it on.

## Third-party scripts

Every third-party script on the page can read the key. Some kinds are especially dangerous:

- **Session replay and heatmaps** (Hotjar, FullStory, LogRocket, Clarity, and the like) record what people type. Even with password masking, don't load them on a page with a key field.
- **Error trackers** (Sentry, Bugsnag and others) can capture input values, breadcrumbs and request details. Scrub them, or leave them off this page.
- **Tag managers** let people outside your engineering team add arbitrary scripts later.
- **Ads, A/B testing and chat widgets** run code you don't control, which can change at any time.
- **Scripts from CDNs** are a supply-chain risk. Self-host them, pin versions, and use Subresource Integrity (`integrity="sha384-…"`) if you must load from elsewhere.

The safest rule: **no third-party scripts on a page that holds a key.** The example page loads nothing from any other origin.

## Recommended Content-Security-Policy

Send this as an HTTP response header on the page that holds the key, not as a `<meta>` tag (`frame-ancestors` doesn't work in a meta tag):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://api.anthropic.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'
```

| Directive | Why |
| --- | --- |
| `default-src 'none'` | Start from nothing allowed. |
| `script-src 'self'` | Scripts only from your own origin. No inline scripts, no `eval`, no CDNs. Add hashes or nonces only if you must. |
| `style-src 'self'` and `img-src 'self'` | No third-party styles or images, which are also ways to leak data. |
| `connect-src 'self' https://api.anthropic.com` | **The important one.** `fetch`, XHR, WebSockets and beacons may only go to your origin and Anthropic. An injected script can't simply `fetch` the key to its own server. Drop `'self'` if the page doesn't call your own API (the example drops it). |
| `base-uri 'none'` | Stops an injected `<base>` tag from redirecting relative URLs. |
| `form-action 'self'` | Forms can only post to your own origin. The example uses `'none'`. |
| `frame-ancestors 'none'` | No one can frame the page and overlay a fake key field (clickjacking). |
| `require-trusted-types-for 'script'` and `trusted-types 'none'` | Blocks `innerHTML`-style DOM sinks entirely. Loosen it only if your framework needs a named policy. |

Also send `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, and serve the page only over HTTPS. [`example/serve.mjs`](example/serve.mjs) sends all of these.

**A CSP reduces the damage; it isn't a guarantee.** An injected script can still leak data by navigating the page to an attacker's URL, and some channels (such as DNS prefetching in some browsers) aren't covered by `connect-src`. Preventing XSS comes first; the CSP is the second line.

## Phishing: the risk of "paste your key here" pages

BYOK teaches people to paste API keys into websites. That habit is what a phishing page exploits. A fake page can copy a legitimate one exactly and send the key to its own server. Visitors can't tell the difference by looking at it.

So a site using this kit should make its behaviour easy to check, and make the habit as safe as possible:

- **Say plainly where the key goes**, next to the field: straight from the browser to `api.anthropic.com`, never to the site's server.
- **Tell visitors how to check.** In the browser's developer tools, the Network tab shows that only requests to `api.anthropic.com` carry the key.
- **Link to the source** of the page and the kit, and say which version is deployed.
- **Ask only for a dedicated key** in its own Console workspace with a monthly spend limit, and link to the steps in the [README](README.md#for-visitors-make-a-dedicated-key-with-a-spend-limit).
- **Never ask for** a Claude.ai sign-in, a Console password, an Admin API key, or a key sent by email, chat or support ticket.
- **Show the limits:** the session budget, the cost of each answer, and the models used.
- **Offer "Forget my key"**, and remind visitors that forgetting doesn't revoke the key: they should delete it in the Console when they're done.
- **Don't look like Anthropic.** Don't use Anthropic's logo or styling, or suggest the page is Anthropic's or endorsed by it.
- **Serve it from your own domain over HTTPS**, and never let it be framed by another site.
- **Never collect keys on your server**, not even "for convenience" or "to save them for you". Once you do, your server is a target holding everyone's keys, and everything above stops being true.

Visitors should treat these as red flags: a page asking for a Claude.ai login or a subscription, a page asking for an Admin key, a key field on a domain they didn't expect, and a Network tab showing the key going anywhere except `api.anthropic.com`.

## If a key leaks

Delete it on the Console's API keys page straight away. This revokes it everywhere. Then check the workspace's usage, and create a new key if you still need one. A workspace spend limit caps what a leaked key could have spent in the meantime.

## Reporting a vulnerability in this kit

Please report it privately through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab) rather than in a public issue.
