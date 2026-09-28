#!/usr/bin/env node
/**
 * Serves the web app (docs/ROADMAP.md P.2): the static build from `npm run build:web`, with the
 * single-page fallback and strict security headers. No dependencies, so the image stays small.
 *
 *   WEB_DIR=dist-web PORT=8080 API_ORIGIN=https://api.example.com node scripts/web/serve.mjs
 *
 * API_ORIGIN is the only other origin the app may talk to (Content-Security-Policy connect-src).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.env.WEB_DIR ?? 'dist-web');
const PORT = Number(process.env.PORT ?? 8080);
const API_ORIGIN = process.env.API_ORIGIN ?? '';

if (API_ORIGIN && !/^https?:\/\/[^/\s]+$/.test(API_ORIGIN)) {
  console.error('API_ORIGIN must be an origin such as https://api.example.com (no path).');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The app runs only its own scripts; SQLite on the web compiles WebAssembly in a worker;
 * react-native-web writes its styles at run time; nothing may frame it.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // The web app never records, so it never needs location, motion, camera or microphone.
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), accelerometer=(), gyroscope=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

async function fileFor(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const full = normalize(join(ROOT, decoded));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  try {
    const info = await stat(full);
    if (info.isFile()) return { path: full, size: info.size };
    const index = join(full, 'index.html');
    const indexInfo = await stat(index).catch(() => null);
    return indexInfo?.isFile() ? { path: index, size: indexInfo.size } : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const headers = { ...SECURITY_HEADERS };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const url = req.url ?? '/';
  if (url === '/healthz') {
    res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  let file = null;
  try {
    file = await fileFor(url);
  } catch {
    res.writeHead(400, headers);
    res.end();
    return;
  }
  // Routes belong to the app: anything that isn't a file gets the app's page.
  const isAsset = /\.[a-z0-9]+$/i.test(url.split('?')[0] ?? '');
  if (!file && isAsset) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Not found');
    return;
  }
  file ??= await fileFor('/index.html');
  if (!file) {
    res.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('The web app has not been built.');
    return;
  }
  const type = TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream';
  // Built bundles carry a content hash in their path, so they can be cached for good.
  const immutable = file.path.includes(`${sep}_expo${sep}static${sep}`) || file.path.includes(`${sep}assets${sep}`);
  headers['content-type'] = type;
  headers['content-length'] = String(file.size);
  headers['cache-control'] = type.startsWith('text/html') ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
});

server.listen(PORT, () => console.log(JSON.stringify({ level: 'info', message: 'web app listening', port: PORT, root: ROOT })));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
