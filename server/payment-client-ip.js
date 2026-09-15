// The client address the PAYMENT rate limits are keyed by, in a form a client
// cannot choose.
//
// req.ip will not do: with app.set('trust proxy', true) it is the LEFTMOST
// X-Forwarded-For entry, which is whatever the client sent. Proxies APPEND to
// that header, so the entries a client can forge are on the left and the ones
// our own proxies wrote are counted from the right. On Railway there is one such
// hop, so the rightmost entry is the address Railway's edge received the request
// from: the client itself, or — when the site's domain sends it through
// Cloudflare first — a Cloudflare edge. In that case, and only then,
// CF-Connecting-IP is believed: Cloudflare sets it and overwrites any value a
// client sent, and a request can only reach Railway FROM a Cloudflare address by
// really passing through Cloudflare. A client that talks to the Railway host
// directly with a CF-Connecting-IP of its own choosing is keyed by its real
// address instead. (The same reasoning as clientIpForMeta in
// server/routes/platform.js, which cannot range-check because it keys off req.ip.)
//
// PAYMENT_PROXY_HOPS (default 1) is how many trusted proxies append to
// X-Forwarded-For in front of this process; 0 ignores the header. With no
// X-Forwarded-For at all (a local run) the socket peer is the client.
//
// The global `trust proxy` setting and the older limiters that use req.ip are
// deliberately untouched here; that is a separate change.

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

function parseV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
}

function parseV6(ip) {
  let s = String(ip).toLowerCase();
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail4) {
    const v = parseV4(tail4[1]);
    if (v == null) return null;
    s =
      s.slice(0, -tail4[1].length) +
      ((v >>> 16) & 0xffff).toString(16) +
      ':' +
      (v & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

function inCidr(ip, cidr) {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const a4 = parseV4(ip);
  const b4 = parseV4(base);
  if (a4 != null && b4 != null) {
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (a4 & mask) >>> 0 === (b4 & mask) >>> 0;
  }
  const a6 = parseV6(ip);
  const b6 = parseV6(base);
  if (a6 != null && b6 != null) {
    const shift = BigInt(128 - bits);
    return a6 >> shift === b6 >> shift;
  }
  return false;
}

function isCloudflare(ip) {
  return !!ip && CLOUDFLARE_RANGES.some((r) => inCidr(ip, r));
}

// One address as a string we can compare: trimmed, brackets gone, a dotted
// IPv4-mapped IPv6 reduced to the IPv4. '' for nothing usable.
function normalizeIp(raw) {
  let ip = String(raw == null ? '' : raw).trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  if (parseV4(ip) != null || parseV6(ip) != null) return ip.toLowerCase();
  return '';
}

function trustedHops() {
  const n = Number(process.env.PAYMENT_PROXY_HOPS);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

function paymentClientIp(req, hops = trustedHops()) {
  const socket = normalizeIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (hops === 0) return socket;
  const headers = (req && req.headers) || {};
  const raw = headers['x-forwarded-for'];
  const list = String(Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
  if (!list.length) return socket;
  // Fewer entries than our own proxies write: the header is not what we expect,
  // so nothing in it is trusted.
  const at = list.length - hops;
  if (at < 0) return socket;
  const peer = list[at];
  const cf = normalizeIp(headers['cf-connecting-ip']);
  return cf && isCloudflare(peer) ? cf : peer;
}

module.exports = { paymentClientIp, isCloudflare, normalizeIp, CLOUDFLARE_RANGES };
