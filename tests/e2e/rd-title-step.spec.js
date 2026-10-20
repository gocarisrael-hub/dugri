import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The title step in redesign mode.
//  - the chosen design's photos are just the photos (owner, 2026-10-20: no paper frame, no tape, no tilt, no outline),
//    big, in a row that scrolls sideways: a swipe on a phone, the arrows on a wide screen. Each shows whole, its window
//    the photo's own shape;
//  - each photo is the right-sized file from the server's width ladder, and shows only once it has fully arrived: the
//    camera originals painted top down on a phone's connection, a strip at the top of an empty window ("אן בי איי");
//  - the live preview (card → back → board, whichever are on offer) is smaller, and goes round both ways, by swipe and
//    by the arrows beside its dots;
//  - on a wide screen "הבא" is a button beside "הקודם", not a bar across the gap. A phone keeps the stretched one.
// The live site keeps its look: the preview stops at the ends and has no arrows (wizard-preview-visual.spec.js).

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// views that tell apart by their picture
const VIEWS = {
  card: '/assets/card-front.png',
  back: '/assets/card-back.png',
  board: '/assets/card-real.png',
};
function mockPreview(page) {
  return page.route('**/api/preview', async (route) => {
    const body = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...VIEWS,
        warning: null,
        word_font: body.word_font || null,
        word_font_options: [],
      }),
    });
  });
}

const activeView = (page) =>
  page.evaluate(() => {
    const sel = document.querySelector('#namePreviewDots .np-dot[aria-selected="true"]');
    return sel ? sel.dataset.npdot : null;
  });
const swipe = async (page, fromX, toX) => {
  const vp = page.getByTestId('name-preview-viewport');
  await vp.dispatchEvent('pointerdown', { clientX: fromX, clientY: 200 });
  await vp.dispatchEvent('pointerup', { clientX: toX, clientY: 200 });
};

async function toTitleStep(page, { live = false, waitUntil = 'load' } = {}) {
  if (!live) await previewRedesign(page);
  await mockPreview(page);
  await page.goto('/options.html?design=japanese&step=3', { waitUntil });
  await expect(page.getByTestId('step-3')).toBeVisible();
}

for (const width of [360, 390, 1440]) {
  test(`at ${width}: the chosen design's photos are just the photos, big, and never widen the step`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await toTitleStepWithPhotos(page);
    const pic = page.getByTestId('chosen-design-pic').first();
    await expect(pic).toBeVisible();
    const look = await pic.evaluate((el) => {
      const cs = getComputedStyle(el);
      const img = el.querySelector('img');
      const ics = getComputedStyle(img);
      return {
        bg: cs.backgroundColor,
        padding: cs.padding,
        outline: cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth),
        shadow: cs.boxShadow,
        rotate: cs.rotate,
        tape: getComputedStyle(el, '::before').content,
        imgOutline: ics.outlineStyle === 'none' ? 0 : parseFloat(ics.outlineWidth),
        imgShadow: ics.boxShadow,
        imgW: img.getBoundingClientRect().width,
      };
    });
    // no frame of any kind: no paper, no padding round the photo, no ink line, no shadow, no tilt, no tape
    expect(look).toMatchObject({
      bg: 'rgba(0, 0, 0, 0)',
      padding: '0px',
      outline: 0,
      shadow: 'none',
      rotate: 'none',
      tape: 'none',
      imgOutline: 0,
      imgShadow: 'none',
    });
    // bigger than the prints were (at most 196 px wide, less their paper)
    expect(look.imgW).toBeGreaterThanOrEqual(220);

    // the row scrolls inside the box: the box is no wider than the step, and the page does not scroll sideways
    const fits = await page.evaluate(() => {
      const box = document.getElementById('chosenDesign').getBoundingClientRect();
      const step = document.querySelector('[data-step="3"]').getBoundingClientRect();
      const row = document.getElementById('chosenDesignPics');
      return {
        inStep: box.width <= step.width + 1,
        noSideScroll: document.documentElement.scrollWidth <= window.innerWidth,
        rowScrolls:
          row.scrollWidth > row.clientWidth + 1 && getComputedStyle(row).overflowX === 'auto',
      };
    });
    expect(fits).toEqual({ inStep: true, noSideScroll: true, rowScrolls: true });
  });
}

test('the live preview goes round both ways, by swipe and by arrow', async ({ page }) => {
  await toTitleStep(page);
  await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');
  await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
  // the views on offer, in track order (the dots are one per present view)
  const views = await page
    .locator('#namePreviewDots .np-dot')
    .evaluateAll((dots) => dots.map((d) => d.dataset.npdot));
  expect(views.length).toBeGreaterThanOrEqual(2);
  const [first, second, last] = [views[0], views[1], views[views.length - 1]];
  expect(await activeView(page)).toBe(first);

  // a swipe back from the first view lands on the last
  await swipe(page, 60, 300);
  await expect.poll(() => activeView(page)).toBe(last);
  // and a swipe on from the last lands on the first
  await swipe(page, 300, 60);
  await expect.poll(() => activeView(page)).toBe(first);

  // the arrows do the same; the row runs like the filmstrip, so next is the right-hand one
  const prev = page.getByTestId('name-preview-prev');
  const next = page.getByTestId('name-preview-next');
  await expect(prev).toHaveAccessibleName('התצוגה הקודמת');
  await expect(next).toHaveAccessibleName('התצוגה הבאה');
  const [pb, nb] = [await prev.boundingBox(), await next.boundingBox()];
  expect(nb.x).toBeGreaterThan(pb.x);
  await prev.click();
  await expect.poll(() => activeView(page)).toBe(last);
  await next.click();
  await expect.poll(() => activeView(page)).toBe(first);
  await next.click();
  await expect.poll(() => activeView(page)).toBe(second);

  // the picture on screen is the view the dot says, once the wrap's slide-in has settled
  const shown = () =>
    page.evaluate(() => {
      const vp = document.getElementById('namePreviewViewport').getBoundingClientRect();
      const mid = vp.left + vp.width / 2;
      const fig = [...document.querySelectorAll('.name-preview-fig')].find((f) => {
        const r = f.getBoundingClientRect();
        return !f.hidden && r.left <= mid && r.right >= mid;
      });
      return fig && fig.dataset.npview;
    });
  await expect.poll(shown).toBe(second);
  await prev.click();
  await prev.click(); // round past the first
  await expect.poll(shown).toBe(last);
});

test('the live site keeps a preview that stops at the ends, with no arrows', async ({ page }) => {
  await toTitleStep(page, { live: true });
  await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');
  await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
  await expect(page.getByTestId('name-preview-next')).toHaveCount(0);
  const first = await page.locator('#namePreviewDots .np-dot').first().getAttribute('data-npdot');
  expect(await activeView(page)).toBe(first);
  await swipe(page, 60, 300);
  await page.waitForTimeout(150);
  expect(await activeView(page)).toBe(first);
});

test('on a wide screen הבא is a button beside הקודם; a phone keeps the wide one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await toTitleStep(page);
  const next = page.getByTestId('next-btn');
  const back = page.getByTestId('back-btn');
  await expect(back).toBeVisible();
  let [nb, bb] = [await next.boundingBox(), await back.boundingBox()];
  expect(nb.width).toBeLessThan(300);
  expect(nb.width).toBeGreaterThanOrEqual(180);
  // side by side at the far (left) end, not with the whole gap between them
  expect(bb.x - (nb.x + nb.width)).toBeLessThan(40);

  await page.setViewportSize({ width: 390, height: 844 });
  [nb, bb] = [await next.boundingBox(), await back.boundingBox()];
  expect(nb.width).toBeGreaterThan(bb.width * 1.5);
});

// ---- the photos fill their window (owner, 2026-10-20) ----
// Solid fixtures of known shapes, read back in pixels from the page, so a declared style cannot pass for a painted one.
// The 5:4 photo is plain red. The odd ones (a 5:6 portrait and a square, the shapes of קליפורניה's and דני's shots)
// are red with a blue strip along their very top and their very foot, so any crop at all takes a strip off.
const RED = [220, 0, 0];
const BLUE = [0, 0, 220];
const PHOTO_54 = '/content-uploads/cccccccccccccccc.png';
const PHOTO_PORTRAIT = '/content-uploads/dddddddddddddddd.png';
const PHOTO_SQUARE = '/content-uploads/eeeeeeeeeeeeeeee.png';
const EDGES = [
  [0, 0.05],
  [0.95, 1],
];
const isRed = ([r, g, b]) => r > 180 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 180 && r < 60 && g < 60;

function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC = crcTable();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = -1;
  for (let i = 0; i < typed.length; i++) c = CRC[(c ^ typed[i]) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ -1) >>> 0);
  return Buffer.concat([len, typed, crc]);
}
// a w×h PNG, red, with the rows in each [from, to] band (fractions of the height) blue
function photoPng(w, h, bands = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const [r, g, b] = bands.some(([a, z]) => y >= a * h && y < z * h) ? BLUE : RED;
    const off = y * (1 + w * 3);
    for (let x = 0; x < w; x++) raw.set([r, g, b], off + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function toTitleStepWithPhotos(page, { srcsets } = {}) {
  const pngs = {
    [PHOTO_54]: photoPng(500, 400),
    [PHOTO_PORTRAIT]: photoPng(400, 480, EDGES),
    [PHOTO_SQUARE]: photoPng(450, 450, EDGES),
  };
  await page.route('**/api/design-images*', (route) =>
    route.fulfill({
      json: {
        images: {
          japanese: {
            base: {
              store: { img: PHOTO_54 },
              front: { img: PHOTO_PORTRAIT },
              back: { img: PHOTO_SQUARE },
            },
            order: ['store', 'front', 'back'],
          },
        },
        ...(srcsets ? { srcsets } : {}),
      },
    })
  );
  await page.route('**/content-uploads/*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: pngs[new URL(route.request().url()).pathname] || pngs[PHOTO_54],
    })
  );
  await toTitleStep(page);
  const imgs = page.locator('.cd-pic img');
  // her three photos lead (the order puts them first); a shipped render may follow
  await expect(imgs.nth(2)).toBeVisible();
  for (const i of [0, 1, 2]) {
    await expect
      .poll(() => imgs.nth(i).evaluate((el) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  }
  await page.evaluate(() =>
    Promise.all([...document.querySelectorAll('.cd-pic img')].slice(0, 3).map((i) => i.decode()))
  );
}

// Colours at points of a photo, given as fractions across and down the photo's own box.
async function photoPixels(page, index, pts) {
  const img = page.locator('.cd-pic img').nth(index);
  await img.scrollIntoViewIfNeeded();
  const geo = await img.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const deg = parseFloat(getComputedStyle(el.parentElement).rotate) || 0;
    return {
      cx: r.x + r.width / 2,
      cy: r.y + r.height / 2,
      w: el.offsetWidth,
      h: el.offsetHeight,
      deg,
    };
  });
  const shot = await page.screenshot();
  const t = (geo.deg * Math.PI) / 180;
  const at = pts.map(([fx, fy]) => {
    const dx = (fx - 0.5) * geo.w;
    const dy = (fy - 0.5) * geo.h;
    return [
      geo.cx + dx * Math.cos(t) - dy * Math.sin(t),
      geo.cy + dx * Math.sin(t) + dy * Math.cos(t),
    ];
  });
  const px = await page.evaluate(
    async ({ b64, at }) => {
      const bmp = await createImageBitmap(
        await (await fetch('data:image/png;base64,' + b64)).blob()
      );
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const k = bmp.width / window.innerWidth;
      return at.map(([x, y]) => [
        ...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3),
      ]);
    },
    { b64: shot.toString('base64'), at }
  );
  return { px, aspect: geo.w / geo.h };
}

for (const width of [390, 1440]) {
  test(`at ${width}: a 5:4 photo fills its print's window to every edge`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await toTitleStepWithPhotos(page);
    const { px, aspect } = await photoPixels(page, 0, [
      [0.05, 0.5],
      [0.95, 0.5],
      [0.5, 0.05],
      [0.5, 0.95],
      [0.5, 0.5],
    ]);
    expect(aspect).toBeGreaterThan(1.22);
    expect(aspect).toBeLessThan(1.28);
    px.forEach((p, i) => expect(isRed(p), `point ${i} is the photo, not a band: ${p}`).toBe(true));
  });
}

test("no crop: every print's window is its own photo's shape, the photo whole and edge to edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await toTitleStepWithPhotos(page);
  const prints = await page.locator('.cd-pic img').evaluateAll((imgs) =>
    imgs.map((el) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // the painted photo's size under the image's object-fit
      const nw = el.naturalWidth;
      const nh = el.naturalHeight;
      const fit = getComputedStyle(el).objectFit;
      const k = fit === 'contain' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh);
      return { natural: nw / nh, window: w / h, w, h, paintedW: nw * k, paintedH: nh * k };
    })
  );
  expect(prints.length).toBeGreaterThanOrEqual(3);
  prints.forEach((p, i) => {
    expect(
      Math.abs(p.window / p.natural - 1),
      `print ${i}: window ${p.window}, photo ${p.natural}`
    ).toBeLessThan(0.01);
    // the painted photo is the window: no band beside it and nothing past it
    expect(Math.abs(p.paintedW / p.w - 1), `print ${i} width`).toBeLessThan(0.01);
    expect(Math.abs(p.paintedH / p.h - 1), `print ${i} height`).toBeLessThan(0.01);
  });
  // and in pixels: the blue strips along the very top and foot of the portrait and the square are both on screen
  for (const index of [1, 2]) {
    const { px } = await photoPixels(page, index, [
      [0.5, 0.02],
      [0.5, 0.5],
      [0.5, 0.98],
    ]);
    const [top, middle, foot] = px;
    expect(isBlue(top), `print ${index}: the photo's top strip is in the window: ${top}`).toBe(
      true
    );
    expect(isRed(middle), `print ${index}: ${middle}`).toBe(true);
    expect(isBlue(foot), `print ${index}: the photo's foot strip is in the window: ${foot}`).toBe(
      true
    );
  }
});

test('a wide screen steps through the row with arrows, shown only where there is somewhere to go', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await toTitleStepWithPhotos(page);
  const prev = page.getByTestId('chosen-design-prev');
  const next = page.getByTestId('chosen-design-next');
  await expect(prev).toHaveAttribute('aria-label', 'התמונה הקודמת');
  await expect(next).toHaveAttribute('aria-label', 'התמונה הבאה');
  // at the start (the right, in RTL) there is only a way on, and it is the left-hand arrow
  await expect(next).toBeVisible();
  await expect(prev).toBeHidden();
  const row = page.getByTestId('chosen-design-pics');
  const at = () => row.evaluate((el) => Math.abs(el.scrollLeft));
  // a click scrolls smoothly: read the arrows only once the row has stopped
  const settle = () =>
    expect
      .poll(async () => {
        const a = await at();
        await page.waitForTimeout(120);
        return Math.abs((await at()) - a);
      })
      .toBeLessThan(1);
  const nb = await next.boundingBox();
  const rb = await row.boundingBox();
  expect(nb.x + nb.width / 2).toBeLessThan(rb.x + rb.width / 2);
  await next.click();
  await settle();
  expect(await at()).toBeGreaterThan(100);
  await expect(prev).toBeVisible();
  const pb = await prev.boundingBox();
  expect(pb.x + pb.width / 2).toBeGreaterThan(rb.x + rb.width / 2);
  // on to the end: the way on goes away
  for (let i = 0; i < 6 && (await next.isVisible()); i++) {
    await next.click();
    await settle();
  }
  await expect(next).toBeHidden();
  await prev.click();
  await settle();
  await expect(next).toBeVisible();
});

test('a phone swipes: no arrows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await toTitleStepWithPhotos(page);
  for (const id of ['chosen-design-prev', 'chosen-design-next'])
    await expect(page.getByTestId(id)).toBeHidden();
});

test('the photos are crisp: no blur anywhere in the box', async ({ page }) => {
  await toTitleStepWithPhotos(page);
  const looks = await page.evaluate(() => {
    const btn = document.querySelector('.cd-pic');
    const img = btn.querySelector('img');
    const read = (el) => {
      const cs = getComputedStyle(el);
      return { filter: cs.filter, backdrop: cs.backdropFilter, shadow: cs.boxShadow };
    };
    return { pic: read(btn), photo: read(img), box: read(document.getElementById('chosenDesign')) };
  });
  // each shadow's third length is its blur radius
  const blurs = (shadow) =>
    shadow === 'none'
      ? []
      : shadow
          .replace(/rgba?\([^)]*\)/g, '')
          .split(',')
          .map((s) => parseFloat((s.match(/-?[\d.]+px/g) || [])[2] || '0'));
  for (const [name, l] of Object.entries(looks)) {
    expect(l.filter, `${name} filter`).toBe('none');
    expect(l.backdrop, `${name} backdrop-filter`).toBe('none');
    for (const b of blurs(l.shadow)) expect(b, `${name} shadow blur`).toBe(0);
  }
});

// ---- "אן בי איי": on a phone every photo was a strip at the top of an empty window (owner, 2026-10-20) ----
// The box loaded the owner's camera originals (2600-3000 px baseline JPEGs, up to 800 KB each), and a baseline JPEG
// paints top down as it arrives. Two halves to the fix, one test each: the file asked for is the right-sized rung of
// the server's width ladder, and a photo still arriving is not shown at all.
test('each photo is the right-sized file from the width ladder, not the camera original', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rungs = [200, 400, 800, 1200, 1600];
  const ladder = (name) => rungs.map((w) => `/design-img/r1/${w}/${name} ${w}w`).join(', ');
  const asked = [];
  await page.route('**/design-img/**', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    route.fulfill({ contentType: 'image/png', body: photoPng(500, 400) });
  });
  await toTitleStepWithPhotos(page, {
    srcsets: {
      'cccccccccccccccc.png': ladder('cccccccccccccccc.png'),
      'dddddddddddddddd.png': ladder('dddddddddddddddd.png'),
      'eeeeeeeeeeeeeeee.png': ladder('eeeeeeeeeeeeeeee.png'),
    },
  });
  const srcs = await page
    .locator('.cd-pic img')
    .evaluateAll((imgs) => imgs.slice(0, 3).map((i) => ({ src: i.currentSrc, sizes: i.sizes })));
  for (const { src, sizes } of srcs) {
    // a rung sized to the screen (a phone at 3x takes 1200), never the camera original under /content-uploads
    expect(new URL(src).pathname).toMatch(/^\/design-img\/r1\/(200|400|800|1200)\//);
    expect(sizes).toContain('320px');
  }
  expect(asked.length).toBeGreaterThanOrEqual(3);
});

test('a photo still arriving is not shown: the window waits, then shows it whole', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/content-uploads/cccccccccccccccc.png', async (route) => {
    await held;
    route.fulfill({ contentType: 'image/png', body: photoPng(500, 400) });
  });
  await page.route('**/api/design-images*', (route) =>
    route.fulfill({
      json: {
        images: { japanese: { base: { store: { img: PHOTO_54 } }, order: ['store'] } },
      },
    })
  );
  // the held photo holds the page's load event too
  await toTitleStep(page, { waitUntil: 'domcontentloaded' });
  const img = page.locator('.cd-pic img').first();
  await expect(img).toBeAttached();
  // still arriving: nothing of it on screen
  await page.waitForTimeout(300);
  expect(await img.evaluate((el) => el.complete)).toBe(false);
  expect(await img.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  release();
  await expect.poll(() => img.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('the live preview is smaller: the card at most 280px, the board at most 480px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await toTitleStep(page);
  await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');
  await expect(page.getByTestId('name-preview-dot-back')).toBeVisible();
  const vp = page.getByTestId('name-preview-viewport');
  await expect.poll(async () => (await vp.boundingBox()).width).toBeLessThanOrEqual(280);
  expect((await vp.boundingBox()).width).toBeGreaterThanOrEqual(240); // still a card you can read
  if (await page.getByTestId('name-preview-dot-board').count()) {
    await page.getByTestId('name-preview-dot-board').click();
    await expect.poll(async () => (await vp.boundingBox()).width).toBeLessThanOrEqual(480);
  }
});
