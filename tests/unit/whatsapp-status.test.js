// @vitest-environment node
// Unit tests for whatsapp.status() — the non-secret arming snapshot the admin
// page reads to show whether the bot is live. status() reads the WHAPI_* env at
// module-require time, so each case fresh-requires the module with a different
// env. The cardinal rule: it must expose PRESENCE booleans only, never the
// token/secret VALUES.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const whatsappPath = path.join(__dirname, '..', '..', 'server', 'whatsapp.js');
const ENV_KEYS = ['WHATSAPP_ENABLED', 'WHAPI_TOKEN', 'WHAPI_WEBHOOK_SECRET', 'WHAPI_BASE_URL'];
const SAVED = {};

function loadWith(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(whatsappPath)];
  return require(whatsappPath);
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  delete require.cache[require.resolve(whatsappPath)];
});

describe('whatsapp.status()', () => {
  it('fully armed (enabled + token + base + secret) -> ready', () => {
    const wa = loadWith({
      WHATSAPP_ENABLED: '1',
      WHAPI_TOKEN: 't',
      WHAPI_WEBHOOK_SECRET: 's',
      WHAPI_BASE_URL: 'https://gate.example',
    });
    expect(wa.status()).toEqual({
      enabled: true,
      tokenPresent: true,
      webhookSecretPresent: true,
      baseUrl: 'https://gate.example',
      configured: true,
      ready: true,
    });
  });

  it('enabled + token but NO webhook secret -> can send (configured) but not ready', () => {
    const wa = loadWith({ WHATSAPP_ENABLED: 'true', WHAPI_TOKEN: 't' });
    const s = wa.status();
    expect(s.configured).toBe(true); // can send / open groups
    expect(s.webhookSecretPresent).toBe(false); // can't receive words
    expect(s.ready).toBe(false);
  });

  it('dormant (no env) -> everything false, default gateway base url', () => {
    const wa = loadWith({});
    expect(wa.status()).toEqual({
      enabled: false,
      tokenPresent: false,
      webhookSecretPresent: false,
      baseUrl: 'https://gate.whapi.cloud',
      configured: false,
      ready: false,
    });
  });

  it('NEVER exposes the token or secret VALUES', () => {
    const wa = loadWith({
      WHATSAPP_ENABLED: '1',
      WHAPI_TOKEN: 'super-secret-token',
      WHAPI_WEBHOOK_SECRET: 'super-secret-hook',
    });
    const json = JSON.stringify(wa.status());
    expect(json).not.toContain('super-secret-token');
    expect(json).not.toContain('super-secret-hook');
  });

  it('falsey WHATSAPP_ENABLED spellings count as OFF', () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      const wa = loadWith({ WHATSAPP_ENABLED: v, WHAPI_TOKEN: 't', WHAPI_WEBHOOK_SECRET: 's' });
      const s = wa.status();
      expect(s.enabled).toBe(false);
      expect(s.configured).toBe(false);
      expect(s.ready).toBe(false);
    }
  });
});
