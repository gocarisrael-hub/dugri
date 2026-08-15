/* start-explainer.js — the full-page "4 steps" explainer that precedes the order
   wizard.

   WHY: shoppers used to land in options.html cold and meet a 4-step wizard with no
   idea what was coming (upload photos? collect words? how long does this take?).
   This overlay is the 30-second briefing that runs BEFORE the wizard: what the four
   stages are, what we need from them at each one, and one button that continues
   into exactly the wizard URL the trigger already pointed at.

   IT IS ONE PAGE, AND THE BUTTON IS AT THE FOOT OF IT (owner's call). Two separate
   promises, and only one of them is absolute:

     • THE BUTTON IS ALWAYS ON SCREEN. `.sx-cta` is `position:sticky;bottom:0`, so
       when the briefing does fit it simply sits at the foot, and when it does not it
       pins to the bottom edge instead of dropping below the fold. This is what makes
       a single bottom CTA safe; without it, a landscape phone or a 200%-text reader
       opens the sheet with no visible way forward — which is exactly why a second
       copy used to sit above the steps.
     • ONE PAGE, on the screens it can be. The type scales with `dvh` so the whole
       briefing lands inside a single viewport on a modern phone held upright
       (390x844 and taller) and on any desktop. It does NOT fit a 320x568 phone, a
       landscape phone, or a short window: this much Hebrew copy cannot be set at a
       readable size in 400px of height, so those readers get a short scroll with the
       button still pinned. Shortening the step copy is what would buy the last few
       screens — every string is owner-editable, and the type grows back on its own.

   The scale has a counter-intuitive trap worth knowing before touching it: because
   the text column stays ~350px wide on a phone, a larger face re-wraps every
   paragraph, so content height grows FASTER than the viewport it is fitting into.
   Turning the dvh multipliers up therefore breaks the TALL phones first, not the
   short ones (measured: ~87px of sheet per 1px of body size at 390px wide, against
   ~58px of screen per 100px of viewport). tests/e2e/start-explainer.spec.js sweeps
   real device viewports for this; do not tune it against one screen size.

   IT NEVER BLOCKS THE PURCHASE. It intercepts the click, shows the explainer, and
   the continue button carries the trigger's OWN href forward — including
   product.js's `options.html?design=<id>&step=2`, so design preselection survives.
   Escape / the X / an overlay-backdrop click all close it and hand focus back to
   the trigger, and a modified click (⌘/ctrl/shift/middle) is left alone so
   "open in new tab" still works.

   BINDING: one delegated document-level listener on `a[data-start-explainer]`, so
   it also covers triggers injected AFTER load (products.html paints its fallback
   CTA from JS). Add the attribute to an anchor and it is wired — no per-page code.

   COPY IS OWNER-EDITABLE: every text node carries a data-edit key
   (`start-explainer-*`). Because the markup is injected, we call
   window.dugriEditor.notifyInjected() right after building it so the content editor
   overlays saved text for every visitor and binds the nodes in edit mode (see the
   contract at the top of js/editor.js). Overrides are stored PER PAGE, so the copy
   is edited separately on index / products / product — same defaults everywhere.

   Written as a classic script (no ESM export) so a plain
   `<script src="js/start-explainer.js" defer>` works on every page, including
   products.html which loads no modules. Pure helpers are hung on
   window.__dugriStartExplainer for unit tests; the browser bootstrap only runs when
   the file is loaded as a real <script> (document.currentScript is set), never when
   a test imports it — the same trick editor.js uses. */
(function () {
  'use strict';

  var OVERLAY_ID = 'startExplainer';
  var STYLE_ID = 'dugri-start-explainer-styles';
  // The content bucket every string in this sheet is stored under, on every page it
  // opens from. A ".html" name because that is what the content store accepts as a
  // key; no such page is ever served.
  var CONTENT_SCOPE = 'start-explainer.html';
  // ?explainer=1 opens the sheet on load. It exists for EDIT MODE: the buttons that
  // open this popup are themselves editable text, and edit mode swallows a click on
  // an editable link (it places a caret instead of navigating) — so without this
  // there is no way for the owner to get the sheet on screen to edit what is inside
  // it. The editor's page picker links here (see EDITABLE_PAGES in js/editor.js).
  var OPEN_PARAM = 'explainer';

  // GA4 events. The trigger keeps its own data-ga="order_started" — analytics.js's
  // delegated listener still sees the click (we preventDefault, never
  // stopPropagation), so the existing funnel is untouched. These two are additional:
  // how many shoppers see the briefing, and how many of them go on into the wizard.
  var EV_OPEN = 'order_explainer_opened';
  var EV_CONTINUE = 'order_explainer_continue';

  // Local mirror of analytics.js's track(): that module is ESM and this file is a
  // classic script loaded on pages (products.html) that import no modules. Same
  // guard — gtag queues into dataLayer before GA loads, and is simply absent when
  // consent hasn't loaded it, in which case this is a no-op.
  function track(name, params) {
    if (typeof gtag === 'function') gtag('event', name, params || {});
  }

  // ---- copy -----------------------------------------------------------------
  // The four stages, in her words. Each step's `note` is the soft/secondary aside.
  var TITLE = 'ככה בונים את המשחק - 4 שלבים';
  var SUB = 'לפני שמתחילים, הנה כל מה שמחכה לכם בדרך. זה לוקח כמה דקות.';
  var CONTINUE = 'יאללה, מתחילים ›';
  var STEPS = [
    {
      key: 'step1',
      title: 'התאמה אישית',
      text: 'מתאימים את המשחק שיהיה שלכם: השם של בעל או בעלת השמחה, או כל כותרת שבא לכם - ורואים בזמן אמת איך הקלף הולך להיראות.',
      note: 'אנחנו עדיין בהרצה, אז ייתכן שלא הכול מושלם. אם משהו נתקע או לא ברור - אל תפחדו, שלחו לנו הודעה בוואטסאפ ונסדר.',
    },
    {
      key: 'step2',
      title: '4 תמונות',
      text: 'מעלים 4 תמונות, אנחנו חותכים אותן אוטומטית והן הופכות לפיונים שלכם במשחק. כמה שיותר מצחיקות ואישיות - ככה זה יוצא מושלם.',
    },
    {
      key: 'step3',
      title: 'פרטי קשר',
      text: 'משאירים מייל וטלפון כדי שנכיר אתכם, ונשלח לכם את הקישור לחברים - ככה שתוכלו להתחיל את המסיבה לפני שהיא התחילה.',
    },
    {
      key: 'step4',
      title: 'אוספים מילים',
      text: 'עכשיו תורכם: שולחים לחברים ולמשפחה את הקישור לאיסוף מילים על בעל או בעלת השמחה. כל אחד מוסיף את המילים שלו, ואפשר להוסיף גם בעצמכם בכל רגע.',
    },
  ];

  // ---- pure helpers (unit-tested) -------------------------------------------

  // A "plain" left click is ours to intercept. A modified or non-primary click is
  // the browser's (new tab / new window / paste-and-go), so we must let it through
  // or we'd break "open the wizard in a new tab".
  function isPlainClick(event) {
    if (!event) return false;
    if (event.defaultPrevented) return false;
    if (typeof event.button === 'number' && event.button !== 0) return false;
    return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  // The continue button must go wherever the TRIGGER currently points — read live at
  // open time, because product.js rewrites #pdpBuy.href to
  // options.html?design=<id>&step=2 only once its ?design resolves. Falls back to the
  // bare wizard so a malformed trigger still sells.
  function resolveContinueHref(trigger) {
    var href = trigger && trigger.getAttribute ? trigger.getAttribute('href') : null;
    return href && href.trim() ? href.trim() : 'options.html';
  }

  // Tab-cycle candidates inside the overlay: the X, the WhatsApp link and the
  // continue CTA. [hidden] / aria-hidden nodes are skipped. Deliberately does NOT
  // probe layout (offsetParent) — everything inside an open sheet is visible, and a
  // layout probe would make this untestable under jsdom.
  function focusablesIn(root) {
    if (!root || !root.querySelectorAll) return [];
    var sel = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
      return !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true';
    });
  }

  // Where Tab / Shift+Tab should land, wrapping at both ends. Returns -1 when
  // there is nothing to focus. Pure, so the wrap-around is unit-testable without a
  // real keyboard.
  function nextFocusIndex(count, current, back) {
    if (!count || count < 1) return -1;
    if (current < 0) return back ? count - 1 : 0;
    return back ? (current - 1 + count) % count : (current + 1) % count;
  }

  // ---- markup ---------------------------------------------------------------

  function el(tag, cls, attrs) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    return node;
  }

  // THE continue CTA — one button, once, at the foot of the sheet. It used to be
  // rendered twice (above the steps and after them) because the briefing scrolled and
  // a reader who reached the end had nothing in view; now the briefing fits one
  // screen, so a second copy would just be the same button twice on one page.
  //
  // `data-sx-continue` stays the hook the runtime binds and open() stamps the live
  // href onto, so the button's wiring is unchanged and independent of where it sits.
  function buildCta() {
    var wrap = el('div', 'sx-cta');
    var go = el('a', 'sx-go', {
      href: 'options.html',
      'data-edit': 'start-explainer-continue',
      'data-sx-continue': '',
      'data-testid': 'start-explainer-continue',
    });
    go.textContent = CONTINUE;
    wrap.appendChild(go);
    return wrap;
  }

  // Build the overlay DOM (hidden). Exported for unit tests; the runtime builds it
  // once, lazily, on the first open and then reuses it.
  function buildOverlay(doc) {
    doc = doc || document;
    var overlay = doc.createElement('div');
    overlay.className = 'sx-overlay';
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'sxTitle');
    overlay.setAttribute('data-testid', 'start-explainer');
    // ONE COPY OF THIS TEXT FOR THE WHOLE SITE. Content overrides are stored per
    // page, and this popup opens from index, products and product — so the owner
    // used to have to make the same edit three times, and an edit made on one page
    // silently did not reach the other two. `data-edit-scope` sends everything
    // inside the sheet to its own shared bucket instead (see js/editor.js), so it
    // is written once and read everywhere it appears.
    overlay.setAttribute('data-edit-scope', CONTENT_SCOPE);

    var inner = el('div', 'sx-inner');

    var x = el('button', 'sx-x', {
      type: 'button',
      'aria-label': 'סגירה',
      'data-testid': 'start-explainer-close',
    });
    x.textContent = '×';
    inner.appendChild(x);

    var head = el('div', 'sx-head');
    var h2 = el('h2', null, { id: 'sxTitle', 'data-edit': 'start-explainer-title' });
    h2.textContent = TITLE;
    var sub = el('p', 'sx-sub', { 'data-edit': 'start-explainer-sub' });
    sub.textContent = SUB;
    head.appendChild(h2);
    head.appendChild(sub);
    inner.appendChild(head);

    var list = el('ol', 'sx-steps');
    STEPS.forEach(function (step, i) {
      var li = el('li', 'sx-step', { 'data-testid': 'start-explainer-step' });
      var num = el('span', 'sx-num', { 'aria-hidden': 'true' });
      num.textContent = String(i + 1);
      li.appendChild(num);

      var body = el('div', 'sx-body');
      var h3 = el('h3', null, { 'data-edit': 'start-explainer-' + step.key + '-title' });
      h3.textContent = step.title;
      body.appendChild(h3);
      var p = el('p', null, { 'data-edit': 'start-explainer-' + step.key + '-text' });
      p.textContent = step.text;
      body.appendChild(p);
      if (step.note) {
        var note = el('p', 'sx-note', { 'data-edit': 'start-explainer-' + step.key + '-note' });
        note.textContent = step.note;
        body.appendChild(note);
      }
      li.appendChild(body);
      list.appendChild(li);
    });
    inner.appendChild(list);

    // The continue CTA, after step 4 — the last thing on the page, which is where the
    // reader's eye already is once the briefing is read. `margin-top:auto` parks it
    // against the foot of the sheet when the steps come up short of the viewport,
    // rather than leaving it floating under the last step.
    inner.appendChild(buildCta());

    overlay.appendChild(inner);
    return overlay;
  }

  // ---- styles ---------------------------------------------------------------
  // Injected once from here (same approach as editor.js) so a page opts in with a
  // single <script> tag and no extra <link>. Built on tokens.css: sharp corners
  // (--radius: 0), thin Heebo headings, warm-sand --accent for the numerals.
  function injectStyles(doc) {
    doc = doc || document;
    if (doc.getElementById(STYLE_ID)) return;
    var css = [
      /* Full VIEWPORT sheet, not a small centered modal, and ONE PAGE of it: the
         briefing is sized to land inside a single screen so nothing has to scroll to
         reach the button. 100dvh (not 100vh) is what makes that true on mobile, where
         the URL bar eats the difference. overflow-y:auto stays as a safety valve for
         the cases the scale cannot absorb — a landscape phone, 200% text, or copy the
         owner has made much longer — so the CTA is never unreachable. */
      '.sx-overlay{position:fixed;inset:0;z-index:9000;display:none;',
      'background:var(--bg,#fff);overflow-y:auto;-webkit-overflow-scrolling:touch;',
      'padding:0;}',
      '.sx-overlay.is-open{display:block;}',
      /* ONE NUMBER SETS THE WHOLE SHEET. Every size below is in `em` off this
         font-size, so the briefing scales as a single object: fitSheet() (see the
         runtime) shrinks this one value until the content stops overflowing, which is
         how the one-page promise survives a phone we never measured and copy the
         owner has rewritten. It also means only this line needs the no-`dvh` fallback
         pair that every clamp used to carry — a browser without dvh gets 14px and a
         sheet that is merely un-fitted, not un-padded.
         SAFE AREAS: the home indicator (~34px) and, in the installed app, the notch
         are REAL height that env() reports as 0 in every headless browser — which is
         exactly why this sheet measured as "one page" in tests and scrolled on the
         owner's iPhone. They are read through a variable so a test can simulate a
         phone by setting --sx-safe-b / --sx-safe-t. */
      '.sx-inner{position:relative;box-sizing:border-box;min-height:100vh;min-height:100dvh;',
      'max-width:640px;margin:0 auto;font-size:14px;font-size:clamp(11px,1.75dvh,15.5px);',
      'padding:3.9em 22px 1.2em;',
      'padding:calc(var(--sx-safe-t,env(safe-area-inset-top,0px)) + 3.9em) 22px',
      ' calc(var(--sx-safe-b,env(safe-area-inset-bottom,0px)) + 1.2em);',
      'display:flex;flex-direction:column;gap:1.1em;text-align:right;}',
      /* X — top-LEFT in RTL (the far corner from the text), below any notch.
         MIND THE UNIT: top/left/width/height on this element resolve `em` against
         its OWN font-size (2.05em), not the sheet's. In sheet-em the box is
         0.34x2.05 = 0.7 from the top and 1.5x2.05 = 3.08 tall, i.e. 3.78 — which is
         what the sheet's 3.9em top padding has to clear, or the title rides up
         underneath it. Written with 0.7em here it was 4.5, and it did. */
      '.sx-x{position:absolute;top:0.34em;left:0.34em;',
      'top:calc(var(--sx-safe-t,env(safe-area-inset-top,0px)) + 0.34em);',
      'font-size:2.05em;width:1.5em;height:1.5em;line-height:1;',
      'background:transparent;border:1px solid var(--line,#e6e6e6);',
      'border-radius:var(--radius,0);color:var(--ink,#141414);cursor:pointer;padding:0;}',
      '.sx-x:hover{background:var(--sage-tint,#f0f0f0);}',
      '.sx-head h2{font-family:var(--display,sans-serif);font-weight:var(--h-weight,300);',
      'letter-spacing:var(--h-spacing,0.1em);font-size:1.7em;',
      'line-height:1.28;color:var(--ink,#141414);}',
      '.sx-sub{margin-top:0.45em;color:var(--muted,#6b6b6b);',
      'font-size:1em;line-height:1.5;font-weight:var(--sub-weight,200);}',
      '.sx-steps{list-style:none;display:grid;gap:0.95em;margin:0;padding:0;}',
      /* A BLOCK step with a FLOATED numeral, not a flex row. As a flex row the
         numeral held a ~40px gutter down the whole step, and on a 393px phone that is
         12% of the column taken from every single line of the paragraph beside it —
         several extra wrapped lines per step, which is height the sheet does not
         have. Floated, the numeral costs the width of its own line only, and the text
         reclaims the full column underneath it. */
      '.sx-step{display:block;border-top:1px solid var(--line,#e6e6e6);padding-top:0.85em;}',
      '.sx-step:first-child{border-top:0;padding-top:0;}',
      /* The numeral is the one splash of warm sand. float:right = the inline start in
         this RTL sheet — so the side the TEXT wraps against is the inline END, and
         that is where the gap has to be. It used to be margin-inline-START, which in
         RTL is the right-hand container edge: half an em spent on the outside margin
         while "1" and "התאמה אישית" sat flush against each other on every step. */
      '.sx-num{float:right;margin-inline-end:0.5em;font-family:var(--display,sans-serif);',
      'font-size:2em;line-height:1;font-weight:300;color:var(--accent,#b7a389);}',
      '.sx-body h3{font-family:var(--display,sans-serif);font-weight:400;font-size:1.3em;',
      'letter-spacing:0.02em;color:var(--ink,#141414);margin-bottom:0.3em;line-height:1.3;}',
      '.sx-body p{font-size:1em;line-height:1.5;color:var(--ink,#141414);}',
      /* `.sx-body p.sx-note`, not `.sx-note`: the note IS one of those paragraphs, so
         the plain class (0,1,0) loses to `.sx-body p` (0,1,1) no matter what order
         they are written in — which is why the aside had been rendering at full body
         size in full ink, never small and muted the way it reads here. */
      '.sx-body p.sx-note{margin-top:0.5em;font-size:0.85em;line-height:1.45;',
      'color:var(--muted,#6b6b6b);}',
      /* ONE CTA, at the foot, and ALWAYS on screen. Two rules do that job:
         `margin-top:auto` parks it against the bottom padding when the briefing comes
         up short of the viewport, and `position:sticky;bottom:0` keeps it pinned to
         the bottom edge when it does NOT — a landscape phone, a short window, a
         reader at 200% text. Without the sticky, the single bottom button is simply
         below the fold on those screens and the sheet opens with no visible way
         forward, which is the whole reason a second copy used to sit above the steps.
         The background is opaque because the steps scroll underneath it. */
      '.sx-cta{margin-top:auto;position:sticky;bottom:0;background:var(--bg,#fff);',
      'padding-top:0.6em;}',
      '.sx-go{display:block;width:100%;box-sizing:border-box;text-align:center;',
      'background:var(--sage,#141414);color:#fff;text-decoration:none;',
      'padding:0.95em 26px;border-radius:var(--radius,0);font-size:1.15em;',
      'letter-spacing:0.03em;}',
      '.sx-go:hover{background:var(--sage-deep,#000);}',
      /* Desktop: the column is 640px wide, not ~350, so the same paragraph takes
         barely half the lines and the base size goes back up. The CTA shrinks to its
         own width and aligns with the start edge (right in RTL). */
      '@media (min-width:700px){.sx-inner{font-size:15px;font-size:clamp(13px,1.9dvh,16px);',
      'padding-top:4.6em;',
      'padding-top:calc(var(--sx-safe-t,env(safe-area-inset-top,0px)) + 4.6em);gap:1.5em;}',
      '.sx-head h2{font-size:2em;}',
      '.sx-go{width:auto;display:inline-block;min-width:290px;}}',
      /* Motion is opt-in. The slide-up runs on .sx-inner, never on the fixed
         .sx-overlay: an animated transform on the overlay would move the sheet's own
         box for the first ~200ms (and make it a containing block for its
         descendants), so the full-bleed geometry is kept animation-free. */
      '@media (prefers-reduced-motion: no-preference){',
      '.sx-overlay.is-open{animation:sx-fade .18s var(--ease,ease) both;}',
      '.sx-overlay.is-open .sx-inner{animation:sx-rise .24s var(--ease,ease) both;}',
      '@keyframes sx-fade{from{opacity:0;}to{opacity:1;}}',
      '@keyframes sx-rise{from{transform:translateY(9px);}to{transform:none;}}}',
      /* Background scroll lock while the sheet is open. */
      'html.sx-locked,body.sx-locked{overflow:hidden;}',
      /* EDIT MODE: the editor's own toolbar is fixed across the foot of the screen,
         and the sheet's last editable string — the continue button's label — sits
         exactly there. Reserve the toolbar's height so the owner can reach the one
         piece of copy she would otherwise have to edit from underneath it. The class
         is set by js/editor.js and exists only while she is editing. */
      'html.dugri-editing .sx-inner{padding-bottom:96px;}',
    ].join('');
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    doc.head.appendChild(style);
  }

  // ---- runtime --------------------------------------------------------------

  function start() {
    injectStyles(document);

    var overlay = null;
    var goBtn = null; // the one [data-sx-continue]
    var lastTrigger = null;

    function onContinue() {
      // `place` is kept, pinned to 'bottom'. The sheet has one CTA now, so the field
      // no longer distinguishes anything — but order_explainer_continue has been
      // reporting it since the two-copy version, and dropping a dimension mid-stream
      // silently splits the existing GA4 funnel report in two. It stays until the
      // owner retires the breakdown on her side.
      track(EV_CONTINUE, {
        cta: (lastTrigger && lastTrigger.dataset.gaCta) || 'unknown',
        place: 'bottom',
      });
      // Let the anchor navigate normally; no preventDefault. The overlay is torn
      // down first so a bfcache back-navigation doesn't restore it wide open.
      close({ keepFocus: true });
    }

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = buildOverlay(document);
      document.body.appendChild(overlay);
      goBtn = overlay.querySelector('[data-sx-continue]');

      overlay.querySelector('.sx-x').addEventListener('click', function () {
        close();
      });
      // A click on the sheet's margin (outside .sx-inner) closes too.
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close();
      });
      goBtn.addEventListener('click', onContinue);
      // Keyboard handling sits on the DOCUMENT, not the overlay: after a backdrop
      // click focus can land on <body>, and a listener bound to the overlay would
      // never see the Escape. Guarded by is-open so it is inert when closed.
      document.addEventListener('keydown', onKeydown);

      // The markup was injected AFTER editor.js's initial scan — hand it over so the
      // owner's saved copy is overlaid for every visitor and bound in edit mode.
      if (window.dugriEditor && typeof window.dugriEditor.notifyInjected === 'function') {
        window.dugriEditor.notifyInjected();
        // The owner's copy can be longer than the shipped default, so the sheet is
        // re-fitted once it has landed. onReady fires immediately when the overrides
        // are already in hand, and later when the sheet was opened mid-fetch.
        if (typeof window.dugriEditor.onReady === 'function') {
          window.dugriEditor.onReady(function () {
            fitSheet();
          });
        }
      }
      return overlay;
    }

    function onKeydown(e) {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: the sheet covers the whole viewport, so Tab must never reach
      // the page behind it.
      var items = focusablesIn(overlay);
      if (!items.length) return;
      var current = items.indexOf(document.activeElement);
      var next = nextFocusIndex(items.length, current, e.shiftKey);
      if (next < 0) return;
      e.preventDefault();
      items[next].focus();
    }

    // ONE PAGE, MEASURED — not predicted. Every size in the sheet is an `em` off
    // .sx-inner's font-size, so shrinking that one value shrinks the whole briefing
    // proportionally. This walks it down until the content stops overflowing.
    //
    // It exists because a CSS-only scale cannot see what the sheet is actually being
    // asked to fit into. Two things it misses, both of which put the owner's iPhone
    // into a scroll while every headless measurement said "one page":
    //   • the home indicator (~34px) and, in the installed app, the notch — real
    //     height that env() reports as 0 in every test browser;
    //   • the copy, which is owner-editable: one longer sentence and a tuned-by-hand
    //     scale is out of date.
    // Measuring covers both, and anything else we never thought of.
    //
    // The floor is the point below which the briefing is no longer worth reading; a
    // sheet that cannot fit above it keeps its scroll, with the CTA still pinned by
    // position:sticky. Steps of 0.25px, so the result is the largest size that fits
    // rather than a jump past it.
    // The size range the briefing may be set at. The fit starts at the CEILING and
    // walks down to the largest size that fits, so a tall phone gets the big
    // comfortable type and a short one gets exactly as much as it can carry — rather
    // than whatever a viewport-height formula guessed in advance. Below the floor the
    // briefing is not worth reading, so the sheet keeps its scroll instead (the CTA
    // stays reachable: position:sticky pins it).
    var FIT_FLOOR_PX = 11.5;
    var FIT_CEIL_PX = 15.5;
    var FIT_CEIL_WIDE_PX = 16;
    var fitTimer = null;
    // How much taller than the screen the briefing currently is.
    //
    // Measured as the SHEET's own content height against the overlay's box, never as
    // the overlay's scrollHeight: the sheet enters with a 9px translateY (keyframes
    // sx-rise), and a transform on the scroll container's child counts toward that
    // container's scrollable overflow. Reading it there reports 9px of overflow that
    // no reader ever sees — and a fitting loop believes it, shrinking the whole
    // briefing to the floor on a desktop with room to spare. An element's own
    // scrollHeight is unaffected by its own transform.
    function sheetOverflow(inner) {
      return inner.scrollHeight - overlay.clientHeight;
    }
    function fitSheet() {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      var inner = overlay.querySelector('.sx-inner');
      if (!inner) return;
      // From the top every time: the sheet may be re-fitting because the phone
      // rotated INTO more room, and it must be free to grow back.
      var size = window.innerWidth >= 700 ? FIT_CEIL_WIDE_PX : FIT_CEIL_PX;
      inner.style.fontSize = size + 'px';
      var guard = 0;
      // 2px of slack: dvh and the overlay's box can disagree by a pixel while a
      // mobile URL bar is mid-collapse, and chasing that would shrink the type for
      // no one's benefit.
      while (sheetOverflow(inner) > 2 && size > FIT_FLOOR_PX && guard < 40) {
        size = Math.max(FIT_FLOOR_PX, size - 0.25);
        inner.style.fontSize = size + 'px';
        guard += 1;
      }
    }

    // Re-fit when the room changes (rotation, a desktop window drag, the mobile URL
    // bar collapsing) and when a late web font finally lands with different metrics.
    // Both are cheap and both are no-ops while the sheet is closed.
    window.addEventListener('resize', fitSheet);
    window.addEventListener('orientationchange', fitSheet);
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(fitSheet);
    }

    function open(trigger) {
      ensureOverlay();
      lastTrigger = trigger;
      // Live read: product.js may have rewritten the trigger's href (design + step),
      // so the button is re-stamped on every open with the URL THIS trigger asks for.
      goBtn.setAttribute('href', resolveContinueHref(trigger));
      overlay.classList.add('is-open');
      document.documentElement.classList.add('sx-locked');
      document.body.classList.add('sx-locked');
      overlay.scrollTop = 0;
      // After is-open: the sheet has no layout to measure while it is display:none.
      fitSheet();
      // Focus the X: it is first in the tab order and announces the dialog without
      // reading the whole sheet before the user asks for it.
      var x = overlay.querySelector('.sx-x');
      if (x) x.focus();
      track(EV_OPEN, { cta: (trigger && trigger.dataset.gaCta) || 'unknown' });
    }

    function close(opts) {
      if (!overlay || !overlay.classList.contains('is-open')) return;
      overlay.classList.remove('is-open');
      document.documentElement.classList.remove('sx-locked');
      document.body.classList.remove('sx-locked');
      // Focus returns to the trigger the shopper came from — except when we are
      // closing because they hit continue and the page is already navigating.
      if (!(opts && opts.keepFocus) && lastTrigger && typeof lastTrigger.focus === 'function') {
        lastTrigger.focus();
      }
    }

    // ?explainer=1 — open on load, without a click. The trigger it "came from" is
    // whichever wizard CTA this page has, so continue still carries that page's own
    // href; a page with no trigger falls back to the bare wizard.
    function autoOpen() {
      var params = new URLSearchParams(location.search || '');
      if (params.get(OPEN_PARAM) !== '1') return;
      open(document.querySelector('a[data-start-explainer]'));
    }
    autoOpen();

    // While the owner is retyping the copy in edit mode, keep the sheet fitted to
    // the screen as she types — the one-page promise is about HER text, and the
    // most useful moment to show whether it still holds is while she is writing it.
    document.addEventListener('input', function (e) {
      if (!overlay || !overlay.contains(e.target)) return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitSheet, 180);
    });

    // One delegated listener covers triggers that exist now AND ones injected later
    // (products.html renders its fallback CTA from JS).
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest && e.target.closest('a[data-start-explainer]');
      if (!trigger) return;
      if (!isPlainClick(e)) return; // ⌘/ctrl/middle click → let the browser have it
      e.preventDefault(); // NOT stopPropagation: analytics.js still logs order_started
      open(trigger);
    });

    return { open: open, close: close };
  }

  var api = {
    isPlainClick: isPlainClick,
    resolveContinueHref: resolveContinueHref,
    focusablesIn: focusablesIn,
    nextFocusIndex: nextFocusIndex,
    buildOverlay: buildOverlay,
    injectStyles: injectStyles,
    start: start,
    STEPS: STEPS,
  };
  if (typeof window !== 'undefined') window.__dugriStartExplainer = api;

  // Only bootstrap when loaded as a real <script> — an ESM import in a unit test
  // leaves document.currentScript null and gets the pure helpers, nothing else.
  if (typeof document !== 'undefined' && document.currentScript) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
})();
