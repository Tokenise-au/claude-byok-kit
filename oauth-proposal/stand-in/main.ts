// Runs the demo: the stand-in for Anthropic's side on one port and the demo
// site on another, so the flow crosses origins as it would for real.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicForwarder, simulatedForwarder } from "./forwarder.js";
import { createStandIn } from "./server.js";

const host = "127.0.0.1";
const sitePort = Number(process.env.SITE_PORT ?? 5191);
const standInPort = Number(process.env.STAND_IN_PORT ?? 5192);
const siteOrigin = `http://${host}:${String(sitePort)}`;
const standInOrigin = `http://${host}:${String(standInPort)}`;
// This file is bundled to dist/oauth/, two levels below the repository root.
const root = fileURLToPath(new URL("../..", import.meta.url));

const apiKey = process.env.ANTHROPIC_API_KEY;
const forwarder = apiKey ? anthropicForwarder(apiKey) : simulatedForwarder();

const standIn = createStandIn({
  forwarder,
  clients: [
    {
      id: "demo-site",
      name: "Demo site",
      // The site works whether it is opened as 127.0.0.1 or localhost.
      redirectUris: [`${siteOrigin}/`, `http://localhost:${String(sitePort)}/`],
      models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      suggestedLimitUsd: 2,
    },
  ],
});

async function toRequest(incoming: IncomingMessage, origin: string, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const body = incoming.method === "GET" || incoming.method === "HEAD" ? null : Buffer.concat(chunks);
  return new Request(new URL(incoming.url ?? "/", origin), { method: incoming.method ?? "GET", headers, body, signal });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) outgoing.write(chunk);
  }
  outgoing.end();
}

createServer((incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.on("close", () => {
    abort.abort();
  });
  // Use the host the browser asked for, so 127.0.0.1 and localhost each count as the page's own origin.
  toRequest(incoming, `http://${incoming.headers.host ?? `${host}:${String(standInPort)}`}`, abort.signal)
    .then((request) => standIn.handle(request))
    .then((response) => send(response, outgoing))
    .catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
}).listen(standInPort, host);

// The demo site: static files only, under a policy that lets it talk to the stand-in and nothing else.
const siteFiles: Record<string, [string, string]> = {
  "/": ["oauth-proposal/site/index.html", "text/html; charset=utf-8"],
  "/style.css": ["oauth-proposal/site/style.css", "text/css; charset=utf-8"],
  "/app.js": ["dist/oauth/site.js", "text/javascript; charset=utf-8"],
  "/app.js.map": ["dist/oauth/site.js.map", "application/json"],
};
const siteHeaders = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${standInOrigin} http://localhost:${String(standInPort)}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; "),
  // Keeps the authorization code in the address bar from leaking to other sites.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

createServer((incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", siteOrigin).pathname;
  const entry = siteFiles[path];
  if (incoming.method !== "GET" || !entry) {
    outgoing.writeHead(404, { ...siteHeaders, "content-type": "text/plain" }).end("Not found");
    return;
  }
  const [file, type] = entry;
  readFile(join(root, file))
    .then((body) => {
      outgoing.writeHead(200, { ...siteHeaders, "content-type": type }).end(body);
    })
    .catch(() => {
      outgoing.writeHead(500, { ...siteHeaders, "content-type": "text/plain" }).end(`Missing ${file}. Run "npm run build" first.`);
    });
}).listen(sitePort, host, () => {
  process.stdout.write(
    [
      `Demo site:  ${siteOrigin}/`,
      `Stand-in:   ${standInOrigin}/  (plays Anthropic's side)`,
      forwarder.simulated
        ? "Answers are simulated. Set ANTHROPIC_API_KEY before starting to get real answers on your own key."
        : "Answers come from the Claude API, billed to the ANTHROPIC_API_KEY set where this runs.",
      "",
    ].join("\n"),
  );
});
