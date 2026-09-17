# Vendored: jQuery 3.6.0 (for Tranzila's Apple Pay parent script)

Tranzila's Apple Pay handler (`https://directng.tranzila.com/assets/js/tranzilanapple_v3.js`)
is written against jQuery. It calls `$n.ajax` three times and `$n.each` once, `$n`
being whatever `jQuery.noConflict(true)` hands back — their documented snippet
loads jQuery purely to rename it that way.

Nothing else on this site uses jQuery, and nothing should start. It is here for
one third-party contract on the payment path, loaded **only** when a buyer opens
the payment window on a Tranzila charge in a browser that can open an Apple Pay
sheet (`site/js/apple-pay.js`).

## What is here, and where each file came from

| file                    | source                                                                | size    |
| ----------------------- | --------------------------------------------------------------------- | ------- |
| `jquery-3.6.0.min.js`   | `https://code.jquery.com/jquery-3.6.0.min.js` (the version their docs name) | 87 KB   |
| `LICENSE.txt`           | `https://raw.githubusercontent.com/jquery/jquery/3.6.0/LICENSE.txt`   | 1.1 KB  |

Served from OUR origin by `express.static`, never a CDN — the same rule as
`site/vendor/mediapipe`. The `/vendor/:dir/:file` route in `server/index.js` only
intercepts files that have a brotli-precompressed `.br` sibling, so this one falls
through to `express.static` untouched and is sent with `Cache-Control: no-cache`
like every other bare `.js` name. That costs one conditional GET per payment
window on a file that never changes, which is the right trade for a library whose
filename is version-pinned: it can never be paired staler than its own name.

It is deliberately NOT content-hashed. `asset-hashing.js` walks `js`, `css` and
`assets/fonts` only (`ASSET_DIRS`), and this file is referenced from JavaScript at
runtime rather than from a `<script src>` in the HTML, so `rewriteTags` would
never see it anyway.

**The full build, not `slim`.** jQuery's slim build drops `ajax` — which is the
only part of jQuery their script actually uses.

## Licence — permits commercial use

jQuery is **MIT** (`LICENSE.txt` here, copyright OpenJS Foundation and other
contributors). MIT asks that the copyright notice and permission notice travel
with the software: that is what `LICENSE.txt` is for. The minified file carries
its own banner comment naming the licence as well, and that banner must not be
stripped.

## Re-vendoring

```sh
curl -o site/vendor/jquery/jquery-3.6.0.min.js https://code.jquery.com/jquery-3.6.0.min.js
curl -o site/vendor/jquery/LICENSE.txt https://raw.githubusercontent.com/jquery/jquery/3.6.0/LICENSE.txt
```

If the version changes, `JQUERY_SRC` in `site/js/apple-pay.js` names the file
explicitly and must change with it. `tests/unit/apple-pay.test.js` fails if the
vendored file goes missing or if the two stop agreeing, so a half-finished
re-vendor cannot merge.
