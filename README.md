# Gratitude Board

A shared board where you and your people add one good thing, every day.

- **Start a board** and get a six-character code (like `5Y87A2`).
- **Invite people** with the code or the invite link (`/b/CODE`).
- **Write anywhere on the whiteboard**: tap a spot, pick a marker colour, a handwriting style and a size, and write. Writing can overlap, like on a real board.
- **Draw** freehand in any marker colour.
- **No names**: nothing on the board says who wrote or drew what. The server never sends that out.
- **Move, edit or erase your own work**: drag your writing to move it, tap it to edit, or rub it out with the eraser. Nobody else's can be touched.
- **Sounds**: a marker noise when something is added, an eraser noise when something is erased, both for an edit. There is a Sound on/off button.
- **Boards expire**: a board is erased for good after 35 days with nothing added, changed or erased on it.
- **The browser remembers you**: your marker, handwriting, writing size, sound setting and the boards you've opened are kept in that browser.

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
| `DATA_DIR` | Railway volume if attached, else `./data` | Folder that holds the SQLite file with boards |
| `BOARD_TTL_DAYS` | `35` | Days with nothing new before a board is erased for good |

## Putting it online (Railway)

1. In Railway, create a **New Project → Deploy from GitHub repo** and pick this repository.
   Railway detects Node and runs `npm start`; `railway.json` adds a health check.
2. Add a **Volume** to the service and mount it at `/data`. The server stores the boards on the
   attached volume automatically. Without a volume, every redeploy wipes the boards.
3. Under the service's **Settings → Networking**, choose **Generate Domain** to get a public link.

Any other host that runs Node works too: run `npm start` and point `DATA_DIR` at a persistent disk.

## How it's put together

- `server.js` — static files + JSON API (`POST /api/boards`, `GET /api/boards/:code`,
  `POST /api/boards/:code/entries`, `PATCH`/`DELETE /api/boards/:code/entries/:id`), SQLite storage, basic per-IP rate limiting.
- `public/` — the site itself (plain HTML, CSS and JavaScript, no build step).
- `test/` — API tests.

Anyone with a board's code can read it and add to it; there are no accounts or passwords.
Each browser keeps a private key, and a note can only be edited or erased with the key that wrote it.

## Security

- No accounts, names, emails or cookies. The only thing kept about a writer is a scrambled copy of their browser's private key, used to decide who may move, edit or erase a note.
- A board's code is its only lock: anyone who has it can read the board and add to it.
- What people write is always shown as plain text, and the server only accepts the listed colours, fonts and sizes.
- Every response carries a Content-Security-Policy and related headers, so the page only runs code from this site and can't be embedded elsewhere.
- Requests are rate-limited per address, request bodies are capped, and a board holds at most 4,000 items.
- There are no third-party scripts, fonts or packages.

## Fonts

The handwriting fonts in `public/fonts/` are served from the site itself. Caveat, Kalam, Indie Flower,
Shadows Into Light, Gloria Hallelujah and Reenie Beanie are under the SIL Open Font License; Permanent Marker is
under the Apache License 2.0. All come from Google Fonts.
