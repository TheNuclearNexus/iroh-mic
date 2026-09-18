// Zero-dependency static file server for local verification.
// Serves ./public with the correct `application/wasm` MIME type.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT ?? 8080);
// NB: do not read `HOST` here — macOS shells export it as the machine hostname.
const host = process.env.BIND_ADDR ?? "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

async function resolve(pathname) {
  let path = decodeURIComponent(pathname);
  if (path.endsWith("/")) path += "index.html";
  const full = normalize(join(root, path));
  if (!full.startsWith(root)) return null;
  const info = await stat(full).catch(() => null);
  if (info?.isDirectory()) return resolve(`${path}/index.html`);
  return info?.isFile() ? full : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? host}`);
  const file = await resolve(url.pathname);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
  }
}).listen(port, host, () => {
  console.log(`serving ${root} at http://${host}:${port}`);
});
