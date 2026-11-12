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

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
