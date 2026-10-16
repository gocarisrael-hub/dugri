// Run a page in redesign mode from an E2E spec, the way a visitor previews it: ?rd=1 makes the server's gate
// (server/redesign-gate.js) set the rd cookie, and from then on every page in this browser context comes with class="rd" on
// <html>, css/redesign.css and js/redesign-shell.js. The page's own css/rd/<page>.css comes with them once it exists.
//   test.beforeEach(({ page }) => previewRedesign(page));
// The cookie is set by a plain request (no page is drawn), and checked, so a spec never runs half in the mode.
export async function previewRedesign(page) {
  const res = await page.request.get('/terms.html?rd=1');
  if (!res.ok()) throw new Error(`?rd=1 answered ${res.status()}`);
  const cookies = await page.context().cookies();
  if (!cookies.some((c) => c.name === 'rd' && c.value === '1'))
    throw new Error('?rd=1 set no rd cookie: is the redesign gate (server/redesign-gate.js) in?');
}
