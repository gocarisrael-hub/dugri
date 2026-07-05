// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const validate = require(path.join(serverDir, 'validate.js'));

// --- validateOrderForProduction (pure) -----------------------------------
describe('validateOrderForProduction', () => {
  const englishCapsTheme = { name_form: 'english-caps', extra_fields: [] };
  const hebrewAgeTheme = { name_form: 'hebrew', extra_fields: ['AGE'] };

  it('flags a Hebrew name against an English theme (name language)', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'שירה' },
      englishCapsTheme,
      ['a']
    );
    expect(problems.length).toBe(1);
    // the expected language (English) is named in the problem
    expect(problems[0]).toContain('אנגלית');
  });

  it('flags a Latin name against a Hebrew theme (name language)', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'Shira', extra_fields: { AGE: '30' } },
      hebrewAgeTheme,
      ['a']
    );
    expect(problems.some((p) => p.includes('עברית'))).toBe(true);
  });

  it('flags a missing required extra field (AGE)', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'רון' }, // valid Hebrew name, but no AGE
      hebrewAgeTheme,
      ['a']
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('AGE');
  });

  it('reads a required extra field from order.extra_fields too', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'רון', order: { extra_fields: { AGE: '40' } } },
      hebrewAgeTheme,
      ['a']
    );
    expect(problems).toEqual([]);
  });

  it('treats a blank extra field as missing', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'רון', extra_fields: { AGE: '  ' } },
      hebrewAgeTheme,
      ['a']
    );
    expect(problems.some((p) => p.includes('AGE'))).toBe(true);
  });

  it('flags an order with no words', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'Shira' },
      englishCapsTheme,
      []
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('מיל'); // "מילים"
  });

  it('accepts a fully valid English order (no problems)', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'Shira' },
      englishCapsTheme,
      ['a', 'b']
    );
    expect(problems).toEqual([]);
  });

  it('accepts a fully valid Hebrew order with the required field (no problems)', () => {
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'רון בן שלמה', extra_fields: { AGE: '30' } },
      hebrewAgeTheme,
      ['a']
    );
    expect(problems).toEqual([]);
  });

  it('collects multiple problems at once', () => {
    // Latin name into a Hebrew+AGE theme, no AGE, no words -> 3 problems.
    const problems = validate.validateOrderForProduction(
      { honoree_name: 'Shira' },
      hebrewAgeTheme,
      []
    );
    expect(problems.length).toBe(3);
  });

  it('resolves a real theme key via getTheme', () => {
    const theme = validate.getTheme('trip comeback');
    expect(theme).toBeTruthy();
    expect(theme.name_form).toBe('english-caps');
    expect(validate.getTheme('no-such-theme')).toBe(null);
  });
});

// --- notify.buildProductionError (pure) ----------------------------------
describe('buildProductionError', () => {
  const notifyPath = path.join(serverDir, 'notify.js');
  function loadNotify() {
    delete require.cache[require.resolve(notifyPath)];
    return require(notifyPath);
  }

  it('lists every problem and names the honoree', () => {
    const notify = loadNotify();
    const problems = ['שם החוגג/ת צריך להיות באנגלית', 'חסר שדה חובה: גיל (AGE)'];
    const msg = notify.buildProductionError({ honoree_name: 'שירה' }, null, problems);
    expect(msg.subject).toContain('שירה');
    for (const p of problems) expect(msg.text).toContain(p);
  });

  it('includes the owner link when the tokens + baseUrl are present', () => {
    const notify = loadNotify();
    const msg = notify.buildProductionError(
      { honoree_name: 'שירה', id: 'col-1', owner_token: 'tok-1' },
      'https://dugri.example',
      ['בעיה']
    );
    expect(msg.text).toContain('https://dugri.example/collect.html?c=col-1&k=tok-1');
  });
});

// --- generate route: a bad order is blocked ------------------------------
describe('POST /generate — validation gate', () => {
  const ADMIN_KEY = 'test-admin-key';
  let app;
  let db;
  let server;
  let base;
  let genDir;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-prodval-'));
    genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-prodval-gen-'));
    process.env.GENERATED_DIR = genDir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';

    // A fake generator that WOULD write a PDF if it ran. The validation gate must
    // reject the bad order before this ever runs, so the file must NOT appear.
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-prodval-py-'));
    const fake = path.join(fakeDir, 'fake-generator.sh');
    fs.writeFileSync(
      fake,
      ['#!/bin/sh', 'printf "%%PDF-1.4 fake" > "$5"', 'echo "wrote $5 (3 pages)"', ''].join('\n'),
      { mode: 0o755 }
    );
    process.env.PYTHON = fake;

    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    db = require(path.join(serverDir, 'db.js'));
    app = require(path.join(serverDir, 'index.js'));

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
  });

  async function post(urlPath, body) {
    const res = await fetch(base + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const key = (p) => p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY;

  it('400s, records an error production status, and does NOT generate', async () => {
    // Hebrew honoree name into an english-caps theme -> a name-language problem.
    const c = db.createCollection('שירה');
    db.addWords(c.id, ['מים', 'אש']);

    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation failed');
    expect(Array.isArray(r.body.problems)).toBe(true);
    expect(r.body.problems.length).toBeGreaterThan(0);
    expect(r.body.production.state).toBe('error');

    // the error state is persisted on the collection
    expect(db.getCollection(c.id).production.state).toBe('error');
    expect(db.getCollection(c.id).production.errors.length).toBeGreaterThan(0);

    // crucially: the generator never ran, so no PDF was written
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(false);
  });

  it('generates normally for a valid order (control)', async () => {
    const c = db.createCollection('Shira');
    db.addWords(c.id, ['מים', 'אש']);
    const r = await post(key('/api/admin/collections/' + c.id + '/generate'), {
      theme: 'trip comeback',
    });
    expect(r.status).toBe(200);
    expect(r.body.production.state).toBe('generated');
    expect(fs.existsSync(path.join(genDir, c.id + '.pdf'))).toBe(true);
  });
});
