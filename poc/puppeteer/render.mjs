// POC renderer: fill the text-fillable bachelorette card template with real
// text and render it to print-quality PNG + PDF using Puppeteer (headless Chrome).
//
//   node poc/puppeteer/render.mjs
//
// The template keeps the original design's decorations (disco ball, heels,
// frame, colours) as an inlined SVG; only the words + title are real text.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const p = (f) => join(__dirname, f);

// --- Sample data to fill the placeholders ---
const data = {
  TITLE_L1: "Ziv's",
  TITLE_L2: 'Bachelorette',
  WORD_1: 'שנילב תירס',
  WORD_2: 'שופינג',
  WORD_3: 'ברוליית',
  WORD_4: 'הכנסת חשמל',
};

// Compose the HTML: inline the decorations-only background SVG, fill placeholders.
const background = readFileSync(p('background.svg'), 'utf8');
let html = readFileSync(p('template.html'), 'utf8').replace('<!--BACKGROUND_SVG-->', background);
for (const [k, v] of Object.entries(data)) {
  html = html.replaceAll(`{{${k}}}`, v);
}

const CARD_W = 750;
const CARD_H = 1075;
const SCALE = 3; // print quality (~2250x3225 px)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: CARD_W, height: CARD_H, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  // Make sure web fonts are actually loaded before we snapshot.
  await page.evaluateHandle('document.fonts.ready');

  const cardEl = await page.$('.card');

  // PNG (print quality)
  await cardEl.screenshot({ path: p('out.png') });

  // PDF sized exactly to the card box (no page margins).
  await page.pdf({
    path: p('out.pdf'),
    width: `${CARD_W}px`,
    height: `${CARD_H}px`,
    printBackground: true,
    pageRanges: '1',
  });

  console.log('Rendered -> poc/puppeteer/out.png and out.pdf');
} finally {
  await browser.close();
}
