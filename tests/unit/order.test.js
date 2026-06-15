import { describe, it, expect } from 'vitest';
import { buildOrder } from '../../site/js/configurator.js';

describe('buildOrder', () => {
  const common = {
    designId: 'birthday',
    designName: 'יום הולדת',
    colorName: 'ירוק',
    mainHex: '#1FAE72',
  };

  it('prices the base plan at 79', () => {
    const o = buildOrder({ plan: 'base', ...common });
    expect(o.price).toBe(79);
    expect(o.summary).toContain('79');
  });

  it('prices the premium plan at 139', () => {
    const o = buildOrder({ plan: 'premium', ...common });
    expect(o.price).toBe(139);
    expect(o.summary).toContain('139');
  });

  it('throws on an unknown plan', () => {
    expect(() => buildOrder({ plan: 'gold', ...common })).toThrow();
  });

  it('returns a wa.me URL with the default number', () => {
    const o = buildOrder({ plan: 'base', ...common });
    expect(o.whatsappUrl.startsWith('https://wa.me/972546577715?text=')).toBe(true);
  });

  it('uses a custom whatsapp number when provided', () => {
    const o = buildOrder({ plan: 'base', ...common, whatsapp: '123456' });
    expect(o.whatsappUrl.startsWith('https://wa.me/123456?text=')).toBe(true);
  });

  it('encodes design name, color name/hex and plan into the message', () => {
    const o = buildOrder({ plan: 'premium', ...common });
    const text = o.whatsappUrl.split('?text=')[1];
    const decoded = decodeURIComponent(text);
    expect(decoded).toContain('יום הולדת');
    expect(decoded).toContain('ירוק');
    expect(decoded).toContain('#1FAE72');
    expect(decoded).toContain('139');
    // plan label (Hebrew "premium")
    expect(decoded).toContain('פרימיום');
  });

  it('properly URL-encodes the message (no raw spaces or newlines)', () => {
    const o = buildOrder({ plan: 'base', ...common });
    const text = o.whatsappUrl.split('?text=')[1];
    expect(text).not.toMatch(/\s/); // encoded, so no whitespace
    expect(text).not.toContain('\n');
  });

  it('summary mentions the plan label, design, color and hex', () => {
    const o = buildOrder({ plan: 'base', ...common });
    expect(o.summary).toContain('בסיס');
    expect(o.summary).toContain('יום הולדת');
    expect(o.summary).toContain('ירוק');
    expect(o.summary).toContain('#1FAE72');
  });
});
