import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("dist");
const port = Number(process.env.PORT || 5000);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer((req, res) => {
  const rawPath = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  const requested = normalize(rawPath).replace(/^[/\\]+/, "");
  const candidate = resolve(join(root, requested));
  const safeCandidate = candidate === root || candidate.startsWith(`${root}${sep}`);
  const file = safeCandidate && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, "index.html");

  if (!existsSync(file)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Demo build is not available yet.");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => {
  console.log(`Wattr Cooling Sandbox listening on ${port}`);
});
