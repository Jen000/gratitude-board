// Gratitude Board — client. Two views (home, board) routed by URL: "/" and "/b/CODE".
const $ = (id) => document.getElementById(id);
const views = { home: $('home'), board: $('board'), missing: $('missing') };

// The markers and handwriting on offer. The server (server.js) accepts the same keys.
const COLORS = [
  ['black', 'Black'], ['blue', 'Blue'], ['red', 'Red'], ['green', 'Green'],
  ['purple', 'Purple'], ['orange', 'Orange'], ['pink', 'Pink'], ['teal', 'Teal'],
];
const FONTS = [
  ['caveat', 'Quick'], ['kalam', 'Neat'], ['indie', 'Loopy'], ['shadows', 'Tall'],
  ['gloria', 'Bouncy'], ['marker', 'Bold'], ['messy', 'Messy'],
];
const SIZES = [['s', 'Small', 0.7], ['m', 'Medium', 1], ['l', 'Large', 1.45], ['xl', 'Extra large', 2]];
const zoomOf = (size) => SIZES.find(([id]) => id === size)?.[2] ?? 1;
// The board is this many units wide for everyone and grows downward as it fills (same number in server.js).
const BOARD_W = 1400;
const NOTE_W = 460; // widest a piece of medium-sized writing gets before it wraps (bigger writing gets more room)
const noteWidth = (size, x) => Math.min(NOTE_W * Math.max(1, zoomOf(size)), BOARD_W - x);
const MAX_STROKE_POINTS = 1500;

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

// A private key for this browser. The server uses it to tell which writing and drawings are yours.
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
const pen = { color: remembered('gb.color', COLORS), font: remembered('gb.font', FONTS), size: 'm' };
if (SIZES.some(([id]) => id === store.get('gb.size', ''))) pen.size = store.get('gb.size', 'm');

// ---------- sounds (made in the browser, no audio files) ----------
let soundOn = store.get('gb.sound', true) !== false;
let audio = null;
let noiseBuffer = null;

// Browsers only allow sound after a tap or key press, so this is also called on every one of those.
function audioContext() {
  if (!soundOn) return null;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  } catch {
    return null;
  }
}
function noiseSource(ac) {
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

// A marker on a whiteboard: a few quick, scratchy strokes with the odd squeak. Returns when it ends.
function playWrite(startAt = 0, strokes = 5) {
  const ac = audioContext();
  if (!ac || ac.state !== 'running') return 0;
  let t = Math.max(ac.currentTime + 0.02, startAt);
  const src = noiseSource(ac);
  const band = ac.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.4;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(band).connect(gain).connect(ac.destination);
  src.start(t);
  for (let i = 0; i < strokes; i++) {
    const length = 0.06 + Math.random() * 0.08;
    band.frequency.setValueAtTime(2300 + Math.random() * 900, t);
    band.frequency.linearRampToValueAtTime(3200 + Math.random() * 1400, t + length);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.012);
    gain.gain.linearRampToValueAtTime(0.1, t + length * 0.7);
    gain.gain.linearRampToValueAtTime(0, t + length);
    if (Math.random() < 0.35) {
      const squeak = ac.createOscillator();
      const squeakGain = ac.createGain();
      squeak.frequency.setValueAtTime(2600 + Math.random() * 500, t);
      squeak.frequency.linearRampToValueAtTime(3300 + Math.random() * 500, t + length);
      squeakGain.gain.setValueAtTime(0, t);
      squeakGain.gain.linearRampToValueAtTime(0.012, t + length / 2);
      squeakGain.gain.linearRampToValueAtTime(0, t + length);
      squeak.connect(squeakGain).connect(ac.destination);
      squeak.start(t);
      squeak.stop(t + length);
    }
    t += length + 0.025 + Math.random() * 0.04;
  }
  src.stop(t + 0.05);
  return t;
}

// A felt eraser: soft, low swishes back and forth. Returns when it ends.
function playErase(startAt = 0, swishes = 3) {
  const ac = audioContext();
  if (!ac || ac.state !== 'running') return 0;
  let t = Math.max(ac.currentTime + 0.02, startAt);
  const src = noiseSource(ac);
  const low = ac.createBiquadFilter();
  low.type = 'lowpass';
  low.Q.value = 0.6;
  const high = ac.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 180;
  const gain = ac.createGain();
  gain.gain.value = 0;
  src.connect(low).connect(high).connect(gain).connect(ac.destination);
  src.start(t);
  for (let i = 0; i < swishes; i++) {
    const length = 0.17 + Math.random() * 0.06;
    low.frequency.setValueAtTime(600, t);
    low.frequency.linearRampToValueAtTime(1500, t + length / 2);
    low.frequency.linearRampToValueAtTime(700, t + length);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + length * 0.45);
    gain.gain.linearRampToValueAtTime(0, t + length);
    t += length + 0.02;
  }
  src.stop(t + 0.05);
  return t;
}
const playEdit = () => playWrite(playErase(0, 2));
// Rubbing with the eraser fires many erases in a row; one swish at a time is plenty.
let eraseSoundUntil = 0;
function playEraseOnce() {
  if (performance.now() < eraseSoundUntil) return;
  eraseSoundUntil = performance.now() + 450;
  playErase(0, 2);
}

function renderSound() {
  $('sound-btn').textContent = soundOn ? 'Sound on' : 'Sound off';
  $('sound-btn').setAttribute('aria-pressed', String(soundOn));
}
$('sound-btn').addEventListener('click', () => {
  soundOn = !soundOn;
  store.set('gb.sound', soundOn);
  renderSound();
  if (soundOn) playWrite(0, 3);
  else audio?.suspend();
});
renderSound();
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, audioContext, { passive: true });

// ---------- helpers ----------
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

// Let a textarea grow with what's written in it.
function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

function toast(message) {
  $('toast').textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('toast').textContent = ''), 5000);
}

// ---------- routing ----------
let current = null; // board being shown: { code, title, entries }
let pollTimer = null;
let seenIds = new Set();
let busyNote = null; // { id, mode: 'edit' | 'delete' } while editing or confirming an erase
let selectedId = null; // your own writing that's been tapped, showing Edit / Erase
let mode = 'write'; // 'write' | 'draw' | 'erase'
let scale = 1; // screen pixels per board unit
// Every request that returns the board is numbered, so a slow, older answer never overwrites a newer one.
let requestCount = 0;
let appliedCount = 0;

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

// ---------- tools: marker, handwriting, write / draw / eraser ----------
const surface = $('surface');
const draft = $('draft');
const draftText = $('draft-text');
let draftSpot = null; // where on the board the writing in progress will go

function buildPicker(container, name, options, render) {
  container.replaceChildren(
    ...options.flatMap(([id, label, extra]) => {
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
      const tag = render(id, label, extra);
      tag.htmlFor = input.id;
      return [input, tag];
    })
  );
}

// Show the handwriting samples and anything being written in the chosen marker.
function applyPen() {
  for (const sample of document.querySelectorAll('.hand')) {
    sample.className = `hand ink c-${pen.color} f-${sample.dataset.font}`;
  }
  draft.className = `draft c-${pen.color} f-${pen.font} s-${pen.size}`;
  if (draftSpot) draft.style.setProperty('--maxw', `${noteWidth(pen.size, draftSpot.x)}px`);
  if (!draft.hidden) autosize(draftText);
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
buildPicker($('size-picker'), 'size', SIZES, (id, label, zoom) => {
  const option = el('label', 'size', 'A');
  option.title = label;
  option.setAttribute('aria-label', `${label} writing`);
  option.style.setProperty('--px', `${Math.round(11 + zoom * 7)}px`);
  return option;
});
applyPen();

const HINTS = {
  write: 'Tap anywhere on the board to write there. Tap your own writing to edit it, or drag it to move it.',
  draw: 'Drag on the board to draw.',
  erase: 'Rub over your own writing or drawings to erase them. Everyone else’s stays put.',
};
function setMode(next) {
  mode = next;
  surface.dataset.mode = mode;
  for (const btn of document.querySelectorAll('.modes button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  }
  $('hint').textContent = HINTS[mode];
  $('write-here').hidden = mode !== 'write';
  $('color-field').hidden = mode === 'erase';
  $('font-field').hidden = mode !== 'write';
  $('size-field').hidden = mode !== 'write';
  if (mode !== 'write') {
    closeDraft();
    if (selectedId !== null || busyNote) {
      selectedId = busyNote = null;
      render();
    }
  }
}
for (const btn of document.querySelectorAll('.modes button')) btn.addEventListener('click', () => setMode(btn.dataset.mode));
setMode('write');

// ---------- the board ----------
function openBoard(board) {
  clearInterval(pollTimer);
  current = board;
  appliedCount = ++requestCount;
  busyNote = selectedId = null;
  seenIds = new Set(board.entries.map((entry) => entry.id));
  rememberBoard(board.code, board.title);
  document.title = `${board.title} · Gratitude Board`;
  $('board-title').textContent = board.title;
  $('copy-code').textContent = board.code;
  $('share-status').textContent = '';
  closeDraft();
  show('board');
  render();
  pollTimer = setInterval(refresh, 20_000);
}

// Runs a request that answers with the whole board, and keeps the answer unless a newer one already arrived.
async function boardRequest(path, body, method) {
  const code = current.code;
  const count = ++requestCount;
  const board = await api(path, body, method);
  if (current?.code === code && count > appliedCount) {
    appliedCount = count;
    current = board;
  }
}

const strokeBottom = (points) => {
  let bottom = 0;
  for (let i = 1; i < points.length; i += 2) bottom = Math.max(bottom, points[i]);
  return bottom;
};

// Fit the board to the screen. On small screens it stops shrinking and scrolls sideways instead.
function layout() {
  const available = $('scroller').clientWidth;
  if (!available || !current) return;
  scale = clamp(available / BOARD_W, 0.62, 1);
  const lowest = Math.max(0, ...current.entries.map((e) => (e.kind === 'draw' ? strokeBottom(e.points) : e.y + 90)));
  const height = Math.max(900, Math.ceil((window.innerHeight * 0.7) / scale), lowest + 500); // always room below
  const board = $('whiteboard');
  board.style.setProperty('--s', scale);
  board.style.setProperty('--inv', 1 / scale);
  board.style.setProperty('--h', height);
  $('pan-hint').hidden = BOARD_W * scale <= available + 1;
}
new ResizeObserver(() => current && layout()).observe($('scroller'));

const pathData = (points) => {
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
  return d;
};
function strokeElement(color, points) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', `stroke c-${color}`);
  path.setAttribute('d', pathData(points));
  return path;
}

const erasing = new Set(); // ids rubbed out but not yet confirmed by the server

function render({ animate = false } = {}) {
  layout();
  const entries = current.entries.filter((entry) => !erasing.has(entry.id));
  $('strokes').replaceChildren(...entries.filter((e) => e.kind === 'draw').map((e) => strokeElement(e.color, e.points)));
  $('notes').replaceChildren(...entries.filter((e) => e.kind === 'text').map((e) => noteElement(e, animate)));
  for (const entry of current.entries) seenIds.add(entry.id);
  for (const box of $('notes').querySelectorAll('textarea')) autosize(box);
}

function noteElement(entry, animate) {
  const busy = busyNote?.id === entry.id ? busyNote.mode : null;
  const note = el('article', `note c-${entry.color} f-${entry.font} s-${entry.size}`);
  note.dataset.id = entry.id;
  note.style.left = `${entry.x}px`;
  note.style.top = `${entry.y}px`;
  note.style.setProperty('--maxw', `${noteWidth(entry.size, entry.x)}px`);
  // A steady, slightly crooked angle for each note, like real handwriting on a board.
  note.style.setProperty('--tilt', `${(((entry.id * 37) % 7) - 3) * 0.6}deg`);
  if (animate && !seenIds.has(entry.id)) note.classList.add('fresh');
  if (busy) note.classList.add('busy');
  note.append(busy === 'edit' ? editForm(entry) : el('p', 'note-text ink', entry.text));
  if (busy === 'delete') note.append(deleteConfirm(entry));
  if (entry.mine) {
    note.classList.add('mine');
    if (!busy) {
      makeMovable(note, entry);
      if (selectedId === entry.id) {
        note.classList.add('selected');
        note.append(noteActions(entry));
      }
    }
  }
  return note;
}

// Where on the board (in board units) a tap or click landed.
function boardPoint(e) {
  const rect = surface.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
}

// ---------- writing: tap a spot, type, done ----------
let suppressClick = false; // set after a drag so the click that follows it is ignored

function openDraft(x, y) {
  // The tap marks the middle of the first line; keep the note fully on the board.
  draftSpot = { x: Math.round(clamp(x - 6, 0, BOARD_W - 260)), y: Math.round(Math.max(0, y - 24 * zoomOf(pen.size))) };
  draft.style.left = `${draftSpot.x}px`;
  draft.style.top = `${draftSpot.y}px`;
  draft.hidden = false;
  $('draft-error').textContent = '';
  applyPen();
  draftText.focus({ preventScroll: true });
  draft.scrollIntoView({ block: 'nearest' }); // keep it clear of the tools at the bottom of the screen
}
function closeDraft() {
  draft.hidden = true;
  draftText.value = '';
  draftSpot = null;
}

surface.addEventListener('click', (e) => {
  if (mode !== 'write' || !current) return;
  if (suppressClick || e.target.closest('.note.mine, .draft')) return;
  if (selectedId !== null || busyNote) {
    // First tap away from a selected note just puts it down.
    selectedId = busyNote = null;
    return render();
  }
  const { x, y } = boardPoint(e);
  openDraft(x, y);
});

// For keyboards and screen readers: start writing in the middle of what's on screen.
$('write-here').addEventListener('click', () => {
  const rect = surface.getBoundingClientRect();
  const midX = $('scroller').getBoundingClientRect().left + $('scroller').clientWidth / 2;
  const midY = clamp(window.innerHeight / 2, rect.top + 40, rect.bottom - 120);
  openDraft((midX - rect.left) / scale - 160, (midY - rect.top) / scale);
});

draftText.addEventListener('input', () => autosize(draftText));
draftText.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDraft();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) draft.requestSubmit();
});
$('draft-cancel').addEventListener('click', closeDraft);

draft.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = draftText.value.trim();
  if (!text) {
    $('draft-error').textContent = "Write something you're grateful for first.";
    return draftText.focus({ preventScroll: true });
  }
  const buttons = [...draft.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await boardRequest(`/api/boards/${current.code}/entries`, { text, color: pen.color, font: pen.font, size: pen.size, ...draftSpot });
    closeDraft();
    playWrite();
    render({ animate: true });
  } catch (err) {
    $('draft-error').textContent = err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// ---------- your own writing: tap to select, drag to move, edit, erase ----------
function setBusy(next) {
  busyNote = next;
  if (!next) selectedId = null;
  render();
}

function makeMovable(note, entry) {
  let drag = null;
  note.addEventListener('pointerdown', (e) => {
    if (mode !== 'write' || e.button || e.target.closest('button')) return;
    drag = { startX: e.clientX, startY: e.clientY, x: entry.x, y: entry.y, moved: false };
    note.setPointerCapture(e.pointerId);
  });
  note.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    closeDraft();
    note.classList.add('dragging');
    drag.x = Math.round(clamp(entry.x + dx / scale, 0, BOARD_W - 60));
    drag.y = Math.round(Math.max(0, entry.y + dy / scale));
    note.style.left = `${drag.x}px`;
    note.style.top = `${drag.y}px`;
  });
  const finish = async (e) => {
    if (!drag) return;
    const { moved, x, y } = drag;
    drag = null;
    note.classList.remove('dragging');
    if (!moved) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (e.type === 'pointercancel') return render();
    // Show it in its new place straight away, then tell the server.
    entry.x = x;
    entry.y = y;
    try {
      await boardRequest(`/api/boards/${current.code}/entries/${entry.id}`, { x, y }, 'PATCH');
    } catch (err) {
      toast(err.status === 404 ? 'That was already erased.' : err.message);
      return refresh();
    }
    if (!busyNote) render();
  };
  note.addEventListener('pointerup', finish);
  note.addEventListener('pointercancel', finish);
  note.addEventListener('click', (e) => {
    if (suppressClick || e.target.closest('button')) return;
    closeDraft();
    selectedId = selectedId === entry.id ? null : entry.id;
    render();
  });
}

function noteActions(entry) {
  const row = el('div', 'note-actions unscale');
  const edit = el('button', '', 'Edit');
  const erase = el('button', '', 'Erase');
  edit.type = erase.type = 'button';
  edit.addEventListener('click', () => {
    setBusy({ id: entry.id, mode: 'edit' });
    const box = $('notes').querySelector('.note-edit textarea');
    box?.focus({ preventScroll: true });
    box?.setSelectionRange(box.value.length, box.value.length);
  });
  erase.addEventListener('click', () => {
    setBusy({ id: entry.id, mode: 'delete' });
    $('notes').querySelector('.note-confirm button')?.focus({ preventScroll: true });
  });
  row.append(edit, erase);
  return row;
}

// Sends a change for one note, then redraws the board with the server's answer.
async function changeNote(entry, method, body, errorNode, buttons, sound) {
  buttons.forEach((b) => (b.disabled = true));
  try {
    await boardRequest(`/api/boards/${current.code}/entries/${entry.id}`, body, method);
    sound();
    setBusy(null);
  } catch (err) {
    if (err.status === 404) {
      busyNote = selectedId = null;
      return refresh(); // it was already erased
    }
    errorNode.textContent = err.message;
    buttons.forEach((b) => (b.disabled = false));
  }
}

function editForm(entry) {
  const form = el('form', 'note-edit');
  const box = el('textarea', 'ink');
  box.value = entry.text;
  box.maxLength = 500;
  box.rows = 1;
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
    changeNote(entry, 'PATCH', { text }, error, [save, cancel], playEdit);
  });
  const controls = el('div', 'unscale');
  const row = el('div', 'note-buttons');
  row.append(save, cancel);
  controls.append(error, row);
  form.append(box, controls);
  return form;
}

function deleteConfirm(entry) {
  const wrap = el('div', 'note-confirm unscale');
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const yes = el('button', 'btn btn-small btn-danger', 'Erase it');
  const no = el('button', 'btn btn-small', 'Keep it');
  yes.type = no.type = 'button';
  yes.addEventListener('click', () => changeNote(entry, 'DELETE', undefined, error, [yes, no], playErase));
  no.addEventListener('click', () => setBusy(null));
  const row = el('div', 'note-buttons');
  row.append(yes, no);
  wrap.append(el('p', 'note-question', 'Erase this from the board for everyone?'), error, row);
  return wrap;
}

// ---------- drawing and the eraser ----------
let stroke = null; // the line being drawn right now: { points, path }

function addStrokePoint(e) {
  const { x, y } = boardPoint(e);
  const px = Math.round(clamp(x, 0, BOARD_W));
  const py = Math.round(Math.max(0, y));
  const { points } = stroke;
  const n = points.length;
  if (n >= MAX_STROKE_POINTS * 2) return;
  if (n && Math.hypot(px - points[n - 2], py - points[n - 1]) < 3) return; // skip points that barely moved
  points.push(px, py);
}

async function finishStroke() {
  const { points, path } = stroke;
  stroke = null;
  if (points.length === 2) points.push(points[0], points[1]); // a tap makes a dot
  path.setAttribute('d', pathData(points));
  playWrite(0, 2);
  try {
    await boardRequest(`/api/boards/${current.code}/entries`, { kind: 'draw', color: pen.color, points });
    render();
  } catch (err) {
    toast(err.message);
  }
  path.remove(); // the saved copy (or nothing, if it failed) takes its place
}

// How close (in board units) a point is to a drawn line.
function distanceToStroke(points, x, y) {
  let best = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = lengthSq ? clamp(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / lengthSq, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return best;
}

// Erase whatever of yours is under the eraser.
function eraseAt(e) {
  const { x, y } = boardPoint(e);
  const reach = 14 / scale + 6; // a finger-sized eraser, whatever the zoom
  for (const entry of current.entries) {
    if (!entry.mine || erasing.has(entry.id)) continue;
    let hit;
    if (entry.kind === 'draw') {
      hit = distanceToStroke(entry.points, x, y) <= reach;
    } else {
      const rect = $('notes').querySelector(`[data-id="${entry.id}"]`)?.getBoundingClientRect();
      hit = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    }
    if (!hit) continue;
    erasing.add(entry.id);
    playEraseOnce();
    boardRequest(`/api/boards/${current.code}/entries/${entry.id}`, undefined, 'DELETE')
      .catch((err) => err.status === 404 || toast(err.message))
      .finally(() => {
        erasing.delete(entry.id);
        if (current) render();
      });
  }
  render();
}

let rubbing = false;
surface.addEventListener('pointerdown', (e) => {
  if (!current || e.button || mode === 'write') return;
  e.preventDefault();
  surface.setPointerCapture(e.pointerId);
  if (mode === 'draw') {
    stroke = { points: [], path: strokeElement(pen.color, [0, 0]) };
    addStrokePoint(e);
    stroke.path.setAttribute('d', pathData([...stroke.points, ...stroke.points]));
    $('pending').append(stroke.path);
  } else {
    rubbing = true;
    eraseAt(e);
  }
});
surface.addEventListener('pointermove', (e) => {
  if (stroke) {
    // Phones report several positions per frame; use them all for a smoother line.
    for (const step of e.getCoalescedEvents?.() ?? [e]) addStrokePoint(step);
    if (stroke.points.length >= 4) stroke.path.setAttribute('d', pathData(stroke.points));
  } else if (rubbing) {
    eraseAt(e);
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  surface.addEventListener(type, () => {
    rubbing = false;
    if (stroke) finishStroke();
  });
}

// ---------- keeping up with everyone else ----------
async function refresh() {
  if (!current || document.hidden) return;
  const before = new Map(current.entries.map((entry) => [entry.id, entry.text]));
  try {
    await boardRequest(`/api/boards/${current.code}`);
  } catch {
    return; // Quietly keep what we have; the next poll will try again.
  }
  // Let people hear what changed while they weren't looking.
  const after = new Map(current.entries.map((entry) => [entry.id, entry.text]));
  const added = [...after.keys()].some((id) => !before.has(id));
  const removed = [...before.keys()].some((id) => !after.has(id) && !erasing.has(id));
  const reworded = [...after].some(([id, text]) => before.has(id) && before.get(id) !== text);
  if (reworded || (added && removed)) playEdit();
  else if (added) playWrite();
  else if (removed) playErase();
  // Don't redraw underneath someone who is mid-edit; they'll catch up when they finish.
  if (!busyNote && !document.querySelector('.note.dragging')) render({ animate: true });
}
document.addEventListener('visibilitychange', () => !document.hidden && refresh());

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
