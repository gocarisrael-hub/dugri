import { describe, it, expect } from 'vitest';
import {
  paymentCharges,
  findByPaymentRef,
  normalizeRef,
  VOUCHER_MISSING_NOTE,
} from '../../site/js/payment-refs.js';

// Plain 7-digit numbers, the shape production PeleCard returns for BOTH the
// approval number and the voucher — which is exactly why each needs its label.
const pelecardOrder = (over = {}) => ({
  id: 'c-pele',
  honoree_name: 'דנה',
  order: {
    paid: true,
    paid_method: 'pelecard',
    paid_at: '2026-10-01T10:00:00.000Z',
    paid_approval_no: '1001018',
    paid_voucher_no: '4471203',
    paid_transaction_id: 'A1B2C3D4-0000-1111-2222-333344445555',
    charged_total: 199,
    ...over,
  },
});

const tranzilaOrder = () => ({
  id: 'c-tz',
  honoree_name: 'נועה',
  order: {
    paid: true,
    paid_method: 'tranzila',
    paid_approval_no: '0123456',
    paid_transaction_id: '88',
    charged_total: 249,
  },
});

describe('paymentCharges', () => {
  it('labels every number, so the approval and the voucher are never confused', () => {
    const [ch] = paymentCharges(pelecardOrder());
    expect(ch.kind).toBe('order');
    expect(ch.methodLabel).toBe('פלאקארד');
    expect(ch.amount).toBe(199);
    expect(ch.refs.map((r) => [r.label, r.value])).toEqual([
      ['מספר אישור', '1001018'],
      ['שובר', '4471203'],
      ['מזהה עסקה', 'A1B2C3D4-0000-1111-2222-333344445555'],
    ]);
    expect(ch.note).toBeNull();
  });

  it('says a missing PeleCard voucher proves nothing, instead of leaving a blank', () => {
    const [ch] = paymentCharges(pelecardOrder({ paid_voucher_no: undefined }));
    expect(ch.refs.map((r) => r.key)).toEqual(['approval', 'transaction']);
    expect(ch.note).toBe(VOUCHER_MISSING_NOTE);
  });

  it('gives a Tranzila charge no voucher row and no voucher note — it never had one', () => {
    const [ch] = paymentCharges(tranzilaOrder());
    expect(ch.methodLabel).toBe('טרנזילה');
    expect(ch.refs.map((r) => r.key)).toEqual(['approval', 'transaction']);
    expect(ch.note).toBeNull();
  });

  it('lists a paid delivery upgrade as its own charge', () => {
    const c = pelecardOrder({
      shipping: {
        paid: true,
        paid_method: 'pelecard',
        paid_approval_no: '2002020',
        paid_voucher_no: '5550001',
        charged_total: 35,
      },
    });
    const charges = paymentCharges(c);
    expect(charges.map((x) => x.kind)).toEqual(['order', 'shipping']);
    expect(charges[1].amount).toBe(35);
    expect(charges[1].refs[1]).toMatchObject({ label: 'שובר', value: '5550001' });
  });

  it('has nothing for an unpaid order, an unpaid upgrade, or no order', () => {
    expect(paymentCharges({ order: { paid: false } })).toEqual([]);
    expect(paymentCharges({})).toEqual([]);
    const c = pelecardOrder({ shipping: { paid: false, paid_approval_no: '9' } });
    expect(paymentCharges(c).map((x) => x.kind)).toEqual(['order']);
  });
});

describe('findByPaymentRef', () => {
  const all = [pelecardOrder(), tranzilaOrder(), { id: 'lead', honoree_name: 'ליד' }];

  it('finds the order and says WHICH number matched', () => {
    const hits = findByPaymentRef(all, '4471203');
    expect(hits).toHaveLength(1);
    expect(hits[0].collection.id).toBe('c-pele');
    expect(hits[0].ref.label).toBe('שובר');
    expect(findByPaymentRef(all, '0123456')[0].ref.label).toBe('מספר אישור');
  });

  it('forgives grouping and case, the way a number is read off a letter', () => {
    expect(findByPaymentRef(all, ' 447-1203 ')).toHaveLength(1);
    expect(findByPaymentRef(all, 'a1b2c3d4-0000-1111-2222-333344445555')).toHaveLength(1);
  });

  it('never matches part of a number — a shared run of digits is another customer', () => {
    expect(findByPaymentRef(all, '447120')).toEqual([]);
    expect(findByPaymentRef(all, '1001')).toEqual([]);
  });

  it('matches nothing on an empty query', () => {
    expect(findByPaymentRef(all, '  ')).toEqual([]);
    expect(normalizeRef(null)).toBe('');
  });
});
