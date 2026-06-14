# אליאס אישי — אתר

Static landing page (Hebrew, RTL, mobile-first). No build step, no dependencies.

## Files
- `index.html` — the landing page.
- `thankyou.html` — where customers land after paying; collects the words.
- `assets/` — put real photos here.

## Fill these in before launch
All in the `CONFIG` block at the bottom of `index.html`:
- `whatsapp` — number in international format, digits only (e.g. `9725XXXXXXXX`).
- `instagram` — handle without the `@`.
- `tranzilaTerminal` — your Tranzila terminal name. **While empty, the order buttons fall back to WhatsApp** so the site already works.
- `successUrl` — your domain + `/thankyou.html`.

Also update `WHATSAPP` at the bottom of `thankyou.html` (same number).

Replace the 4 placeholder boxes in the gallery section with real images:
`<img src="assets/your-photo.jpg" alt="">`

## Preview locally
Open `index.html` in a browser, or run:
`python3 -m http.server 8000` then visit `http://localhost:8000`

## Deploy (free)
Drag the `site` folder onto https://app.netlify.com/drop — you get a live URL in seconds.
Later connect a custom domain.

## Payment flow
Pay (Tranzila hosted page) → redirect to `thankyou.html` → customer taps WhatsApp to send words → file within 24h.
Automating the *outbound* WhatsApp (Make/Zapier + Tranzila webhook) is a fast-follow, not needed for launch.
