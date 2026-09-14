// Agent B (Catalog & Design): the HTTP routes, moved out of server/index.js.
//
// Slice 2 of splitting the monolith (see docs/agent-partition.md, "Splitting the
// monolith"). Every block below is a VERBATIM move; only the glue is new.
//
// Wired exactly like server/routes/platform.js:
//   - Each function registers ONE contiguous block that used to sit inline in
//     index.js, and index.js calls it at exactly the spot the block occupied.
//     Express matches in registration order, so a block mounted anywhere else could
//     change which handler answers. tests/unit/route-order.test.js pins the order.
//   - Everything a block uses from index.js is passed in explicitly, `__dirname`
//     included: the moved code resolves site/ and site/js/designs.js relative to
//     server/, and this file lives one directory deeper. This module never
//     requires index.js (a cycle) and requires NOTHING at the top level, because
//     the unit tests reload the app by purging require.cache for server/*.js.
//   - Whatever index.js still calls from a block comes back as the return value.

// The merged admin design catalog (/api/admin/designs).
function registerAdminDesigns(
  app,
  { requireAdmin, path, __dirname, TEMPLATE_ROOT, designCatalog }
) {
  // Admin: the MERGED design catalog + per-design asset inventory. ONE list, no
  // built-in/owner-template distinction — an uploaded template is a design like any
  // other, so it appears wherever a built-in design does. BOTH admin design screens
  // read this endpoint: "עיצובים" (admin-designs.html) for the inventory, and
  // "גלריית מוצר" (admin-images.html) for the design list + each slot's shipped
  // render. One server-side merge, so the two screens can never drift apart again —
  // they did, and that is how an in-store template ended up sellable but invisible
  // in both of them. The merge itself lives in server/design-catalog.js (which also
  // documents the two art layouts and the per-kind asset checklist).
  app.get('/api/admin/designs', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let designs;
    try {
      designs = await designCatalog.mergedDesigns({
        siteDir: path.join(__dirname, '..', 'site'),
        templateRoot: TEMPLATE_ROOT,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    // `expected` stays the BUILT-IN file list it always was (the shape a built-in
    // design is measured against). Per-design expectations now travel on each
    // design's own `assets` / `source`, which is what a mixed list needs.
    res.json({ designs, expected: designCatalog.EXPECTED_DESIGN_ASSETS });
  });
}

// site/js/designs.js, the ESM design catalog, loaded ONCE for every route in this
// file. A CommonJS file can only reach it through a dynamic import, so the cache is
// the import promise, keyed by the file's URL (derived from the `__dirname` each
// register function is given). A FAILED import is dropped from the cache, so the
// next request tries again, as it did when each route imported the file itself.
// It rejects rather than resolving to a fallback because the callers disagree on
// what a missing catalog means: the public routes answer empty, the template
// delete guard refuses (fail closed).
const designsModules = new Map();
function loadDesignsModule({ path, __dirname, pathToFileURL }) {
  const url = pathToFileURL(path.join(__dirname, '..', 'site', 'js', 'designs.js')).href;
  let loading = designsModules.get(url);
  if (!loading) {
    loading = import(url);
    designsModules.set(url, loading);
    loading.catch(() => {
      if (designsModules.get(url) === loading) designsModules.delete(url);
    });
  }
  return loading;
}

// The design -> theme map, the in-store check and the private-design access codes.
function registerDesignCodes(
  app,
  {
    requireAdmin,
    couponRateOk,
    clientKey,
    path,
    __dirname,
    pathToFileURL,
    TEMPLATE_ROOT,
    db,
    templates,
  }
) {
  // A design id -> its generator theme key. A CUSTOM design is its own theme (the
  // themes.json key IS the design id); a BUILT-IN one is mapped by THEME_BY_DESIGN
  // in site/js/designs.js. That module is ESM, so it is imported once and cached —
  // a miss just means "unknown", never a thrown route.
  let _themeByDesign = null;
  async function loadThemeByDesign() {
    if (_themeByDesign) return _themeByDesign;
    try {
      const mod = await loadDesignsModule({ path, __dirname, pathToFileURL });
      _themeByDesign = mod.THEME_BY_DESIGN || {};
    } catch {
      _themeByDesign = {};
    }
    return _themeByDesign;
  }

  /**
   * Is this DESIGN offered in the shop? Unknown ids answer true: the flag exists to
   * let the owner withdraw something deliberately, so it must never be the reason a
   * design nobody registered stops working.
   *
   * Synchronous on purpose — the callers are request paths that cannot await — so
   * it uses the cached map and falls back to treating the design id as its own
   * theme key, which is exactly right for a custom design.
   */
  function designIsInStore(designId) {
    const id = String(designId || '');
    if (!id) return true;
    try {
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT)) || {};
      const key = (_themeByDesign && _themeByDesign[id]) || id;
      const entry = themes[key];
      return entry ? templates.inStore(entry) : true;
    } catch {
      return true;
    }
  }
  // Warm the map at boot so the synchronous check above can see built-in designs.
  loadThemeByDesign();

  // --- Private-design access codes (admin CRUD) ----------------------------
  // Mirrors the coupon admin routes. An access code unlocks a PRIVATE design in
  // the order flow (see POST /api/design-code/validate). All gated by ADMIN_KEY.

  // Admin: list all design access codes.
  app.get('/api/admin/design-codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ design_codes: db.listDesignCodes() });
  });

  // Admin: create an access code. 400 on invalid input or a duplicate code.
  app.post('/api/admin/design-codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const dc = db.createDesignCode({
      code: b.code,
      design_id: b.design_id,
      valid_until: b.valid_until,
    });
    if (dc && dc.error) return res.status(400).json({ error: dc.error });
    res.status(201).json({ design_code: dc });
  });

  // Admin: toggle an access code's active flag. 404 when the id is unknown.
  app.post('/api/admin/design-codes/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const active = !!(req.body && req.body.active);
    const dc = db.setDesignCodeActive(req.params.id, active);
    if (!dc) return res.status(404).json({ error: 'not found' });
    res.json({ design_code: dc });
  });

  // Admin: delete an access code. 404 when the id is unknown.
  app.delete('/api/admin/design-codes/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db.deleteDesignCode(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // PUBLIC design-code validation: the client enters an access code in the order
  // flow to unlock a PRIVATE design. Public (no owner token — a fresh visitor is
  // choosing a design), but rate-limited per client IP like the coupon oracle to
  // blunt code enumeration. Only the unlocked design id is ever leaked. On failure
  // it returns a GENERIC { valid:false } with NO reason — distinguishing not_found
  // from inactive/expired would turn this into an enumeration oracle (an attacker
  // learns which codes exist). Detailed reasons stay internal (db.validateDesignCode).
  app.post('/api/design-code/validate', (req, res) => {
    if (!couponRateOk('designcode:' + clientKey(req))) {
      return res.status(429).json({ error: 'too many attempts' });
    }
    const r = db.validateDesignCode(req.body && req.body.code);
    if (!r.valid) return res.json({ valid: false });
    // A design taken OFF the shop floor is off it for everyone. An access code
    // chooses how an on-sale private design is reached; it is not a way past
    // "this is not for sale yet", or withdrawing a design would still leave it
    // orderable by every code already handed out. Reads as an invalid code
    // rather than "valid but unavailable", so a withdrawn design leaks nothing.
    if (!designIsInStore(r.design_id)) return res.json({ valid: false });
    db.incrementDesignCodeUses(req.body && req.body.code);
    res.json({ valid: true, design: r.design_id });
  });
}

// Template upload, create, list, rename, settings, delete and single-asset replace.
function registerTemplateOnboarding(
  app,
  {
    requireAdmin,
    express,
    path,
    __dirname,
    pathToFileURL,
    TEMPLATE_ROOT,
    TEMPLATE_UPLOAD_LIMIT,
    PYTHON_BIN,
    templates,
  }
) {
  // Admin: onboard a NEW private template. Multipart upload of the card SVGs, the
  // title + word font files, and a few text fields (slug, display_he, title_text,
  // name_form, language?, extra_fields?). Accepts BOTH asset layouts and detects
  // which one the upload is (see server/templates.js):
  //   sheet (legacy) clean+filled {fronts,backs,board}.svg
  //   cards  (new)   clean+filled 1.svg-9.svg (1 = back, 2-9 = the eight fronts),
  //                  the board uploaded separately since it is its own output file
  // Writes them into resources/canva/templates/<slug>/, best-effort runs
  // generator/recipe_diff.py to produce generator/recipes/<slug>.json (sheet only —
  // there is no sheet to measure on a single-card template), and appends a
  // visibility:"private", calibrated:false entry to generator/themes.json. The
  // new template is NOT yet renderable — it needs a title-style calibration pass.
  // Body is parsed with a tiny in-repo multipart parser (no multer/busboy dep).
  app.post(
    '/api/admin/templates',
    express.raw({ type: () => true, limit: TEMPLATE_UPLOAD_LIMIT }),
    (req, res) => {
      if (!requireAdmin(req, res)) return;
      const boundary = templates.boundaryFromContentType(req.headers['content-type']);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'expected multipart/form-data upload' });
      }
      const { fields, files, fileLists } = templates.parseMultipart(req.body, boundary);
      let result;
      try {
        result = templates.onboardTemplate({
          root: TEMPLATE_ROOT,
          pythonBin: PYTHON_BIN,
          fields,
          files,
          // Repeated parts sharing one name — how a single multi-file picker
          // delivers the nine numbered card SVGs (and the shared assets/) at once.
          fileLists,
        });
      } catch (e) {
        return res
          .status(500)
          .json({ error: 'onboarding failed', detail: String((e && e.message) || e) });
      }
      // `titleless` marks the ONE rejection the owner can override: a title with no
      // {NAME}. It is legitimate (a deck whose artwork carries no name at all) but
      // must never be reached by accident, so the form re-posts with
      // allow_titleless:true after an explicit confirmation.
      if (result.error) {
        return res
          .status(result.httpStatus || 400)
          .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
      }
      res.status(201).json({ ok: true, ...result });
    }
  );

  // Admin: CREATE an EMPTY template shell from METADATA only (no files). Register the
  // themes.json entry + the empty dir, so a heavy template can be added by uploading
  // each asset SEPARATELY afterwards (via the per-asset replace route) instead of one
  // giant multipart POST that would exceed the body-size limit. JSON body carries the
  // same metadata fields the full upload form does (slug, display_he, title_text,
  // name_form, language, extra_fields, visibility).
  app.post('/api/admin/templates/create', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let result;
    try {
      result = templates.createTemplateShell({ root: TEMPLATE_ROOT, fields: req.body || {} });
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'create failed', detail: String((e && e.message) || e) });
    }
    if (result.error) {
      return res
        .status(result.httpStatus || 400)
        .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
    }
    res.status(201).json({ ok: true, ...result });
  });

  // Admin: template STATUS view — READ-ONLY inventory of every registered template
  // and which of its assets exist vs are MISSING (front/back/board clean+filled,
  // and both fonts). Powers the admin checklist so gaps are visible at a glance.
  app.get('/api/admin/templates', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let list;
    try {
      list = templates.listTemplateStatuses(TEMPLATE_ROOT);
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    res.json({ templates: list });
  });

  // Admin: rename a template's DISPLAY LABEL only (display_he). The slug/key/dir —
  // the identity stored orders reference — stay stable, so a rename never breaks an
  // existing order. Body: { display_he }.
  app.post('/api/admin/templates/:key/rename', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const displayName = (req.body && (req.body.display_he ?? req.body.name)) || '';
    let result;
    try {
      result = templates.renameTemplate({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        displayName,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
    res.json({ ok: true, ...result });
  });

  // Admin: edit an existing template's SETTINGS (display_he, language, name_form,
  // extra_fields, visibility, title_text/title_lines) — the storefront/config knobs,
  // never the identity (slug/dir/recipe) or assets. JSON body carries only the
  // fields to change; each is validated. e.g. flip an uploaded template
  // public/private, fix its language, or repair a title that lost its {NAME}.
  app.post('/api/admin/templates/:key/settings', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let result;
    try {
      result = templates.updateTemplateSettings({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        patch: req.body || {},
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    // See the upload route: `titleless` is the one rejection the owner may confirm
    // past (allow_titleless:true), not a validation the client can simply ignore.
    if (result.error) {
      return res
        .status(result.httpStatus || 400)
        .json({ error: result.error, ...(result.titleless ? { titleless: true } : {}) });
    }
    res.json({ ok: true, ...result });
  });

  // Admin: DELETE a template — remove its themes.json entry + on-disk files. GUARDED:
  // a theme a live orderable design maps to (its key is a THEME_BY_DESIGN value in
  // site/js/designs.js) is refused (409) so deleting can't break the storefront or an
  // in-flight order. The in-use set is derived from the catalog; if the catalog can't
  // be read we FAIL CLOSED (refuse) rather than risk deleting an in-use theme.
  app.delete('/api/admin/templates/:key', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let inUse;
    try {
      const mod = await loadDesignsModule({ path, __dirname, pathToFileURL });
      inUse = new Set(Object.values(mod.THEME_BY_DESIGN || {}));
    } catch (e) {
      return res.status(500).json({
        error:
          'could not verify the template is safe to delete (catalog unavailable): ' +
          String((e && e.message) || e),
      });
    }
    let result;
    try {
      result = templates.deleteTemplate({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        inUseThemes: inUse,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
    res.json({ ok: true, ...result });
  });

  // Admin: replace a SINGLE asset of an existing template in place. Multipart
  // upload of one file part; the role (whitelisted) comes from the URL so the write
  // target is a fixed path inside the template dir — no traversal, and the other
  // onboarded assets are untouched. SVG roles are SVG-validated, font roles by sfnt
  // magic. On a CALIBRATED template, replacing an SVG role is rejected (409,
  // calibrationWarning) unless the form carries force=1 — the UI re-submits with
  // force after the admin confirms they verified the proof.
  //
  // Replacing a NUMBERED CARD SVG then re-runs slot detection, and the outcome
  // comes back as `redetect: {ok, detail}`. The old recipe measured artwork that is
  // no longer there — and since card_slots carries no colour, leaving it alone
  // would paint the new art's words in the OLD art's ink. Detection writes the
  // RECIPE only, so the owner's hand-tuned card_slots still win; a failure changes
  // nothing on disk and is reported rather than swallowed.
  app.post(
    '/api/admin/templates/:key/assets/:role',
    express.raw({ type: () => true, limit: TEMPLATE_UPLOAD_LIMIT }),
    (req, res) => {
      if (!requireAdmin(req, res)) return;
      const boundary = templates.boundaryFromContentType(req.headers['content-type']);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'expected multipart/form-data upload' });
      }
      const { fields, files } = templates.parseMultipart(req.body, boundary);
      const file = files.file || files.asset || Object.values(files)[0];
      const force = fields && (fields.force === '1' || fields.force === 'true');
      let result;
      try {
        result = templates.replaceAsset({
          root: TEMPLATE_ROOT,
          key: req.params.key,
          role: req.params.role,
          file,
          force,
          pythonBin: PYTHON_BIN, // shrink embedded rasters on a per-file SVG upload too
        });
      } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e) });
      }
      if (result.error) {
        const { httpStatus, error, ...rest } = result;
        return res.status(httpStatus || 400).json({ error, ...rest });
      }
      res.json({ ok: true, ...result });
    }
  );
}

// Reading and removing one template asset.
function registerTemplateAssets(app, { requireAdmin, TEMPLATE_ROOT, templates }) {
  // Admin: READ one of a template's asset files (the counterpart to the replace
  // route above). The role is a whitelisted id, never a path, and templates.readAsset
  // resolves it through the SAME table the writer uses, so the two can never point at
  // different files.
  //
  // This exists so a tool can render a template's real type. The fonts live only on
  // the volume — nothing served them — which is why the calibration bench had to bake
  // its own copies in and then drifted from the site the moment a face was replaced.
  app.get('/api/admin/templates/:key/assets/:role', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let result;
    try {
      result = templates.readAsset({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        role: req.params.role,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) {
      return res
        .status(result.httpStatus || 400)
        .json({ error: result.error, ...(result.optional ? { optional: true } : {}) });
    }
    // Immutable per (template, role, mtime) is not knowable here, so no-cache: a
    // replaced font must never be served from an edge copy to a calibration screen
    // that is measuring against it.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(result.file);
  });

  app.delete('/api/admin/templates/:key/assets/:role', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let result;
    try {
      result = templates.clearAsset({
        root: TEMPLATE_ROOT,
        key: req.params.key,
        role: req.params.role,
      });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) {
      const { httpStatus, error, ...rest } = result;
      return res.status(httpStatus || 400).json({ error, ...rest });
    }
    res.json({ ok: true, ...result });
  });
}

// Reverting a shipped template.
function registerTemplateRevert(app, { requireAdmin, TEMPLATE_ROOT, templates }) {
  app.post('/api/admin/templates/:key/revert', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let result;
    try {
      result = templates.revertTemplate({ root: TEMPLATE_ROOT, key: req.params.key });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
    if (result.error) return res.status(result.httpStatus || 400).json({ error: result.error });
    res.json({ ok: true, ...result });
  });
}

// Strip anything executable from a template SVG before it is served. Both template
// SVG routes send their output through this.
//
// WHAT IT TARGETS: the XML parser, and only that. Both routes answer
// `image/svg+xml`, and the one way a response becomes a live document is opening
// the URL directly, which parses it as XML. No production path hands these
// responses to an HTML parser: the storefront, wizard, collect and admin-images
// pages use <img src> (an SVG image runs no script and loads nothing external),
// admin-bench draws through a data: <img>, and the admin checklist
// (admin-templates.html) parses with DOMParser as image/svg+xml and runs its own
// allowlist over the parsed tree before inserting it. This scanner therefore makes
// NO claim about what an HTML parser (innerHTML) would build from its output, and
// nothing in XML is raw text: a <script> inside <style> or <title> is a script
// element like any other, and is removed like any other.
//
// It is one of two defences on a direct open. The other is TEMPLATE_SVG_CSP (no
// script, sandboxed), so a byte that slips past here still cannot run.
//
// Why a scanner and not a parser: express is the server's only runtime dependency
// (svgo is a dev-only tool, absent at runtime). The scan COPIES safe bytes
// verbatim and DROPS only dangerous spans, so well-formed art comes out
// byte-identical (tests/unit/svg-sanitize.test.js checks real template files).
//
// It is O(n) per pass. The cursor only moves forward; a tag's end is looked for
// once, from that tag's own "<", and the next search starts past it. A tag with no
// closing ">" ends the scan: everything from it on is dropped, because an XML
// parser renders nothing past a tag it cannot close, and re-scanning from the next
// "<" is exactly what made the previous version quadratic. A "<" that does not
// start a name is copied as one character without any search. A bounded fixpoint
// (SVG_SANITIZE_MAX_PASSES) catches a removal that re-forms a tag; real art is
// stable on the first pass, and anything still changing at the cap fails closed
// to "".
// Elements that run script or load another document. frame/frameset matter in the
// XHTML namespace: `<h:frame src="data:text/html,<script>…">` runs its document.
const SVG_BLOCKED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'object',
]);
const SVG_SANITIZE_MAX_PASSES = 8;

// The second, independent defence for a template SVG opened DIRECTLY as a document
// (both routes below set it): the document may run no script and fetch nothing but
// images from data: or our own origin, inline styles and data: fonts. `sandbox`
// (no allow-tokens) gives it an opaque origin with scripting disabled. `img-src
// 'self'` is there for de-duplicated cards, whose background is an
// "../assets/<sha>.png" reference rewritten to /api/template-asset/… (without it a
// directly opened card lost its background). No page loads these routes as a
// document — they are all <img src>, where a response CSP does not apply — so this
// only hardens the direct-open view.
const TEMPLATE_SVG_CSP =
  "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data:; sandbox";

// The local name of a possibly namespace-prefixed name, lower-cased. The prefix is
// anything up to the first ":", in any script: `<é:script>` and `<ש:iframe>` are as
// blocked as `<svg:script>`.
function svgLocalName(name) {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

// A name character (by char code): anything above ASCII space that is not "/", "=",
// "<", ">" or a quote. XML whitespace is all at or below 0x20.
function svgIsNameChar(c) {
  return c > 32 && c !== 47 && c !== 61 && c !== 60 && c !== 62 && c !== 34 && c !== 39;
}

// Would this attribute value be read as a script URL? Character references are
// decoded (&#106; &#x6A; …) and every ASCII whitespace/control character dropped,
// because the URL parser ignores them: "java&#x09;script:" and "  JavaScript:" both
// run. Checked anywhere in the value, which also covers <set to="javascript:…"> and
// <animate values="#a;javascript:…"> aimed at an href.
function svgValueRunsScript(value) {
  if (!/[:&]/.test(value)) return false;
  const decoded = value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(colon|tab|newline));?/gi,
    (m, hex, dec, named) => {
      if (named) return { colon: ':', tab: '\t', newline: '\n' }[named.toLowerCase()];
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
  );
  const bare = decoded.replace(/[\x00-\x20\x7f-\x9f]+/g, '').toLowerCase();
  return /(?:java|vb)script:/.test(bare);
}

// Clean ONE tag's interior (the text between "<" and ">"). Removes event-handler
// attributes (name starts with "on") and any attribute whose value is a script URL,
// each with its value. Returns the SAME string when nothing is removed, so the
// caller can tell "unchanged" by reference; nothing is reordered or re-spaced.
function svgCleanTag(inner) {
  const L = inner.length;
  let j = inner.charCodeAt(0) === 47 ? 1 : 0;
  while (j < L && svgIsNameChar(inner.charCodeAt(j))) j++;
  let parts = null;
  let keep = 0;
  while (j < L) {
    const c = inner.charCodeAt(j);
    if (c <= 32 || c === 47 || c === 61) {
      j++;
      continue;
    }
    if (c === 34 || c === 39) {
      const close = inner.indexOf(inner[j], j + 1);
      j = close === -1 ? L : close + 1;
      continue;
    }
    const nameStart = j;
    while (j < L && svgIsNameChar(inner.charCodeAt(j))) j++;
    if (j === nameStart) {
      j++; // a stray "<" or ">" inside the tag: step over it, so j always advances
      continue;
    }
    let k = j;
    while (k < L && inner.charCodeAt(k) <= 32) k++;
    let end = j;
    let value = '';
    if (inner.charCodeAt(k) === 61) {
      k++;
      while (k < L && inner.charCodeAt(k) <= 32) k++;
      const q = inner.charCodeAt(k);
      if (q === 34 || q === 39) {
        const close = inner.indexOf(inner[k], k + 1);
        end = close === -1 ? L : close + 1;
        value = inner.slice(k + 1, close === -1 ? L : close);
      } else {
        let m = k;
        while (m < L && inner.charCodeAt(m) > 32) m++;
        end = m;
        value = inner.slice(k, m);
      }
    }
    const handler =
      (inner.charCodeAt(nameStart) | 32) === 111 && (inner.charCodeAt(nameStart + 1) | 32) === 110;
    if (handler || svgValueRunsScript(value)) {
      if (!parts) parts = [];
      parts.push(inner.slice(keep, nameStart));
      keep = end;
    }
    j = Math.max(j, end);
  }
  if (!parts) return inner;
  parts.push(inner.slice(keep));
  return parts.join('');
}

// The end of a "<!DOCTYPE …>" / "<!ENTITY …>" declaration: the next ">", but a
// DOCTYPE's internal subset ("[ … ]") may contain ">", so a "[" is skipped to its
// "]" first. Returns the index just past the ">" (or the end of the input).
function svgSkipDeclaration(s, lt) {
  let i = lt + 2;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 91) {
      const close = s.indexOf(']', i + 1);
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (c === 62) return i + 1;
    i++;
  }
  return s.length;
}

// The index of the ">" that ends the tag opened at "<" (position lt), skipping a
// ">" inside a quoted attribute value; -1 when the tag never closes. A "<" outside
// quotes also means it never closes: XML allows no "<" inside a tag, so the parser
// stops there, and so does the scan (rather than letting the tag swallow the next
// tag's ">", which would carry that tag's bytes through uncleaned).
function svgTagEnd(s, lt) {
  const n = s.length;
  let i = lt + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39) {
      const close = s.indexOf(s[i], i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (c === 62) return i;
    if (c === 60) return -1;
    i++;
  }
  return -1;
}

// One forward pass. Kept bytes are never copied piece by piece: the pass only
// records where a removal or a cleaned tag interrupts the input, and joins the
// pieces once at the end. A pass that changes nothing returns the input string
// itself, so real art costs no copy and the fixpoint check is a reference compare.
function svgSanitizePass(s) {
  const n = s.length;
  const parts = [];
  let keep = 0; // s[keep..] has not been emitted yet
  const cut = (from, to) => {
    parts.push(s.slice(keep, from));
    keep = to;
  };
  const closeRe = /<\/(?:[^\s<>/:=]+:)?([^\s<>/:=]+)\s*>/gi;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    const next = s.charCodeAt(lt + 1);
    if (next === 33 /* ! */) {
      if (s.startsWith('<!--', lt)) {
        const e = s.indexOf('-->', lt + 4); // an XML comment is inert: kept
        i = e === -1 ? n : e + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', lt)) {
        const e = s.indexOf(']]>', lt + 9); // CDATA is character data in XML: kept
        i = e === -1 ? n : e + 3;
        continue;
      }
      // <!DOCTYPE …> / <!ENTITY …>: REMOVED. Without the DOCTYPE no entity is
      // defined, so an entity-expansion payload (which libxml2 would expand into a
      // live <script> or a javascript: value) has nothing to expand; the XML parser
      // errors on the undefined reference and renders nothing.
      const end = svgSkipDeclaration(s, lt);
      cut(lt, end);
      i = end;
      continue;
    }
    if (next === 63 /* ? */) {
      const e = s.indexOf('?>', lt + 2);
      const end = e === -1 ? n : e + 2;
      // <?xml-stylesheet …?> can pull in a stylesheet: REMOVED. A plain <?xml …?>
      // declaration is inert and kept, so art that has one stays byte-identical.
      if (s.slice(lt, lt + 16).toLowerCase() === '<?xml-stylesheet') cut(lt, end);
      i = end;
      continue;
    }
    // The name first, without searching: a "<" that starts no name is kept as one
    // character, so a run of them costs nothing.
    const p = next === 47 ? lt + 2 : lt + 1;
    let q = p;
    while (q < n && svgIsNameChar(s.charCodeAt(q))) q++;
    if (q === p) {
      i = lt + 1;
      continue;
    }
    const gt = svgTagEnd(s, lt);
    if (gt === -1) {
      cut(lt, n); // an unclosed tag ends the document for an XML parser
      i = n;
      break;
    }
    const local = svgLocalName(s.slice(p, q));
    if (SVG_BLOCKED_ELEMENTS.has(local)) {
      if (next === 47 || s.charCodeAt(gt - 1) === 47) {
        cut(lt, gt + 1); // a close tag or a self-closing tag: remove just the tag
        i = gt + 1;
        continue;
      }
      // An open blocked element: remove it and its content up to the next close tag
      // with the same local name (any prefix); none left means remove to the end.
      closeRe.lastIndex = gt + 1;
      let m;
      let closeEnd = n;
      while ((m = closeRe.exec(s))) {
        if (svgLocalName(m[1]) === local) {
          closeEnd = m.index + m[0].length;
          break;
        }
      }
      cut(lt, closeEnd);
      i = closeEnd;
      continue;
    }
    const inner = s.slice(lt + 1, gt);
    const cleaned = svgCleanTag(inner);
    if (cleaned !== inner) {
      cut(lt + 1, gt);
      parts.push(cleaned);
    }
    i = gt + 1;
  }
  if (!parts.length) return s;
  parts.push(s.slice(keep));
  return parts.join('');
}

function sanitizeSvgForDom(svg) {
  let s = String(svg);
  for (let pass = 0; pass < SVG_SANITIZE_MAX_PASSES; pass++) {
    const next = svgSanitizePass(s);
    if (next === s) return s; // stable: real artwork returns here on the first pass
    s = next;
  }
  // Still changing at the cap: a self-re-forming payload. Fail closed.
  return svgSanitizePass(s) === s ? s : '';
}

// Design names, custom designs and the template picture/asset routes.
function registerStorefrontTemplates(
  app,
  { requireAdmin, fs, path, __dirname, pathToFileURL, TEMPLATE_ROOT, templates }
) {
  // Public: the LIVE, owner-editable per-design metadata the storefront and the
  // buyer wizard must not bake into their bundle —
  //   `names`  { <designId>: displayName }   an admin "rename template"
  //   `fields` { <designId>: { extra_fields, language, name_form } }
  //
  // Both exist for the same reason: they are edited in the ADMIN, which writes the
  // owner themes.json on the volume (DATA_DIR), while site/js/designs.js holds only
  // build-time DEFAULTS. `fields` was added after סנטוריני was changed from a couple
  // deck to a one-person deck in the admin and the wizard went on asking the buyer
  // for two partner names + years-married — nothing the owner could do reached it,
  // because the client mirror is compiled into the browser bundle.
  //
  // Each design carries its generator theme (site/js/designs.js), so a themes.json
  // entry maps straight onto the design id — no separate slug↔id table.
  // Unauthenticated on purpose (every visitor needs the current values) and exposes
  // ONLY these whitelisted keys, never any other theme field. themes.json is read
  // ONCE per request; any error (missing/corrupt config, catalog import failure)
  // resolves to {} / {} so the pages fall back to their built-in defaults and never
  // break. The buyer-facing fetchers add their own timeout.
  app.get('/api/design-names', async (req, res) => {
    let names = {};
    let fields = {};
    try {
      const mod = await loadDesignsModule({ path, __dirname, pathToFileURL });
      // PUBLIC subset only — a private/access-gated design's name must never leak to
      // anonymous visitors. themes.json is read through an mtime cache so this hot
      // endpoint doesn't hit disk on every products.html / product.html load.
      const publicDesigns = mod.PUBLIC_DESIGNS || [];
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
      names = templates.designDisplayNames(themes, publicDesigns);
      fields = templates.designThemeFields(themes, publicDesigns);
    } catch {
      names = {};
      fields = {};
    }
    res.json({ names, fields });
  });

  // --- Custom designs: uploaded templates that become storefront products -------
  // A "custom design" is DERIVED (no separate store): a PUBLIC generator theme
  // (themes.json) that is NOT one of the built-in catalog designs' themes. So an
  // admin-uploaded template automatically becomes an orderable product, and deleting
  // the template removes it — no catalog rebuild. Its pictures are the template's own
  // FILLED SVGs (the sample-personalized art — a realistic product photo, unlike the
  // blank clean art), served by GET /api/template-image below. Uncalibrated templates
  // still appear (the owner controls visibility + the admin gates PDF generation).

  // The product picture slots a custom design can expose.
  const CUSTOM_SLOTS = ['front', 'back', 'board'];
  // Does the template have a filled SVG for this picture slot? The FILE behind a
  // slot depends on the template's asset layout — filled/fronts.svg on a legacy
  // sheet, filled/2.svg on a single-card template (whose filled/1.svg is the back)
  // — so the mapping lives in templates.filledImageRel and is resolved through the
  // persistent overlay (server/template-store.js), so an OWNER-uploaded template —
  // whose assets live under DATA_DIR and not in the image — shows its pictures.
  function customSvgExists(slug, slot) {
    if (!templates.isSafeSlug(slug)) return false;
    const file = templates.templateImagePath(TEMPLATE_ROOT, slug, slot);
    return !!file && fs.existsSync(file);
  }

  // Public: the list of custom designs (uploaded templates that aren't built-in),
  // each shaped like a catalog design the storefront can render — id (=slug), name
  // (display_he), theme (=slug), custom:true, and img URLs for whichever of
  // front/back/board SVGs the template actually has on disk. Fail-safe: any error →
  // empty list so the storefront just shows the built-in catalog.
  app.get('/api/custom-designs', async (req, res) => {
    let out = [];
    try {
      const mod = await loadDesignsModule({ path, __dirname, pathToFileURL });
      const builtIn = new Set(Object.values(mod.THEME_BY_DESIGN || {}));
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
      for (const key of Object.keys(themes || {})) {
        const t = themes[key] || {};
        if (builtIn.has(key)) continue; // a built-in design's theme, not a custom product
        // Taken off the shop floor entirely — not in the grid, and NOT unlockable
        // with an access code either. That is the difference from `visibility`
        // below, which only chooses HOW an on-sale design is reached. The owner can
        // still generate an order for it from the admin.
        if (!templates.inStore(t)) continue;
        if ((t.visibility || 'public') !== 'public') continue; // owner hid it
        if (!templates.isSafeSlug(key)) continue;
        const img = {};
        for (const slot of CUSTOM_SLOTS) {
          if (customSvgExists(key, slot)) {
            img[slot] = '/api/template-image/' + encodeURIComponent(key) + '/' + slot;
          }
        }
        // Skip a shell with no card art yet — nothing to show as a product.
        if (!img.front && !img.back && !img.board) continue;
        out.push({
          id: key,
          // The ONE display-name rule (templates.displayNameForDesign) — a custom
          // design IS its own theme, so this is its live `display_he`, resolved the
          // same way /api/design-names and the admin catalog resolve every other
          // design's name.
          name: templates.displayNameForDesign(themes, { id: key, theme: key }),
          theme: key,
          custom: true,
          public: true,
          calibrated: !!t.calibrated,
          hasBoard: !!img.board,
          // The wizard resolves a BUILT-IN design's fields from a static map in
          // site/js/designs.js, which by definition cannot contain a custom
          // template. Without these it asked for none of them: a template
          // declaring AGE / YEARS / NAME1+NAME2 took the order anyway and printed
          // the title with unfilled placeholders, and an ENGLISH template got the
          // Hebrew name rule from the fallback.
          extra_fields: Array.isArray(t.extra_fields) ? t.extra_fields : [],
          language: typeof t.language === 'string' && t.language ? t.language : 'hebrew',
          name_form: typeof t.name_form === 'string' && t.name_form ? t.name_form : null,
          img,
        });
      }
    } catch {
      out = [];
    }
    res.json({ designs: out });
  });

  // Public: serve a custom design's picture — the template's FILLED SVG for the
  // slot (the sample-personalized art, so the storefront shows a realistic
  // example). slot is front|back|board, mapped to a file by the template's asset
  // layout (fronts/backs.svg on a sheet, 2.svg/1.svg on a single-card template).
  // The slug is validated to the safe-slug shape and the path is confined to the
  // templates dir, so there is no traversal. Cached (the art changes only on a
  // re-upload, which changes the file). SVG only.
  // A template's de-duplicated background lives in its own assets/ dir and each
  // card SVG points at it RELATIVELY ("../assets/<sha>.png"). Served straight from
  // an /api/... URL that relative path resolves to nothing, so the card arrived
  // WITHOUT its artwork — the storefront has been showing de-duplicated templates
  // as bare cards. Serving the asset itself, and rewriting the reference to point
  // here, fixes that and lets the admin checklist show a thumbnail per file
  // without inlining a 5MB background into every one of them (the browser fetches
  // it once and caches it across all of them).
  app.get('/api/template-asset/:slug/:name', (req, res) => {
    const slug = String(req.params.slug || '');
    const name = path.basename(String(req.params.name || ''));
    if (!templates.isSafeSlug(slug) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(404).type('txt').send('Not found');
    }
    let dir = null;
    try {
      dir = templates.resolveTemplateDirBySlug(TEMPLATE_ROOT, slug);
    } catch {
      return res.status(404).type('txt').send('Not found');
    }
    if (!dir) return res.status(404).type('txt').send('Not found');
    const file = path.resolve(dir, 'assets', name);
    // Confined to the template's own assets dir — basename() above plus this
    // prefix check, so neither half has to be perfect alone.
    const root = path.resolve(dir, 'assets') + path.sep;
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      return res.status(404).type('txt').send('Not found');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  });

  // Read a card SVG with its "../assets/" references rewritten to absolute
  // /api/template-asset/ URLs, so the markup renders correctly wherever it is
  // served from. Returns null when the file is missing.
  function templateSvgWithAssets(slug, file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    return text.replace(
      /((?:xlink:)?href=")\.\.\/assets\/([^"]+)(")/gi,
      (_m, pre, name, post) =>
        pre +
        '/api/template-asset/' +
        encodeURIComponent(slug) +
        '/' +
        encodeURIComponent(name) +
        post
    );
  }

  // One card SVG by ROLE, for the admin checklist's thumbnails. Admin-gated: the
  // public storefront route below exposes only the three display slots.
  app.get('/api/admin/templates/:key/asset-svg/:role', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const key = String(req.params.key || '');
    const role = String(req.params.role || '');
    if (!templates.isSafeThemeKey(key)) return res.status(404).type('txt').send('Not found');
    let entry = null;
    let dir = null;
    try {
      const themes = templates.loadThemesCached(templates.themesPathFor(TEMPLATE_ROOT));
      entry = themes && themes[key];
      dir = templates.resolveTemplateDirBySlug(TEMPLATE_ROOT, key);
    } catch {
      /* fall through to 404 */
    }
    if (!entry || !dir) return res.status(404).type('txt').send('Not found');
    // assetRolesFor is the single source of truth for role -> file, so a thumbnail
    // can only ever name a file the checklist itself lists.
    const spec = (templates.assetRolesFor(entry) || []).find((a) => a.role === role);
    if (!spec || !spec.rel) return res.status(404).type('txt').send('Not found');
    const file = path.resolve(dir, spec.rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
      return res.status(404).type('txt').send('Not found');
    }
    const svg = templateSvgWithAssets(key, file);
    if (svg == null) return res.status(404).type('txt').send('Not found');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', TEMPLATE_SVG_CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.send(sanitizeSvgForDom(svg));
  });

  app.get('/api/template-image/:slug/:slot', (req, res) => {
    const slug = String(req.params.slug || '');
    const slot = String(req.params.slot || '');
    if (!templates.isSafeSlug(slug) || !CUSTOM_SLOTS.includes(slot)) {
      return res.status(404).type('txt').send('Not found');
    }
    // Resolved through the persistent overlay and confined to the resolved template
    // dir (templateImagePath returns null on any escape), so an owner-uploaded
    // template's art is served from DATA_DIR while there is still no traversal.
    const file = templates.templateImagePath(TEMPLATE_ROOT, slug, slot);
    if (!file || !fs.existsSync(file)) return res.status(404).type('txt').send('Not found');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', TEMPLATE_SVG_CSP);
    res.setHeader('Cache-Control', 'public, max-age=300');
    // NOT sendFile: a de-duplicated card points at "../assets/<sha>.png", which
    // resolves to nothing from this URL, so the storefront was showing those
    // templates as bare cards with no artwork.
    const svg = templateSvgWithAssets(slug, file);
    if (svg == null) return res.status(404).type('txt').send('Not found');
    res.send(sanitizeSvgForDom(svg));
  });
}

// The new-game promo photo upload and the per-design gallery.
function registerPromoImageGallery(
  app,
  {
    requireAdmin,
    express,
    CONTENT_IMAGE_UPLOAD_LIMIT,
    templates,
    content,
    designImages,
    imageThumbs,
    photoFallback,
  }
) {
  // Admin: upload ONE photo for the home-page "new game" block and return the path
  // it was stored at. Same multipart shape and magic-byte typing as the content
  // routes above, and the same content-addressed store — so a photo already on the
  // volume de-dupes to the file that is already there.
  //
  // Unlike the content routes this attaches the file to NOTHING: the admin page
  // puts the returned path into the block and saves the block through
  // /api/admin/settings, which is what makes the whole section save atomically.
  // The cost of that is an upload the owner never saves leaves an unreferenced
  // file behind; the client shrinks images before sending, so a stray is a few tens
  // of KB, and deleting it here could just as easily delete a file the SAVED block
  // (or a content override sharing the same bytes) still points at.
  app.post(
    '/api/admin/promo/image',
    // Authenticate (on ?key=, available before the body) BEFORE buffering, so an
    // unauthenticated client can't force large allocations.
    (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      next();
    },
    express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
    (req, res) => {
      const boundary = templates.boundaryFromContentType(req.headers['content-type']);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'expected multipart/form-data upload' });
      }
      const { files } = templates.parseMultipart(req.body, boundary);
      const file = files.file || files.image || Object.values(files)[0];
      if (!file || !Buffer.isBuffer(file.data)) {
        return res.status(400).json({ error: 'no image file part' });
      }
      try {
        res.json({ ok: true, img: content.saveImageBytes(file.data).path });
      } catch (e) {
        res.status(400).json({ error: String((e && e.message) || e) });
      }
    }
  );

  // --- Per-design GALLERY (server/design-images.js) ----------------------------
  // The owner CURATES each design's gallery WITHOUT a deploy — same self-serve
  // pattern as the content editor: REPLACE a base render (store|front|back|photo|board),
  // ADD named extra photos, toggle each picture's visibility per surface (products
  // grid / product detail), and reorder. Storage is REUSED from content.js: a
  // picture only ever holds a "/content-uploads/<hash>.<ext>" path THIS server
  // produced (magic-byte typed, size-capped), so it can never point off-origin.
  // Uploads are content-addressed and SHARED across the design-images store AND the
  // content store, so before reclaiming a displaced file we confirm NEITHER store
  // still references it.

  // Reclaim a now-orphaned upload: delete it only when no design-image picture and
  // no content override still points at it (content-addressed files are shared).
  function reclaimDesignImage(imgPath) {
    if (!imgPath) return;
    if (designImages.isImageReferenced(imgPath)) return;
    if (content.isImageReferenced(imgPath)) return;
    // ...and the photo-card fallback pawns, which reuse the same content-addressed
    // uploads: the SAME bytes uploaded as both a gallery picture and a pawn are ONE
    // file, so displacing the picture must not delete what the pawn still points at.
    if (photoFallback.isImageReferenced(imgPath)) return;
    content.deleteUpload(imgPath);
  }

  // Save the multipart file part as an our-own upload, or send a 400. Returns the
  // "/content-uploads/<name>" path on success, or null after responding on failure.
  function saveGalleryUpload(req, res) {
    const boundary = templates.boundaryFromContentType(req.headers['content-type']);
    if (!boundary || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'expected multipart/form-data upload' });
      return null;
    }
    const { fields, files } = templates.parseMultipart(req.body, boundary);
    const file = files.file || files.image || Object.values(files)[0];
    if (!file || !Buffer.isBuffer(file.data)) {
      res.status(400).json({ error: 'no image file part' });
      return null;
    }
    let img;
    try {
      img = content.saveImageBytes(file.data).path;
    } catch (e) {
      res.status(400).json({ error: String((e && e.message) || e) });
      return null;
    }
    return { img, fields };
  }

  // Public: the whole gallery-config map. Unauthenticated on purpose — every
  // visitor's grid + product page needs it to render the owner's curated gallery
  // (see site/js/design-images.js). Read-only.
  //
  // `srcsets` rides along: for every upload the config references, the ready-made
  // srcset string for its derivative ladder (server/image-thumbs.js). It is built
  // HERE rather than on the client so exactly ONE place decides what `w` descriptor
  // each rung gets — the client only ever copies a string it was handed, and can
  // never assert a width the resizer would not produce (INVARIANT 1). An upload
  // whose dimensions cannot be read is simply absent, and the client keeps a plain
  // `src` rather than an unbacked descriptor.
  app.get('/api/design-images', (req, res) => {
    const images = designImages.getAll();
    const srcsets = {};
    for (const p of designImages.collectImagePaths(images)) {
      const name = p.split('/').pop();
      const set = imageThumbs.srcsetFor(name);
      if (set) srcsets[name] = set;
    }
    res.json({ images, srcsets, rev: imageThumbs.REV });
  });

  // Public: ONE rung of an upload's derivative ladder (see server/image-thumbs.js).
  // The owner's gallery uploads are camera files — up to 4032 px and 3.4 MB — and
  // every surface paints them into a 100–400 CSS px box. This is what those
  // surfaces load instead.
  //
  // The REVISION is in the PATH, not just in the on-disk filename. The response is
  // `immutable` for a year, so if the produced bytes ever change (a new encoder,
  // quality, colour handling or geometry rule) while the URL stayed the same, every
  // browser that has visited would keep the old picture until the cache expired.
  // Bumping imageThumbs.REV therefore changes the public URL too, which is a clean
  // cutover, and sweepStale() reclaims the previous generation from the volume.
  //
  // A request carrying a PAST revision is still served (never a broken image on a
  // page whose HTML was cached across a bump) — but with a short max-age, since
  // those bytes are by definition not the current answer for that URL.
  //
  // 404 is a NORMAL answer (no Python/Pillow, an undecodable upload): every caller
  // keeps its own fallback, so a missing derivative costs one picture, never the
  // page. It deliberately does NOT fall back to serving the original — that is the
  // multi-MB page this route exists to avoid.
  app.get('/design-img/:rev/:w/:name', (req, res) => {
    const current = req.params.rev === imageThumbs.REV;
    imageThumbs
      .get(req.params.name, Number(req.params.w))
      .then((der) => {
        if (!der) return res.status(404).type('txt').send('Not found');
        res.setHeader(
          'Cache-Control',
          current ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
        );
        // Defense in depth, as on /content-uploads: never let a browser sniff a
        // served image into an executable type.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type(der.type);
        res.sendFile(der.file);
      })
      .catch(() => res.status(404).type('txt').send('Not found'));
  });

  // Public: the wizard design picker's small derivative. Predates the ladder and
  // keeps its own URL because buyer sessions have this path cached; it now serves
  // the 400 rung of the same pipeline.
  app.get('/design-thumb/:name', (req, res) => {
    imageThumbs
      .get(req.params.name, 400)
      .then((thumb) => {
        if (!thumb) return res.status(404).type('txt').send('Not found');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type(thumb.type);
        res.sendFile(thumb.file);
      })
      .catch(() => res.status(404).type('txt').send('Not found'));
  });

  // Admin: REPLACE a base render (store|front|back|photo|board) with an uploaded picture.
  // Multipart (fields designId, slot + a file part). A displaced prior override is
  // reclaimed. Auth runs on ?key= BEFORE buffering megabytes.
  app.post(
    '/api/admin/design-images/base/image',
    (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      next();
    },
    express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
    (req, res) => {
      const saved = saveGalleryUpload(req, res);
      if (!saved) return;
      const designId = designImages.designOk(saved.fields.designId);
      const slot = designImages.slotOk(saved.fields.slot);
      if (!designId || !slot) {
        // Reclaim the just-written orphan (nothing references it yet).
        reclaimDesignImage(saved.img);
        return res.status(400).json({ error: 'bad designId or slot' });
      }
      const { prev } = designImages.setBaseImg(designId, slot, saved.img);
      if (prev) reclaimDesignImage(prev);
      res.json({ ok: true, img: saved.img, gallery: designImages.getForDesign(designId) });
    }
  );

  // Admin: ADD a named extra photo to a design's gallery. Multipart (fields
  // designId, name? + a file part).
  app.post(
    '/api/admin/design-images/photo',
    (req, res, next) => {
      if (!requireAdmin(req, res)) return;
      next();
    },
    express.raw({ type: () => true, limit: CONTENT_IMAGE_UPLOAD_LIMIT }),
    (req, res) => {
      const saved = saveGalleryUpload(req, res);
      if (!saved) return;
      const designId = designImages.designOk(saved.fields.designId);
      if (!designId) {
        reclaimDesignImage(saved.img);
        return res.status(400).json({ error: 'bad designId' });
      }
      const photo = designImages.addPhoto(designId, saved.img, saved.fields.name);
      res.json({ ok: true, photo, gallery: designImages.getForDesign(designId) });
    }
  );

  // Admin: revert a base slot to its shipped render. JSON { designId, slot }.
  app.delete('/api/admin/design-images/base', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { designId, slot } = req.body || {};
    if (!designImages.designOk(designId) || !designImages.slotOk(slot)) {
      return res.status(400).json({ error: 'bad designId or slot' });
    }
    const { prev } = designImages.resetBaseImg(designId, slot);
    if (prev) reclaimDesignImage(prev);
    res.json({ ok: true, gallery: designImages.getForDesign(designId) });
  });

  // Admin: set a base slot's per-surface visibility. JSON { designId, slot,
  // onProducts?, onProduct? }.
  app.post('/api/admin/design-images/base/flags', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { designId, slot, onProducts, onProduct } = req.body || {};
    if (!designImages.designOk(designId) || !designImages.slotOk(slot)) {
      return res.status(400).json({ error: 'bad designId or slot' });
    }
    const flags = {};
    if (onProducts !== undefined) flags.onProducts = !!onProducts;
    if (onProduct !== undefined) flags.onProduct = !!onProduct;
    designImages.setBaseFlags(designId, slot, flags);
    res.json({ ok: true, gallery: designImages.getForDesign(designId) });
  });

  // Admin: patch an extra photo's name / visibility. JSON { designId, photoId,
  // name?, onProducts?, onProduct? }.
  app.post('/api/admin/design-images/photo/update', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { designId, photoId, name, onProducts, onProduct } = req.body || {};
    if (!designImages.designOk(designId)) {
      return res.status(400).json({ error: 'bad designId' });
    }
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (onProducts !== undefined) patch.onProducts = !!onProducts;
    if (onProduct !== undefined) patch.onProduct = !!onProduct;
    const photo = designImages.updatePhoto(designId, photoId, patch);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    res.json({ ok: true, photo, gallery: designImages.getForDesign(designId) });
  });

  // Admin: remove an extra photo. JSON { designId, photoId }. Reclaims its file.
  app.delete('/api/admin/design-images/photo', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { designId, photoId } = req.body || {};
    if (!designImages.designOk(designId)) {
      return res.status(400).json({ error: 'bad designId' });
    }
    const removed = designImages.removePhoto(designId, photoId);
    if (removed == null) return res.status(404).json({ error: 'photo not found' });
    reclaimDesignImage(removed);
    res.json({ ok: true, gallery: designImages.getForDesign(designId) });
  });

  // Admin: set the gallery display order. JSON { designId, order: [key,...] }
  // (keys = base slots + photo ids).
  app.post('/api/admin/design-images/order', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { designId, order } = req.body || {};
    if (!designImages.designOk(designId)) {
      return res.status(400).json({ error: 'bad designId' });
    }
    const next = designImages.setOrder(designId, order);
    if (next == null) return res.status(400).json({ error: 'order must be an array' });
    res.json({ ok: true, gallery: designImages.getForDesign(designId) });
  });

  return { saveGalleryUpload };
}

// The public new-game promo block (/api/promo).
function registerPromo(app, { settings, promo }) {
  // Public, UNAUTHENTICATED: the home-page "new game" block the owner edits in
  // admin-newgame.html. Same posture as /api/faq — a WHITELISTED projection, never
  // the raw stored object.
  //
  // The switch is enforced HERE, not only in the renderer: while the section is off
  // this answers `{ promo: null }` and nothing else. An unlaunched game's name,
  // copy and photos would otherwise sit in an unauthenticated response for anyone
  // who opened devtools, days before the owner meant to announce it — "off" has to
  // mean "not on the wire", not "not drawn".
  app.get('/api/promo', (req, res) => {
    res.json({ promo: promo.publicPromo(settings.get('promo', 'block')) });
  });
}

module.exports = {
  registerAdminDesigns,
  registerDesignCodes,
  registerTemplateOnboarding,
  registerTemplateAssets,
  registerTemplateRevert,
  registerStorefrontTemplates,
  registerPromoImageGallery,
  registerPromo,
  sanitizeSvgForDom,
};
