# Gratitude Board

A shared board where you and your people add one good thing, every day.

- **Start a board** and get a six-character code (like `5Y87A2`).
- **Invite people** with the code or the invite link (`/b/CODE`).
- **Everyone adds their name once** and posts what they're grateful for; notes are grouped by day.
- **Fix or remove your own notes**: each note has Edit and Delete for the person who wrote it, in the browser they wrote it in.
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
| `DATA_DIR` | Railway volume if attached, else `./data` | Folder that holds the SQLite file with boards |

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
Each browser keeps a private key, and a note can only be edited or deleted with the key that wrote it.
