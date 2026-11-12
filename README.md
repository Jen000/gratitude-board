# Gratitude Board

A shared board where you and your people add one good thing, every day.

- **Start a board** and get a six-character code (like `5Y87A2`).
- **Invite people** with the code or the invite link (`/b/CODE`).
- **Everyone adds their name once** and posts what they're grateful for; notes are grouped by day.
- **The browser remembers you**: your name and the boards you've opened are kept in that browser, so coming back is one tap.

## Run it

Needs Node 22.13 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:3000.

```bash
npm test
```

## Configuration

| Variable   | Default  | What it does                                   |
| ---------- | -------- | ---------------------------------------------- |
| `PORT`     | `3000`   | Port the site listens on                       |
| `DATA_DIR` | `./data` | Folder that holds the SQLite file with boards  |

## Putting it online

It's one Node process (`npm start`) plus one SQLite file, so any host that runs Node works
(Render, Railway, Fly.io, a small VPS). The one thing to get right: point `DATA_DIR` at a
**persistent disk/volume**. On hosts with a throwaway filesystem the boards would be wiped on
every redeploy.

## How it's put together

- `server.js` — static files + JSON API (`POST /api/boards`, `GET /api/boards/:code`,
  `POST /api/boards/:code/entries`), SQLite storage, basic per-IP rate limiting.
- `public/` — the site itself (plain HTML, CSS and JavaScript, no build step).
- `test/` — API tests.

Anyone with a board's code can read it and add to it; there are no accounts or passwords.
