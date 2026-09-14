# דוגרי — CLAUDE.md

Working language: English. Style: concise, no long horizontal dividers, no emojis unless asked. (The body below is partly Hebrew; the conversation is English.)

## מה הפרויקט

דוגרי: משחק מסיבה מותאם אישית בסגנון ניחוש מילים בקבוצות, סביב אדם אחד — מסיבות רווקות, ימי הולדת עגולים, ימי נישואין, פרישה, פרידה. הלקוחה מזמינה באתר, אוספת מילים על בעל/ת השמחה (לבד או עם חברים), ואנחנו מפיקים חפיסת קלפים מעוצבת + לוח משחק.

- האתר החי: dugri-israel.co.il (הדומיין הישן dugri.co.il מת). קישורים נבנים מ-`PUBLIC_BASE_URL`, לא מכתובת קבועה.
- בחומרים ללקוח לא משתמשים בשם "אליאס" (סימן מסחר של Tactic) — מתארים את מנגנון המשחק בלבד.

## Where the live truth is

Business facts change from the admin, not in code. Never copy a number from a doc; read it from its source.

- Prices, sale mode, enabled versions (pdf / pickup / delivery / custom), free word limit: `server/settings.js` → `REGISTRY.pricing` (defaults), overridden live from `site/admin-pricing.html`. `server/db.js` derives `ORDER_PRICES` from it.
- Payment: PeleCard card payment, `server/pelecard.js` (setup: `server/PELECARD.md`).
- Shipping: HFD courier, `server/hfd.js`; self-pickup stickers, `generator/pickup_stickers.py`.
- Deck production: the Python generator in `generator/` (`docs/deck-rendering.md`, `docs/card-structure-schema.md`, `docs/photo-card.md`). Short word lists are topped up from seed pools (`generator/topup.py`, `server/wordlists.js`).
- Emails, WhatsApp/SMS texts, reminder timings: `server/settings.js`, edited in the admin.
- Template artwork and calibration live on the Railway volume per environment, not only in the repo.
- Deploy and environment setup: `RAILWAY_SETUP.md`. Order recipes for manual work: `dugri_playbook.html` (not served).

Decisions that stand and are not visible in code: no "אליאס" in customer-facing material; production deploys are owner-only.

## Git and tests

- Branch per change: `feat/<short>` or `fix/<short>` (`docs/<short>` for docs). Open a PR to main.
- Nobody pushes to main, ever. Every change lands through a PR merged with `gh pr merge`.
- CI (`.github/workflows/ci.yml`) must be green before merge. Jobs: `Format + Lint + Unit` (Prettier, ESLint, Vitest), `E2E 1/4`..`E2E 4/4` (Playwright, sharded), `Generator tests (pytest)`, and the summary check `CI`, which fails if any job did not succeed. CI runs on every PR and on every push to main (E2E included).
- Every change ships with tests that cover it: feature, bug fix, or behaviour change.
- Test locations: unit `tests/unit/*.test.js` (Vitest, jsdom); E2E `tests/e2e/*.spec.js` (Playwright against `site/`); generator `generator/test_*.py` (pytest from `generator/`, `npm run test:py`).
- Local Vitest needs `cd server && npm ci` first.
- A red E2E is never "flake" until the failing spec passes in isolation on the same commit.

## Multi-agent workflow

If you are the integrator, read `docs/integrator.md`. Domain agents don't need it.

If you were told "you are Agent A/B/C/D", you are one of several parallel domain agents. A single integrator, not you, reviews and merges every PR.

- A — Commerce, B — Catalog & Design, C — Wizard & Word-collection (incl. generator and print), D — Platform & Comms (incl. CI harness). File-level ownership: `docs/agent-partition.md`. Stay inside your domain; ask the integrator before touching another domain's files.

Rules:

1. Worktree first. From the repo root run `git worktree add -b feat/<short> ../dugri-<short> origin/main` and do all work there. Never edit the shared root checkout.
2. Monolith files (`server/index.js`, `server/db.js`): edit only your domain's block; never reorder or reflow another domain's code.
3. Before every push: `git fetch origin && git rebase origin/main`, re-run the tests, then `git push --force-with-lease`.
4. Open your own PR with `gh pr create` and get CI green. Then stop. If the integrator's review requests changes, you fix them on your branch.
5. Never merge anything, never push to main, never deploy (staging belongs to the integrator, production to the owner).
6. Stacked work: PRs always target main. Don't open a PR that depends on an unmerged PR. Wait for the first to merge, or open the second as a draft whose body says "contains #N, rebase after it lands".
7. One driver per branch: only the session that created a branch pushes to it. If that session has ended and can't be resumed, the integrator or a newly briefed agent may take the branch over: it first posts "Taking over this branch from <session>" on the PR, and is the only driver from then on.
8. No `git stash`. The stash is shared across all worktrees and can restore another agent's work into your branch. Set work aside with a WIP commit on your branch.
9. Cleanup: when your PR is merged or closed, run `git worktree remove ../dugri-<short>` and `git branch -D feat/<short>`. Never remove a worktree you didn't create, or one with uncommitted changes.
