'use strict';

// ORDERS BY OCCASION PAGE, for the admin's ads page (site/admin-ads.html): per
// occasion slug (/yom-huledet, ...), over the newest `days`,
//   visits    distinct visitors who opened the page (the first-party ledger,
//             attribution.occasionVisits: a visit beacon carries the page's slug);
//   started   orders created from it (the wizard stores the slug on the order when
//             she came from options.html?occasion=<slug>), by created_at;
//   paid      of the orders from it, those PAID inside the window, by paid_at;
//   revenue   what those paid orders are credited with: attribution.orderValue,
//             the same rule the ad report and the Meta report use for a sale.
// Orders placed from one of our own addresses (arrival.i, judged at the door like
// the ad report's internal traffic) are left out, as the ad report leaves them out
// of its rows. Pure: the caller hands in the orders, the visits and the pages.

const { orderValue } = require('./attribution');

const DAY_MS = 24 * 60 * 60 * 1000;

function occasionReport({
  collections = [],
  visits = {},
  pages = [],
  days = 30,
  now = Date.now(),
}) {
  const span = Math.max(1, Number(days) || 30);
  const cutoff = now - span * DAY_MS;
  const rows = new Map();
  const row = (slug) => {
    if (!rows.has(slug)) {
      const page = pages.find((p) => p.slug === slug);
      rows.set(slug, {
        slug,
        label: page ? page.label : slug,
        live: !!page,
        visits: 0,
        started: 0,
        paid: 0,
        revenue: 0,
      });
    }
    return rows.get(slug);
  };
  // every live page has a row, even before its first visit: a zero is an answer
  for (const p of pages) row(p.slug);
  for (const [slug, n] of Object.entries(visits || {})) row(slug).visits += Number(n) || 0;

  const inWindow = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= cutoff && t <= now;
  };
  for (const c of collections) {
    if (!c || typeof c.occasion !== 'string' || !c.occasion) continue;
    if (c.arrival && c.arrival.i === 1) continue;
    const r = row(c.occasion);
    if (inWindow(c.created_at)) r.started += 1;
    const o = c.order;
    if (o && o.paid && inWindow(o.paid_at)) {
      r.paid += 1;
      r.revenue += orderValue(o) || 0;
    }
  }

  const out = [...rows.values()].map((r) => ({
    ...r,
    revenue: Math.round(r.revenue * 100) / 100,
  }));
  // money first, then orders, then traffic, like the ad report
  out.sort(
    (a, b) =>
      b.revenue - a.revenue ||
      b.paid - a.paid ||
      b.started - a.started ||
      b.visits - a.visits ||
      (a.slug < b.slug ? -1 : 1)
  );
  const totals = out.reduce(
    (t, r) => ({
      visits: t.visits + r.visits,
      started: t.started + r.started,
      paid: t.paid + r.paid,
      revenue: Math.round((t.revenue + r.revenue) * 100) / 100,
    }),
    { visits: 0, started: 0, paid: 0, revenue: 0 }
  );
  return { days: span, rows: out, totals };
}

module.exports = { occasionReport };
