// Gratitude Board — a tiny zero-dependency Node server.
// Serves the static site in ./public and a small JSON API backed by SQLite.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomInt, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
// On Railway, an attached volume announces itself through RAILWAY_VOLUME_MOUNT_PATH.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;

// No 0/O, 1/I/L — codes get read aloud and typed on phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_TITLE = 60;
const MAX_TEXT = 500;
const MAX_BODY_BYTES = 10_000;
// The markers and handwriting people can choose from. The site (public/app.js) offers the same lists.
const COLORS = ['black', 'blue', 'red', 'green', 'purple', 'orange', 'pink', 'teal'];
const FONTS = ['caveat', 'kalam', 'indie', 'shadows', 'gloria', 'marker'];
const pick = (value, allowed) => (allowed.includes(value) ? value : allowed[0]);

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'gratitude.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS boards (
    code TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_code TEXT NOT NULL REFERENCES boards(code),
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entries_by_board ON entries(board_code, created_at);
`);
// Columns added after the first version: who may edit a note, and when it was last edited.
const entryColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name));
if (!entryColumns.has('author_key')) db.exec('ALTER TABLE entries ADD COLUMN author_key TEXT');
if (!entryColumns.has('edited_at')) db.exec('ALTER TABLE entries ADD COLUMN edited_at INTEGER');
if (!entryColumns.has('color')) db.exec('ALTER TABLE entries ADD COLUMN color TEXT');
if (!entryColumns.has('font')) db.exec('ALTER TABLE entries ADD COLUMN font TEXT');

const q = {
  insertBoard: db.prepare('INSERT INTO boards (code, title, created_at) VALUES (?, ?, ?)'),
  getBoard: db.prepare('SELECT code, title, created_at AS createdAt FROM boards WHERE code = ?'),
  getEntries: db.prepare(
    'SELECT id, text, color, font, created_at AS createdAt, author_key AS authorKey FROM entries WHERE board_code = ? ORDER BY created_at DESC, id DESC'
  ),
  insertEntry: db.prepare("INSERT INTO entries (board_code, name, text, color, font, created_at, author_key) VALUES (?, '', ?, ?, ?, ?, ?)"),
  getEntry: db.prepare('SELECT author_key AS authorKey FROM entries WHERE id = ? AND board_code = ?'),
  updateEntry: db.prepare('UPDATE entries SET text = ?, edited_at = ? WHERE id = ?'),
  deleteEntry: db.prepare('DELETE FROM entries WHERE id = ?'),
};

const newCode = () =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Trim, collapse runs of whitespace (keeping single newlines when allowed), cap length.
function clean(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

// --- very small in-memory rate limiter (per IP, fixed window) ---
const buckets = new Map();
function limited(ip, kind, max, windowMs) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) buckets.set(key, (b = { count: 0, reset: now + windowMs }));
  return ++b.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Too much text.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('Invalid request.'), { status: 400 });
  }
}

// There are no accounts. Each browser makes up a private key and sends it with every request;
// a note remembers (a hash of) the key that wrote it, and only that key may edit or delete it.
function authorKey(req) {
  const raw = String(req.headers['x-author-key'] || '');
  return raw.length >= 16 && raw.length <= 200 ? createHash('sha256').update(raw).digest('hex') : null;
}

function boardPayload(code, key) {
  const board = q.getBoard.get(code);
  if (!board) return null;
  // Notes are anonymous: nothing about who wrote one leaves the server, except "this one is yours".
  const entries = q.getEntries.all(code).map(({ authorKey: owner, ...entry }) => ({
    ...entry,
    color: pick(entry.color, COLORS),
    font: pick(entry.font, FONTS),
    mine: Boolean(key && owner && owner === key),
  }));
  return { ...board, entries };
}

async function handleApi(req, res, path) {
  const ip = clientIp(req);
  const key = authorKey(req);
  const parts = path.split('/').filter(Boolean); // ['api', 'boards', code?, 'entries'?]
  if (parts[1] !== 'boards') return send(res, 404, { error: 'Not found.' });

  // POST /api/boards — start a new board
  if (parts.length === 2 && req.method === 'POST') {
    if (limited(ip, 'create', 20, 3_600_000)) return send(res, 429, { error: 'Too many new boards — try again later.' });
    const body = await readJson(req);
    const title = clean(body.title, MAX_TITLE) || 'Our Gratitude Board';
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newCode();
      try {
        q.insertBoard.run(code, title, Date.now());
        return send(res, 201, boardPayload(code, key));
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err; // collision: try another code
      }
    }
    return send(res, 500, { error: 'Could not create a board. Please try again.' });
  }

  const code = normalizeCode(parts[2]);

  // GET /api/boards/:code
  if (parts.length === 3 && req.method === 'GET') {
    if (limited(ip, 'read', 600, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    const board = boardPayload(code, key);
    return board ? send(res, 200, board) : send(res, 404, { error: "We couldn't find a board with that code." });
  }

  // POST /api/boards/:code/entries — add a gratitude
  if (parts.length === 4 && parts[3] === 'entries' && req.method === 'POST') {
    if (limited(ip, 'post', 60, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    if (!q.getBoard.get(code)) return send(res, 404, { error: "We couldn't find a board with that code." });
    const body = await readJson(req);
    const text = clean(body.text, MAX_TEXT, { multiline: true });
    if (!text) return send(res, 400, { error: 'Write something you are grateful for.' });
    q.insertEntry.run(code, text, pick(body.color, COLORS), pick(body.font, FONTS), Date.now(), key);
    return send(res, 201, boardPayload(code, key));
  }

  // PATCH / DELETE /api/boards/:code/entries/:id — change or remove your own note
  if (parts.length === 5 && parts[3] === 'entries' && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (limited(ip, 'post', 60, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    const id = Number(parts[4]);
    const entry = Number.isInteger(id) ? q.getEntry.get(id, code) : null;
    if (!entry) return send(res, 404, { error: 'That note is no longer on the board.' });
    if (!key || entry.authorKey !== key) {
      return send(res, 403, { error: 'Only the person who wrote a note can change it, from the browser they wrote it in.' });
    }
    if (req.method === 'DELETE') {
      q.deleteEntry.run(id);
    } else {
      const text = clean((await readJson(req)).text, MAX_TEXT, { multiline: true });
      if (!text) return send(res, 400, { error: 'Write something you are grateful for.' });
      q.updateEntry.run(text, Date.now(), id);
    }
    return send(res, 200, boardPayload(code, key));
  }

  return send(res, 404, { error: 'Not found.' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function handleStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // Anything without a file extension (/, /b/ABC123) is the single-page app.
  const rel = extname(path) ? normalize(path).replace(/^([/\\]|\.\.)+/, '') : 'index.html';
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else await handleStatic(req, res, path);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
    else res.end();
  }
});

server.listen(PORT, () =>
  console.log(`Gratitude Board running at http://localhost:${server.address().port} (boards stored in ${DATA_DIR})`)
);
