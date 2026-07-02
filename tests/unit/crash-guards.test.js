// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Verify the top-level process crash guards added in server/index.js:
// a rejected promise or uncaught error must be LOGGED to stderr (not silently
// swallowed), and the uncaughtException exit must be suppressed under test so
// emitting a synthetic event can't tear down the runner.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let before;

beforeAll(() => {
  // NODE_ENV must be 'test' so the uncaughtException handler skips process.exit.
  process.env.NODE_ENV = 'test';
  before = {
    uncaught: process.listenerCount('uncaughtException'),
    unhandled: process.listenerCount('unhandledRejection'),
  };
  // Loading the module registers the guards exactly once (module cache).
  require(path.join(serverDir, 'index.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('process crash guards', () => {
  it('registers one uncaughtException and one unhandledRejection listener', () => {
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.unhandled + 1);
  });

  it('logs an uncaughtException to stderr and does NOT exit under test', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const boom = new Error('synthetic boom');

    process.emit('uncaughtException', boom);

    expect(errSpy).toHaveBeenCalledWith('[uncaughtException]', boom);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs an unhandledRejection to stderr and does NOT exit', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const reason = new Error('synthetic rejection');

    process.emit('unhandledRejection', reason, Promise.resolve());

    expect(errSpy).toHaveBeenCalledWith('[unhandledRejection]', reason);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
