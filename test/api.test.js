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

  const res = await post(`/api/boards/${created.code}/entries`, { name: ' Jen ', text: 'Coffee\n\n\n\nand   sunshine' });
  assert.equal(res.status, 201);

  // Codes are forgiving: lowercase and stray punctuation still find the board.
  const board = await (await fetch(`${base}/api/boards/${created.code.toLowerCase().replace(/^(...)/, '$1-')}`)).json();
  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].name, 'Jen');
  assert.equal(board.entries[0].text, 'Coffee\n\nand sunshine');
});

test('rejects empty entries and unknown codes', async () => {
  const { code } = await (await post('/api/boards', {})).json();
  assert.equal((await post(`/api/boards/${code}/entries`, { name: '', text: 'hi' })).status, 400);
  assert.equal((await post(`/api/boards/${code}/entries`, { name: 'Jen', text: '   ' })).status, 400);
  assert.equal((await fetch(`${base}/api/boards/ZZZZZZ`)).status, 404);
  assert.equal((await post('/api/boards/ZZZZZZ/entries', { name: 'Jen', text: 'hi' })).status, 404);
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
  const mine = await (await post(`/api/boards/${code}/entries`, { name: 'Jen', text: 'Tea' }, jen)).json();
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
  assert.ok(edited.entries[0].editedAt);

  const gone = await (await send('DELETE', `/api/boards/${code}/entries/${id}`, undefined, jen)).json();
  assert.deepEqual(gone.entries, []);
  assert.equal((await send('DELETE', `/api/boards/${code}/entries/${id}`, undefined, jen)).status, 404);
});
