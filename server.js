#!/usr/bin/env node
/*
 * Stagegate self-hosted server. No dependencies: Node 22.5+ (built-in SQLite).
 *   PORT=8080 DATA_FILE=./data/stagegate.db TRACKER_PASSWORD=secret node server.js
 * Serves the same front end as the hosted claude.ai version, storing data in SQLite.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { COLLECTIONS } = require('./public/core.js');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'stagegate.db');
const PASSWORD = process.env.TRACKER_PASSWORD || '';
const USER = process.env.TRACKER_USER || 'admin';
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
const db = new DatabaseSync(DATA_FILE);
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id));`);
const qAll = db.prepare('SELECT collection, data FROM docs');
const qPut = db.prepare(`INSERT INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
const qDel = db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?');

// Same document skeleton the claude.ai artifact host wraps the page in.
const SKELETON_HEAD = '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const SKELETON_TAIL = '</body></html>';

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function authorised(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  return u === USER && rest.join(':') === PASSWORD;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleApi(req, res, parts) {
  if (parts[0] === 'health') return send(res, 200, { ok: true });
  if (parts[0] === 'data' && req.method === 'GET') {
    const out = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    for (const row of qAll.all()) if (out[row.collection]) out[row.collection].push(JSON.parse(row.data));
    return send(res, 200, out);
  }
  const [col, rawId] = parts;
  const id = rawId && decodeURIComponent(rawId);
  if (!COLLECTIONS.includes(col) || !id || id.length > 200) return send(res, 404, { error: 'Unknown collection or id' });
  if (req.method === 'PUT') {
    let doc;
    try { doc = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'Invalid JSON' }); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return send(res, 400, { error: 'Body must be an object' });
    doc.id = id;
    qPut.run(col, id, JSON.stringify(doc), new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') { qDel.run(col, id); res.writeHead(204); return res.end(); }
  return send(res, 405, { error: 'Method not allowed' });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    const page = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return send(res, 200, SKELETON_HEAD + page + SKELETON_TAIL, TYPES['.html']);
  }
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Stagegate", charset="UTF-8"' });
      return res.end('Sign in required');
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname.slice(5).split('/').filter(Boolean));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Stagegate running on http://localhost:${PORT}  (data: ${DATA_FILE}${PASSWORD ? ', password protected' : ''})`);
  if (!PASSWORD && HOST !== '127.0.0.1') console.log('Tip: set TRACKER_PASSWORD before exposing this server to a network.');
});
