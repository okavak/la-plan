#!/usr/bin/env node
// Static file server for local development and the end-to-end tests (never caches).
//   node tools/serve.mjs [port] [backend-url]      (port default 8123)
// With a backend url, /src/config.js is generated to point at it (e.g. the fake backend),
// so tests never have to edit the committed config.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function startServer({ port = 0, backend = null } = {}) {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (backend && pathname === '/src/config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(`export const SUPABASE_URL = ${JSON.stringify(backend.url)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(backend.anonKey ?? 'dev')};\n`);
      return;
    }
    let file = resolve(join(ROOT, normalize(pathname)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      statSync(file);
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      done({ url: `http://127.0.0.1:${actual}`, port: actual, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backend = process.argv[3] ? { url: process.argv[3] } : null;
  const { url } = await startServer({ port: Number(process.argv[2]) || 8123, backend });
  console.log(`serving ${ROOT} on ${url}${backend ? ` with backend ${backend.url}` : ''}`);
}
