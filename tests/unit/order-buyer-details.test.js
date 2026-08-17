// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// WHO IS ORDERING, AND WHAT THE PARTY IS. The owner asked for both beside the
// email and the phone, in her own list: "add for the mail+phone stage also:
// 1. full name (free text - short) 2. type event (free text - short)
// 3. comments (free text - possible long)."
//
// The third one shipped first (see order-comment.test.js). These are the other
// two, and they are built the same way: stored on the collection, sanitized and
// capped on the way in, editable in admin, and in the owner's order email.
//
// THE NAME IS THE BUYER'S, NOT THE HONOREE'S — that is the whole reason it needs
// a field of its own. The wizard has asked for a honoree name since day one and
// prints it on the cards; this is the person paying, and she is buying the game
// FOR somebody else. Anything that conflated the two would look like it worked
// right up until the owner greeted the wrong person on WhatsApp, so the tests
// below keep asserting that the two fields stay apart end to end.
//
// THE NAME IS REQUIRED IN THE WIZARD AND OPTIONAL ON THIS ROUTE, deliberately.
// The owner made it mandatory to type ("make it must to write"), and the gate for
// that lives on the last wizard step, where it can name the missing thing and put
// the cursor in the box (tests/e2e/order-buyer-details.spec.js). The ROUTE stays
// lenient on purpose, for three reasons that all point the same way:
//   • hundreds of orders were taken before the rule existed. A required field
//     here does not fix them, it only makes the admin PATCH that touches one of
//     them — a phone number correction, a status change — fail on a field the
//     owner never asked about.
//   • the admin edit dialog posts every box it holds, buyer_name included, so a
//     400 on an empty one would break correcting a legacy order.
//   • a 400 at POST /api/collections is the wizard's dead end: it lands on the
//     screen after the buyer pressed "צרו את המשחק", where the only thing the
//     page can say is "משהו השתבש". A rule she can still satisfy has to be
//     enforced where she can still see the box.
// So an order without a name is still a complete order as far as storage is
// concerned, and the tests below keep saying so. The event type is optional on
// both sides — it is the nice-to-have of the two.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let notify;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-buyer-details-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  app = require(path.join(serverDir, 'index.js'));
  db = require(path.join(serverDir, 'db.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  await new Promise((res) => {
    server = app.listen(0, res);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((res) => server.close(res));
});

// Orders exactly as the wizard posts them: the honoree name is always there (it
// is required), and the two new answers ride alongside it.
async function createOrder(fields) {
  const r = await fetch(base + '/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      honoree_name: 'שירה',
      email: 'buyer@example.com',
      design: 'פריז',
      ...fields,
    }),
  });
  expect(r.status).toBe(201);
  return r.json();
}

describe('the buyer’s own name, on the order she is paying for', () => {
  it('is stored exactly as she typed it', async () => {
    const { id } = await createOrder({ buyer_name: 'דנה כהן' });
    expect(db.getCollection(id).buyer_name).toBe('דנה כהן');
  });

  it('is NOT the honoree name — the two live side by side, untouched', async () => {
    // The single most important thing about this field. She is ordering a game
    // about שירה; her own name is דנה. Nothing may quietly write one over the
    // other, and the name that gets PRINTED must stay the honoree's.
    const { id } = await createOrder({ buyer_name: 'דנה כהן' });
    const c = db.getCollection(id);
    expect(c.honoree_name).toBe('שירה');
    expect(c.buyer_name).toBe('דנה כהן');
  });

  it('is absent, not blank, on an order that arrived without one', async () => {
    // The route does not refuse a nameless order — see the note at the top of the
    // file — and "no name" is stored as null rather than as an empty string, so
    // every reader (admin, the email) has one thing to test for. Whitespace is
    // the same as nothing, which is also why the wizard's own gate tests the
    // TRIMMED value rather than the box's length.
    expect(db.getCollection((await createOrder({})).id).buyer_name).toBeNull();
    expect(db.getCollection((await createOrder({ buyer_name: '' })).id).buyer_name).toBeNull();
    expect(db.getCollection((await createOrder({ buyer_name: '   ' })).id).buyer_name).toBeNull();
  });

  it('an order taken before the rule existed is still editable in admin', async () => {
    // The reason the route stays lenient, as a test. An old order has no
    // buyer_name; the owner opens it to fix something else entirely and the
    // dialog posts every box it holds, the empty name included. That PATCH has to
    // succeed — a required field here would lock her out of her own back office
    // for the whole history of orders that predate the wizard's gate.
    const { id } = await createOrder({});
    expect(db.getCollection(id).buyer_name).toBeNull();
    const edited = await fetch(
      base + '/api/admin/collections/' + id + '?key=' + encodeURIComponent(ADMIN_KEY),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyer_name: '', event_type: 'פרישה' }),
      }
    );
    expect(edited.status).toBe(200);
    const c = db.getCollection(id);
    expect(c.buyer_name).toBeNull();
    expect(c.event_type).toBe('פרישה');
  });

  it('lands as ONE line however she pasted it', async () => {
    // Names get pasted out of WhatsApp, contact cards and autofill, and they
    // arrive with newlines and double spaces in them. This is a single-line
    // answer, so it is stored as one: an admin table row must not come apart
    // because somebody copied a signature block.
    const { id } = await createOrder({ buyer_name: '  דנה\n  כהן  ' });
    expect(db.getCollection(id).buyer_name).toBe('דנה כהן');
  });

  it('caps a runaway paste instead of storing it whole', async () => {
    const { id } = await createOrder({ buyer_name: 'א'.repeat(400) });
    expect(db.getCollection(id).buyer_name.length).toBe(80);
  });

  it('never bisects an emoji at the cap', async () => {
    const { id } = await createOrder({ buyer_name: '🎉'.repeat(200) });
    const stored = db.getCollection(id).buyer_name;
    expect(Array.from(stored).length).toBe(80);
    expect(stored).not.toMatch(/[\uD800-\uDBFF]$/); // no lone surrogate
  });
});

describe('the event, in the buyer’s own words', () => {
  it('is stored exactly as she typed it', async () => {
    const { id } = await createOrder({ event_type: 'בת מצווה של אחותי' });
    expect(db.getCollection(id).event_type).toBe('בת מצווה של אחותי');
  });

  it('is free text, not the design she picked', async () => {
    // A design hints at an occasion, but it is a picture she liked — the two
    // disagree often enough that the owner asked to be TOLD. So "פרישה" is stored
    // on an order whose design is פריז, with no attempt to reconcile them.
    const { id } = await createOrder({ design: 'פריז', event_type: 'פרישה' });
    const c = db.getCollection(id);
    expect(c.design).toBe('פריז');
    expect(c.event_type).toBe('פרישה');
  });

  it('is absent, not blank, on an order that skipped it', async () => {
    expect(db.getCollection((await createOrder({})).id).event_type).toBeNull();
    expect(db.getCollection((await createOrder({ event_type: '  ' })).id).event_type).toBeNull();
  });

  it('lands as ONE line, and is capped like the name', async () => {
    const { id } = await createOrder({ event_type: 'יום נישואין\n25' });
    expect(db.getCollection(id).event_type).toBe('יום נישואין 25');
    const long = await createOrder({ event_type: 'ב'.repeat(400) });
    expect(db.getCollection(long.id).event_type.length).toBe(80);
  });
});

describe('both answers travel with the order', () => {
  it('reaches the admin order and can be corrected there', async () => {
    // Most orders finish on WhatsApp, so the owner needs to be able to write down
    // what she was told in the same boxes the buyer typed into.
    const { id } = await createOrder({ buyer_name: 'דנה', event_type: 'יום הולדת' });
    const listed = await fetch(
      base + '/api/admin/collections?key=' + encodeURIComponent(ADMIN_KEY)
    );
    const row = (await listed.json()).collections.find((x) => x.id === id);
    expect(row.buyer_name).toBe('דנה');
    expect(row.event_type).toBe('יום הולדת');

    const edited = await fetch(
      base + '/api/admin/collections/' + id + '?key=' + encodeURIComponent(ADMIN_KEY),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyer_name: 'דנה כהן-לוי', event_type: 'בת מצווה' }),
      }
    );
    expect(edited.status).toBe(200);
    const c = db.getCollection(id);
    expect(c.buyer_name).toBe('דנה כהן-לוי');
    expect(c.event_type).toBe('בת מצווה');
    // …and correcting them left the printed name alone.
    expect(c.honoree_name).toBe('שירה');
  });

  it('is sanitized on the admin edit exactly as it is on the wizard', async () => {
    // The admin patch is a second front door to the same field, and a field with
    // two doors gets two shapes unless they share the sanitizer. A newline typed
    // here must flatten and a blank must clear, the same as from the wizard.
    const { id } = await createOrder({ buyer_name: 'דנה', event_type: 'יום הולדת' });
    await fetch(base + '/api/admin/collections/' + id + '?key=' + encodeURIComponent(ADMIN_KEY), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer_name: ' דנה\nכהן ', event_type: '   ' }),
    });
    expect(db.getCollection(id).buyer_name).toBe('דנה כהן');
    expect(db.getCollection(id).event_type).toBeNull();
  });

  it('is in the email the owner actually reads', () => {
    // She reads the mail on a phone and acts on it — so the name she has to greet
    // and the occasion she has to match are IN it, not one admin login away.
    const full = notify.buildPaidMessage(
      {
        id: 'c1',
        honoree_name: 'שירה',
        buyer_name: 'דנה כהן',
        event_type: 'בת מצווה של אחותי',
      },
      'https://test.example',
      {}
    );
    expect(full.text).toContain('שם המזמין/ה: דנה כהן');
    expect(full.text).toContain('סוג האירוע: בת מצווה של אחותי');

    // …and an order that answered neither carries no empty labels. A label with
    // nothing after it is worse than a missing line: it reads as data lost.
    const bare = notify.buildPaidMessage(
      { id: 'c1', honoree_name: 'שירה' },
      'https://test.example',
      {}
    );
    expect(bare.text).not.toContain('שם המזמין/ה');
    expect(bare.text).not.toContain('סוג האירוע');
  });

  it('is never handed to the generator — neither one is a title', async () => {
    const { id } = await createOrder({ buyer_name: 'דנה כהן', event_type: 'פרישה' });
    const c = db.getCollection(id);
    expect(c.custom_title).toBeNull();
    expect(c.buyer_name).toBe('דנה כהן');
    expect(c.event_type).toBe('פרישה');
  });

  it('an order that answers nothing optional still goes through', async () => {
    // The three optional answers on this step, all skipped at once: the order is
    // created, is complete, and nothing about it is in an error state.
    const created = await createOrder({});
    const c = db.getCollection(created.id);
    expect(c.buyer_name).toBeNull();
    expect(c.event_type).toBeNull();
    expect(c.comment).toBeNull();
    expect(c.honoree_name).toBe('שירה');
    expect(db.effectiveStatus(c)).toBe('open');
  });
});
