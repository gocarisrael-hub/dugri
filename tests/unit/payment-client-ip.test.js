// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The client key the payment limits count by must be the address our own proxy
// saw — never an X-Forwarded-For entry the client wrote, never a
// CF-Connecting-IP a client sent straight to the Railway host — and an IPv6
// client counts as its whole /64.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { paymentClientIp, isCloudflare, normalizeIp, limitKey } = require(
  path.join(__dirname, '..', '..', 'server', 'payment-client-ip.js')
);

const req = (headers = {}, remoteAddress = '10.0.0.2') => ({ headers, socket: { remoteAddress } });

describe('paymentClientIp', () => {
  it('takes the entry our one proxy appended, not the ones the client wrote', () => {
    expect(paymentClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }), 1)).toBe(
      '203.0.113.9'
    );
    for (const spoof of ['9.9.9.9', '8.8.8.8, 7.7.7.7', 'garbage', ', ,']) {
      expect(paymentClientIp(req({ 'x-forwarded-for': spoof + ', 203.0.113.9' }), 1)).toBe(
        '203.0.113.9'
      );
    }
  });

  it('counts hops on the raw entries, so an unparsable entry cannot shift the count', () => {
    // Two hops: the entry second from the right is ours, even though the one to
    // its right does not parse.
    expect(paymentClientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, unknown' }), 2)).toBe(
      '198.51.100.7'
    );
    // Our own entry does not parse: nothing in the header is trusted.
    expect(
      paymentClientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4:5678' }, '10.9.9.9'), 1)
    ).toBe('10.9.9.9');
  });

  it('believes CF-Connecting-IP only when the hop that handed us the request is Cloudflare', () => {
    expect(
      paymentClientIp(
        req({
          'x-forwarded-for': '6.6.6.6, 198.51.100.7, 172.64.10.20',
          'cf-connecting-ip': '198.51.100.7',
        }),
        1
      )
    ).toBe('198.51.100.7');
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

  it('keys an IPv6 client by its /64, however many addresses in it the client uses', () => {
    const keys = new Set(
      [
        '2001:db8:abcd:12::1',
        '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
        '2001:db8:abcd:12:a:b:c:d',
      ].map((ip) => paymentClientIp(req({ 'x-forwarded-for': ip }), 1))
    );
    expect([...keys]).toEqual(['20010db8abcd0012::/64']);
    expect(paymentClientIp(req({ 'x-forwarded-for': '2001:db8:abcd:13::1' }), 1)).toBe(
      '20010db8abcd0013::/64'
    );
    // Through Cloudflare, the client's own IPv6 is grouped the same way.
    expect(
      paymentClientIp(
        req({
          'x-forwarded-for': '2001:db8:abcd:12::99, 2606:4700:10::6816:1',
          'cf-connecting-ip': '2001:db8:abcd:12::99',
        }),
        1
      )
    ).toBe('20010db8abcd0012::/64');
  });
});

describe('isCloudflare / normalizeIp / limitKey', () => {
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

  it('leaves an IPv4 as it is', () => {
    expect(limitKey('203.0.113.9')).toBe('203.0.113.9');
  });
});
