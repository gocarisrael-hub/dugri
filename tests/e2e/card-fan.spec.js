// The card fan (css/cards.css), on the home page and on the campaign page.
//
// Every card face on the site is a CROP of one real print sheet, so two
// different things can rot here and neither shows up as an error.
//
// GEOMETRY. The cards are `flex: 0 0 <basis>` — no shrink — so the row's width
// is 3*basis minus the middle card's two negative margins, and the moment that
// exceeds 100% the fan silently overflows whatever it is dropped into. It did:
// at 46%/6% the row is 126%, which nobody noticed inside a hero column with
// overflow hidden and which burst its box by ~90px a side on the home page.
// Rotation and translateY compound it, because transforms paint outside the
// layout box and reserve no space — untamed, the tilted cards laid themselves
// over the celebrations counter beneath them.
//
// So the assertions are the two invariants, not the numbers that satisfy them
// today: every card paints INSIDE its fan, and the fan touches nothing below it.
//
// IDENTITY. A card is addressed by `data-card="<col> <row>"`, and a wrong
// background-position does not fail — it just quietly frames someone else's
// card, or half of two. Hence: the artwork resolves, and no two cards in one
// fan show the same crop.
import { test, expect } from '@playwright/test';

const SHEET = 'gallery-front.webp';

async function boxes(fan) {
  const cards = fan.locator('.card');
  const out = [];
  for (const card of await cards.all()) out.push(await card.boundingBox());
  return out;
}

for (const page_ of [
  { name: 'home page', url: '/index.html', fan: '.home-fan' },
  { name: 'campaign page', url: '/lp.html', fan: '.hero .card-fan' },
]) {
  test.describe(`the fan on the ${page_.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(page_.url);
      await page.locator(page_.fan).scrollIntoViewIfNeeded();
    });

    test('every card paints inside the fan, not over its neighbours', async ({ page }) => {
      const fan = page.locator(page_.fan);
      const frame = await fan.boundingBox();
      for (const card of await boxes(fan)) {
        // 1px of tolerance for sub-pixel rounding on the rotation.
        expect(card.x).toBeGreaterThanOrEqual(frame.x - 1);
        expect(card.x + card.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
        expect(card.y).toBeGreaterThanOrEqual(frame.y - 1);
        expect(card.y + card.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
      }
    });

    test('the cards are crops of the real sheet, and all different', async ({ page }) => {
      const cards = page.locator(`${page_.fan} .card`);
      await expect(cards).toHaveCount(3);
      const seen = await cards.evaluateAll((els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          return { image: cs.backgroundImage, pos: cs.backgroundPosition };
        })
      );
      for (const { image } of seen) expect(image).toContain(SHEET);
      // Three cards, three different crops. A copy-pasted data-card shows the
      // same face twice and reads as carelessness rather than as a hand.
      expect(new Set(seen.map((s) => s.pos)).size).toBe(3);
    });
  });
}

test('the home fan clears the celebrations counter beneath it', async ({ page }) => {
  await page.goto('/index.html');
  const fan = page.locator('.home-fan');
  await fan.scrollIntoViewIfNeeded();
  const fanBox = await fan.boundingBox();
  const stat = await page.locator('#about .stat-box').boundingBox();
  // The transforms tilt the cards well below the flex row's own height; the
  // fan's padding is what reserves that room. Without it the cards sat on top
  // of the counter.
  expect(fanBox.y + fanBox.height).toBeLessThanOrEqual(stat.y);
});

test('the home fan is described; the hero fan is decorative', async ({ page }) => {
  await page.goto('/index.html');
  // On the home page the fan is the only place a visitor sees what a card IS,
  // so it carries meaning and needs a name.
  const home = page.locator('.home-fan');
  await expect(home).toHaveAttribute('role', 'img');
  expect((await home.getAttribute('aria-label')).trim().length).toBeGreaterThan(10);

  await page.goto('/lp.html');
  // On the campaign page the same three cards are decorative, because four are
  // shown further down at readable size with their words in the label. Naming
  // them twice would make a screen reader read the deck twice.
  await expect(page.locator('.hero .card-fan')).toHaveAttribute('aria-hidden', 'true');
});

test('reduced motion leaves the hand still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/index.html');
  const card = page.locator('.home-fan .card').first();
  await card.scrollIntoViewIfNeeded();
  // The tilt is layout, not animation, so it stays — what must not exist is a
  // transition waiting to run on hover.
  const transition = await card.evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(transition === 'none' || transition === 'all').toBeTruthy();
});
