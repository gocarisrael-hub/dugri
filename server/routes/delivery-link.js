// Agent A (Commerce): the owner's "add delivery" payment link — its admin routes
// and the customer page's read. The store is server/stores/delivery-link.js; the
// customer's PAY route stays in index.js with the rest of the payment block
// (docs/agent-partition.md: the payment block is not split out), and the paid
// charge settles through settleVerifiedPayment's shipping branch like any other
// delivery bought after the fact.
//
// Wired like the other route modules: everything comes in through `deps`, and
// nothing is required at the top level (the unit tests reload the app by purging
// require.cache).

function registerDeliveryLink(app, { requireAdmin, db, publicBaseUrl, cardEnabled }) {
  // The page the customer opens. Built from PUBLIC_BASE_URL, never from the
  // request's Host header, like every other link we hand out.
  const linkUrl = (token) => {
    const base = publicBaseUrl();
    return base ? base + '/add-delivery.html?t=' + encodeURIComponent(token) : null;
  };

  // What the admin dialog reads and every admin route answers with.
  const adminState = (id) => {
    const st = db.deliveryLinkState(id);
    if (!st) return null;
    const live = st.link && !st.link.cancelled_at ? st.link : null;
    return {
      ...st,
      message: st.reason ? REASONS[st.reason] || st.reason : null,
      url: live ? linkUrl(live.token) : null,
    };
  };

  // The refusals the owner can act on, in her words.
  const REASONS = {
    'no paid order': 'אפשר ליצור קישור רק להזמנה ששולמה.',
    cancelled: 'ההזמנה מבוטלת.',
    paid: 'המשלוח כבר שולם בקישור.',
    'already delivery': 'זו כבר הזמנת משלוח.',
    digital: 'זו הזמנה דיגיטלית — אין מה לשלוח.',
    custom: 'זו הזמנה מיוחדת — המשלוח שלה מסוכם ישירות, לא בקישור.',
    open: 'האיסוף עדיין פתוח — הלקוח/ה יכול/ה להוסיף משלוח בעצמו/ה בדף האיסוף.',
    'invalid amount': 'הסכום צריך להיות מספר שלם וחיובי.',
    'no link': 'אין קישור פעיל להזמנה הזו.',
  };
  const refuse = (res, status, error) =>
    res.status(status).json({ error, message: REASONS[error] || error });

  // Admin: the link's state and the default price for the dialog.
  app.get('/api/admin/collections/:id/delivery-link', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const st = adminState(req.params.id);
    if (!st) return res.status(404).json({ error: 'not found' });
    res.json(st);
  });

  // Admin: create the link, or REPLACE the live one (the old token stops working
  // at once). Body: { amount } in whole shekels.
  app.post('/api/admin/collections/:id/delivery-link', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!publicBaseUrl()) {
      // No address to write the link out as, and no way for its payment to
      // call back. Refused before anything is stored.
      return res.status(503).json({
        error: 'payment base url not configured',
        message: 'PUBLIC_BASE_URL לא מוגדר — אי אפשר לבנות קישור.',
      });
    }
    const r = db.createDeliveryLink(req.params.id, { amount: (req.body || {}).amount });
    if (r && r.error === 'not found') return res.status(404).json({ error: 'not found' });
    if (r && r.error) return refuse(res, r.error === 'invalid amount' ? 400 : 409, r.error);
    res.status(201).json(adminState(req.params.id));
  });

  // Admin: cancel the unpaid link.
  app.delete('/api/admin/collections/:id/delivery-link', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = db.cancelDeliveryLink(req.params.id);
    if (r && r.error === 'not found') return res.status(404).json({ error: 'not found' });
    if (r && r.error) return refuse(res, 409, r.error);
    res.json(adminState(req.params.id));
  });

  // Public: what the customer's page shows. 404 for an unknown, cancelled or
  // replaced token — the page says the link is no longer valid.
  app.get('/api/delivery-link/:token', (req, res) => {
    const pub = db.deliveryLinkPublic(req.params.token);
    if (!pub) return res.status(404).json({ error: 'not found' });
    res.json({ ...pub, card_enabled: !!cardEnabled() });
  });
}

module.exports = { registerDeliveryLink };
