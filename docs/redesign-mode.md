# Redesign mode: restyling a page

The redesign ("The Game Night Table") reaches the whole site through a mode, not through copies of pages.

**Turning it on.** Either of these turns the mode on:

- the setting `redesign.enabled`, which the owner flips in admin-features;
- a preview: the visitor opens any page with `?rd=1`, which sets the `rd` cookie; `?rd=0` clears it.

**What the gate does.** D's gate (`server/redesign-gate.js`) then:

- adds `class="rd"` to `<html>` on every non-admin page;
- links `/css/redesign.css` and `/js/redesign-shell.js`;
- serves `new.html` at `/`.

With the mode off, every page is byte-identical to before.

## The pattern (binding for A, C and D)

- **A page's HTML is never edited for the mode.** A page's look in the mode lives in `site/css/rd/<page>.css`, for example `css/rd/options.css`, owned by the page's owner.
  - **`site/css/rd/chrome.css`** (D) holds old chrome shared across pages: the old header and the consent chip.
  - **Link order:** the gate links, in the mode only and each only if it exists: `redesign.css`, `css/rd/chrome.css`, `css/rd/<page>.css`, then `redesign-shell.js` (D's #679). A page's rules therefore win over the shell's at equal specificity.
  - **No faces or globals there:** `@font-face` and `@import` are refused in `css/rd/`, because the faces live in `redesign.css`.
- **Scope every rule under `html.rd`.** `tests/unit/rd-css-scope.test.js` fails on any rule in `site/css/rd/` that isn't.
- **Build on the shell, don't repeat it.** Use its tokens (`var(--color-ink)`, `var(--radius-box)`, …). Give your own elements its components' look with `--rd-as-*` (below) instead of copying their rules.
- **Preview in a spec** with `previewRedesign(page)` from `tests/e2e/helpers/redesign.js`. It goes through the real `?rd=1` path.

## Redesign page owners

For the redesign, this table overrides `docs/agent-partition.md` where they differ. The page-level owner holds the page's settings (`--rd-header`, `--rd-footer`, the `--rd-as-*` lists) in its own section of `css/rd/<page>.css`, and adds another owner's selectors to those lists when asked. Each owner writes only inside its own marked section, `/* == X: <domain> — <part> == */ … /* == end X == */`; whoever lands second rebases and adds its section as a unit.

| Page                                             | Page-level owner                                   | Other sections                                         |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------ |
| products.html, design-codes.html                 | B                                                  | none                                                   |
| product.html                                     | B (gallery, title note, sections, related designs) | A: the buy box (`.pdp-head`, `.pdp-price`, `.pdp-buy`) |
| options.html, collect.html                       | C (the wizard, the word collection)                | A: the checkout sections                               |
| pickup.html, pay pages, partner, coupons         | A                                                  | none                                                   |
| wordlists, proof                                 | C                                                  | none                                                   |
| how, timer, terms, unsubscribe                   | D                                                  | none                                                   |
| the site header and footer (`css/rd/chrome.css`) | D                                                  | none                                                   |

## What the shell gives every page

### 1. The token bridge (`html.rd:not(.rd-native)`)

Every palette token `tokens.css` declares is renamed onto the redesign. A page that styles through them takes the new look with no edit; its hard-coded colours stay its owner's to change.

| tokens.css                                                             | becomes                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--bg`                                                                 | `--color-ground` (#fff1de)                                                                                                                       |
| `--section`, `--surface`                                               | `--color-paper` (#fff)                                                                                                                           |
| `--ink`, `--line`, `--sage`, `--sage-deep`, `--sage-deeper`, `--blush` | `--color-ink` (#000)                                                                                                                             |
| `--muted`                                                              | `--color-text-muted`                                                                                                                             |
| `--sage-tint`, `--blush-tint`                                          | `--color-tag` (#fdf2d4)                                                                                                                          |
| `--accent`                                                             | `--color-accent-pink` (#ff7aa9)                                                                                                                  |
| `--accent-deep`                                                        | `--color-brand-pink` (#ea4795)                                                                                                                   |
| `--accent-tint`                                                        | `--color-card-hot` (#ffe9f0)                                                                                                                     |
| `--ok`                                                                 | #1f7a4f                                                                                                                                          |
| `--display`                                                            | `--font-body` (M PLUS): the old display face also set prices, buttons and names, so Gveret goes only where a page asks for a title (`.rd-title`) |
| `--font`                                                               | `--font-body` (M PLUS Rounded 1c)                                                                                                                |
| `--h-weight`                                                           | `--weight-strong` (800)                                                                                                                          |
| `--h-spacing`                                                          | 0                                                                                                                                                |
| `--sub-weight`                                                         | `--weight-body`                                                                                                                                  |
| `--radius`                                                             | `--radius-box` (14px)                                                                                                                            |
| `--radius-pill`                                                        | 999px                                                                                                                                            |
| `--ease`                                                               | `--ease-pop`                                                                                                                                     |
| `--shadow-sm` / `-md` / `-lg`                                          | hard ink shadows: 3/3, 4/4, 6/7 px                                                                                                               |

`--price-gap` and `--was-gap` are spacing and stay as they are. A test fails if a new palette token is added to `tokens.css` without a mapping here.

### 2. Faces and tokens

`redesign.css` carries the M PLUS Rounded 1c and Gveret Levin faces and every role token of `redesign-tokens.css`, so every page in the mode gets them.

- They are copies: `home-new.css` keeps its faces and `redesign-tokens.css` its tokens, because new.html also loads outside the mode, where `redesign.css` does not.
- A test keeps the copies byte-identical, so change both or the test fails.

### 3. The header, menu and footer

The shell renders the shared header (logo, ≡ and "הזמינו עכשיו"), the menu sheet and the footer.

- **Where they go:** the header goes in place of the page's own header. The footer is opt-in (`--rd-footer`), because a page's own footer usually holds the owner's contacts (WhatsApp, phone, email, Instagram, the business line), which the shell's footer doesn't. Restyle that one instead. Anything replaced stays in the DOM, hidden (`data-rd-replaced`), so its ids, scripts and tests keep working.
- **Page rules don't reach them:** the shell's header and footer reset what a page's own `header { }` / `footer { }` rules would give them.
- **header.js:** it doesn't need to stand down, and the gate doesn't skip it. It only wires the hidden `header.hdr`, so it does nothing visible.
- **Before the shell runs:** `header.hdr` is hidden by CSS from the first paint, and the body padding it reserved goes to the new header, so nothing flashes or jumps.

A page decides from its `css/rd/<page>.css`:

```css
html.rd {
  --rd-header: replace; /* replace (default, when the page has one) | top | none */
  --rd-header-replace: '#wizTop'; /* the page's own header, if it isn't header.hdr */
  --rd-footer: replace; /* none (default) | replace | end */
  --rd-footer-replace: 'body > footer';
}
```

The wizard, for example, keeps its own bar with `--rd-header: none`.

### 4. Components

They are shown on `/rd-kit.html` (noindex). Each is a class under `html.rd`:

| Class                       | What                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.rd-btn`                   | the black pill; `.secondary` (outlined, hard shadow), `.ghost`, `.sm`, `.lg`, `.block`, disabled, `aria-busy="true"` (spinner) |
| `.rd-btn.arrow`             | the pill with the drawn forward arrow (pointing left, in the button's colour)                                                  |
| `.rd-title`                 | a heading in Gveret Levin with the coloured offset; `--rd-title-offset` picks the colour                                       |
| `.rd-card`                  | paper, a hair outline, the review card's hard shadow; `.hot` is the pink one; a link or button card lifts                      |
| `.rd-box`                   | the FAQ item's box: a bold outline, 14px corners, a small hard shadow                                                          |
| `.rd-field`                 | a label above, the input or textarea, `.hint` or `.err` under it; `.invalid` or `aria-invalid`                                 |
| `.rd-select`, `.rd-check`   | a select with its chevron; a checkbox or radio beside its label                                                                |
| `.rd-tag`, `.rd-chip`       | a small label (`.hot`); a choice (`aria-pressed`)                                                                              |
| `.rd-sheet`, `.rd-x`        | a bottom sheet (`<dialog>`, `showModal()`); the round ✕                                                                        |
| `.rd-toast`                 | `window.dugriRd.toast(text)`                                                                                                   |
| `.rd-steps`                 | an `<ol>`, current step `aria-current="step"`, done ones `.done`                                                               |
| `.rd-price`                 | `<span class="amt">199 ₪</span><s class="amt">239 ₪</s>`, ₪ kept with its number                                               |
| `.rd-empty`, `.rd-skeleton` | nothing yet; loading                                                                                                           |

**Using them without editing the HTML.** Name your own elements in your page's CSS, and the shell adds the class to them. It does this at start, and again for whatever the page adds later (the wizard's steps, the word lists):

```css
html.rd {
  --rd-as-btn: '.cta, button.next';
  --rd-as-btn-secondary: '.back';
  --rd-as-card: '.opt';
  --rd-as-field: '.fld';
}
```

The keys are `btn`, `btn-secondary`, `btn-ghost`, `btn-arrow`, `title`, `card`, `card-hot`, `box`, `field`, `select`, `check`, `tag`, `chip`, `x`, `sheet`, `price`, `steps`. Layout and anything particular to your page go in your `css/rd/<page>.css` as ordinary rules under `html.rd`, using the tokens.

### 5. Pages already built in the redesign

On new.html and new-faq.html (and `/`, which is new.html in the mode), the shell adds `html.rd-native` and does nothing else. The bridge doesn't apply there.

## Old Safari

The owner's Mac runs Safari 15.6 at most: it shows no WebP, so it is macOS 10.15 or older.

- **The shell:** ES5, with the `<dialog>` and `replaceChildren` fallbacks.
- **`redesign.css`** keeps to what Safari 15.6 reads, and a test holds it there. Write `css/rd/*.css` the same way:
  - no `inset`, `-inline` or `-block` shorthands (use top/right/bottom/left and the physical sides; the page is RTL);
  - no `:has()`, `:is()`, `:where()`, `color-mix()`, `@layer` or `@container`;
  - `:focus-visible` only in a rule of its own;
  - a `vh` line before any `svh`, and `overflow: hidden` before `overflow: clip`;
  - `aspect-ratio` only beside an explicit height;
  - flex `gap` needs Safari 14.1, so where the spacing matters use margins.
