// Run a page in redesign mode from an E2E spec.
//
// previewRedesign(page, baseURL): the real path. Sets the rd=1 cookie that ?rd=1 sets, so the server (D's gate) adds class="rd" to <html>
// and links css/redesign.css and js/redesign-shell.js. Use it in a spec that restyles a page:
//   test.beforeEach(({ page, baseURL }) => previewRedesign(page, baseURL));
//
// simulateRedesignGate(page, re): what the gate does, done in the browser, for a spec that must not depend on the server's
// setting. Every document whose URL matches `re` comes back with class="rd" and the two tags, as the gate would add them.
export async function previewRedesign(page, baseURL) {
  await page.context().addCookies([{ name: 'rd', value: '1', url: baseURL }]);
}

export async function simulateRedesignGate(page, re) {
  await page.route(re, async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const html = (await res.text())
      .replace(/<html([^>]*)>/, (m, attrs) =>
        /class="/.test(attrs) ? m.replace('class="', 'class="rd ') : `<html${attrs} class="rd">`
      )
      .replace(
        '</head>',
        '<link rel="stylesheet" href="/css/redesign.css" />\n<script src="/js/redesign-shell.js" defer></script>\n</head>'
      );
    await route.fulfill({ response: res, body: html });
  });
}
