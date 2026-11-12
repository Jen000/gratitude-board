// Gratitude Board — client. Two views (home, board) routed by URL: "/" and "/b/CODE".
const $ = (id) => document.getElementById(id);
const views = { home: $('home'), board: $('board'), missing: $('missing') };

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
const getName = () => store.get('gb.name', '');
const setName = (name) => store.set('gb.name', name);
const getBoards = () => {
  const list = store.get('gb.boards', []);
  return Array.isArray(list) ? list.filter((b) => b && typeof b.code === 'string') : [];
};
function rememberBoard(code, title) {
  const rest = getBoards().filter((b) => b.code !== code);
  store.set('gb.boards', [{ code, title, visited: Date.now() }, ...rest].slice(0, 12));
}
const forgetBoard = (code) => store.set('gb.boards', getBoards().filter((b) => b.code !== code));

// ---------- helpers ----------
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
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
// Each person gets a steady note colour, derived from their name.
function hueFor(name) {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// ---------- routing ----------
let current = null; // board being shown: { code, title, entries }
let pollTimer = null;
let seenIds = new Set();

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
  // Old-style share links (?code=ABC123) work too.
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
  const name = getName();
  const boards = getBoards();
  $('greeting').textContent = name
    ? `Welcome back, ${name}. What's one good thing today?`
    : 'A shared board where you and your people add one good thing, every day.';
  $('create-name').value = name;

  const list = $('recent-list');
  list.replaceChildren(
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
  const name = $('create-name').value.trim();
  if (!name) {
    $('create-error').textContent = 'Add your name so people know who started it.';
    return $('create-name').focus();
  }
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  try {
    const board = await api('/api/boards', { title: $('create-title').value });
    setName(name);
    history.pushState(null, '', `/b/${board.code}`);
    openBoard(board);
    $('create-title').value = '';
  } catch (err) {
    $('create-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- board ----------
function openBoard(board) {
  clearInterval(pollTimer);
  current = board;
  seenIds = new Set(board.entries.map((entry) => entry.id));
  rememberBoard(board.code, board.title);
  document.title = `${board.title} · Gratitude Board`;
  $('board-title').textContent = board.title;
  $('copy-code').textContent = board.code;
  $('share-status').textContent = '';
  $('entry-error').textContent = '';
  renderIdentity();
  renderEntries(board.entries);
  show('board');
  pollTimer = setInterval(refresh, 20_000);
}

function renderIdentity(editing = false) {
  const name = getName();
  const known = Boolean(name) && !editing;
  $('name-row').hidden = known;
  $('posting-as').hidden = !known;
  $('posting-name').textContent = name;
  $('entry-name').value = name;
}

function renderEntries(entries, { animate = false } = {}) {
  const container = $('entries');
  const name = getName().trim().toLowerCase();
  const today = dayKey(Date.now());
  const mineToday = name
    ? entries.filter((entry) => dayKey(entry.createdAt) === today && entry.name.trim().toLowerCase() === name).length
    : 0;
  $('today-status').textContent = mineToday
    ? `You've added ${mineToday === 1 ? 'one' : mineToday} today — add another any time.`
    : '';

  if (entries.length === 0) {
    container.replaceChildren(el('p', 'empty', 'Nothing here yet. Add the first good thing, then invite people with the code above.'));
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
        const note = el('article', 'note');
        if (animate && !seenIds.has(entry.id)) note.classList.add('fresh');
        note.style.setProperty('--hue', hueFor(entry.name));
        const meta = el('p', 'note-meta');
        const time = el('time', 'note-time', new Date(entry.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
        time.dateTime = new Date(entry.createdAt).toISOString();
        meta.append(el('span', 'note-name', entry.name), time);
        note.append(el('p', 'note-text', entry.text), meta);
        notes.append(note);
      }
      section.append(el('h2', 'day-label', day.label), notes);
      return section;
    })
  );
  for (const entry of entries) seenIds.add(entry.id);
}

async function refresh() {
  if (!current || document.hidden) return;
  const code = current.code;
  try {
    const board = await api(`/api/boards/${code}`);
    if (current?.code !== code) return; // navigated away while loading
    current = board;
    renderEntries(board.entries, { animate: true });
  } catch {
    // Quietly keep what we have; the next poll will try again.
  }
}
document.addEventListener('visibilitychange', () => !document.hidden && refresh());

$('change-name').addEventListener('click', () => {
  renderIdentity(true);
  $('entry-name').focus();
  $('entry-name').select();
});

$('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!current) return;
  const error = $('entry-error');
  const name = $('entry-name').value.trim();
  const text = $('entry-text').value.trim();
  error.textContent = '';
  if (!name) {
    renderIdentity(true);
    error.textContent = 'Add your name so people know who this is from.';
    return $('entry-name').focus();
  }
  if (!text) {
    error.textContent = "Write something you're grateful for first.";
    return $('entry-text').focus();
  }
  const btn = e.submitter || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const board = await api(`/api/boards/${current.code}/entries`, { name, text });
    setName(name);
    current = board;
    $('entry-text').value = '';
    renderIdentity();
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
  const text = `Add what you're grateful for to "${current.title}". Open the link, or enter code ${current.code}.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: current.title, text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // they closed the share sheet
    }
  }
  flash((await copy(url)) ? 'Invite link copied — paste it to anyone' : `Share this link: ${url}`);
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
