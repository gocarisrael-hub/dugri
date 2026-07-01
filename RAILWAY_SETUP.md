# Railway Deployment — One-Time Setup

This repo deploys the static site in `site/` to [Railway](https://railway.app)
via the GitHub Actions workflow at `.github/workflows/railway.yml`. Railway
builds the root `Dockerfile` (Caddy) and serves `site/` on the port Railway
assigns (`$PORT`).

The workflow runs on every push to `main` (and via manual "Run workflow").
It will **fail until you complete the steps below** — that is expected.

## Steps (require your Railway account — must be done by you)

1. **Create a Railway account / project**
   - Go to https://railway.app and sign in (GitHub login is easiest).
   - Create a new project.

2. **Create a service**
   - Either: "Deploy from GitHub repo" and pick `gocarisrael-hub/dugri`, or
   - Create an **empty service** and name it `dugri`.
   - If you name the service something other than `dugri`, note the name for
     step 5.

3. **Generate a token**
   - Project Settings → **Tokens** → create a **Project token**.
   - Copy it (you only see it once).

4. **Add the token to GitHub as a repo secret**
   - Name it exactly `RAILWAY_TOKEN`.
   - Via UI: https://github.com/gocarisrael-hub/dugri/settings/secrets/actions
     → "New repository secret".
   - Or via CLI:
     ```bash
     gh secret set RAILWAY_TOKEN
     ```
     (paste the token when prompted)

5. **(Optional) Set the service name variable**
   - Only needed if your service is **not** named `dugri`.
   - Add a repo **variable** (not secret) named `RAILWAY_SERVICE` with your
     service name:
     https://github.com/gocarisrael-hub/dugri/settings/variables/actions
     - Or: `gh variable set RAILWAY_SERVICE --body "your-service-name"`

6. **Trigger a deploy**
   - Push any commit to `main`, or run the workflow manually from the Actions
     tab. Railway will build the Dockerfile and serve `site/` on the domain it
     assigns (Settings → Networking → Generate Domain if you don't have one).

## Simpler native alternative

Instead of this workflow, you can connect the GitHub repo directly in the
Railway dashboard for automatic deploys on every push (no Actions, no token
needed) — but the GitHub Actions workflow above is the configured primary path.

## Word-collection backend (Node service + volume)

The site is now a small **Node/Express** service (it serves `site/` AND the
`/api` for the collaborative word-collection feature) instead of a static Caddy
container. After connecting the repo:

1. Railway builds the `Dockerfile` (node:20-alpine) and runs `node server/index.js`.
2. Add a **Volume** to the service, mounted at `/data`.
3. Add an env var **`DATA_DIR=/data`** so the JSON store (`dugri-data.json`)
   persists across redeploys. (`$PORT` is provided by Railway automatically.)

Without the volume + `DATA_DIR`, collected words are lost on every redeploy.

## Admin orders page

The private orders page is at `/admin.html?key=YOUR_ADMIN_KEY`. Set a strong
**`ADMIN_KEY`** env var on the Railway service; only that key can open the page
or call `/api/admin/collections`. (Locally it defaults to `dugri-admin`.)

## Card payment (PeleCard)

Online credit-card payment via the PeleCard Iframe is **off until you set the
credentials** — without them the pay panel shows Bit only. To turn it on, add
these env vars on the Railway service (see `server/PELECARD.md` for the full
checklist and how to get them from PeleCard):

- **`PELECARD_TERMINAL`** — your internet/CNP terminal number.
- **`PELECARD_USER`** — API user.
- **`PELECARD_PASSWORD`** — API password.
- **`PUBLIC_BASE_URL`** — the site's public origin, e.g. `https://dugri.co.il`
  (used to build the payment return + server-callback URLs PeleCard calls).

Optional: `PELECARD_BASE_URL` overrides the gateway host (defaults to
`https://gateway21.pelecard.biz`); set this only if PeleCard gives you a
different test/production gateway. `PELECARD_DEBUG=1` logs the init/GetTransaction
shapes for the first test charge (turn off after).
