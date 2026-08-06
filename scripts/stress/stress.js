#!/usr/bin/env node
//
//  Dugri PDF-production stress harness
//  ===================================
//
//  Drives the REAL admin HTTP API of a running deployment (staging by default)
//  the way the owner's browser drives it — create an order, load it with words,
//  press "produce", then DOWNLOAD the file and prove it is a complete PDF — and
//  varies every axis a single hand-run smoke test cannot:
//
//    theme         all templates the target actually serves (read live from
//                  /api/admin/templates, so an owner-uploaded template is
//                  covered without touching this file)
//    word count    from the 70-word minimum, through the real 109/224/416 lists,
//                  to well past anything ordered
//    word content  short Hebrew, wrapping phrases, unbreakable 80-char tokens,
//                  Latin, Hebrew+Latin+digit mixes, punctuation, HTML-injection
//    variants      chasers add-on, custom titles, theme extra fields, word-font
//                  override, the separately-produced board, the press build
//    load          N concurrent generations, and generation racing previews
//                  (both spawn Chrome; one render was measured at ~113 PIDs
//                  against a 1000-PID cgroup ceiling)
//
//  Every run records: HTTP status, response body, wall time, generator page
//  count, downloaded byte size, a STRUCTURAL PDF verdict (header + %%EOF +
//  startxref — "present" is not "valid": the generator prints Chrome's output
//  straight to the final path, so a killed render leaves a truncated file
//  exactly where a successful one would), and container memory + PID peaks
//  sampled inside the container while it ran.
//
//  USAGE
//    node scripts/stress/stress.js --base <url> --key <admin key> [options]
//
//    --suite <a,b,...>   catalog | matrix | glyphs | extremes | variants |
//                        press | concurrency | preview-race
//                        (default: everything except press, which is slow)
//                        `catalog` alone is a one-second audit that needs no
//                        rendering: it flags every design that is ON SALE while
//                        uncalibrated, i.e. unproducible.
//    --themes <a,b>      restrict to these theme keys (default: every public one)
//    --counts <n,n>      word counts for the matrix suite (default 70,224,416)
//    --profiles <a,b>    word profiles (see scripts/stress/words.js)
//    --concurrency <n,n> concurrency levels to ramp (default 2,4,6,8)
//    --out <dir>         where results land (default ./stress-results/<stamp>)
//    --seed <n>          PRNG seed, so any red run replays exactly
//    --no-probe          skip the in-container memory/PID sampler
//    --railway-project <id>  project id for the sampler (a git worktree is not
//                        the linked checkout, so the CLI cannot infer it)
//    --keep              do not delete the collections the run created
//    --repeat <n>        run the whole selection n times (flaky-hunting)
//
//  EXIT CODE is non-zero when any case failed, so CI can gate on it.

import fs from 'node:fs';
import path from 'node:path';
import { Api } from './api.js';
import { buildWords, PROFILE_NAMES } from './words.js';
import { checkPdf, checkPressPdf } from './pdfcheck.js';
import { Probe } from './probe.js';

// --- argument parsing --------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true;
      else {
        a[key] = next;
        i += 1;
      }
    } else a._.push(t);
  }
  return a;
}
const list = (v, dflt) =>
  v == null || v === true
    ? dflt
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const nums = (v, dflt) => (v == null || v === true ? dflt : list(v, []).map(Number));

const args = parseArgs(process.argv.slice(2));
const BASE = args.base || process.env.STRESS_BASE || 'https://dugri-staging.up.railway.app';
const KEY = args.key || process.env.STRESS_ADMIN_KEY || process.env.SMOKE_ADMIN_KEY;
const SEED = Number(args.seed || 42);
const REPEAT = Number(args.repeat || 1);
const OUT =
  args.out ||
  path.join(process.cwd(), 'stress-results', new Date().toISOString().replace(/[:.]/g, '-'));
const KEEP = !!args.keep;
const PROBE_ON = !args['no-probe'];
const RAILWAY_ENV = args['railway-env'] || 'staging';
const RAILWAY_SERVICE = args['railway-service'] || 'dugri';
const RAILWAY_PROJECT = args['railway-project'] || process.env.RAILWAY_PROJECT_ID || null;

if (!KEY) {
  console.error('need --key <ADMIN_KEY> (or STRESS_ADMIN_KEY in the environment)');
  process.exit(2);
}

const api = new Api({ base: BASE, key: KEY });
const probe = new Probe({
  environment: RAILWAY_ENV,
  service: RAILWAY_SERVICE,
  project: RAILWAY_PROJECT,
  enabled: PROBE_ON,
});

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'pdf'), { recursive: true });
const jsonl = fs.createWriteStream(path.join(OUT, 'runs.jsonl'), { flags: 'a' });

const RESULTS = [];
const CREATED = new Set();

function log(...m) {
  process.stdout.write(m.join(' ') + '\n');
}

function record(row) {
  RESULTS.push(row);
  jsonl.write(JSON.stringify(row) + '\n');
  const verdict = row.pass ? 'PASS' : 'FAIL';
  log(
    `  ${verdict.padEnd(4)} ${row.case}` +
      ` | http ${row.status}` +
      ` | ${row.ms == null ? '-' : (row.ms / 1000).toFixed(1) + 's'}` +
      ` | pages ${row.pages ?? '-'}` +
      ` | ${row.bytes == null ? '-' : (row.bytes / 1048576).toFixed(2) + 'MB'}` +
      (row.peakPids ? ` | pids ${row.peakPids} mem ${row.peakMemMb}MB` : '') +
      (row.pass ? '' : ` | ${String(row.reason || '').slice(0, 220)}`)
  );
}

// --- theme metadata ----------------------------------------------------------
// Read LIVE from the target, never from the repo's themes.json: staging carries
// owner-uploaded templates (their config lives in the data volume) that the repo
// copy does not know about, and those are exactly the templates least likely to
// have been exercised.
async function loadThemes() {
  const r = await api.templates();
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.templates)) {
    throw new Error(
      `could not list templates: HTTP ${r.status} ${r.text || JSON.stringify(r.json)}`
    );
  }
  return r.json.templates.map((t) => ({
    key: t.key,
    label: t.display_he,
    nameForm: t.name_form || null,
    extraFields: Array.isArray(t.extra_fields) ? t.extra_fields : [],
    visibility: t.visibility,
    inStore: t.in_store !== false,
    calibrated: !!t.calibrated,
  }));
}

// The cheapest check in the file, and the one that found the outage: a design
// can be ON SALE and UNPRODUCIBLE at the same time.
//
// `calibrated` and "sellable" are independent flags. The generator hard-refuses
// an uncalibrated theme (config.ensure_calibrated) before Chrome even starts, so
// every order for such a design dies at production with a raw Python traceback —
// after the customer has paid and sent their words. Nothing in the storefront,
// the wizard or the admin blocks the sale, and several ordinary admin actions
// (switching card_structure, changing the front/back mode) deliberately reset
// calibrated to false on a design that was working yesterday.
//
// This runs in about a second and needs no rendering at all, so it belongs at
// the FRONT of any run — and is worth running on its own after any template
// edit.
async function suiteCatalog(themes) {
  log('\n== suite: catalog (is everything on sale actually producible?) ==');
  for (const theme of themes) {
    const sellable = theme.inStore && (theme.visibility || 'public') === 'public';
    const row = {
      case: `catalog-${theme.key}`.replace(/\s+/g, '_'),
      suite: 'catalog',
      theme: theme.key,
      themeLabel: theme.label,
      at: new Date().toISOString(),
      status: 200,
      sellable,
      calibrated: theme.calibrated,
      pass: !sellable || theme.calibrated,
      reason:
        sellable && !theme.calibrated
          ? 'ON SALE but calibrated:false — every order for this design fails at production'
          : null,
    };
    record(row);
  }
}

// A honoree name in the script the theme demands — a mismatch is refused by
// validateOrderForProduction before Chrome ever runs, which would make the whole
// row a test of the validator instead of the generator.
function nameFor(theme) {
  if (theme.nameForm === 'hebrew') return 'מיכל';
  if (theme.nameForm === 'english-caps') return 'MICHAL';
  return 'Michal';
}

// Values for whatever extra fields the theme requires (AGE / YEARS+NAME1+NAME2).
function extrasFor(theme) {
  const out = {};
  for (const f of theme.extraFields) {
    if (f === 'AGE') out.AGE = '30';
    else if (f === 'YEARS') out.YEARS = '10';
    else if (f === 'NAME1') out.NAME1 = theme.nameForm === 'hebrew' ? 'דנה' : 'Dana';
    else if (f === 'NAME2') out.NAME2 = theme.nameForm === 'hebrew' ? 'יוסי' : 'Yossi';
    else out[f] = '1';
  }
  return out;
}

// --- collection pool ---------------------------------------------------------
// Collections are EXPENSIVE side effects (each creation fires the owner's
// "new order" emails), so one collection is built per distinct word list and
// then re-pointed at each theme with an admin PATCH. That is also closer to
// reality than a fresh order per render: the owner re-generates the SAME order
// onto a different template all the time.
const pool = new Map();

async function collectionFor(profile, count, seed) {
  const sig = `${profile}:${count}:${seed}`;
  if (pool.has(sig)) return pool.get(sig);

  const created = await api.createCollection({
    honoree_name: 'Michal',
    // No email: the buyer copy of every notification is then skipped, and the
    // owner's staging inbox only ever sees the one creation alert.
    design: 'stress',
    color: 'stress',
  });
  if (created.status !== 201 || !created.json) {
    throw new Error(
      `create collection failed: HTTP ${created.status} ${created.text || JSON.stringify(created.json)}`
    );
  }
  const id = created.json.id;
  CREATED.add(id);

  // Lift the free-word quota for THIS collection before loading it: unpaid
  // collections are capped (20 words by default) and a capped collection would
  // silently make every "416-word" case a 20-word case.
  const lifted = await api.patchCollection(id, { free_limit_applies: false });
  if (lifted.status !== 200) {
    throw new Error(`could not lift free quota on ${id}: HTTP ${lifted.status}`);
  }

  const words = buildWords(profile, count, seed);
  let added = 0;
  // The add route caps a single request at 500 words.
  for (let i = 0; i < words.length; i += 400) {
    const chunk = words.slice(i, i + 400);
    const r = await api.addWords(id, chunk);
    if (r.status !== 200) {
      throw new Error(
        `addWords failed on ${id}: HTTP ${r.status} ${r.text || JSON.stringify(r.json)}`
      );
    }
    added += r.json.added;
    if (r.json.blocked) throw new Error(`quota still blocking on ${id}: ${r.json.blocked} blocked`);
  }
  if (added !== count) {
    throw new Error(`wanted ${count} words on ${id}, server stored ${added} (profile ${profile})`);
  }
  const entry = { id, profile, count, seed };
  pool.set(sig, entry);
  log(`  · collection ${id} = ${count} × ${profile}`);
  return entry;
}

// --- one production run ------------------------------------------------------
// The whole point of the harness: generate, then IMMEDIATELY download and
// validate — the owner's exact flow, and the only sequence that can catch a
// truncated file sitting at a path that "exists".
async function runCase(
  caseName,
  { collection, theme, body = {}, patch = null, expectBoard = null, saveAs = null }
) {
  const row = {
    case: caseName,
    theme: theme.key,
    themeLabel: theme.label,
    profile: collection.profile,
    words: collection.count,
    collection: collection.id,
    at: new Date().toISOString(),
    pass: false,
  };
  const t0 = Date.now();
  try {
    // Point the collection at this theme: name in the right script, the theme's
    // required extra fields, and whatever the variant is toggling.
    const patchBody = {
      honoree_name: nameFor(theme),
      extra_fields: extrasFor(theme),
      chasers: false,
      custom_title: '',
      ...(patch || {}),
    };
    const p = await api.patchCollection(collection.id, patchBody);
    if (p.status !== 200) {
      row.status = p.status;
      row.reason = `PATCH failed: ${p.text || JSON.stringify(p.json)}`;
      row.ms = Date.now() - t0;
      record(row);
      return row;
    }

    const genStart = Date.now();
    const gen = await api.generate(collection.id, { theme: theme.key, ...body });
    row.ms = Date.now() - genStart;
    row.status = gen.status;
    row.body = gen.json || gen.text || gen.error || null;

    if (gen.status !== 200) {
      row.reason =
        gen.error ||
        (gen.json &&
          (gen.json.detail || gen.json.error || JSON.stringify(gen.json).slice(0, 400))) ||
        gen.text ||
        `HTTP ${gen.status}`;
      Object.assign(row, probe.window(genStart, Date.now()));
      record(row);
      return row;
    }
    row.pages = (gen.json && gen.json.production && gen.json.production.pages) ?? null;
    row.boardRecorded = !!(gen.json && gen.json.production && gen.json.production.board_file);
    Object.assign(row, probe.window(genStart, Date.now()));

    // DOWNLOAD — generate-then-immediately-download is the owner's real flow, and
    // it is the only step that proves the file left the container intact.
    const dl = await api.downloadPdf(collection.id);
    row.downloadStatus = dl.status;
    row.downloadMs = dl.ms;
    if (dl.status !== 200) {
      row.reason = `download HTTP ${dl.status}` + (dl.error ? ` (${dl.error})` : '');
      record(row);
      return row;
    }
    row.bytes = dl.buf.length;
    row.contentType = dl.contentType;
    const v = checkPdf(dl.buf);
    row.pdf = v;
    if (!v.ok) {
      row.reason = 'invalid PDF: ' + v.reason;
      if (saveAs !== false) fs.writeFileSync(path.join(OUT, 'pdf', `BAD-${caseName}.pdf`), dl.buf);
      record(row);
      return row;
    }
    row.pdfPages = v.pages;
    // The generator's own page count and the file's must agree. A disagreement
    // means pages were lost between rendering and writing — silent corruption,
    // the worst kind.
    if (row.pages != null && v.pages != null && v.pages !== row.pages) {
      row.reason = `page-count mismatch: generator said ${row.pages}, file has ${v.pages}`;
      fs.writeFileSync(path.join(OUT, 'pdf', `MISMATCH-${caseName}.pdf`), dl.buf);
      record(row);
      return row;
    }

    // The board is a SECOND artifact for v2 templates. When the generation
    // recorded one, it must download and be a valid file too.
    if (row.boardRecorded || expectBoard) {
      const b = await api.downloadBoard(collection.id);
      row.boardStatus = b.status;
      if (b.status !== 200) {
        row.reason = `board download HTTP ${b.status}`;
        record(row);
        return row;
      }
      row.boardBytes = b.buf.length;
      // The board can legitimately be a PNG or an SVG, so only validate the PDF
      // form structurally; any board must at least be non-trivially sized.
      if (b.buf.subarray(0, 5).toString('latin1') === '%PDF-') {
        const bv = checkPdf(b.buf);
        row.boardPdf = bv;
        if (!bv.ok) {
          row.reason = 'invalid board PDF: ' + bv.reason;
          record(row);
          return row;
        }
      } else if (b.buf.length < 1024) {
        row.reason = `board is only ${b.buf.length} bytes`;
        record(row);
        return row;
      }
    }

    row.pass = true;
    record(row);
    return row;
  } catch (e) {
    row.reason = 'harness error: ' + String((e && e.message) || e);
    row.ms = Date.now() - t0;
    record(row);
    return row;
  }
}

// --- suites ------------------------------------------------------------------

// The core results table: every theme × a sweep of realistic word counts.
async function suiteMatrix(themes, opts) {
  log('\n== suite: matrix (theme × word count) ==');
  const counts = nums(args.counts, [70, 224, 416]);
  const profile = list(args.profiles, ['realistic'])[0];
  for (const count of counts) {
    const c = await collectionFor(profile, count, opts.seed);
    for (const theme of themes) {
      await runCase(`matrix-${theme.key}-${count}`.replace(/\s+/g, '_'), { collection: c, theme });
    }
  }
}

// Word CONTENT, held at one count so the only variable is which glyphs are on
// the cards.
async function suiteGlyphs(themes, opts) {
  log('\n== suite: glyphs (word content) ==');
  const profiles = list(args.profiles, PROFILE_NAMES);
  const count = Number(args['glyph-count'] || 224);
  for (const profile of profiles) {
    const c = await collectionFor(profile, count, opts.seed);
    for (const theme of themes) {
      await runCase(`glyph-${profile}-${theme.key}`.replace(/\s+/g, '_'), { collection: c, theme });
    }
  }
}

// Past the edges: the smallest producible deck, and lists far larger than any
// she has sold.
async function suiteExtremes(themes, opts) {
  log('\n== suite: extremes (deck size) ==');
  const counts = nums(args['extreme-counts'], [1, 2, 33, 800, 1600]);
  for (const count of counts) {
    const c = await collectionFor('realistic', count, opts.seed);
    for (const theme of themes) {
      await runCase(`extreme-${theme.key}-${count}`.replace(/\s+/g, '_'), { collection: c, theme });
    }
  }
}

// The rest of the real production surface: the add-ons and overrides a live
// order actually carries.
async function suiteVariants(themes, opts) {
  log('\n== suite: variants (chasers / titles / fonts) ==');
  const c = await collectionFor('realistic', Number(args['variant-count'] || 224), opts.seed);
  for (const theme of themes) {
    const k = theme.key.replace(/\s+/g, '_');
    await runCase(`chasers-${k}`, { collection: c, theme, patch: { chasers: true } });
    // A title starting with '-' is the argparse trap the generator guards
    // against with --title=<value>; a 120-char multi-line title is the cap.
    await runCase(`title-dash-${k}`, { collection: c, theme, patch: { custom_title: '-40 מיכל' } });
    await runCase(`title-long-${k}`, {
      collection: c,
      theme,
      patch: { custom_title: 'שורה ראשונה ארוכה מאוד מאוד מאוד\nשורה שנייה ארוכה גם היא מאוד' },
    });
    // An order whose theme requires extras but has NONE, with no custom title:
    // must be REFUSED cleanly (400 with problems), never generated half-blank.
    if (theme.extraFields.length) {
      const r = await runCase(`missing-extras-${k}`, {
        collection: c,
        theme,
        patch: { extra_fields: {}, custom_title: '' },
      });
      // Invert the verdict: a clean 400 is the CORRECT outcome here.
      if (!r.pass && r.status === 400) {
        r.pass = true;
        r.expectedFailure = true;
        r.reason = 'correctly refused (' + String(r.reason).slice(0, 120) + ')';
      } else if (r.pass) {
        r.pass = false;
        r.reason = 'generated an order that is missing its required extra fields';
      }
    }
  }
}

// The בית דפוס copy: a full re-render plus a Ghostscript CMYK/flatten pass,
// running as a BACKGROUND job whose whole state is three files on the volume.
// Nobody has ever tested this path, and it is named in the owner's complaint.
async function suitePress(themes, opts) {
  log('\n== suite: press (בית דפוס) ==');
  const count = Number(args['press-count'] || 224);
  const c = await collectionFor('realistic', count, opts.seed);
  const timeout = Number(args['press-timeout'] || 960000);
  for (const theme of themes) {
    const row = {
      case: `press-${theme.key}`.replace(/\s+/g, '_'),
      theme: theme.key,
      themeLabel: theme.label,
      profile: c.profile,
      words: c.count,
      collection: c.id,
      at: new Date().toISOString(),
      pass: false,
      suite: 'press',
    };
    const t0 = Date.now();
    await api.patchCollection(c.id, {
      honoree_name: nameFor(theme),
      extra_fields: extrasFor(theme),
      custom_title: '',
    });
    const start = await api.startPress(c.id, { theme: theme.key });
    row.status = start.status;
    if (start.status !== 202) {
      row.reason = `start HTTP ${start.status}: ${start.text || JSON.stringify(start.json)}`;
      row.ms = Date.now() - t0;
      record(row);
      continue;
    }
    // Poll to completion. 202 = still building, 409 = failed with detail,
    // 200 = the finished PDF streamed back.
    let done = null;
    let polls = 0;
    while (Date.now() - t0 < timeout) {
      await new Promise((r) => setTimeout(r, 5000));
      polls += 1;
      const s = await api.pressGet(c.id);
      if (s.status === 202) continue;
      done = s;
      break;
    }
    row.polls = polls;
    row.ms = Date.now() - t0;
    Object.assign(row, probe.window(t0, Date.now()));
    if (!done) {
      row.reason = `press never finished within ${Math.round(timeout / 1000)}s`;
      record(row);
      continue;
    }
    row.status = done.status;
    if (done.status !== 200) {
      row.reason =
        (done.json && (done.json.detail || done.json.error)) || done.text || `HTTP ${done.status}`;
      record(row);
      continue;
    }
    row.bytes = done.buf.length;
    // NOT checkPdf: a structurally perfect PDF is the easy half. The press copy
    // has to be CMYK against a named ICC condition with a TrimBox stating where
    // to cut — and the ONE artifact that satisfies "structurally valid PDF at
    // the press path" while being none of those is the intermediate RGB deck,
    // which is what a poll answered too early actually returns.
    const v = checkPressPdf(done.buf);
    row.pdf = v;
    row.pdfPages = v.pages;
    if (!v.ok) {
      row.reason = 'invalid press PDF: ' + v.reason;
      fs.writeFileSync(path.join(OUT, 'pdf', `BAD-${row.case}.pdf`), done.buf);
      record(row);
      continue;
    }
    row.pass = true;
    record(row);
  }
}

// N generations at once. One render was measured at ~113 PIDs against a 1000-PID
// cgroup ceiling, so this is where a box that renders one deck perfectly starts
// dropping real orders.
async function suiteConcurrency(themes, opts) {
  log('\n== suite: concurrency ==');
  const levels = nums(args.concurrency, [2, 4, 6, 8]);
  const count = Number(args['conc-count'] || 224);
  const maxLevel = Math.max(...levels);
  // Distinct collections: two generations of the SAME order write the same
  // output path, which would confound a resource failure with a self-collision.
  const cols = [];
  for (let i = 0; i < maxLevel; i += 1)
    cols.push(await collectionFor('realistic', count, opts.seed + i));
  for (const level of levels) {
    log(`  -- ${level} concurrent --`);
    const t0 = Date.now();
    const jobs = [];
    for (let i = 0; i < level; i += 1) {
      const theme = themes[i % themes.length];
      jobs.push(
        runCase(`conc${level}-${i}-${theme.key}`.replace(/\s+/g, '_'), {
          collection: cols[i],
          theme,
        })
      );
    }
    const rows = await Promise.all(jobs);
    const failed = rows.filter((r) => !r.pass).length;
    const w = probe.window(t0, Date.now());
    log(
      `  -- level ${level}: ${rows.length - failed}/${rows.length} passed,` +
        ` wall ${((Date.now() - t0) / 1000).toFixed(1)}s, peak pids ${w.peakPids ?? '?'}, peak mem ${w.peakMemMb ?? '?'}MB --`
    );
    // Let the box settle so the next level starts from a clean baseline rather
    // than inheriting the previous level's teardown.
    await new Promise((r) => setTimeout(r, 8000));
  }
}

// Generation racing PREVIEWS. Previews spawn Chrome too, are public and
// unauthenticated, and are exactly what is running while the owner produces an
// order — a buyer on the site picking a design. This is the most realistic
// contention the box ever sees.
async function suitePreviewRace(themes, opts) {
  log('\n== suite: preview race ==');
  const count = Number(args['race-count'] || 416);
  const c = await collectionFor('realistic', count, opts.seed);
  const previewers = Number(args['race-previews'] || 6);
  const theme = themes[0];
  let stop = false;
  const previewRows = [];
  // A steady stream of previews with UNIQUE names so the preview cache can never
  // serve them without spawning Chrome.
  const flood = async (i) => {
    let n = 0;
    while (!stop) {
      const t = themes[(i + n) % themes.length];
      const r = await api.preview({
        theme: t.key,
        name: nameFor(t) + (t.nameForm === 'hebrew' ? 'ה' : 'x').repeat((n % 5) + 1),
        extra_fields: extrasFor(t),
      });
      previewRows.push({
        status: r.status,
        ms: r.ms,
        theme: t.key,
        error: r.error || (r.json && r.json.detail) || null,
      });
      n += 1;
    }
  };
  const floods = Array.from({ length: previewers }, (_, i) => flood(i));
  await new Promise((r) => setTimeout(r, 4000)); // let the previews get going
  const t0 = Date.now();
  const row = await runCase(`race-${theme.key}`.replace(/\s+/g, '_'), { collection: c, theme });
  stop = true;
  await Promise.all(floods);
  const bad = previewRows.filter((p) => p.status !== 200 && p.status !== 429);
  log(
    `  -- previews: ${previewRows.length} issued, ${previewRows.filter((p) => p.status === 200).length} ok,` +
      ` ${previewRows.filter((p) => p.status === 429).length} rate-limited, ${bad.length} FAILED --`
  );
  record({
    case: 'preview-race-previews',
    theme: 'mixed',
    suite: 'preview-race',
    at: new Date().toISOString(),
    status: bad.length ? bad[0].status : 200,
    ms: Date.now() - t0,
    pass: bad.length === 0 && row.pass,
    previewTotal: previewRows.length,
    previewFailed: bad.length,
    previewSample: bad.slice(0, 5),
    ...probe.window(t0, Date.now()),
    reason: bad.length
      ? `${bad.length} previews failed while a deck was generating: ${JSON.stringify(bad.slice(0, 3))}`
      : null,
  });
}

const SUITES = {
  catalog: suiteCatalog,
  matrix: suiteMatrix,
  glyphs: suiteGlyphs,
  extremes: suiteExtremes,
  variants: suiteVariants,
  press: suitePress,
  concurrency: suiteConcurrency,
  'preview-race': suitePreviewRace,
};

// --- report ------------------------------------------------------------------
function writeReport() {
  const pass = RESULTS.filter((r) => r.pass).length;
  const fail = RESULTS.length - pass;
  const lines = [];
  lines.push(`# Dugri production stress run`);
  lines.push('');
  lines.push(`- target: ${BASE}`);
  lines.push(`- started: ${RESULTS[0] ? RESULTS[0].at : '-'}`);
  lines.push(`- cases: ${RESULTS.length} — **${pass} pass, ${fail} fail**`);
  lines.push('');
  lines.push(
    '| case | theme | words | profile | http | secs | pages | size | peak PIDs | peak MB | verdict |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of RESULTS) {
    lines.push(
      `| ${r.case} | ${r.themeLabel || r.theme || '-'} | ${r.words ?? '-'} | ${r.profile || '-'} | ${r.status ?? '-'}` +
        ` | ${r.ms == null ? '-' : (r.ms / 1000).toFixed(1)} | ${r.pages ?? '-'}` +
        ` | ${r.bytes == null ? '-' : (r.bytes / 1048576).toFixed(2) + 'MB'}` +
        ` | ${r.peakPids ?? '-'} | ${r.peakMemMb ?? '-'}` +
        ` | ${
          r.pass
            ? 'pass'
            : 'FAIL — ' +
              String(r.reason || '')
                .replace(/\|/g, '/')
                .slice(0, 200)
        } |`
    );
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
  log(`\nreport: ${path.join(OUT, 'report.md')}`);
}

// --- main --------------------------------------------------------------------
async function main() {
  log(`target: ${BASE}`);
  log(`output: ${OUT}`);
  const all = await loadThemes();
  const want = list(args.themes, null);
  const themes = want ? all.filter((t) => want.includes(t.key)) : all;
  if (!themes.length) throw new Error('no themes selected');
  log(`themes (${themes.length}): ${themes.map((t) => t.key).join(', ')}`);

  probe.start();
  await new Promise((r) => setTimeout(r, 3000)); // let the sampler connect
  if (probe.enabled && !probe.samples.length && probe.error) {
    log(`  (probe unavailable: ${probe.error} — running without memory/PID sampling)`);
  }

  const suites = list(args.suite, [
    'catalog',
    'matrix',
    'glyphs',
    'extremes',
    'variants',
    'concurrency',
    'preview-race',
  ]);
  try {
    for (let rep = 0; rep < REPEAT; rep += 1) {
      for (const s of suites) {
        const fn = SUITES[s];
        if (!fn) throw new Error(`unknown suite: ${s} (have: ${Object.keys(SUITES).join(', ')})`);
        await fn(themes, { seed: SEED + rep * 1000 });
      }
    }
  } finally {
    probe.stop();
    if (!KEEP) {
      for (const id of CREATED) await api.deleteCollection(id);
      log(`cleaned up ${CREATED.size} collections`);
    } else {
      log(`kept ${CREATED.size} collections: ${[...CREATED].join(' ')}`);
    }
    writeReport();
    jsonl.end();
  }
  const fail = RESULTS.filter((r) => !r.pass).length;
  log(`\n${RESULTS.length - fail}/${RESULTS.length} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nharness aborted:', (e && e.stack) || e);
  probe.stop();
  writeReport();
  process.exit(3);
});
