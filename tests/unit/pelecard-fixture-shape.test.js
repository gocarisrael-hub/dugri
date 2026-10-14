// @vitest-environment node
//
// PeleCard fixtures must look like what PeleCard returns. Production's approval
// numbers and vouchers are plain 7-digit strings (all 308 stored at the time of
// writing). The fixtures used a dashed `86-001-006` form PeleCard never produces,
// and an agent reasoning about real data from them built a shape classifier on
// invented data and got a confident, meaningless answer. No test depended on the
// format, so nothing caught it. This does: every DebitApproveNumber / VoucherId
// literal in the unit suites must be 7 digits.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIELD = /\b(DebitApproveNumber|VoucherId)\s*:\s*'([^']*)'/g;

describe('PeleCard fixtures', () => {
  it('carry approval numbers and vouchers in production shape (7 digits)', () => {
    const seen = [];
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(FIELD)) {
        seen.push(m[2]);
        if (!/^\d{7}$/.test(m[2])) bad.push(f + ': ' + m[1] + " '" + m[2] + "'");
      }
    }
    // A scan that found nothing would pass vacuously.
    expect(seen.length).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
