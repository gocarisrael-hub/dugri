# Photo-card fallback pawns — owner overrides

Contract between the admin (Agent B) and the generator (Agent C).

## What this is

The deck's 104th card is the **photo card**: the customer's four pawn photos. An
order that supplies none is filled with generic Dugri pawns shipped at
`resources/canva/templates/_shared/photo-fallback/{1..4}.svg`.

Those are baked into the repo, so replacing one meant a PR and a deploy. The
owner can now replace any of the four from the admin (גלריית מוצר →
"חיילים לקלף התמונות"), per slot, with no deploy.

## The store

`$DATA_DIR/photo-fallback.json` — written by `server/photo-fallback.js`, on the
volume so it survives a redeploy.

<!-- Fenced as `text`, not `json`/`jsonc`: the formatter rewrites a JSON block
     with trailing commas, and the real file is STRICT JSON. -->

```text
{
  "slots": {
    "1": "/content-uploads/<16-hex>.png",
    "3": "/content-uploads/<16-hex>.webp"
  }
}
```

- Keys are `"1"`–`"4"`. **Only overridden slots are present** — an absent slot
  means "use the shipped pawn", which is what makes reset a deletion rather than
  a copy of the default.
- Values are always `/content-uploads/<16-hex>.<webp|jpg|jpeg|png>`, re-validated
  on every read and write. The file itself is at
  `$DATA_DIR/content-uploads/<name>`.
- A missing, empty or corrupt file means "no overrides" — it must never raise.
  This file not existing is the normal state.

## What the generator needs to do

`config.photo_fallback_paths(theme)` currently returns the shipped
`_shared/<subdir>/{1..4}.svg` in numeric order. It should consult this store
**per slot**, preferring an override and falling back to the shipped pawn:

```python
def _override_pawns():
    """{slot_int: absolute path} from the owner's admin overrides, or {}.

    Unreadable/corrupt is deliberately the same as "none": a bad file must
    degrade to the shipped pawns, never fail an order.
    """
    data_dir = os.environ.get("DATA_DIR")
    if not data_dir:
        return {}
    try:
        with open(os.path.join(data_dir, "photo-fallback.json"), encoding="utf-8") as f:
            slots = (json.load(f) or {}).get("slots") or {}
    except (OSError, ValueError):
        return {}
    out = {}
    for key, rel in slots.items():
        if not re.fullmatch(r"[1-4]", str(key)):
            continue
        name = os.path.basename(str(rel))
        # Only ever a file this server produced, under its own upload dir.
        if not re.fullmatch(r"[a-f0-9]{16}\.(webp|jpe?g|png)", name):
            continue
        path = os.path.join(data_dir, "content-uploads", name)
        if os.path.isfile(path):
            out[int(key)] = path
    return out
```

...then, in the existing numeric loop, take `override.get(i)` before the shipped
`{i}.svg`. The current "drop entries whose file is absent" behaviour should stay
exactly as it is.

## Two things worth knowing

**Overrides are rasters; the shipped pawns are SVG.** `server/content.js` refuses
SVG uploads on purpose — an uploaded `.svg` is served from our own origin at a
public `/content-uploads` URL and can carry `<script>`, so accepting one would be
a stored-XSS vector. Both forms render into the photo card the same way, so the
generator should not assume the extension.

**A slot may be overridden while its neighbours are not**, so the resolved set is
routinely a mix of `$DATA_DIR/content-uploads/*.png` and
`resources/.../photo-fallback/*.svg`. Order is still slot order: pawn N fills
slot N.

## Ownership

| Area                                                   | Owner |
| ------------------------------------------------------ | ----- |
| `server/photo-fallback.js`, the admin routes and panel | B     |
| `config.photo_fallback_paths` reading this store       | C     |
