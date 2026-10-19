// Reach the collect page's checkout (#payPanel) the way the buyer does. While the pay cards show (open, unpaid, card
// payment on) that is the sticky pay bar: the תשלום tab is down then (the owner, 2026-10-19), and the bar opens the panel
// EXPANDED. Without the cards (closed before paying, or card payment off) the tab is the fallback way in, and it shows
// the panel collapsed, as it always did. Both go through showTab('pay'), so the panel is the same one either way.
// WAIT, never just look: both appear when the owner's state lands. A contributor's page has neither, so the wait may
// expire; that returns false and clicks nothing.
export async function showCheckout(page, { timeout = 5000 } = {}) {
  const way = page
    .locator('[data-testid="tab-pay"]:visible, [data-testid="pay-bar-btn"]:visible')
    .first();
  const shown = await way
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!shown) return false;
  const tab = page.getByTestId('tab-pay');
  if (await tab.isVisible()) await tab.click();
  else await page.getByTestId('pay-bar-btn').click();
  return true;
}

// The checkout shown AND expanded, whichever way in it took. `> summary` (a direct child): the panel holds a second
// <summary> in its remote-towns note.
export async function openCheckout(page, opts) {
  const shown = await showCheckout(page, opts);
  const panel = page.locator('#payPanel');
  if (!(await panel.evaluate((el) => el.open))) await page.locator('#payPanel > summary').click();
  return shown;
}
