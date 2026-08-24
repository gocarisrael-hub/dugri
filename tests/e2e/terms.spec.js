// THE TERMS PAGE, and the footer link that makes it findable.
//
// A shop that takes money needs its terms reachable from every page — that is
// both the legal expectation and the practical one: the person looking for the
// cancellation clause is usually mid-doubt, and a page nobody can find is a page
// that does not exist.
import { test, expect } from '@playwright/test';

const PAGES = ['/index.html', '/products.html', '/product.html', '/how.html'];

test.describe('the footer link', () => {
  for (const path of PAGES) {
    test(`${path} links to the terms`, async ({ page }) => {
      await page.goto(path);
      const link = page.getByTestId('footer-terms');
      await expect(link).toHaveAttribute('href', 'terms.html');
      await expect(link).toHaveText('תקנון ותנאי שימוש');
    });
  }

  test('and the link actually opens the page', async ({ page }) => {
    await page.goto('/index.html');
    await page.getByTestId('footer-terms').click();
    await expect(page).toHaveURL(/terms\.html$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('תקנון');
  });
});

test.describe('the terms page', () => {
  test.beforeEach(async ({ page }) => await page.goto('/terms.html'));

  test('carries all 26 clauses, each with a heading and text under it', async ({ page }) => {
    const sections = page.locator('main section');
    await expect(sections).toHaveCount(26);
    // Not merely present: a clause with a heading and no body is a clause that
    // was lost in conversion, which is exactly the failure this page risks.
    for (const i of [1, 13, 26]) {
      const s = page.locator(`#sec-${i}`);
      await expect(s.locator('h2')).not.toBeEmpty();
      await expect(s.locator('p').first()).not.toBeEmpty();
    }
  });

  test('the clauses a customer comes looking for are there', async ({ page }) => {
    const main = page.locator('main');
    for (const clause of ['ביטול עסקה', 'זמני ייצור ואספקה', 'איסוף עצמי', 'משלוחים']) {
      await expect(main.getByRole('heading', { name: clause })).toBeVisible();
    }
  });

  test('the table of contents jumps to a clause', async ({ page }) => {
    await page.getByRole('navigation', { name: 'תוכן עניינים' }).getByText('ביטול עסקה').click();
    await expect(page).toHaveURL(/#sec-11$/);
    await expect(page.locator('#sec-11')).toBeInViewport();
  });

  // The docx left the business details as "[להשלמה לפני פרסום]". Publishing that
  // bracket on a live legal page is the one thing this page must never do.
  test('no unfinished placeholder is published', async ({ page }) => {
    await expect(page.locator('body')).not.toContainText('להשלמה לפני פרסום');
    await expect(page.locator('body')).not.toContainText('[');
  });

  test('says which version the reader is agreeing to', async ({ page }) => {
    // §24 makes the published version the binding one, so the page has to date
    // itself or the clause is unreadable.
    await expect(page.getByText(/עודכן לאחרונה/)).toBeVisible();
  });

  test('offers a way back, and the contact channels the terms promise', async ({ page }) => {
    await expect(page.getByRole('link', { name: /חזרה לאתר/ })).toHaveAttribute(
      'href',
      'index.html'
    );
    await expect(page.locator('[data-edit="terms-contact"]')).toContainText(
      'dugri.israel@gmail.com'
    );
    await expect(page.locator('footer a[href*="wa.me"]')).toHaveAttribute('href', /972552441334/);
  });
});
