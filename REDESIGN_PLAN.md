# Dugri full redesign: agent runbook

You are redesigning the customer-facing Dugri website (`site/`) from scratch. Follow the phases in order. At every **STOP** gate, present the options, recommend one, and wait for the owner (Nevo). Never skip a gate or decide it yourself.

## Ground rules

- Read `CLAUDE.md` first. Its git, test and deploy rules override this file.
- Work only in a worktree: `git worktree add -b feat/redesign ../dugri-redesign origin/main`. Never edit the root checkout and never push to main. Open PRs with `gh pr create --draft`. Never merge or deploy.
- Every session starts from: **Hebrew RTL, mobile-first, follow PRODUCT.md and DESIGN.md.**
- Owner's brief: a total change, light only (no dark designs), graphic and eye-catching, "nothing seen before", little text and few photos, things that shift and move, must not look AI-generated. Reference: SKYLRK (Justin Bieber's collection site).
- Never use the name "אליאס" in customer-facing copy. Describe the game mechanic instead.
- Don't hardcode prices, versions or texts. They come from `server/settings.js` and the admin (see CLAUDE.md "Where the live truth is"). Keep the existing data hooks and JS behavior working.
- After every visual change, take Playwright screenshots at 390px (mobile) and 1440px (desktop) and show them. Judge mobile first.
- One skill leads each step. Taste picks the look, Impeccable plans, builds and reviews, and Emil handles motion. Don't mix their advice in one step.

## Skills

| Skill                                                                                                      | Use for                                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `impeccable` (`/impeccable <cmd>`)                                                                         | init, document, critique, shape, audit, harden, polish, bolder, quieter, animate |
| `taste-skill`, `soft-skill`, `minimalist-skill`, `redesign-skill`                                          | Direction and aesthetics, **marketing pages only**                               |
| `emil-design-eng`, `find-animation-opportunities`, `animate`, `review-animations`, `animation-performance` | Motion                                                                           |
| `dugri-brand`                                                                                              | Current brand assets, only if the owner keeps them (gate D3)                     |

## Page scope

| Group                         | Pages                                                                                                                            | Approach                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A, Persuade                   | `index.html`, `how.html`, `products.html`, `product.html`, `partner.html`                                                        | Full redesign: Taste + Impeccable + Emil                                                                   |
| B, Operate (money and orders) | `options.html`, `collect.html`, `proof.html`, `pickup.html`, `pay-success.html`, `pay-done.html`, `timer.html`, `wordlists.html` | New visual system only. **Do not change flow, fields, logic or IDs/selectors.** Impeccable only, no Taste. |
| C, Read                       | `terms.html`, `unsubscribe.html`                                                                                                 | Restyle with the new system                                                                                |
| Out of scope                  | `admin*.html`, `dashboard.html`, `coupons.html`, `design-codes.html`                                                             | Don't touch unless the owner says otherwise (gate D7)                                                      |

## Phase 1: Understand

1. Run `/impeccable init` to write PRODUCT.md: product, buyers (mostly women organizing a bachelorette, birthday, anniversary or farewell, arriving on a phone from WhatsApp), occasions, tone.
2. Screenshot every group A, B and C page, mobile and desktop.
3. Run `/impeccable critique` on the current site.
4. Write `redesign/inventory.md`. For every page, list the content, functions and data that must survive, and what is just old styling.

**STOP D1: Confirm PRODUCT.md and the must-keep inventory.** Ask: is anything missing or wrong? Is there anything to drop entirely (sections, pages)?

## Phase 2: Direction (no production code)

1. Use `taste-skill` to output a one-line design read and the dial values (expected around variance 8–9, motion 7–8, density 2–3).
2. Build **3 distinct homepage directions** as static mockups in `redesign/directions/{a,b,c}.html`, using real Dugri content. Make one with `soft-skill` and one with `minimalist-skill`. The third is your boldest original idea. All light, all with planned motion described or prototyped.
3. Screenshot each at both widths and present them side by side with a two-line rationale each.

**STOP D2: Pick a direction**, or a combination ("A's color with C's layout"). Iterate until approved.

**STOP D3: Brand.** Keep the current logo, colors and fonts (`dugri-brand`), evolve them, or replace them entirely? If replacing, propose 2–3 logo, wordmark and type options and stop again for a pick.

4. Run `/impeccable document` and write a **new** DESIGN.md for the chosen direction: tokens (color, type, spacing, radius, motion curves and durations), components and do/don't rules. It replaces the old look. Implement the tokens in `site/css/tokens.css`.

**STOP D4: Approve DESIGN.md**, the fonts (they must support Hebrew well) and the color palette.

## Phase 3: Homepage

1. Run `/impeccable shape homepage` to plan sections, order and hierarchy (little text, strong graphics, clear CTA to order).

**STOP D5: Approve the homepage plan**, including the hero concept and what the main CTA says.

2. Build it in `site/index.html` and the CSS. Keep existing JS hooks and dynamic content working.
3. Screenshot it, then use `/impeccable bolder` or `/impeccable quieter` as needed.

## Phase 4: Motion (homepage)

1. Run `find-animation-opportunities`, then build with `animate`.
2. Run `review-animations` (Emil's before/after table) and apply the fixes.
3. Run `animation-performance`: transform and opacity only, `prefers-reduced-motion` handled, smooth on a mid-range phone.
4. Record a short screen capture or frames of the motion for the owner.

**STOP D6: Approve the homepage look and motion** on a real phone. Ask the owner to open the preview link on their phone.

## Phase 5: Quality (homepage)

Run `/impeccable audit`, then `/impeccable harden` (RTL, long Hebrew words, empty, error and loading states, slow network), then `/impeccable polish`. Run the full test suite (`npm test`, the E2E specs, pytest) and fix breakages. Add or adjust tests per CLAUDE.md. Open a **draft PR** for the homepage.

## Phase 6: Remaining pages

1. Group A pages, one at a time: Phases 3–5 per page. Each page gets a quick approval of screenshots, but no full gate unless the owner asks.
2. Group B pages: apply DESIGN.md with Impeccable only. Run `/impeccable audit` and `/impeccable harden`. **Zero behavior change.** The E2E specs must pass unchanged, except where only selectors for styling moved (avoid that).
3. Group C pages: restyle.
4. Shared pieces: `header.css`, footer, the WhatsApp help button (`wa-help.css`), carousel. Redesign them once and reuse everywhere.

**STOP D7: Scope check.** Before starting group B, ask whether the order flow should only be restyled (default) or also rethought, and whether admin pages are in scope.

## Phase 7: Ship

1. Full test suite green, CI green on the PR, and screenshots of every page at both widths attached to the PR.
2. Mark the PR ready with the ready report from CLAUDE.md.

**STOP D8: Launch.** The owner reviews on staging and decides whether to go live in one switch or page by page. Production deploy is owner-only.

## Owner decisions summary

| Gate | Decision                                                | When           |
| ---- | ------------------------------------------------------- | -------------- |
| D1   | PRODUCT.md correct; what must stay or can be dropped    | After Phase 1  |
| D2   | Which of the 3 directions                               | Phase 2        |
| D3   | Keep, evolve or replace the brand (logo, colors, fonts) | Phase 2        |
| D4   | Approve DESIGN.md: palette, Hebrew fonts, rules         | End of Phase 2 |
| D5   | Homepage plan, hero concept, CTA wording                | Phase 3        |
| D6   | Homepage look and motion on a real phone                | Phase 4        |
| D7   | Order flow restyle-only or rethink; admin in scope?     | Before group B |
| D8   | Launch approach and production deploy                   | Phase 7        |
