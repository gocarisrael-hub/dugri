// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Buffer } from 'node:buffer';
// Node's global Response (undici) — imported explicitly so the lint config's
// browser-ish globals don't have to know about it.
const { Response } = globalThis;

// server/cutout.js in isolation. NOTHING here touches the network: the two tests
// that exercise the Adobe call replace globalThis.fetch, and every other test only
// pokes the module's pure helpers. What is pinned:
//
//   • unconfigured is INERT — no credentials (or no https base url) means the
//     feature does not exist and removeBackground answers null without a request;
//   • a failing/slow/garbage provider yields null rather than a throw;
//   • the temporary source URL Adobe fetches expires and is unguessable;
//   • the transparent PNG comes back byte-identical (alpha intact);
//   • prepare_photo.py really does EXIF-rotate and downscale before sending.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const cutoutPath = require.resolve(path.join(serverDir, 'cutout.js'));

const CUTOUT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGNgwAb+gxGmKBZBBgYGAIa9A/0e+NXIAAAAAElFTkSuQmCC',
  'base64'
);
// A JPEG header + filler: enough for the magic sniff, unreadable to Pillow (so the
// prepare step falls back to the original bytes — which is itself the behaviour we
// want when a photo cannot be normalised).
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 0x41)]);

const ENV_KEYS = ['ADOBE_CLIENT_ID', 'ADOBE_CLIENT_SECRET', 'PUBLIC_BASE_URL'];
let savedEnv;
let savedFetch;

// Load a FRESH cutout.js against the current env (the module reads credentials once
// at require time, exactly as pelecard.js does).
function loadCutout(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[cutoutPath];
  return require(cutoutPath);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
  delete require.cache[cutoutPath];
});

const CONFIGURED = {
  ADOBE_CLIENT_ID: 'test-client',
  ADOBE_CLIENT_SECRET: 'test-secret',
  PUBLIC_BASE_URL: 'https://dugri.example',
};

describe('isConfigured', () => {
  it('is false with no credentials at all', () => {
    expect(loadCutout({ PUBLIC_BASE_URL: 'https://dugri.example' }).isConfigured()).toBe(false);
  });

  it('is false without a PUBLIC_BASE_URL — Adobe has to be able to reach the source', () => {
    expect(loadCutout({ ADOBE_CLIENT_ID: 'a', ADOBE_CLIENT_SECRET: 'b' }).isConfigured()).toBe(
      false
    );
  });

  it('is false on a plain-http base url', () => {
    expect(
      loadCutout({ ...CONFIGURED, PUBLIC_BASE_URL: 'http://localhost:3000' }).isConfigured()
    ).toBe(false);
  });

  it('is true with credentials + an https base url', () => {
    expect(loadCutout(CONFIGURED).isConfigured()).toBe(true);
  });

  it('unconfigured removeBackground answers null WITHOUT making a request', async () => {
    const cutout = loadCutout({});
    globalThis.fetch = () => {
      throw new Error('must not be called');
    };
    expect(await cutout.removeBackground(FAKE_JPEG)).toBe(null);
  });
});

describe('the temporary source URL', () => {
  it('serves the published bytes and forgets them once expired', () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_SOURCE_TTL_MS: '1' });
    const token = cutout._internals.publishSource(FAKE_JPEG, 'image/jpeg');
    expect(token).toMatch(/^[a-f0-9]{32}$/); // 128 bits — the token IS the credential
    expect(cutout.serveSource(token).bytes).toBe(FAKE_JPEG);
    delete process.env.ADOBE_CUTOUT_SOURCE_TTL_MS;
    // TTL of 1ms: by the next tick the entry is gone (and stays gone).
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cutout.serveSource(token)).toBe(null);
        expect(cutout._internals.sources.has(token)).toBe(false);
        resolve();
      }, 10);
    });
  });

  it('404-equivalent (null) for an unknown token', () => {
    const cutout = loadCutout(CONFIGURED);
    expect(cutout.serveSource('deadbeef')).toBe(null);
    expect(cutout.serveSource(undefined)).toBe(null);
  });
});

describe('normalising a photo before it is sent', () => {
  it('falls back to the ORIGINAL bytes when the photo cannot be normalised', () => {
    // generator/prepare_photo.py exits non-zero on anything Pillow cannot read;
    // the send must go ahead with the original rather than be abandoned. (What the
    // script does when it CAN read the photo — EXIF rotation + the size cap — is
    // pinned in generator/test_prepare_photo.py.)
    const { prepareForProvider } = loadCutout(CONFIGURED)._internals;
    expect(prepareForProvider(FAKE_JPEG).equals(FAKE_JPEG)).toBe(true);
  });

  it('labels the source URL with the sniffed image type', () => {
    const { mimeOf } = loadCutout(CONFIGURED)._internals;
    expect(mimeOf(FAKE_JPEG)).toBe('image/jpeg');
    expect(mimeOf(CUTOUT_PNG)).toBe('image/png');
    expect(mimeOf(Buffer.from('not an image at all'))).toBe('application/octet-stream');
  });
});

describe('reading Adobe responses defensively', () => {
  it('accepts either outputs[].url or outputs[].destination.url', () => {
    const { resultUrlOf } = loadCutout(CONFIGURED)._internals;
    expect(resultUrlOf({ result: { outputs: [{ url: 'https://a/b.png' }] } })).toBe(
      'https://a/b.png'
    );
    expect(
      resultUrlOf({ result: { outputs: [{ destination: { url: 'https://c/d.png' } }] } })
    ).toBe('https://c/d.png');
    expect(resultUrlOf({})).toBe(null);
  });

  it('refuses a non-https url the provider hands back', () => {
    const { resultUrlOf, httpsOnly } = loadCutout(CONFIGURED)._internals;
    expect(httpsOnly('http://169.254.169.254/latest/meta-data')).toBe(null);
    expect(httpsOnly('file:///etc/passwd')).toBe(null);
    expect(resultUrlOf({ result: { outputs: [{ url: 'http://internal/x.png' }] } })).toBe(null);
  });
});

describe('removeBackground against a stubbed Adobe', () => {
  // A fetch stub that walks the real three-call flow: IMS token → submit → status.
  function stubAdobe({ status = 'succeeded', png = CUTOUT_PNG, submitOk = true } = {}) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      seen.push({ url: u, init });
      if (u.includes('adobelogin.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86399 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('remove-background')) {
        if (!submitOk) return new Response('nope', { status: 429 });
        return new Response(
          JSON.stringify({ jobId: 'job-1', statusUrl: 'https://image.adobe.io/v2/status/job-1' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/v2/status/')) {
        return new Response(
          JSON.stringify({
            status,
            result: { outputs: [{ url: 'https://storage.adobe.io/out.png' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(png, { status: 200 });
    };
    return seen;
  }

  it('returns the transparent PNG byte-for-byte and publishes the source https', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '1' });
    const seen = stubAdobe();
    const out = await cutout.removeBackground(FAKE_JPEG);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(CUTOUT_PNG)).toBe(true);
    expect(out[25]).toBe(6); // PNG colour type 6 = truecolour WITH alpha
    const submit = seen.find((s) => s.url.includes('remove-background'));
    const body = JSON.parse(submit.init.body);
    expect(body.mode).toBe('cutout');
    expect(body.output.mediaType).toBe('image/png');
    expect(body.image.source.url).toMatch(
      /^https:\/\/dugri\.example\/api\/pawn-cutout\/src\/[a-f0-9]{32}$/
    );
    expect(submit.init.headers['x-api-key']).toBe('test-client');
    expect(submit.init.headers.Authorization).toBe('Bearer tok');
  });

  it('stops serving the photo the moment the job ends', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '1' });
    stubAdobe();
    await cutout.removeBackground(FAKE_JPEG);
    expect(cutout._internals.sources.size).toBe(0);
  });

  it('caches by content hash — the same photo is never cut twice', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '1' });
    const seen = stubAdobe();
    await cutout.removeBackground(FAKE_JPEG);
    const after = seen.length;
    await cutout.removeBackground(Buffer.from(FAKE_JPEG)); // same bytes, new buffer
    expect(seen.length).toBe(after);
  });

  it('null (never a throw) when Adobe rate-limits the submit', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '1' });
    stubAdobe({ submitOk: false });
    await expect(cutout.removeBackground(FAKE_JPEG)).resolves.toBe(null);
  });

  it('null when the job reports failed', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '1' });
    stubAdobe({ status: 'failed' });
    await expect(cutout.removeBackground(FAKE_JPEG)).resolves.toBe(null);
  });

  it('null when the whole call blows its time budget instead of hanging forever', async () => {
    const cutout = loadCutout({ ...CONFIGURED, ADOBE_CUTOUT_POLL_MS: '5' });
    stubAdobe({ status: 'running' }); // never terminal
    await expect(cutout.removeBackground(FAKE_JPEG, { timeoutMs: 60 })).resolves.toBe(null);
  });

  it('null when the network itself throws', async () => {
    const cutout = loadCutout(CONFIGURED);
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(cutout.removeBackground(FAKE_JPEG)).resolves.toBe(null);
  });
});
