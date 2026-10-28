// A small static server for the example, with the security headers the kit
// recommends. Serves only the files listed below, on 127.0.0.1.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 5190);

const files = {
  "/": ["example/index.html", "text/html; charset=utf-8"],
  "/style.css": ["example/style.css", "text/css; charset=utf-8"],
  "/app.js": ["example/app.js", "text/javascript; charset=utf-8"],
  "/dist/browser/claude-byok.js": ["dist/browser/claude-byok.js", "text/javascript; charset=utf-8"],
  "/dist/browser/claude-byok.js.map": ["dist/browser/claude-byok.js.map", "application/json"],
};

// The policy from SECURITY.md: scripts and styles only from this origin, and the
// only network destination api.anthropic.com.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src https://api.anthropic.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

const securityHeaders = {
  "Content-Security-Policy": csp,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "no-store",
};

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const entry = files[path];
  if (request.method !== "GET" || !entry) {
    response.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  const [file, type] = entry;
  readFile(join(root, file))
    .then((body) => {
      response.writeHead(200, { ...securityHeaders, "Content-Type": type }).end(body);
    })
    .catch(() => {
      response
        .writeHead(500, { ...securityHeaders, "Content-Type": "text/plain" })
        .end(`Missing ${file}. Run "npm run build" first.`);
    });
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Example running at http://127.0.0.1:${String(port)}/\n`);
});
