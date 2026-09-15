// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The client address the payment limits key on must be the one our own proxy
// saw — never an X-Forwarded-For entry the client wrote, and never a
// CF-Connecting-IP a client sent straight to the Railway host.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { paymentClientIp, isCloudflare, normalizeIp } = require(
  path.join(__dirname, '..', '..', 'server', 'payment-client-ip.js')
);

const req = (headers = {}, remoteAddress = '10.0.0.2') => ({ headers, socket: { remoteAddress } });

describe('paymentClientIp', () => {
  it('takes the entry our one proxy appended, not the ones the client wrote', () => {
    expect(paymentClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }), 1)).toBe(
      '203.0.113.9'
    );
    for (const spoof of ['9.9.9.9', '8.8.8.8, 7.7.7.7', 'garbage']) {
      expect(paymentClientIp(req({ 'x-forwarded-for': spoof + ', 203.0.113.9' }), 1)).toBe(
        '203.0.113.9'
      );
    }
  });

  it('counts the configured number of hops from the right', () => {
    expect(paymentClientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.1.1.1' }), 2)).toBe(
      '198.51.100.7'
    );
  });

  it('believes CF-Connecting-IP only when the hop that handed us the request is Cloudflare', () => {
    // Through Cloudflare: Railway appended a Cloudflare edge address.
    expect(
      paymentClientIp(
        req({
          'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.64.10.20',
          'cf-connecting-ip': '198.51.100.7',
        }),
        1
      )
    ).toBe('198.51.100.7');
    // Straight to Railway with a made-up CF header: keyed by the real address.
    expect(
      paymentClientIp(req({ 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '1.2.3.4' }), 1)
    ).toBe('203.0.113.9');
  });

  it('uses the socket with no X-Forwarded-For, with 0 hops, or when the header is shorter than the hops', () => {
    expect(paymentClientIp(req({}, '::ffff:127.0.0.1'), 1)).toBe('127.0.0.1');
    expect(paymentClientIp(req({ 'x-forwarded-for': '9.9.9.9' }, '127.0.0.1'), 0)).toBe(
      '127.0.0.1'
    );
    expect(paymentClientIp(req({ 'x-forwarded-for': '9.9.9.9' }, '127.0.0.1'), 2)).toBe(
      '127.0.0.1'
    );
  });
});

describe('isCloudflare / normalizeIp', () => {
  it('knows Cloudflare edge ranges in both address families', () => {
    expect(isCloudflare('104.16.1.1')).toBe(true);
    expect(isCloudflare('172.71.255.255')).toBe(true);
    expect(isCloudflare('172.72.0.0')).toBe(false);
    expect(isCloudflare('2606:4700:10::6816:1')).toBe(true);
    expect(isCloudflare('2a06:98c7:ffff::1')).toBe(true);
    expect(isCloudflare('2a06:98c8::1')).toBe(false);
    expect(isCloudflare('203.0.113.9')).toBe(false);
  });

  it('normalizes what proxies write and rejects what is not an address', () => {
    expect(normalizeIp(' ::ffff:1.2.3.4 ')).toBe('1.2.3.4');
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBe('');
    expect(normalizeIp('999.1.1.1')).toBe('');
  });
});
