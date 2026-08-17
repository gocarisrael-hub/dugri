// @vitest-environment node
// server/hfd.js — the HFD courier client. The mapping from OUR order to HFD's
// fields is the whole integration, so it is tested as a pure function; the four
// network calls are tested against a fake fetch, including the two shapes HFD
// uses to say no.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const hfdPath = require.resolve(path.join(serverDir, 'hfd.js'));

let hfd;
const ENV = {};

// Load the module with credentials present. hfd.js reads its env once at require
// time (like pelecard/whatsapp), so the env is set before the require and the
// cache is cleared around it.
beforeAll(() => {
  for (const k of ['HFD_TOKEN', 'HFD_CLIENT_NUMBER', 'HFD_SENDER_NAME', 'HFD_BASE_URL'])
    ENV[k] = process.env[k];
  process.env.HFD_TOKEN = 'test-token';
  process.env.HFD_CLIENT_NUMBER = '4242';
  process.env.HFD_SENDER_NAME = 'דוגרי';
  process.env.HFD_BASE_URL = 'https://api.hfd.example/rest/v2';
  delete require.cache[hfdPath];
  hfd = require(hfdPath);
});

afterAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[hfdPath];
});

// A delivery order shaped like db.js stores one. `overrides.order` is merged
// INTO the order (so a test can change one field of it), everything else onto
// the collection.
function order(overrides = {}) {
  const { order: orderOverride, ...rest } = overrides;
  return {
    id: 'col-1',
    order_no: 'DG-1042',
    buyer_name: 'רותם לוי',
    honoree_name: 'שירה',
    custom_title: 'שירה בת 30',
    design: 'טיול חזרה',
    theme: 'trip comeback',
    owner_phone: '052-123-4567',
    owner_email: 'rotem@example.com',
    order: {
      version: 'delivery',
      quantity: 2,
      address: {
        street: 'הרצל 5',
        city: 'תל אביב',
        postal: '6100000',
        apartment: '3',
        floor: '2',
      },
      ...orderOverride,
    },
    ...rest,
  };
}

// A fetch stand-in: records the call and answers with what the test wants.
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  impl.calls = calls;
  return impl;
}

const jsonRes = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

const pdfRes = (bytes, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: () => 'application/pdf' },
  arrayBuffer: async () => bytes,
});

describe('buildShipment — our order in HFD’s fields', () => {
  it('maps a delivery order onto the plain deliver-to-an-address service', () => {
    const { payload, error } = hfd.buildShipment(order());
    expect(error).toBeUndefined();
    expect(payload).toMatchObject({
      clientNumber: 4242,
      mesiraIsuf: 'מסירה',
      shipmentTypeCode: 35,
      cargoTypeHaloch: 10,
      cargoTypeHazor: 0,
      pudoCodeDestination: 0,
      ordererName: 'דוגרי',
      nameTo: 'רותם לוי',
      streetName: 'הרצל',
      houseNum: '5',
      apartment: '3',
      floor: '2',
      cityName: 'תל אביב',
      telFirst: '0521234567',
      email: 'rotem@example.com',
      referenceNum1: 'DG-1042',
      packsHaloch: '1',
    });
  });

  it('carries the postal code, flat and floor in the remark the courier reads', () => {
    const { payload } = hfd.buildShipment(order());
    expect(payload.addressRemarks).toBe('הרצל 5, מיקוד 6100000, דירה 3, קומה 2');
  });

  it('names the game on the sticker — the printed title and the design’s CURRENT name', () => {
    // The caller resolves the live name (themes.json display_he); the name
    // stamped on the order is only the fallback.
    const { payload } = hfd.buildShipment(order(), { designName: 'סיישל' });
    expect(payload.shipmentRemarks).toBe('שירה בת 30 · סיישל');
    expect(hfd.buildShipment(order()).payload.shipmentRemarks).toBe('שירה בת 30 · טיול חזרה');
  });

  it('never asks the courier to collect money — the customer already paid us', () => {
    const { payload } = hfd.buildShipment(order({ order: { total: 289 } }));
    expect(payload.productsPrice).toBe(0);
  });

  it('falls back to the honoree when the buyer left no name', () => {
    const c = order();
    c.buyer_name = null;
    expect(hfd.buildShipment(c).payload.nameTo).toBe('שירה');
  });

  it('refuses an order that cannot ship, without inventing a payload', () => {
    expect(hfd.buildShipment({ id: 'x' }).error).toBe('no order');
    expect(hfd.buildShipment(order({ order: { version: 'pickup' } })).error).toBe(
      'not a delivery order'
    );
    expect(hfd.buildShipment(order({ order: { address: null } })).error).toBe('address required');
  });
});

describe('field normalization', () => {
  it('turns any spelling of an Israeli mobile into the local 0-form', () => {
    expect(hfd.normalizePhone('052-123-4567')).toBe('0521234567');
    expect(hfd.normalizePhone('+972521234567')).toBe('0521234567');
    expect(hfd.normalizePhone('972 52 123 4567')).toBe('0521234567');
    // Too short to be a phone: an empty field beats a fake one.
    expect(hfd.normalizePhone('1234')).toBe('');
    expect(hfd.normalizePhone(null)).toBe('');
  });

  it('splits the house number off the end of a street, and only off the end', () => {
    expect(hfd.splitStreet('הרצל 5')).toEqual({ streetName: 'הרצל', houseNum: '5' });
    expect(hfd.splitStreet('ביאליק 12ב')).toEqual({ streetName: 'ביאליק', houseNum: '12ב' });
    // A number that isn't the house number stays part of the street name.
    expect(hfd.splitStreet('רחוב 12 הבנים')).toEqual({
      streetName: 'רחוב 12 הבנים',
      houseNum: '',
    });
    expect(hfd.splitStreet('שדרות ירושלים')).toEqual({
      streetName: 'שדרות ירושלים',
      houseNum: '',
    });
  });

  it('labels the box with the title and the design’s live name, one line, capped', () => {
    // The name passed in WINS over the one stamped on the order — a renamed
    // template must not go out under the label it used to have.
    expect(hfd.gameRemark({ custom_title: 'שירה בת 30', design: 'טיול חזרה' }, 'סיישל')).toBe(
      'שירה בת 30 · סיישל'
    );
    // No live name resolved (themes.json unreadable): the stamped one still ships.
    expect(hfd.gameRemark({ custom_title: 'שירה בת 30', design: 'טיול חזרה' })).toBe(
      'שירה בת 30 · טיול חזרה'
    );
    // A multi-line card title becomes a single label line.
    expect(hfd.gameRemark({ custom_title: 'שירה\nבת 30' }, 'סיישל')).toBe('שירה בת 30 · סיישל');
    // No title set: the honoree's name is what the orders table shows too.
    expect(hfd.gameRemark({ honoree_name: 'שירה' }, 'סיישל')).toBe('שירה · סיישל');
    // Nothing named at all: the generator key beats an unlabelled box.
    expect(hfd.gameRemark({ honoree_name: 'שירה', order: { theme: 'trip comeback' } })).toBe(
      'שירה · trip comeback'
    );
    // Neither: an empty remark, not a stray separator.
    expect(hfd.gameRemark({})).toBe('');
    // A long title is cut to fit the field rather than sent whole.
    const long = hfd.gameRemark({ custom_title: 'א'.repeat(200) }, 'סיישל');
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('links tracking by the RAND number, not the shipment number', () => {
    expect(hfd.trackingUrl('abc123')).toBe('https://run.hfd.co.il/info/abc123');
    expect(hfd.trackingUrl('')).toBe(null);
  });
});

describe('createShipment', () => {
  it('POSTs the payload with the bearer token and returns both numbers', async () => {
    const fetchImpl = fakeFetch(jsonRes({ shipmentNumber: 987654, randNumber: 'r-1' }));
    const r = await hfd.createShipment(order(), { fetchImpl });
    expect(r).toEqual({ ok: true, shipmentNumber: '987654', randNumber: 'r-1' });
    const call = fetchImpl.calls[0];
    expect(call.url).toBe('https://api.hfd.example/rest/v2/shipments/create');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer test-token');
    expect(call.body.referenceNum1).toBe('DG-1042');
    // What the sticker says the box is — it has to leave with the request.
    expect(call.body.shipmentRemarks).toBe('שירה בת 30 · טיול חזרה');
  });

  it('passes the caller’s live design name through to the request', async () => {
    const fetchImpl = fakeFetch(jsonRes({ shipmentNumber: 1, randNumber: 'r' }));
    await hfd.createShipment(order(), { fetchImpl, designName: 'סיישל' });
    expect(fetchImpl.calls[0].body.shipmentRemarks).toBe('שירה בת 30 · סיישל');
  });

  it('reports HFD’s refusal in either shape it uses, and books nothing', async () => {
    const byMessage = await hfd.createShipment(order(), {
      fetchImpl: fakeFetch(jsonRes({ errorMessage: 'עיר לא מוכרת' })),
    });
    expect(byMessage).toMatchObject({ ok: false, error: 'עיר לא מוכרת' });

    const byDetails = await hfd.createShipment(order(), {
      fetchImpl: fakeFetch(jsonRes({ details: 'token expired' }, { ok: false, status: 401 })),
    });
    expect(byDetails).toMatchObject({ ok: false, error: 'token expired', status: 401 });
  });

  it('survives the courier being down — a network error is a soft failure', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const r = await hfd.createShipment(order(), { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNRESET');
  });

  it('refuses a non-shippable order before opening a socket', async () => {
    const fetchImpl = fakeFetch(jsonRes({ shipmentNumber: 1 }));
    const r = await hfd.createShipment(order({ order: { address: null } }), { fetchImpl });
    expect(r).toEqual({ ok: false, error: 'address required' });
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('cancelShipment', () => {
  it('DELETEs the shipment and accepts only a real OK', async () => {
    const fetchImpl = fakeFetch(jsonRes({ status: 'OK' }));
    expect(await hfd.cancelShipment('987654', { fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl.calls[0].url).toBe('https://api.hfd.example/rest/v2/shipments/987654');
    expect(fetchImpl.calls[0].init.method).toBe('DELETE');
  });

  it('treats a 200 that says ERROR as the failure it is', async () => {
    const r = await hfd.cancelShipment('987654', {
      fetchImpl: fakeFetch(jsonRes({ status: 'ERROR', status_desc: 'כבר נאסף' })),
    });
    expect(r).toMatchObject({ ok: false, error: 'כבר נאסף' });
  });
});

describe('fetchLabel', () => {
  const PDF = () => Buffer.from('%PDF-1.4 sticker');

  it('returns the sticker bytes', async () => {
    const fetchImpl = fakeFetch(pdfRes(PDF()));
    const r = await hfd.fetchLabel('987654', { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(fetchImpl.calls[0].url).toBe('https://api.hfd.example/rest/v2/shipments/987654/label');
  });

  it('unwraps the base64-in-JSON shape HFD also uses', async () => {
    const r = await hfd.fetchLabel('987654', {
      fetchImpl: fakeFetch(jsonRes({ Base64String: PDF().toString('base64') })),
    });
    expect(r.ok).toBe(true);
    expect(r.pdf.toString()).toBe('%PDF-1.4 sticker');
  });

  it('refuses a body that is not a PDF rather than handing over a broken file', async () => {
    const r = await hfd.fetchLabel('987654', {
      fetchImpl: fakeFetch(pdfRes(Buffer.from('<html>login</html>'))),
    });
    expect(r.ok).toBe(false);
  });
});

describe('dormant without credentials', () => {
  let dormant;
  beforeEach(() => {
    delete require.cache[hfdPath];
    const token = process.env.HFD_TOKEN;
    delete process.env.HFD_TOKEN;
    dormant = require(hfdPath);
    process.env.HFD_TOKEN = token;
    delete require.cache[hfdPath];
  });

  it('opens no socket and says so, on every entry point', async () => {
    const fetchImpl = fakeFetch(jsonRes({ shipmentNumber: 1 }));
    expect(dormant.isConfigured()).toBe(false);
    expect(dormant.status().configured).toBe(false);
    expect(dormant.status().senderName).toBeTruthy();
    for (const r of [
      await dormant.createShipment(order(), { fetchImpl }),
      await dormant.cancelShipment('1', { fetchImpl }),
      await dormant.fetchLabel('1', { fetchImpl }),
    ]) {
      expect(r).toMatchObject({ ok: false, skipped: true });
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('never leaks the token in its status', () => {
    expect(JSON.stringify(dormant.status())).not.toContain('test-token');
  });
});
