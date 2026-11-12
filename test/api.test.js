import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

let server, base, dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gratitude-'));
  process.env.DATA_DIR = dataDir;
  process.env.PORT = '0';
  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const send = (method, path, body, key) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key && { 'X-Author-Key': key }) },
    body: body && JSON.stringify(body),
  });
const post = (path, body, key) => send('POST', path, body, key);

test('create a board, add to it, read it back by code', async () => {
  const created = await (await post('/api/boards', { title: '  Team   Friday ' })).json();
  assert.match(created.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(created.title, 'Team Friday');
  assert.deepEqual(created.entries, []);

  const res = await post(`/api/boards/${created.code}/entries`, { name: 'Jen', text: 'Coffee\n\n\n\nand   sunshine', color: 'teal', font: 'gloria', x: 321.4, y: 99999 });
  assert.equal(res.status, 201);

  // Codes are forgiving: lowercase and stray punctuation still find the board.
  const board = await (await fetch(`${base}/api/boards/${created.code.toLowerCase().replace(/^(...)/, '$1-')}`)).json();
  assert.equal(board.entries.length, 1);
  // Notes are anonymous (a name is ignored even if one is sent) and keep their marker and handwriting.
  assert.equal('name' in board.entries[0], false);
  assert.equal(board.entries[0].color, 'teal');
  assert.equal(board.entries[0].font, 'gloria');
  // It stays where it was put (rounded, and kept on the board).
  assert.equal(board.entries[0].x, 321);
  assert.equal(board.entries[0].y, 20000);
  assert.equal(board.entries[0].text, 'Coffee\n\nand sunshine');
});

test('rejects empty entries and unknown codes', async () => {
  const { code } = await (await post('/api/boards', {})).json();
  assert.equal((await post(`/api/boards/${code}/entries`, { text: '   ' })).status, 400);
  // Unknown markers fall back to the defaults rather than being stored.
  const odd = await (await post(`/api/boards/${code}/entries`, { text: 'hi', color: 'url(evil)', font: 'x' })).json();
  assert.equal(odd.entries[0].color, 'black');
  assert.equal(odd.entries[0].font, 'caveat');
  assert.ok(Number.isInteger(odd.entries[0].x) && Number.isInteger(odd.entries[0].y));
  assert.equal((await fetch(`${base}/api/boards/ZZZZZZ`)).status, 404);
  assert.equal((await post('/api/boards/ZZZZZZ/entries', { text: 'hi' })).status, 404);
});

test('serves the app for board links and blocks path traversal', async () => {
  const page = await fetch(`${base}/b/ABC123`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Gratitude Board/);
  assert.equal((await fetch(`${base}/..%2Fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});

test('only the author can edit or delete a note', async () => {
  const jen = 'jen-browser-key-0123456789';
  const sam = 'sam-browser-key-0123456789';
  const { code } = await (await post('/api/boards', {})).json();
  const mine = await (await post(`/api/boards/${code}/entries`, { text: 'Tea' }, jen)).json();
  const { id } = mine.entries[0];
  assert.equal(mine.entries[0].mine, true);
  assert.equal('authorKey' in mine.entries[0], false);

  // Someone else sees the note but can't touch it.
  const theirs = await (await send('GET', `/api/boards/${code}`, undefined, sam)).json();
  assert.equal(theirs.entries[0].mine, false);
  assert.equal((await send('PATCH', `/api/boards/${code}/entries/${id}`, { text: 'hacked' }, sam)).status, 403);
  assert.equal((await send('DELETE', `/api/boards/${code}/entries/${id}`, undefined, sam)).status, 403);
  assert.equal((await send('DELETE', `/api/boards/${code}/entries/${id}`)).status, 403);

  // The author can edit (but not blank it out), and the note can't be reached through another board.
  assert.equal((await send('PATCH', `/api/boards/${code}/entries/${id}`, { text: '  ' }, jen)).status, 400);
  const other = await (await post('/api/boards', {})).json();
  assert.equal((await send('DELETE', `/api/boards/${other.code}/entries/${id}`, undefined, jen)).status, 404);
  const edited = await (await send('PATCH', `/api/boards/${code}/entries/${id}`, { text: 'Green tea' }, jen)).json();
  assert.equal(edited.entries[0].text, 'Green tea');

  // Moving is also the author's alone, and leaves the words as they are.
  assert.equal((await send('PATCH', `/api/boards/${code}/entries/${id}`, { x: 5, y: 5 }, sam)).status, 403);
  assert.equal((await send('PATCH', `/api/boards/${code}/entries/${id}`, {}, jen)).status, 400);
  const moved = await (await send('PATCH', `/api/boards/${code}/entries/${id}`, { x: 700, y: 410 }, jen)).json();
  assert.deepEqual([moved.entries[0].x, moved.entries[0].y, moved.entries[0].text], [700, 410, 'Green tea']);

  const gone = await (await send('DELETE', `/api/boards/${code}/entries/${id}`, undefined, jen)).json();
  assert.deepEqual(gone.entries, []);
  assert.equal((await send('DELETE', `/api/boards/${code}/entries/${id}`, undefined, jen)).status, 404);
});

test('drawings are saved as strokes that only their author can erase', async () => {
  const jen = 'jen-browser-key-0123456789';
  const sam = 'sam-browser-key-0123456789';
  const { code } = await (await post('/api/boards', {})).json();
  const drawn = await (await post(`/api/boards/${code}/entries`, { kind: 'draw', color: 'red', points: [10.4, 20, 30, 40, 5000, -3] }, jen)).json();
  const stroke = drawn.entries[0];
  assert.deepEqual(stroke, { id: stroke.id, color: 'red', mine: true, kind: 'draw', points: [10, 20, 30, 40, 1400, 0] });

  for (const points of [[1, 2], [1, 2, 3], [1, 2, 'x', 4], 'nope', new Array(3002).fill(1)]) {
    assert.equal((await post(`/api/boards/${code}/entries`, { kind: 'draw', points }, jen)).status, 400);
  }
  assert.equal((await send('PATCH', `/api/boards/${code}/entries/${stroke.id}`, { x: 1, y: 1 }, jen)).status, 400);
  assert.equal((await send('DELETE', `/api/boards/${code}/entries/${stroke.id}`, undefined, sam)).status, 403);
  const gone = await (await send('DELETE', `/api/boards/${code}/entries/${stroke.id}`, undefined, jen)).json();
  assert.deepEqual(gone.entries, []);
});
