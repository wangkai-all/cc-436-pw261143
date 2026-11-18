import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import {
  ApiError,
  approveContract,
  compareContracts,
  createContract,
  createException,
  exceptionImpact,
  getBatch,
  getSource,
  ingest,
  listBatches,
  listExceptions,
  listQuarantine,
  listSources,
  overview,
  previewExceptionImpact,
  replayAllQuarantine,
  replayQuarantine,
  sourceTimeline,
  toggleException,
  updateSource,
  verifySource,
  fieldProposals,
  playgroundDetect,
} from './core.js';
import { CATEGORY_META, DEFAULT_POLICY, VERSION_POLICIES } from './policies.js';
import { buildMockPayload, CATALOG, VARIANT_META } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const dbPath = process.env.DB_PATH ?? path.join(root, 'data', 'sentinel.db');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

export function createApp({ databasePath = dbPath } = {}) {
  const db = openDatabase(databasePath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(db, req, res, url);
        return;
      }
      serveStatic(req, res, url);
    } catch (error) {
      sendJson(res, error instanceof ApiError ? error.status : 500, {
        error: error.message,
        ...(error instanceof ApiError ? error.extra : {}),
      });
      if (!(error instanceof ApiError)) console.error(error);
    }
  });

  return { server, db };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new ApiError('请求体过大（上限 8MB）', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(db, req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method ?? 'GET';
  const q = Object.fromEntries(url.searchParams.entries());

  // GET /api/meta
  if (method === 'GET' && segments[0] === 'meta') {
    return sendJson(res, 200, {
      categories: CATEGORY_META,
      versionPolicies: VERSION_POLICIES,
      defaultPolicy: DEFAULT_POLICY,
      variants: VARIANT_META,
      catalog: CATALOG.map((s) => ({ slug: s.slug, name: s.name, variants: s.variants })),
    });
  }
  if (method === 'GET' && segments[0] === 'overview') {
    return sendJson(res, 200, overview(db));
  }
  if (segments[0] === 'sources' && segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, { sources: listSources(db) });
  }
  if (segments[0] === 'sources' && segments.length === 2 && method === 'GET') {
    return sendJson(res, 200, getSource(db, segments[1]));
  }
  if (segments[0] === 'sources' && segments.length === 2 && method === 'PATCH') {
    const body = await readBody(req);
    return sendJson(res, 200, updateSource(db, segments[1], body));
  }
  if (segments[0] === 'sources' && segments[2] === 'contracts') {
    if (segments.length === 3 && method === 'GET') {
      const source = getSource(db, segments[1]);
      return sendJson(res, 200, {
        contracts: source.contracts,
        currentContract: source.currentContract,
      });
    }
    if (segments.length === 3 && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, createContract(db, segments[1], body));
    }
    if (segments[3] === 'compare' && method === 'GET') {
      return sendJson(res, 200, compareContracts(db, segments[1], { from: q.from, to: q.to }));
    }
    if (segments.length === 5 && segments[4] === 'approve' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, approveContract(db, segments[1], segments[3], body));
    }
  }
  if (segments[0] === 'sources' && segments[2] === 'batches' && method === 'GET') {
    return sendJson(res, 200, { batches: listBatches(db, segments[1], { limit: q.limit }) });
  }
  if (segments[0] === 'sources' && segments[2] === 'timeline' && method === 'GET') {
    return sendJson(res, 200, { batches: sourceTimeline(db, segments[1]) });
  }
  if (segments[0] === 'sources' && segments[2] === 'field-proposals' && method === 'GET') {
    return sendJson(res, 200, fieldProposals(db, segments[1]));
  }
  if (segments[0] === 'sources' && segments[2] === 'verify' && method === 'GET') {
    return sendJson(res, 200, verifySource(db, segments[1]));
  }
  if (segments[0] === 'verify' && segments.length === 1 && method === 'GET') {
    return sendJson(res, 200, { results: listSources(db).map((s) => verifySource(db, s.slug)) });
  }
  if (segments[0] === 'sources' && segments[2] === 'ingest' && method === 'POST') {
    const body = await readBody(req);
    const batch = ingest(db, segments[1], body);
    return sendJson(res, 201, { batch, source: getSource(db, segments[1]) });
  }
  if (segments[0] === 'sources' && segments[2] === 'mock' && method === 'GET') {
    const source = CATALOG.find((s) => s.slug === segments[1]);
    if (!source) throw new ApiError('该数据源没有本地模拟接口', 404);
    const variant = q.variant ?? 'clean';
    const payload = buildMockPayload(source.slug, variant, { seed: q.seed ? Number(q.seed) : undefined });
    return sendJson(res, 200, { payload, variants: source.variants });
  }
  if (segments[0] === 'sources' && segments[2] === 'quarantine') {
    if (segments.length === 3 && method === 'GET') {
      return sendJson(res, 200, listQuarantine(db, segments[1], { status: q.status, limit: q.limit }));
    }
    if (segments[3] === 'replay-all' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, replayAllQuarantine(db, segments[1], body));
    }
  }
  if (segments[0] === 'sources' && segments[2] === 'exceptions') {
    if (segments.length === 3 && method === 'GET') {
      return sendJson(res, 200, { exceptions: listExceptions(db, segments[1]) });
    }
    if (segments.length === 3 && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, createException(db, segments[1], body));
    }
    if (segments[3] === 'preview' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, previewExceptionImpact(db, segments[1], body));
    }
  }
  if (segments[0] === 'batches' && segments.length === 2 && method === 'GET') {
    return sendJson(res, 200, getBatch(db, segments[1]));
  }
  if (segments[0] === 'quarantine' && segments.length === 3 && segments[2] === 'replay' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, replayQuarantine(db, segments[1], body));
  }
  if (segments[0] === 'exceptions' && segments.length === 3 && method === 'PATCH') {
    const body = await readBody(req);
    return sendJson(res, 200, toggleException(db, segments[1], Boolean(body.active)));
  }
  if (segments[0] === 'exceptions' && segments.length === 3 && segments[2] === 'impact') {
    return sendJson(res, 200, exceptionImpact(db, segments[1]));
  }
  if (segments[0] === 'playground' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, playgroundDetect(db, body));
  }

  throw new ApiError(`未知接口 ${method} ${url.pathname}`, 404);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(publicDir, 'index.html');
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`契约哨站已启动: http://${host}:${address.port}`);
    console.log(`数据库: ${dbPath}`);
  });
}
