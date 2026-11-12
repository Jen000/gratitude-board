// Gratitude Board — client. Two views (home, board) routed by URL: "/" and "/b/CODE".
const $ = (id) => document.getElementById(id);
const views = { home: $('home'), board: $('board'), missing: $('missing') };

// The markers and handwriting on offer. The server (server.js) accepts the same keys.
const COLORS = [
  ['black', 'Black'], ['blue', 'Blue'], ['red', 'Red'], ['green', 'Green'],
  ['purple', 'Purple'], ['orange', 'Orange'], ['pink', 'Pink'], ['teal', 'Teal'],
];
const FONTS = [
  ['caveat', 'Quick'], ['kalam', 'Neat'], ['indie', 'Loopy'],
  ['shadows', 'Tall'], ['gloria', 'Bouncy'], ['marker', 'Bold'],
];

// ---------- what the browser remembers ----------
// localStorage can be unavailable (private windows, blocked storage) — the site still works without it.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
const getBoards = () => {
  const list = store.get('gb.boards', []);
  return Array.isArray(list) ? list.filter((b) => b && typeof b.code === 'string') : [];
};
function rememberBoard(code, title) {
  const rest = getBoards().filter((b) => b.code !== code);
  store.set('gb.boards', [{ code, title, visited: Date.now() }, ...rest].slice(0, 12));
}
const forgetBoard = (code) => store.set('gb.boards', getBoards().filter((b) => b.code !== code));

// A private key for this browser. The server uses it to tell which notes are yours to edit or erase.
let authorKey = store.get('gb.key', '');
if (typeof authorKey !== 'string' || authorKey.length < 16) {
  authorKey = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('gb.key', authorKey);
}

// Your marker and handwriting. First-time visitors get a random pair so a new board isn't all one colour.
function remembered(key, options) {
  const saved = store.get(key, '');
  if (options.some(([id]) => id === saved)) return saved;
  const choice = options[Math.floor(Math.random() * options.length)][0];
  store.set(key, choice);
  return choice;
}
const pen = { color: remembered('gb.color', COLORS), font: remembered('gb.font', FONTS) };

// ---------- helpers ----------
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function api(path, body, method = body ? 'POST' : 'GET') {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-Author-Key': authorKey, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the board right now. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
function dayLabel(ts) {
  const now = new Date();
  if (dayKey(ts) === dayKey(now)) return 'Today';
  if (dayKey(ts) === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
}

// Let a textarea grow with what's written in it.
function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + 2}px`;
}

// ---------- routing ----------
let current = null; // board being shown: { code, title, entries }
let pollTimer = null;
let seenIds = new Set();
let busyNote = null; // { id, mode: 'edit' | 'delete' } while someone is editing or confirming an erase

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  window.scrollTo(0, 0);
}

function go(path) {
  history.pushState(null, '', path);
  route();
}

async function route() {
  clearInterval(pollTimer);
  current = null;
  const match = location.pathname.match(/^\/b\/([^/]+)\/?$/);
  const code = normalizeCode(match ? match[1] : new URLSearchParams(location.search).get('code'));
  if (!code) return renderHome();
  try {
    openBoard(await api(`/api/boards/${code}`));
  } catch (err) {
    if (err.status === 404) {
      forgetBoard(code);
      document.title = 'Board not found · Gratitude Board';
      show('missing');
    } else {
      renderHome();
      $('join-code').value = code;
      $('join-error').textContent = err.message;
    }
  }
}

// ---------- home ----------
function renderHome() {
  document.title = 'Gratitude Board';
  const boards = getBoards();
  $('greeting').textContent = boards.length
    ? "Welcome back. What's one good thing today?"
    : 'A shared whiteboard where you and your people write one good thing, every day. No names — just gratitude.';

  $('recent-list').replaceChildren(
    ...boards.map((b) => {
      const a = el('a');
      a.href = `/b/${b.code}`;
      a.append(el('span', 'title', b.title || 'Gratitude Board'), el('span', 'code', b.code));
      const li = el('li');
      li.append(a);
      return li;
    })
  );
  $('recent').hidden = boards.length === 0;
  $('join-error').textContent = '';
  $('create-error').textContent = '';
  show('home');
}

$('join-code').addEventListener('input', (e) => {
  e.target.value = normalizeCode(e.target.value);
  $('join-error').textContent = '';
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = normalizeCode($('join-code').value);
  if (!code) return ($('join-error').textContent = 'Type the code someone shared with you.');
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  try {
    const board = await api(`/api/boards/${code}`);
    history.pushState(null, '', `/b/${board.code}`);
    openBoard(board);
    $('join-code').value = '';
  } catch (err) {
    $('join-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  try {
    const board = await api('/api/boards', { title: $('create-title').value });
    history.pushState(null, '', `/b/${board.code}`);
    openBoard(board);
    $('create-title').value = '';
  } catch (err) {
    $('create-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- marker and handwriting pickers ----------
function buildPicker(container, name, options, render) {
  container.replaceChildren(
    ...options.flatMap(([id, label]) => {
      const input = el('input');
      input.type = 'radio';
      input.name = name;
      input.value = id;
      input.id = `${name}-${id}`;
      input.checked = pen[name] === id;
      input.addEventListener('change', () => {
        pen[name] = id;
        store.set(`gb.${name}`, id);
        applyPen();
      });
      const tag = render(id, label);
      tag.htmlFor = input.id;
      return [input, tag];
    })
  );
}

// Show the composer (and the handwriting samples) in the chosen marker.
function applyPen() {
  $('entry-form').className = `composer c-${pen.color} f-${pen.font}`;
  for (const sample of document.querySelectorAll('.hand')) {
    sample.className = `hand ink c-${pen.color} f-${sample.dataset.font}`;
  }
  autosize($('entry-text'));
}

buildPicker($('color-picker'), 'color', COLORS, (id, label) => {
  const swatch = el('label', `swatch c-${id}`);
  swatch.title = label;
  swatch.setAttribute('aria-label', `${label} marker`);
  return swatch;
});
buildPicker($('font-picker'), 'font', FONTS, (id, label) => {
  const sample = el('label', 'hand', label);
  sample.dataset.font = id;
  return sample;
});
applyPen();
$('entry-text').addEventListener('input', (e) => autosize(e.target));
document.fonts?.ready.then(() => autosize($('entry-text')));

// ---------- board ----------
function openBoard(board) {
  clearInterval(pollTimer);
  current = board;
  busyNote = null;
  seenIds = new Set(board.entries.map((entry) => entry.id));
  rememberBoard(board.code, board.title);
  document.title = `${board.title} · Gratitude Board`;
  $('board-title').textContent = board.title;
  $('copy-code').textContent = board.code;
  $('share-status').textContent = '';
  $('entry-error').textContent = '';
  renderEntries(board.entries);
  show('board');
  autosize($('entry-text'));
  pollTimer = setInterval(refresh, 20_000);
}

function renderEntries(entries, { animate = false } = {}) {
  const container = $('entries');
  const today = dayKey(Date.now());
  const mineToday = entries.filter((entry) => entry.mine && dayKey(entry.createdAt) === today).length;
  $('today-status').textContent = mineToday
    ? `You've written ${mineToday === 1 ? 'one' : mineToday} today. Add another any time.`
    : '';

  if (entries.length === 0) {
    container.replaceChildren(el('p', 'empty', 'A clean board. Write the first good thing, then invite people with the code.'));
    return;
  }

  const days = [];
  for (const entry of entries) {
    const key = dayKey(entry.createdAt);
    if (days.at(-1)?.key !== key) days.push({ key, label: dayLabel(entry.createdAt), items: [] });
    days.at(-1).items.push(entry);
  }

  container.replaceChildren(
    ...days.map((day) => {
      const section = el('section', 'day');
      const notes = el('div', 'notes');
      for (const entry of day.items) {
        const busy = busyNote?.id === entry.id ? busyNote.mode : null;
        const note = el('article', `note c-${entry.color} f-${entry.font}`);
        if (busy) note.classList.add('busy');
        if (animate && !seenIds.has(entry.id)) note.classList.add('fresh');
        // A steady, slightly crooked angle for each note, like real handwriting on a board.
        note.style.setProperty('--tilt', `${(((entry.id * 37) % 7) - 3) * 0.6}deg`);
        note.append(busy === 'edit' ? editForm(entry) : el('p', 'note-text ink', entry.text));
        if (entry.mine && !busy) note.append(noteActions(entry));
        if (busy === 'delete') note.append(deleteConfirm(entry));
        notes.append(note);
      }
      section.append(el('h2', 'day-label', day.label), notes);
      return section;
    })
  );
  for (const entry of entries) seenIds.add(entry.id);
}

// ---------- editing and erasing your own notes ----------
function setBusy(next) {
  busyNote = next;
  renderEntries(current.entries);
}

function noteActions(entry) {
  const row = el('div', 'note-actions');
  const edit = el('button', 'link', 'Edit');
  const erase = el('button', 'link', 'Erase');
  edit.type = erase.type = 'button';
  edit.addEventListener('click', () => {
    setBusy({ id: entry.id, mode: 'edit' });
    const box = document.querySelector('.note-edit textarea');
    if (!box) return;
    autosize(box);
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
  erase.addEventListener('click', () => {
    setBusy({ id: entry.id, mode: 'delete' });
    document.querySelector('.note-confirm button')?.focus();
  });
  row.append(edit, erase);
  return row;
}

// Sends a change for one note, then redraws the board with the server's answer.
async function changeNote(entry, method, body, errorNode, buttons) {
  const code = current.code;
  buttons.forEach((b) => (b.disabled = true));
  try {
    const board = await api(`/api/boards/${code}/entries/${entry.id}`, body, method);
    if (current?.code !== code) return;
    current = board;
    setBusy(null);
  } catch (err) {
    if (err.status === 404) return refreshNow(); // it was already erased
    errorNode.textContent = err.message;
    buttons.forEach((b) => (b.disabled = false));
  }
}

function editForm(entry) {
  const form = el('form', 'note-edit');
  const box = el('textarea', 'ink');
  box.value = entry.text;
  box.maxLength = 500;
  box.rows = 2;
  box.setAttribute('aria-label', 'Edit what you wrote');
  box.addEventListener('input', () => autosize(box));
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const save = el('button', 'btn btn-small btn-primary', 'Save');
  const cancel = el('button', 'btn btn-small', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => setBusy(null));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setBusy(null);
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return (error.textContent = 'It needs some words. To remove it, cancel and choose Erase.');
    if (text === entry.text) return setBusy(null);
    changeNote(entry, 'PATCH', { text }, error, [save, cancel]);
  });
  const row = el('div', 'note-buttons');
  row.append(save, cancel);
  form.append(box, error, row);
  return form;
}

function deleteConfirm(entry) {
  const wrap = el('div', 'note-confirm');
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const yes = el('button', 'btn btn-small btn-danger', 'Erase it');
  const no = el('button', 'btn btn-small', 'Keep it');
  yes.type = no.type = 'button';
  yes.addEventListener('click', () => changeNote(entry, 'DELETE', undefined, error, [yes, no]));
  no.addEventListener('click', () => setBusy(null));
  const row = el('div', 'note-buttons');
  row.append(yes, no);
  wrap.append(el('p', 'note-question', 'Erase this from the board for everyone?'), error, row);
  return wrap;
}

function refreshNow() {
  busyNote = null;
  return refresh();
}

async function refresh() {
  if (!current || document.hidden) return;
  const code = current.code;
  try {
    const board = await api(`/api/boards/${code}`);
    if (current?.code !== code) return; // navigated away while loading
    current = board;
    // Don't redraw underneath someone who is mid-edit; they'll catch up when they finish.
    if (!busyNote) renderEntries(board.entries, { animate: true });
  } catch {
    // Quietly keep what we have; the next poll will try again.
  }
}
document.addEventListener('visibilitychange', () => !document.hidden && refresh());

$('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!current) return;
  const error = $('entry-error');
  const text = $('entry-text').value.trim();
  error.textContent = '';
  if (!text) {
    error.textContent = "Write something you're grateful for first.";
    return $('entry-text').focus();
  }
  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const board = await api(`/api/boards/${current.code}/entries`, { text, color: pen.color, font: pen.font });
    current = board;
    busyNote = null;
    $('entry-text').value = '';
    autosize($('entry-text'));
    renderEntries(board.entries, { animate: true });
  } catch (err) {
    error.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Enter adds a new line; Ctrl/Cmd+Enter posts.
$('entry-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('entry-form').requestSubmit();
});

// ---------- sharing ----------
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
function flash(message) {
  const status = $('share-status');
  status.textContent = message;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (status.textContent = ''), 4000);
}

$('copy-code').addEventListener('click', async () => {
  if (!current) return;
  flash((await copy(current.code)) ? 'Code copied' : `Your code is ${current.code}`);
});

$('share-btn').addEventListener('click', async () => {
  if (!current) return;
  const url = `${location.origin}/b/${current.code}`;
  const text = `Write what you're grateful for on "${current.title}". Open the link, or enter code ${current.code}. No names needed.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: current.title, text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // they closed the share sheet
    }
  }
  flash((await copy(url)) ? 'Invite link copied. Paste it to anyone.' : `Share this link: ${url}`);
});

// ---------- in-app navigation ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

route();
