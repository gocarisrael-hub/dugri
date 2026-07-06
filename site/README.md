# דוגרי — אתר

Hebrew, RTL, mobile-first. Served by a small Node/Express app (`server/`) that
serves this `site/` folder plus a tiny `/api` (word-collection + orders), with a
JSON-file store under `DATA_DIR`.

## The flow

Landing (`index.html`) → **order wizard** (`options.html`, 5 steps: design → color →
add-ons → celebrant name → contact) → creates a collection → **`collect.html`**
(collect 100+ words with friends, and pay any time). Payment is **credit card only**,
via the **PeleCard** iframe in the pay panel (`pay-done.html` posts the result back;
no Bit). `admin.html?key=…`
lists every order (design/color/version/total/address/🥃-chasers) with a "סמן כשולם" button.

## Pages

- `index.html` — landing page.
- `options.html` — the step-by-step order wizard.
- `collect.html` — collaborative word collection + the owner pay panel (PeleCard card payment).
- `admin.html` — owner orders page (needs `?key=<ADMIN_KEY>`).
- `timer.html` — in-game timer.
- `js/` — `configurator.js`, `collect.js`, `word-prompts.js`, `analytics.js`, `consent.js`, etc.
- `assets/` — logo, designs (`assets/designs/*`), photos, videos.

## Config

- Google Analytics id lives in `js/consent.js` (`GA_ID`).
- Card payment (PeleCard) opens from `collect.html`'s pay panel; `pay-done.html` is the iframe callback.
- Server env: `ADMIN_KEY` (required in production for the admin page), `DATA_DIR`
  (the JSON store path; a Railway volume in prod, e.g. `/data`).

## Run locally

```
cd server && npm i
DATA_DIR=/tmp/dugri ADMIN_KEY=dev node index.js   # then open http://localhost:$PORT
```

## Deploy

Railway, via the `Dockerfile` (node:20-alpine). Set a volume at `/data`,
`DATA_DIR=/data`, and `ADMIN_KEY`. Deploy is triggered manually from the GitHub
Actions "Deploy to Railway" workflow.
