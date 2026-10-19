// The redesign's shell for the pages not built in it yet (docs/redesign-mode.md is the guide; css/redesign.css has the look).
// Loaded with defer, only in redesign mode: the server's gate (server/redesign-gate.js) adds it, with class="rd" on <html>, when
// the setting redesign.enabled is on or the visitor previews with ?rd=1. ES5, so the owner's old Safari runs it.
// A page's HTML is never edited for the mode: a page tells the shell what it wants from its own /css/rd/<page>.css, through
// custom properties on html.rd (read here once, at start):
//   --rd-header: replace | top | none        the shared header in place of the page's own (default: replace, when there is one)
//   --rd-header-replace: '<selector>'        which element is the page's own header (default 'header.hdr')
//   --rd-footer: replace | end | none        the shared footer (default none: a page's own footer holds the owner's contacts)
//   --rd-footer-replace: '<selector>'        which element is the page's own footer (default 'body > footer')
//   --rd-as-<component>: '<selectors>'       the page's own elements that take a shared component's look, e.g.
//                                            --rd-as-btn: '.cta, .next'; the shell adds the class, now and as the page adds more
// What it does, once per page:
//   1. a page already built in the redesign (new.html, new-faq.html, served at / in the mode too) is marked html.rd-native and
//      left alone
//   2. <dialog> and replaceChildren for Safari before 15.4 / 14 (the same fallbacks as js/home-legacy.js)
//   3. the shared header (logo, ≡ and the order button, with the menu sheet) and footer; a page's own stays in the DOM, hidden,
//      so its ids, scripts (header.js) and tests keep working
//   4. the component classes from --rd-as-*
//   5. window.dugriRd.toast(text)
(function () {
  var doc = document;
  var root = doc.documentElement;
  if (window.__dugriRdShell || !/(^|\s)rd(\s|$)/.test(root.className)) return;
  window.__dugriRdShell = true;

  var NATIVE = ['new.html', 'new-faq.html'];
  var meta = doc.querySelector('meta[name="dugri:page"]');
  if (meta && NATIVE.indexOf(meta.getAttribute('content')) > -1) {
    root.className += ' rd-native';
    return;
  }

  // ---------- 2. old Safari ----------
  var Dlg = window.HTMLDialogElement;
  if (!Dlg || typeof Dlg.prototype.showModal !== 'function') {
    root.className += ' no-dialog';
    var proto = (Dlg || window.HTMLUnknownElement || window.HTMLElement).prototype;
    var fire = function (el, type, cancelable) {
      var ev = doc.createEvent('Event');
      ev.initEvent(type, false, !!cancelable);
      return el.dispatchEvent(ev);
    };
    var modals = [];
    var openDlg = function (el, modal) {
      if (el.hasAttribute('open')) return;
      el.setAttribute('open', '');
      if (!modal) return;
      var bd = doc.createElement('div');
      bd.className = 'dlg-bd';
      bd.addEventListener('click', function () {
        if (fire(el, 'cancel', true)) el.close();
      });
      el.parentNode.insertBefore(bd, el);
      el._bd = bd;
      el._back = doc.activeElement;
      modals.push(el);
      var first = el.querySelector('[autofocus], button, a[href], input, select, textarea');
      if (first) first.focus();
    };
    Object.defineProperty(proto, 'open', {
      configurable: true,
      get: function () {
        return this.hasAttribute('open');
      },
      set: function (v) {
        if (v) this.setAttribute('open', '');
        else this.removeAttribute('open');
      },
    });
    proto.show = function () {
      openDlg(this, false);
    };
    proto.showModal = function () {
      openDlg(this, true);
    };
    proto.close = function (value) {
      if (!this.hasAttribute('open')) return;
      if (value !== undefined) this.returnValue = value;
      this.removeAttribute('open');
      if (this._bd) {
        this._bd.parentNode.removeChild(this._bd);
        this._bd = null;
      }
      var i = modals.indexOf(this);
      if (i > -1) modals.splice(i, 1);
      if (this._back && this._back.focus) this._back.focus();
      this._back = null;
      fire(this, 'close', false);
    };
    doc.addEventListener('keydown', function (e) {
      var top = modals[modals.length - 1];
      if (!top || (e.key !== 'Escape' && e.key !== 'Esc')) return;
      e.preventDefault();
      if (fire(top, 'cancel', true)) top.close();
    });
  }
  var withReplace = [window.Element, window.Document, window.DocumentFragment];
  for (var r = 0; r < withReplace.length; r++) {
    var P = withReplace[r] && withReplace[r].prototype;
    if (!P || P.replaceChildren) continue;
    P.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var j = 0; j < arguments.length; j++) {
        var n = arguments[j];
        this.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
      }
    };
  }

  // ---------- 3, 4. header and footer ----------
  // In the mode / is the redesigned homepage (new.html): its sections are the designs (#order), the story, the reviews, business
  var LINKS = [
    // [href, label, the nav_click target GA reports it under (the same names as the homepage's own menu)]
    ['/#order', 'העיצובים', 'designs'],
    ['how.html', 'איך זה עובד', 'how'],
    ['/#recs', 'ממליצים עלינו', 'recs'],
    ['new-faq.html', 'שאלות נפוצות', 'faq'],
    ['pickup.html', 'איסוף עצמי', 'pickup'],
    ['/#biz', 'פניות עסקיות', 'biz'],
  ];
  var here = (location.pathname.split('/').pop() || '').toLowerCase();
  var ICON =
    '<svg viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
    '<path class="l1" d="M24 8H4"/><path class="l2" d="M24 14H4"/><path class="l3" d="M24 20H4"/></svg>';
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  function headerHtml() {
    return (
      '<div class="rd-start">' +
      '<button class="rd-menu-btn" id="rdMenuBtn" type="button" aria-label="תפריט" aria-haspopup="dialog"' +
      ' aria-expanded="false" aria-controls="rdMenu" data-ga="menu_open">' +
      ICON +
      '</button>' +
      '<a class="rd-logo" href="/" data-ga="nav_click" data-ga-target="home" data-ga-where="header"><img src="/assets/logo-pink-original.png" alt="דוגרי, לעמוד הבית" /></a>' +
      '</div>' +
      '<a class="rd-btn" href="/#order" data-ga="nav_order">הזמינו עכשיו</a>'
    );
  }

  function menuHtml() {
    var items = '';
    for (var i = 0; i < LINKS.length; i++) {
      var cur = LINKS[i][0] === here ? ' aria-current="page"' : '';
      items +=
        '<li><a href="' +
        esc(LINKS[i][0]) +
        '" data-ga="nav_click" data-ga-target="' +
        LINKS[i][2] +
        '" data-ga-where="menu"' +
        cur +
        '>' +
        esc(LINKS[i][1]) +
        '</a></li>';
    }
    return (
      '<button class="rd-x" type="button" id="rdMenuX" aria-label="סגירת התפריט">✕</button>' +
      '<nav aria-label="ניווט"><ul>' +
      items +
      '</ul></nav>' +
      '<a class="rd-btn block" href="/#order" data-ga="nav_order" data-ga-where="menu">הזמינו עכשיו</a>'
    );
  }

  var foot = function (target) {
    return ' data-ga="nav_click" data-ga-target="' + target + '" data-ga-where="footer"';
  };
  function footerHtml() {
    return (
      '<span><a href="terms.html"' +
      foot('terms') +
      '>תקנון ותנאי שימוש</a><a href="new-faq.html"' +
      foot('faq') +
      '>שאלות נפוצות</a>' +
      '<a href="pickup.html"' +
      foot('pickup') +
      '>איסוף עצמי</a></span>' +
      '<img src="/assets/logo-pink-original.png" alt="" />'
    );
  }

  // focus stays inside the open menu and visits every link and button (Safari's own Tab skips links by default)
  function trapTab(dlg) {
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var all = dlg.querySelectorAll('a[href], button:not([disabled])');
      var f = [];
      for (var i = 0; i < all.length; i++) if (all[i].offsetParent !== null) f.push(all[i]);
      if (!f.length) return;
      e.preventDefault();
      var k = f.indexOf(doc.activeElement);
      f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    });
  }

  function mountMenu(btn) {
    var menu = doc.createElement('dialog');
    menu.className = 'rd-menu';
    menu.id = 'rdMenu';
    menu.setAttribute('aria-label', 'תפריט');
    menu.innerHTML = menuHtml();
    doc.body.appendChild(menu);
    btn.addEventListener('click', function () {
      menu.showModal();
      btn.setAttribute('aria-expanded', 'true');
    });
    menu.addEventListener('close', function () {
      btn.setAttribute('aria-expanded', 'false');
    });
    menu.querySelector('#rdMenuX').addEventListener('click', function () {
      menu.close();
    });
    menu.addEventListener('click', function (e) {
      if (e.target === menu) menu.close(); // the dimmed page around the sheet
    });
    var links = menu.querySelectorAll('a');
    for (var i = 0; i < links.length; i++)
      links[i].addEventListener('click', function () {
        menu.close();
      });
    trapTab(menu);
  }

  // a page's settings: a custom property's value, without the quotes a string needs in CSS
  var cs = window.getComputedStyle(root);
  var conf = function (name, dflt) {
    var v = (cs.getPropertyValue(name) || '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    return v || dflt;
  };
  var pick = function (sel) {
    try {
      return doc.querySelector(sel);
      // eslint-disable-next-line no-unused-vars -- ES5 has no catch without a binding
    } catch (e) {
      return null; // a selector this browser cannot read
    }
  };

  var body = doc.body;
  var hMode = conf('--rd-header', 'replace');
  if (hMode !== 'none') {
    var old = pick(conf('--rd-header-replace', 'header.hdr'));
    if (hMode === 'top' || old) {
      var hdr = doc.createElement('header');
      hdr.className = 'rd-hdr';
      hdr.innerHTML = headerHtml();
      if (hMode === 'replace' && old) {
        old.parentNode.insertBefore(hdr, old);
        old.setAttribute('data-rd-replaced', '');
        root.className += ' rd-hdr-swapped';
      } else body.insertBefore(hdr, body.firstChild);
      mountMenu(hdr.querySelector('#rdMenuBtn'));
    }
  }
  var fMode = conf('--rd-footer', 'none');
  if (fMode !== 'none') {
    var oldF = pick(conf('--rd-footer-replace', 'body > footer'));
    if (fMode === 'end' || oldF) {
      var ftr = doc.createElement('footer');
      ftr.className = 'rd-ftr';
      ftr.innerHTML = footerHtml();
      if (fMode === 'replace' && oldF) {
        oldF.parentNode.insertBefore(ftr, oldF);
        oldF.setAttribute('data-rd-replaced', '');
      } else body.appendChild(ftr);
    }
  }

  // ---------- 4. the page's own elements in a shared component's look ----------
  var AS = {
    btn: 'rd-btn',
    'btn-secondary': 'rd-btn secondary',
    'btn-ghost': 'rd-btn ghost',
    'btn-arrow': 'rd-btn arrow',
    field: 'rd-field',
    select: 'rd-select',
    check: 'rd-check',
    card: 'rd-card',
    'card-hot': 'rd-card hot',
    box: 'rd-box',
    tag: 'rd-tag',
    chip: 'rd-chip',
    title: 'rd-title',
    x: 'rd-x',
    price: 'rd-price',
    steps: 'rd-steps',
    sheet: 'rd-sheet',
  };
  var maps = [];
  for (var key in AS) {
    if (!Object.prototype.hasOwnProperty.call(AS, key)) continue;
    var sel = conf('--rd-as-' + key, '');
    if (sel) maps.push([sel, AS[key].split(' ')]);
  }
  var applyAs = function (scope) {
    for (var m = 0; m < maps.length; m++) {
      var els;
      try {
        els = scope.querySelectorAll(maps[m][0]);
        // eslint-disable-next-line no-unused-vars -- ES5 has no catch without a binding
      } catch (e) {
        continue;
      }
      for (var k = 0; k < els.length; k++)
        for (var c = 0; c < maps[m][1].length; c++) els[k].classList.add(maps[m][1][c]);
    }
  };
  if (maps.length) {
    applyAs(doc);
    // the wizard and the word lists draw more as you go: give what they add the same look
    var queued = false;
    if (window.MutationObserver)
      new MutationObserver(function () {
        if (queued) return; // one pass per frame, however many nodes arrived
        queued = true;
        window.requestAnimationFrame(function () {
          queued = false;
          applyAs(doc);
        });
      }).observe(body, { childList: true, subtree: true });
  }

  // ---------- 5. the page's API ----------
  var toastEl = null;
  var toastTimer = 0;
  window.dugriRd = {
    toast: function (text, ms) {
      if (!toastEl) {
        toastEl = doc.createElement('div');
        toastEl.className = 'rd-toast';
        toastEl.setAttribute('role', 'status');
        body.appendChild(toastEl);
      }
      toastEl.textContent = text;
      toastEl.className = 'rd-toast';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.className = 'rd-toast out';
      }, ms || 3200);
    },
  };
})();
