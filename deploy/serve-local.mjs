/**
 * Local stand-in for the IIS sub-application layout (see backend/DEPLOY.md).
 * Same harness as the 2D / 3D dashboards' deploy/serve-local.mjs, adapted to
 * the Python API.
 *
 * Reproduces production's URL shape on a machine with no IIS, so the sub-path
 * assumptions can be validated BEFORE touching the server:
 *
 *     /wafermap/         -> frontend\dist\          (the static dashboard app)
 *     /wafermap/api/*    -> http://localhost:8090/wafermap/api/*   (the API app)
 *
 * The behaviours worth testing here are the ones that only appear once the
 * app is mounted under a path:
 *
 *   1. PATH BASE. Under IIS, HttpPlatformHandler forwards the FULL path
 *      ("/wafermap/api/wafermap?...") to the Python process, which infers its
 *      path base from "/api/" and routes "/api/wafermap" (backend/app.py,
 *      StripBasePath). This proxy forwards the full path too, so you test the
 *      real behaviour, not a rewritten one. (The GroupsApi's proxy strips the
 *      prefix instead, because the ASP.NET Core Module does that for .NET.)
 *
 *   2. THE TRAILING-SLASH REDIRECT. "api/..." and "./assets/..." are RELATIVE
 *      URLs - they resolve against the page. At "/wafermap/" that gives
 *      "/wafermap/api/..."; at "/wafermap" (no slash) it would give "/api/..."
 *      and miss. IIS 301s application paths to add the slash; so does this.
 *
 * Zero dependencies. Static files only, no caching, no compression: this is a
 * verification harness, not a web server. Do not deploy it.
 *
 *   node deploy/serve-local.mjs            # or: npm run serve:local (in frontend/)
 *   node deploy/serve-local.mjs --port 8080 --api-port 8090 --base /dashboard.wafermap
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 8080));
const API_PORT = Number(arg('api-port', 8090));
const DIST = path.resolve(arg('dist', path.join(REPO, 'frontend', 'dist')));
// Normalised to "/name" - no trailing slash, so BASE + "/..." is always clean.
const BASE = '/' + arg('base', '/wafermap').replace(/^\/+|\/+$/g, '');
const API_BASE = `${BASE}/api`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
};

/**
 * Forward to the Python API with the FULL path (like HttpPlatformHandler).
 * `raw` must still be PERCENT-ENCODED: sample ids and layout names can carry
 * spaces and http.request rejects a path containing raw spaces.
 */
function proxyToApi(req, res, raw) {
  let upstream;
  try {
    upstream = httpRequest({
      host: 'localhost',
      port: API_PORT,
      method: req.method,
      path: raw,
      headers: { ...req.headers, host: `localhost:${API_PORT}` },
    });
  } catch (e) {
    console.error(`  ! bad proxy path ${JSON.stringify(raw)}: ${e.message}`);
    return send(res, 502, `Bad proxy path: ${e.message}\n`);
  }
  upstream.on('response', (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    console.error(`  ! API unreachable on :${API_PORT} - is uvicorn running?`);
    send(
      res,
      502,
      `The API is not running on http://localhost:${API_PORT}.\n\n` +
        `Start it (from backend/):  .venv\\Scripts\\python -m uvicorn app:app --port ${API_PORT}\n`,
    );
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const raw = url.pathname;
  const pathname = decodeURIComponent(raw);

  // The API application, nested under the dashboard application.
  if (raw === API_BASE || raw.startsWith(`${API_BASE}/`)) {
    return proxyToApi(req, res, raw + url.search);
  }

  // Outside the app entirely - mirrors "other apps live on this site too".
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) {
    return send(res, 404, `Nothing here. The dashboard is at http://localhost:${PORT}${BASE}/\n`);
  }

  // The IIS application redirect. Load-bearing: relative URLs need the slash.
  if (pathname === BASE) {
    res.writeHead(301, { Location: `${BASE}/${url.search}` });
    return res.end();
  }

  const rel = pathname.slice(BASE.length + 1) || 'index.html';
  if (rel.includes('..')) return send(res, 400, 'Bad path\n');
  // IIS never serves web.config (request filtering hides it); neither does this.
  if (path.basename(rel).toLowerCase() === 'web.config') return send(res, 404, 'Not found\n');

  let file = path.join(DIST, rel);
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) {
    // No SPA rewrite: routing is in the query / hash, so a rewrite here would
    // only mask a genuinely missing file as a silent 200.
    return send(res, 404, `Not found: ${rel}\n`);
  }

  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

if (!existsSync(DIST)) {
  console.error(`dist not found at ${DIST}\nBuild it first:  cd frontend && npm run build`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`\n  Simulating the IIS sub-application layout\n`);
  console.log(`    Dashboard   http://localhost:${PORT}${BASE}/?sample=<id>&plan=2d`);
  console.log(`    Editor      http://localhost:${PORT}${BASE}/#/editor`);
  console.log(`    API         http://localhost:${PORT}${API_BASE}/health  ->  localhost:${API_PORT}${API_BASE}/health`);
  console.log(`    Serving     ${DIST}\n`);
  console.log(`  The API must be running separately (from backend/):`);
  console.log(`    .venv\\Scripts\\python -m uvicorn app:app --port ${API_PORT}\n`);
});
