// Unit tests for the fault-injection transport wrapper.
//
// Runs under `node --test` against the tsc-compiled `dist/fault-provider.js`
// (no browser, no @novasamatech runtime deps — the module's only imports are
// type-only and erased). Build first: `pnpm run build:tsc` (or `pnpm build`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFaultProvider,
  isHandshakeResponse,
  HANDSHAKE_RESPONSE_INDEX,
} from './dist/fault-provider.js';

/** SCALE compact-encode a small length (single- or two-byte mode). */
function compactPrefix(n) {
  if (n < 64) return [n << 2]; // mode 0
  if (n < 16384) {
    const raw = (n << 2) | 1; // mode 1
    return [raw & 0xff, (raw >> 8) & 0xff];
  }
  throw new Error('test helper only supports compact lengths < 16384');
}

/**
 * Build a wire frame `Struct({ requestId: str, payload: Enum(index, ...) })`:
 * compact length prefix, requestId UTF-8 bytes, then the payload enum index.
 */
function frame(requestId, payloadIndex) {
  const id = new TextEncoder().encode(requestId);
  return new Uint8Array([...compactPrefix(id.length), ...id, payloadIndex, 0, 0]);
}

/** A fake inner Provider that records outbound frames and replays inbound ones. */
function fakeProvider() {
  let inboundWrapped = null;
  const out = [];
  return {
    out,
    emitInbound(message) {
      if (!inboundWrapped) throw new Error('no subscriber');
      inboundWrapped(message);
    },
    provider: {
      logger: {},
      isCorrectEnvironment: () => true,
      postMessage: (m) => out.push(m),
      subscribe: (cb) => {
        inboundWrapped = cb;
        return () => {
          inboundWrapped = null;
        };
      },
      dispose: () => {},
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('isHandshakeResponse detects the handshake response (enum index 1)', () => {
  assert.equal(HANDSHAKE_RESPONSE_INDEX, 1);
  assert.equal(isHandshakeResponse(frame('req-1', 1)), true);
});

test('isHandshakeResponse rejects the request (0) and other methods', () => {
  assert.equal(isHandshakeResponse(frame('req-1', 0)), false);
  assert.equal(isHandshakeResponse(frame('req-1', 5)), false);
});

test('isHandshakeResponse handles a two-byte compact requestId length', () => {
  // 100-char requestId → compact mode 1 (two-byte length prefix).
  const longId = 'x'.repeat(100);
  assert.equal(isHandshakeResponse(frame(longId, 1)), true);
  assert.equal(isHandshakeResponse(frame(longId, 0)), false);
});

test('isHandshakeResponse never throws on garbage input', () => {
  assert.equal(isHandshakeResponse(new Uint8Array([])), false);
  assert.equal(isHandshakeResponse(new Uint8Array([0xff])), false);
});

test('no faults → transparent pass-through both directions', () => {
  const fake = fakeProvider();
  const fp = createFaultProvider(fake.provider, () => ({}));
  const received = [];
  fp.subscribe((m) => received.push(m));

  fp.postMessage(frame('a', 1));
  fp.postMessage(frame('a', 5));
  assert.equal(fake.out.length, 2); // both delivered, including handshake

  fake.emitInbound(frame('a', 5));
  assert.equal(received.length, 1);
});

test('dropHandshake swallows the handshake response, passes everything else', () => {
  const fake = fakeProvider();
  const fp = createFaultProvider(fake.provider, () => ({ dropHandshake: true }));

  fp.postMessage(frame('a', 1)); // handshake response → dropped
  assert.equal(fake.out.length, 0);

  fp.postMessage(frame('a', 5)); // some other method → delivered
  assert.equal(fake.out.length, 1);
});

test('dropEveryNth drops every Nth inbound message', () => {
  const fake = fakeProvider();
  const fp = createFaultProvider(fake.provider, () => ({ dropEveryNth: 3 }));
  const received = [];
  fp.subscribe((m) => received.push(m));

  for (let i = 1; i <= 6; i++) fake.emitInbound(frame('a', 5));
  // Messages 3 and 6 dropped → 4 delivered.
  assert.equal(received.length, 4);
});

test('latencyMs delays delivery in both directions', async () => {
  const fake = fakeProvider();
  const fp = createFaultProvider(fake.provider, () => ({ latencyMs: 25 }));
  const received = [];
  fp.subscribe((m) => received.push(m));

  fp.postMessage(frame('a', 5));
  fake.emitInbound(frame('a', 5));
  // Nothing delivered synchronously.
  assert.equal(fake.out.length, 0);
  assert.equal(received.length, 0);

  await delay(60);
  assert.equal(fake.out.length, 1);
  assert.equal(received.length, 1);
});

test('faults are read per-message (runtime toggle)', () => {
  const fake = fakeProvider();
  let faults = {};
  const fp = createFaultProvider(fake.provider, () => faults);

  fp.postMessage(frame('a', 1));
  assert.equal(fake.out.length, 1); // delivered: no faults yet

  faults = { dropHandshake: true };
  fp.postMessage(frame('a', 1));
  assert.equal(fake.out.length, 1); // now dropped
});
