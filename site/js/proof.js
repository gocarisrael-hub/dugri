// The buyer's proof screen: every page of her produced deck, read out of the PDF.
//
// There is deliberately no drawing code in here. The pages arrive as images the
// server rendered from the file the print shop will get, so this module only has
// to fetch, lay out and enlarge them. Anything that redrew a card here could
// disagree with the artefact, and a proof that can disagree is worse than none.
const P = new URLSearchParams(location.search);
const CID = P.get('c') || '';
const TOKEN = P.get('t') || '';
// The business line, for "something looks wrong". Same number the site uses.
const WA = '972552441334';

const $ = (id) => document.getElementById(id);
const state = $('state');
const sheet = $('sheet');
const dlg = $('big');
const bigImg = $('bigImg');

let PAGES = 0;
let at = 1;

const pageUrl = (n) =>
  '/api/collections/' + encodeURIComponent(CID) + '/proof/' + n + '?t=' + encodeURIComponent(TOKEN);

function say(text) {
  state.hidden = false;
  state.textContent = text;
}

// Lay the whole deck out at once, but let the browser fetch only what is on
// screen: a hundred full-size requests on a phone is the difference between a
// page that opens and one that times out.
function draw(pages) {
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= pages; n++) {
    const fig = document.createElement('figure');
    fig.className = 'card';
    fig.tabIndex = 0;
    fig.dataset.n = String(n);
    fig.setAttribute('aria-label', 'קלף ' + n);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = pageUrl(n);
    fig.appendChild(img);
    frag.appendChild(fig);
  }
  sheet.replaceChildren(frag);
  $('deck').hidden = false;
  $('help').hidden = false;
  state.hidden = true;
}

function open(n) {
  if (!PAGES) return;
  at = Math.min(PAGES, Math.max(1, n));
  bigImg.src = pageUrl(at);
  bigImg.alt = 'קלף ' + at;
  if (!dlg.open) dlg.showModal();
}

sheet.addEventListener('click', (e) => {
  const fig = e.target.closest('.card');
  if (fig) open(Number(fig.dataset.n));
});
sheet.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const fig = e.target.closest('.card');
  if (!fig) return;
  e.preventDefault();
  open(Number(fig.dataset.n));
});
// RTL: "previous" is the card to the right, which is the LOWER number. The arrow
// keys are mirrored to match, or the deck reads backwards under the reader's hand.
$('prev').addEventListener('click', () => open(at - 1));
$('next').addEventListener('click', () => open(at + 1));
$('close').addEventListener('click', () => dlg.close());
dlg.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') open(at - 1);
  else if (e.key === 'ArrowLeft') open(at + 1);
});

async function load() {
  if (!CID || !TOKEN) return say('הקישור חסר פרטים. פתחי אותו מההודעה ששלחנו.');
  let r;
  try {
    r = await fetch(
      '/api/collections/' + encodeURIComponent(CID) + '/proof?t=' + encodeURIComponent(TOKEN)
    );
  } catch {
    return say('לא הצלחנו לטעון את החפיסה. נסי לרענן.');
  }
  if (r.status === 404) return say('החפיסה עוד לא מוכנה. נעדכן ברגע שהיא תהיה.');
  if (r.status === 403) return say('הקישור לא תקף. פתחי אותו מההודעה ששלחנו.');
  if (!r.ok) return say('לא הצלחנו לטעון את החפיסה. נסי לרענן.');
  const data = await r.json();
  PAGES = Number(data.pages) || 0;
  if (!PAGES) return say('החפיסה עוד לא מוכנה. נעדכן ברגע שהיא תהיה.');
  const who = data.name ? ' של ' + data.name : '';
  const text = 'היי, יש לי הערה על ההגהה' + who + ' (הזמנה ' + CID + ')';
  $('wa').href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text);
  draw(PAGES);
}

load();
