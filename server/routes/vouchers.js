// Agent A (Commerce): partner voucher pools — the owner's admin routes
// (site/admin-partners.html).
//
// A reseller (the first is Hi Tech Zone) sells Dugri to its own customers and
// hands each one a code worth one free pickup copy; the owner bills the reseller
// per code USED. These routes create a pool, mint more codes, list and search
// them, void a lost one, and export two CSVs: the codes (to hand over) and the
// usage (to invoice from). Redemption is NOT here — a voucher goes through the
// ordinary checkout coupon field (validateCoupon, pay/init, markPaid).
//
// OWNER ONLY. requireAdmin refuses the staff key on every path below, because
// none of them is on the staff allow-list in index.js — and a list of codes is a
// list of free games.
//
// Wired like server/routes/commerce.js: everything is passed in, nothing is
// required at the top level (the tests reload the app by purging require.cache).

function registerPartnerVouchers(app, { requireAdmin, db, voucherRules }) {
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  // The row as the page shows it: the code's status, and the order it paid for
  // with a link the owner can open.
  function present(row) {
    const c = row.order_id ? db.getCollection(row.order_id) : null;
    return {
      id: row.id,
      code: row.code,
      status: voucherRules.statusOf(row),
      created_at: row.created_at,
      used_at: row.used_at,
      voided_at: row.voided_at,
      void_reason: row.void_reason || '',
      held: !row.used_at && row.held && Date.parse(row.held.until) > Date.now(),
      order_no: c ? db.orderRef(c) : null,
      order_link: c ? '/collect.html?c=' + c.id + '&k=' + c.owner_token : null,
      order_cancelled: c ? !!c.cancelled : false,
    };
  }

  function errorStatus(err) {
    return err === 'duplicate prefix' ? 409 : 400;
  }

  // Every pool, with its numbers.
  app.get('/api/admin/partner-pools', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    res.json({
      pools: db.listVoucherPools(),
      entropy_bits: Math.floor(voucherRules.ENTROPY_BITS),
      max_batch: voucherRules.MAX_BATCH,
    });
  });

  // Create a pool and its first codes. Body: { partner_name, prefix, count,
  // price_per_use }. 201 { pool, created }, 400 bad input, 409 a prefix in use.
  app.post('/api/admin/partner-pools', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    const b = req.body || {};
    const r = db.createVoucherPool({
      partner_name: b.partner_name,
      prefix: b.prefix,
      count: b.count,
      price_per_use: b.price_per_use,
    });
    if (r.error) return res.status(errorStatus(r.error)).json({ error: r.error });
    res.status(201).json({ pool: r.pool, created: r.codes.length });
  });

  // Edit the partner's name and/or the price per used code.
  app.post('/api/admin/partner-pools/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    const b = req.body || {};
    const pool = db.updateVoucherPool(req.params.id, {
      partner_name: b.partner_name,
      price_per_use: b.price_per_use,
    });
    if (!pool) return res.status(404).json({ error: 'not found' });
    if (pool.error) return res.status(400).json({ error: pool.error });
    res.json({ pool });
  });

  // Mint more codes into a pool. Body: { count }.
  app.post('/api/admin/partner-pools/:id/codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    const r = db.addVouchers(req.params.id, (req.body || {}).count);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.error) return res.status(400).json({ error: r.error });
    res.status(201).json({ created: r.codes.length });
  });

  // The pool's codes, searchable (?q=) and filterable (?status=unused|used|void),
  // plus the pool and its numbers.
  app.get('/api/admin/partner-pools/:id/codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    const pool = db.getVoucherPool(req.params.id);
    if (!pool) return res.status(404).json({ error: 'not found' });
    const status = ['unused', 'used', 'void'].includes(req.query.status) ? req.query.status : null;
    const codes = db.listVouchers(pool.id, { q: req.query.q, status }).map(present);
    res.json({
      pool,
      summary: voucherRules.poolSummary(pool, db.vouchersInPool(pool.id)),
      codes,
    });
  });

  function sendCsv(res, name, body) {
    noStore(res);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(body);
  }

  // THE CODES, for handing to the reseller. ?status=unused gives only the ones
  // still good to hand out (the default is every code, with its status).
  app.get('/api/admin/partner-pools/:id/codes.csv', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const pool = db.getVoucherPool(req.params.id);
    if (!pool) return res.status(404).json({ error: 'not found' });
    const status = ['unused', 'used', 'void'].includes(req.query.status) ? req.query.status : null;
    const rows = db
      .listVouchers(pool.id, { status })
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    sendCsv(res, pool.prefix + '-codes.csv', voucherRules.codesCsv(pool, rows));
  });

  // THE USAGE, for invoicing the reseller: every used code, its month, its order.
  app.get('/api/admin/partner-pools/:id/usage.csv', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const pool = db.getVoucherPool(req.params.id);
    if (!pool) return res.status(404).json({ error: 'not found' });
    const orderRefOf = (row) => {
      const c = row.order_id ? db.getCollection(row.order_id) : null;
      return c ? db.orderRef(c) : '';
    };
    sendCsv(
      res,
      pool.prefix + '-usage.csv',
      voucherRules.usageCsv(pool, db.vouchersInPool(pool.id), orderRefOf)
    );
  });

  // Void an unused code (lost, leaked). Body: { reason }. 409 once it is used.
  app.post('/api/admin/partner-vouchers/:id/void', (req, res) => {
    if (!requireAdmin(req, res)) return;
    noStore(res);
    const r = db.voidVoucher(req.params.id, (req.body || {}).reason);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.error) return res.status(409).json({ error: r.error });
    res.json({ code: present(r) });
  });
}

module.exports = { registerPartnerVouchers };
