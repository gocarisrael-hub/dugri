// The friend coupon's offer on collect.html (Agent A).
//
// A FRIEND — someone who opened a shared collect link (?c= with no owner token)
// and added a word — sees a black bar slide up: "אהבתם?". Tapping "תראו לי"
// opens a sheet that reveals the percent (never on the bar) and asks for an
// email; the server issues a personal single-use code and mails it
// (POST /api/friend-coupon, server/routes/commerce.js).
//
// Who never sees it:
//   - the collection's owner. On her managing link (?k=) that is obvious; on the
//     plain link she shares, this browser remembers it opened the managing link
//     before (OWNED_PREFIX), which covers "she tapped her own WhatsApp link".
//   - anyone who dismissed it (×) or already got a code, on this browser, for
//     good (DONE_KEY). Blocked storage only means it may come back next visit.
//   - everyone, while the owner has switched the offer off (GET /api/friend-coupon).
//
// It never covers the word input or the list: while it is up the page's bottom
// padding grows by its height (--friend-bar-h, read by collect.html's body
// padding and the WhatsApp button), and it steps aside while any text field on
// the page has focus, so a phone keyboard can never put it over the box she is
// typing in.
//
// Everything is built here, styles included, so collect.html carries one import
// and one call. Selectors are scoped under the two ids because collect.html's
// own global `button` rules are specific enough to win over a bare class.

const DONE_KEY = 'dugri:friendbar:done';
const OWNED_PREFIX = 'dugri:owned:';

// The same rule the server applies (server/friend-coupons.js isValidEmail).
export function isValidEmail(s) {
  const e = String(s == null ? '' : s)
    .trim()
    .toLowerCase();
  return !!e && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function store(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback; // in-app browsers that refuse storage
  }
}

function track(name, params) {
  if (typeof gtag === 'function') gtag('event', name, params);
}

const CSS = `
#friendBar{position:fixed;inset-inline:0;bottom:0;z-index:56;display:flex;align-items:center;gap:12px;
  background:#141414;color:#fff;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));
  box-shadow:0 -6px 22px rgba(0,0,0,.18);transform:translateY(110%);transition:transform .32s cubic-bezier(.2,.8,.2,1)}
#friendBar.fb-in{transform:translateY(0)}
#friendBar.fb-aside{transform:translateY(110%)}
#friendBar .fb-text{display:flex;flex-direction:column;line-height:1.25;min-width:0}
#friendBar .fb-main{font-size:18px;font-weight:300}
#friendBar .fb-small{font-size:13.5px;font-weight:300;opacity:.85}
#friendBar button.fb-go{margin-inline-start:auto;background:#fff;color:#141414;border:1.5px solid #fff;border-radius:0;
  font:inherit;font-weight:500;font-size:15px;padding:10px 18px;white-space:nowrap}
#friendBar button.fb-x{background:none;border:0;color:#fff;font-size:24px;line-height:1;padding:4px 6px;border-radius:0}
#friendBar button.fb-x::before,#friendSheet button.fs-x::before{display:none}
#friendSheet{position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}
#friendSheet[hidden]{display:none}
#friendSheet .fs-card{position:relative;background:#fff;color:#141414;width:min(520px,100%);max-height:92vh;overflow:auto;
  padding:28px 22px calc(24px + env(safe-area-inset-bottom,0px));border-radius:0;box-shadow:0 -10px 40px rgba(0,0,0,.25)}
#friendSheet h2{font-size:26px;font-weight:300;line-height:1.2;margin:0 0 8px}
#friendSheet p{font-size:15.5px;line-height:1.6;margin:0 0 16px;color:#141414}
#friendSheet label.fs-label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}
#friendSheet input[type=email]{width:100%;font:inherit;font-size:16px;padding:12px;border:1.5px solid #141414;border-radius:0;
  background:#fff;color:#141414;direction:ltr;text-align:left}
#friendSheet .fs-err{color:#b3261e;font-size:13.5px;min-height:20px;margin:6px 0 4px}
#friendSheet .fs-consent{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.5;margin:6px 0 18px}
#friendSheet .fs-consent input{width:18px;height:18px;margin-top:2px;accent-color:#141414;flex:none}
#friendSheet button.fs-go{width:100%;background:#141414;color:#fff;border:1.5px solid #141414;border-radius:0;
  font:inherit;font-size:16px;font-weight:500;padding:14px 18px}
#friendSheet button.fs-go:disabled{opacity:.35;cursor:default}
#friendSheet button.fs-x{position:absolute;top:10px;inset-inline-end:10px;background:none;border:0;color:#141414;
  font-size:26px;line-height:1;padding:4px 8px;border-radius:0}
#friendSheet .fs-code{display:block;margin:4px auto 18px;width:max-content;max-width:100%;border:2px dashed var(--accent,#b7a389);
  background:#f6f1e8;padding:12px 24px;font-size:24px;letter-spacing:3px;direction:ltr;font-weight:400}
@media (prefers-reduced-motion: reduce){#friendBar{transition:none}}
`;

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) n.setAttribute(k, '');
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  if (text != null) n.textContent = text;
  return n;
}

// Wire the offer for one collection. Returns { wordAdded() }, which the page
// calls after every successful add; the first one (on a friend's browser, with
// the offer on) brings the bar up. Every other case returns a no-op.
export function initFriendBar({ collectionId, isOwner, fetchImpl } = {}) {
  const noop = { wordAdded() {} };
  if (!collectionId) return noop;
  if (isOwner) {
    store(() => localStorage.setItem(OWNED_PREFIX + collectionId, '1'));
    return noop;
  }
  if (store(() => localStorage.getItem(OWNED_PREFIX + collectionId), null)) return noop;
  if (store(() => localStorage.getItem(DONE_KEY), null)) return noop;

  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let offer = null; // { enabled, percent } once asked
  let shown = false;
  let done = false;
  let bar = null;
  let sheet = null;
  let keyboardUp = false;

  const markDone = () => {
    done = true;
    store(() => localStorage.setItem(DONE_KEY, '1'));
  };

  function syncHeight() {
    const h = bar && shown && !done && !keyboardUp ? bar.offsetHeight : 0;
    document.documentElement.style.setProperty('--friend-bar-h', h + 'px');
  }

  function hideBar() {
    if (!bar) return;
    bar.classList.remove('fb-in');
    syncHeight();
    setTimeout(() => bar && bar.remove(), 400);
  }

  function buildBar() {
    if (!document.getElementById('friendBarCss')) {
      const style = el('style', { id: 'friendBarCss' });
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    bar = el('div', { id: 'friendBar', 'data-testid': 'friend-bar', role: 'region' });
    bar.setAttribute('aria-label', 'מתנה קטנה');
    const text = el('div', { class: 'fb-text' });
    text.append(
      el('span', { class: 'fb-main' }, 'אהבתם?'),
      el('span', { class: 'fb-small' }, 'יש לנו מתנה קטנה בשבילכם')
    );
    const go = el(
      'button',
      { type: 'button', class: 'fb-go', 'data-testid': 'friend-bar-go' },
      'תראו לי'
    );
    const x = el('button', {
      type: 'button',
      class: 'fb-x',
      'aria-label': 'סגירה',
      'data-testid': 'friend-bar-x',
    });
    x.textContent = '×';
    bar.append(text, go, x);
    go.addEventListener('click', () => {
      track('friend_bar_click', { collection_id: collectionId });
      openSheet();
    });
    x.addEventListener('click', () => {
      track('friend_bar_dismiss', { collection_id: collectionId });
      markDone();
      hideBar();
    });
    document.body.appendChild(bar);
    // Step aside while the ON-SCREEN KEYBOARD is up, which would otherwise lift
    // the bar over the very box she is typing in, and come back when it goes
    // down. Read from the visual viewport, not from focus: the page refocuses
    // the word box after every add, and on an iPhone a programmatic focus opens
    // no keyboard — a focus rule would hide the bar with nothing to hide it
    // from. The keyboard is "a visual viewport well short of the tallest one
    // seen", which holds both where the keyboard overlays the page (iOS) and
    // where it resizes it (Android). No visualViewport, no keyboard to dodge:
    // the page's bottom padding already keeps everything clear.
    const vv = window.visualViewport;
    if (vv) {
      let tallest = vv.height;
      const check = () => {
        tallest = Math.max(tallest, vv.height);
        const up = vv.height < tallest * 0.75;
        if (up === keyboardUp) return;
        keyboardUp = up;
        if (bar) bar.classList.toggle('fb-aside', up);
        syncHeight();
      };
      vv.addEventListener('resize', check);
      check();
    }
    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(syncHeight).observe(bar);
    }
    window.addEventListener('resize', syncHeight);
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.hidden = true;
    sheet.remove();
    sheet = null;
  }

  function openSheet() {
    closeSheet();
    const percent = offer && offer.percent;
    sheet = el('div', { id: 'friendSheet', 'data-testid': 'friend-sheet' });
    const card = el('div', {
      class: 'fs-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'friendSheetTitle',
    });
    const x = el('button', {
      type: 'button',
      class: 'fs-x',
      'aria-label': 'סגירה',
      'data-testid': 'friend-sheet-x',
    });
    x.textContent = '×';
    x.addEventListener('click', closeSheet);
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) closeSheet();
    });
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSheet();
    });

    const form = el('form', { novalidate: true });
    const title = el('h2', { id: 'friendSheetTitle' }, percent + '% הנחה, רק לכם');
    const lead = el('p', {}, 'השאירו מייל ונשלח לכם קופון אישי לשימוש אחד.');
    const label = el('label', { class: 'fs-label', for: 'friendEmail' }, 'מייל');
    const input = el('input', {
      type: 'email',
      id: 'friendEmail',
      name: 'email',
      autocomplete: 'email',
      inputmode: 'email',
      'data-testid': 'friend-email',
      required: true,
    });
    const err = el('div', { class: 'fs-err', role: 'alert', 'data-testid': 'friend-err' });
    const consentRow = el('label', { class: 'fs-consent' });
    const consent = el('input', { type: 'checkbox', 'data-testid': 'friend-consent' });
    consentRow.append(consent, el('span', {}, 'אשמח לקבל מדי פעם עדכונים ומבצעים מדוגרי'));
    const send = el(
      'button',
      { type: 'submit', class: 'fs-go', disabled: true, 'data-testid': 'friend-send' },
      'שלחו לי את הקופון'
    );
    form.append(title, lead, label, input, err, consentRow, send);
    card.append(x, form);
    sheet.appendChild(card);
    document.body.appendChild(sheet);

    const BAD_EMAIL = 'נראה שחסר משהו במייל. בדקו שוב';
    input.addEventListener('input', () => {
      send.disabled = !isValidEmail(input.value);
      if (!send.disabled) err.textContent = '';
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() && !isValidEmail(input.value)) err.textContent = BAD_EMAIL;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!isValidEmail(input.value)) {
        err.textContent = BAD_EMAIL;
        return;
      }
      send.disabled = true;
      err.textContent = '';
      const email = input.value.trim();
      let res;
      let body = {};
      try {
        res = await doFetch('/api/friend-coupon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            collection_id: collectionId,
            marketing_consent: consent.checked === true,
          }),
        });
        body = await res.json().catch(() => ({}));
      } catch {
        res = null;
      }
      if (!res || !res.ok) {
        send.disabled = false;
        if (res && res.status === 400) err.textContent = BAD_EMAIL;
        else if (res && res.status === 429) err.textContent = 'יותר מדי ניסיונות. נסו שוב בעוד שעה';
        else err.textContent = 'משהו השתבש. נסו שוב';
        return;
      }
      if (body.used) {
        send.disabled = false;
        err.textContent = 'הקופון הזה כבר נוצל';
        return;
      }
      // Issued (or resent). Analytics gets the collection, never the email.
      track('friend_coupon_sent', { collection_id: collectionId });
      markDone();
      hideBar();
      showConfirmation(card, email, body);
    });
    setTimeout(() => input.focus(), 50);
  }

  function showConfirmation(card, email, body) {
    const pct = body.percent != null ? body.percent : offer && offer.percent;
    card.replaceChildren();
    const x = el('button', { type: 'button', class: 'fs-x', 'aria-label': 'סגירה' });
    x.textContent = '×';
    x.addEventListener('click', closeSheet);
    const wrap = el('div', { 'data-testid': 'friend-confirm' });
    // The mail did not go out (Resend down, the address unsubscribed): the code
    // was made all the same, so it goes on the screen rather than nowhere.
    const failed = body.created && body.emailed === false;
    wrap.append(
      el('h2', { id: 'friendSheetTitle' }, failed ? 'הנה הקופון שלכם' : 'הקופון בדרך'),
      el(
        'p',
        {},
        failed
          ? 'לא הצלחנו לשלוח את המייל כרגע, אז הנה הקוד. ' + pct + '% הנחה, לשימוש אחד.'
          : 'שלחנו קוד אישי אל ' + email + '. ' + pct + '% הנחה, לשימוש אחד.'
      )
    );
    if (body.code)
      wrap.append(el('div', { class: 'fs-code', 'data-testid': 'friend-code' }, body.code));
    const back = el('button', { type: 'button', class: 'fs-go' }, 'חזרה להוספת מילים');
    back.addEventListener('click', () => {
      closeSheet();
      const w = document.getElementById('wordInput');
      if (w && typeof w.focus === 'function') w.focus();
    });
    wrap.append(back);
    card.append(x, wrap);
  }

  async function ensureOffer() {
    if (offer) return offer;
    try {
      const r = await doFetch('/api/friend-coupon');
      offer = r && r.ok ? await r.json() : { enabled: false };
    } catch {
      offer = { enabled: false };
    }
    return offer;
  }

  return {
    async wordAdded() {
      if (shown || done) return;
      shown = true;
      const o = await ensureOffer();
      if (!o || !o.enabled || !o.percent) return;
      buildBar();
      // Next frame, so the slide-up actually animates from below the fold.
      requestAnimationFrame(() => {
        if (!bar) return;
        bar.classList.add('fb-in');
        syncHeight();
      });
      track('friend_bar_shown', { collection_id: collectionId });
    },
  };
}
