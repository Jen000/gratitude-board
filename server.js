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
const MAX_BODY_BYTES = 40_000;
const MAX_STROKE_POINTS = 1500;
// A board is erased for good once this many days pass with nothing added, changed or erased on it.
const BOARD_TTL_DAYS = Number(process.env.BOARD_TTL_DAYS) > 0 ? Number(process.env.BOARD_TTL_DAYS) : 35;
const BOARD_TTL_MS = BOARD_TTL_DAYS * 86_400_000;
const MAX_ENTRIES_PER_BOARD = 4000; // keeps one board from growing without limit
// The markers and handwriting people can choose from. The site (public/app.js) offers the same lists.
const COLORS = ['black', 'blue', 'red', 'green', 'purple', 'orange', 'pink', 'teal'];
const FONTS = ['caveat', 'kalam', 'indie', 'shadows', 'gloria', 'marker', 'messy'];
// The board is BOARD_WIDTH units wide and grows downward as it fills. A note's x/y is its top-left corner.
const BOARD_WIDTH = 1400;
const MAX_X = BOARD_WIDTH - 60;
const MAX_Y = 20_000;
const coord = (value, max) => (Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : null);
const SIZES = ['m', 's', 'l', 'xl']; // medium is the default
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
if (!db.prepare('PRAGMA table_info(boards)').all().some((c) => c.name === 'last_active')) {
  db.exec(`
    ALTER TABLE boards ADD COLUMN last_active INTEGER;
    UPDATE boards SET last_active = MAX(created_at, COALESCE((SELECT MAX(created_at) FROM entries WHERE board_code = code), 0));
  `);
}
const entryColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name));
if (!entryColumns.has('author_key')) db.exec('ALTER TABLE entries ADD COLUMN author_key TEXT');
if (!entryColumns.has('edited_at')) db.exec('ALTER TABLE entries ADD COLUMN edited_at INTEGER');
if (!entryColumns.has('color')) db.exec('ALTER TABLE entries ADD COLUMN color TEXT');
if (!entryColumns.has('font')) db.exec('ALTER TABLE entries ADD COLUMN font TEXT');
if (!entryColumns.has('path')) db.exec('ALTER TABLE entries ADD COLUMN path TEXT');
if (!entryColumns.has('size')) db.exec('ALTER TABLE entries ADD COLUMN size TEXT');
if (!entryColumns.has('x')) {
  db.exec('ALTER TABLE entries ADD COLUMN x INTEGER; ALTER TABLE entries ADD COLUMN y INTEGER;');
  // Notes written before people could choose a spot: lay them out in three loose columns.
  const place = db.prepare('UPDATE entries SET x = ?, y = ? WHERE id = ?');
  const counts = new Map();
  for (const { id, board } of db.prepare('SELECT id, board_code AS board FROM entries ORDER BY id').all()) {
    const n = counts.get(board) || 0;
    counts.set(board, n + 1);
    place.run(70 + (n % 3) * 450, 50 + Math.floor(n / 3) * 170, id);
  }
}

const q = {
  insertBoard: db.prepare('INSERT INTO boards (code, title, created_at, last_active) VALUES (?, ?, ?, ?)'),
  getBoard: db.prepare('SELECT code, title, created_at AS createdAt, last_active AS lastActive FROM boards WHERE code = ?'),
  touchBoard: db.prepare('UPDATE boards SET last_active = ? WHERE code = ?'),
  expiredBoards: db.prepare('SELECT code FROM boards WHERE last_active < ?'),
  deleteBoardEntries: db.prepare('DELETE FROM entries WHERE board_code = ?'),
  deleteBoard: db.prepare('DELETE FROM boards WHERE code = ?'),
  getEntries: db.prepare(
    'SELECT id, text, color, font, size, x, y, path, author_key AS authorKey FROM entries WHERE board_code = ? ORDER BY id'
  ),
  insertEntry: db.prepare("INSERT INTO entries (board_code, name, text, color, font, size, x, y, created_at, author_key) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?)"),
  insertDrawing: db.prepare(
    "INSERT INTO entries (board_code, name, text, color, size, x, y, path, created_at, author_key) VALUES (?, '', '', ?, ?, ?, ?, ?, ?, ?)"
  ),
  getEntry: db.prepare('SELECT author_key AS authorKey, path FROM entries WHERE id = ? AND board_code = ?'),
  countEntries: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE board_code = ?'),
  updateEntry: db.prepare('UPDATE entries SET text = ?, edited_at = ? WHERE id = ?'),
  moveEntry: db.prepare('UPDATE entries SET x = ?, y = ? WHERE id = ?'),
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

// Who is asking, for rate limiting. Behind a host's proxy (Railway) the real address arrives in a header.
// The last X-Forwarded-For entry is the one the proxy added; earlier ones can be made up by the sender.
const clientIp = (req) =>
  String(req.headers['x-real-ip'] || '').trim() ||
  String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() ||
  req.socket.remoteAddress ||
  '?';

// Sent with every response. The page may only load scripts, styles, fonts and data from this site itself,
// may not be embedded in other sites, and tells browsers not to pass board links on to other sites.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

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

// ---------- expiry ----------
const isExpired = (board) => board.lastActive < Date.now() - BOARD_TTL_MS;
function eraseBoard(code) {
  q.deleteBoardEntries.run(code);
  q.deleteBoard.run(code);
}
function eraseExpiredBoards() {
  for (const { code } of q.expiredBoards.all(Date.now() - BOARD_TTL_MS)) eraseBoard(code);
}
eraseExpiredBoards();
setInterval(eraseExpiredBoards, 3_600_000).unref();

function boardPayload(code, key) {
  const found = q.getBoard.get(code);
  if (!found) return null;
  const { lastActive, ...board } = found;
  board.expiresAfterDays = BOARD_TTL_DAYS;
  board.expiresAt = lastActive + BOARD_TTL_MS;
  // Notes are anonymous: nothing about who wrote one leaves the server, except "this one is yours".
  // An entry is either a piece of writing or one drawn stroke (a list of x,y,x,y,… points).
  const entries = q.getEntries.all(code).map(({ authorKey: owner, path, text, font, size, x, y, ...entry }) => ({
    ...entry,
    color: pick(entry.color, COLORS),
    mine: Boolean(key && owner && owner === key),
    ...(path ? { kind: 'draw', size: pick(size, SIZES), points: JSON.parse(path) } : { kind: 'text', text, font: pick(font, FONTS), size: pick(size, SIZES), x, y }),
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
        q.insertBoard.run(code, title, Date.now(), Date.now());
        return send(res, 201, boardPayload(code, key));
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err; // collision: try another code
      }
    }
    return send(res, 500, { error: 'Could not create a board. Please try again.' });
  }

  const code = normalizeCode(parts[2]);
  // The hourly sweep removes old boards; this catches one that ran out since the last sweep.
  const existing = q.getBoard.get(code);
  if (existing && isExpired(existing)) eraseBoard(code);

  // GET /api/boards/:code
  if (parts.length === 3 && req.method === 'GET') {
    if (limited(ip, 'read', 600, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    const board = boardPayload(code, key);
    return board ? send(res, 200, board) : send(res, 404, { error: "We couldn't find a board with that code." });
  }

  // POST /api/boards/:code/entries — add a gratitude
  if (parts.length === 4 && parts[3] === 'entries' && req.method === 'POST') {
    // Generous, because a doodle is many strokes and a household often shares one address.
    if (limited(ip, 'post', 900, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    if (!q.getBoard.get(code)) return send(res, 404, { error: "We couldn't find a board with that code." });
    const body = await readJson(req);
    if (q.countEntries.get(code).n >= MAX_ENTRIES_PER_BOARD) {
      return send(res, 400, { error: 'This board is full. Erase something of yours, or start a new board.' });
    }
    if (body.kind === 'draw') {
      const raw = body.points;
      const ok = Array.isArray(raw) && raw.length >= 4 && raw.length % 2 === 0 && raw.length <= MAX_STROKE_POINTS * 2;
      const points = ok ? raw.map((v, i) => coord(v, i % 2 ? MAX_Y : BOARD_WIDTH)) : [];
      if (!ok || points.includes(null)) return send(res, 400, { error: "That drawing couldn't be saved." });
      q.insertDrawing.run(code, pick(body.color, COLORS), pick(body.size, SIZES), points[0], points[1], JSON.stringify(points), Date.now(), key);
      q.touchBoard.run(Date.now(), code);
      return send(res, 201, boardPayload(code, key));
    }
    const text = clean(body.text, MAX_TEXT, { multiline: true });
    if (!text) return send(res, 400, { error: 'Write something you are grateful for.' });
    // No spot given (or nonsense): drop it somewhere near the top of the board.
    const x = coord(body.x, MAX_X) ?? randomInt(60, 900);
    const y = coord(body.y, MAX_Y) ?? randomInt(40, 600);
    q.insertEntry.run(code, text, pick(body.color, COLORS), pick(body.font, FONTS), pick(body.size, SIZES), x, y, Date.now(), key);
    q.touchBoard.run(Date.now(), code);
    return send(res, 201, boardPayload(code, key));
  }

  // PATCH / DELETE /api/boards/:code/entries/:id — reword, move or erase your own note
  if (parts.length === 5 && parts[3] === 'entries' && (req.method === 'PATCH' || req.method === 'DELETE')) {
    if (limited(ip, 'post', 900, 600_000)) return send(res, 429, { error: 'Slow down a little and try again.' });
    const id = Number(parts[4]);
    const entry = Number.isInteger(id) ? q.getEntry.get(id, code) : null;
    if (!entry) return send(res, 404, { error: 'That note is no longer on the board.' });
    if (!key || entry.authorKey !== key) {
      return send(res, 403, { error: 'Only the person who wrote a note can change it, from the browser they wrote it in.' });
    }
    if (req.method === 'DELETE') {
      q.deleteEntry.run(id);
    } else if (entry.path) {
      return send(res, 400, { error: 'Drawings can be erased, not changed.' });
    } else {
      // A change can reword the note, move it, or both.
      const body = await readJson(req);
      const x = coord(body.x, MAX_X);
      const y = coord(body.y, MAX_Y);
      if (body.text !== undefined) {
        const text = clean(body.text, MAX_TEXT, { multiline: true });
        if (!text) return send(res, 400, { error: 'Write something you are grateful for.' });
        q.updateEntry.run(text, Date.now(), id);
      } else if (x === null || y === null) {
        return send(res, 400, { error: 'Nothing to change.' });
      }
      if (x !== null && y !== null) q.moveEntry.run(x, y, id);
    }
    q.touchBoard.run(Date.now(), code);
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
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      throw Object.assign(new Error('Invalid request.'), { status: 400 });
    }
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
