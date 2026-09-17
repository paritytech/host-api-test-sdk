# TrUAPI 0.17 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@novasamatech/host-container` with `@parity/truapi@0.17.0` + `@parity/truapi-host@0.17.0` + `@parity/truapi-provider@0.2.0` and `polkadot-api` v3, keeping local auto-signing dev accounts with no network, no Docker and no external process.

**Architecture:** The host boots the WASM TrUAPI core in a Web Worker and supplies 12 typed callback groups. Signing always travels to "the paired peer" over a statement-store channel, so the host mints both halves of that session itself and serves the channel through its own `chain.connect` as an in-memory loopback store. A local responder decrypts each request, signs it with `//Alice`-style dev keys, and posts the reply back on the peer topic.

**Tech Stack:** `@parity/truapi` 0.17.0, `@parity/truapi-host` 0.17.0, `@parity/truapi-provider` 0.2.0, `polkadot-api` 3.1.0, `scale-ts`, `@scure/sr25519`, `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@polkadot-labs/hdkd-helpers`, esbuild, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-truapi-migration-design.md`

## Global Constraints

- Dependency versions are exact, not ranged: `@parity/truapi@0.17.0`, `@parity/truapi-host@0.17.0`, `@parity/truapi-provider@0.2.0`, `polkadot-api@3.1.0`.
- No external signer, no `truapi-host` CLI, no signing-bot, no `@novasamatech/host-papp`, no custom WASM build. Nothing may leave the page or require the network at test time.
- All `@novasamatech/*` dependencies are removed by the end of the plan.
- Dev-account addresses MUST stay stable: `//Alice` = `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`, `//Bob` = `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`.
- `RemoteMessage` variant order is the wire protocol; indices 14–23 are pinned explicitly and MUST match `rust/crates/truapi-server/src/host_logic/sso/messages/v1.rs` in `../host-rust-core`.
- The synthetic People-chain genesis hash is 32 bytes of `0x01`. It identifies the loopback statement store and must be used consistently in `hostConfig.people.genesisHash` and the `chain.connect` branch.
- Per `CLAUDE.md`, the final task MUST update `package.json`, `CHANGELOG.md`, `forum-post.md` and `README.md` together.
- Reference sources (read, never depend on): `../host-rust-core` for the Rust wire definitions, `../triangle-js-sdks/packages/statement-store` for a JS implementation of the same codecs.

---

### Task 1: Tooling and dependency swap

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/browser/constants.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PEOPLE_GENESIS_HASH: Uint8Array` (32 bytes of `0x01`), `ZERO_HASH: Uint8Array` (32 zero bytes), both from `src/browser/constants.ts`.

- [ ] **Step 1: Swap dependencies**

```bash
pnpm remove @novasamatech/host-api @novasamatech/host-api-wrapper @novasamatech/host-container
pnpm add -D @parity/truapi@0.17.0 @parity/truapi-host@0.17.0 @parity/truapi-provider@0.2.0 \
  polkadot-api@3.1.0 scale-ts@1.6.1 @scure/sr25519 @noble/curves @noble/ciphers @noble/hashes \
  @polkadot-labs/hdkd-helpers vitest
```

`@polkadot/keyring`, `@polkadot/types`, `@polkadot/util`, `@polkadot/util-crypto` and `neverthrow` stay for now; Task 8 decides their fate.

- [ ] **Step 2: Add the vitest config**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add the unit-test script**

In `package.json` `scripts`, add:

```json
"test:unit": "vitest run"
```

- [ ] **Step 4: Add the shared constants**

```ts
// src/browser/constants.ts
/**
 * Genesis hash identifying the in-page loopback statement store.
 *
 * The core opens its SSO channel by asking the host to connect to the People
 * chain. Nothing real is behind it here, so a fixed synthetic hash marks the
 * connection the loopback store answers — distinct from the all-zero hash,
 * which declares "this host has no such chain".
 */
export const PEOPLE_GENESIS_HASH = new Uint8Array(32).fill(1);

/** All-zero hash — declares a chain this host deliberately does not have. */
export const ZERO_HASH = new Uint8Array(32);
```

- [ ] **Step 5: Verify the toolchain runs**

Run: `pnpm test:unit`
Expected: exits 0 with "No test files found" (no specs yet).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/browser/constants.ts
git commit -m "chore: swap to @parity/truapi 0.17 stack and add vitest"
```

---

### Task 2: Dev account derivation

**Files:**
- Create: `src/browser/dev-accounts.ts`
- Test: `src/browser/dev-accounts.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DevKeypair { secretKey: Uint8Array; publicKey: Uint8Array; address: string }` — `secretKey` is the 64-byte expanded sr25519 secret.
  - `deriveDev(...junctions: string[]): DevKeypair`
  - `deriveFromUri(uri: string): DevKeypair` — accepts `//Alice`, `//Alice//myapp.dot/0`.
  - `DEV_ACCOUNT_URIS: Record<DevAccountName, string>`

The 64-byte secret shape matters: the core's `validate_auto_signing_key` and every signing path use `SecretKey::from_bytes`, which wants `scalar || nonce`.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/dev-accounts.spec.ts
import { describe, expect, it } from 'vitest';
import { deriveDev, deriveFromUri } from './dev-accounts.js';

describe('dev account derivation', () => {
  it('reproduces the canonical dev addresses', () => {
    expect(deriveDev('Alice').address).toBe(
      '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    );
    expect(deriveDev('Bob').address).toBe(
      '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    );
  });

  it('exposes the 64-byte expanded secret the core requires', () => {
    const alice = deriveDev('Alice');
    expect(alice.secretKey).toHaveLength(64);
    expect(alice.publicKey).toHaveLength(32);
  });

  it('parses substrate URIs, including nested junctions', () => {
    expect(deriveFromUri('//Alice').address).toBe(deriveDev('Alice').address);
    expect(deriveFromUri('//Alice//myapp.dot/0').address).toBe(
      deriveDev('Alice', 'myapp.dot/0').address,
    );
  });

  it('derives distinct keys per junction', () => {
    expect(deriveDev('Alice', 'a').address).not.toBe(deriveDev('Alice', 'b').address);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/dev-accounts.spec.ts`
Expected: FAIL — cannot resolve `./dev-accounts.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/dev-accounts.ts
/**
 * Dev-account keys, derived in-page with no WASM crypto.
 *
 * Addresses are the canonical Substrate dev ones, so tests and funded testnet
 * accounts keep working across the migration.
 */
import { HDKD, getPublicKey, secretFromSeed } from '@scure/sr25519';
import { DEV_MINI_SECRET, ss58Address } from '@polkadot-labs/hdkd-helpers';

export type DevAccountName = 'alice' | 'bob' | 'charlie' | 'dave' | 'eve' | 'ferdie';

export const DEV_ACCOUNT_URIS: Record<DevAccountName, string> = {
  alice: '//Alice',
  bob: '//Bob',
  charlie: '//Charlie',
  dave: '//Dave',
  eve: '//Eve',
  ferdie: '//Ferdie',
};

export interface DevKeypair {
  /** 64-byte expanded sr25519 secret — what `SecretKey::from_bytes` expects. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value !== 'string') return value;
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const ROOT_SECRET = secretFromSeed(toBytes(DEV_MINI_SECRET as unknown as string));

/** SCALE chain code for a junction label: compact length prefix, then the bytes. */
function chainCode(label: string): Uint8Array {
  const encoded = new TextEncoder().encode(label);
  if (encoded.length >= 32) {
    throw new Error(`derivation junction too long: ${label}`);
  }
  const cc = new Uint8Array(32);
  cc[0] = encoded.length << 2;
  cc.set(encoded, 1);
  return cc;
}

function fromSecret(secretKey: Uint8Array): DevKeypair {
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, address: ss58Address(publicKey, 42) };
}

/** Derive a dev account by hard junctions: `deriveDev('Alice', 'myapp.dot/0')`. */
export function deriveDev(...junctions: string[]): DevKeypair {
  let secretKey = ROOT_SECRET;
  for (const junction of junctions) {
    secretKey = HDKD.secretHard(secretKey, chainCode(junction));
  }
  return fromSecret(secretKey);
}

/**
 * Derive from a Substrate URI. Only hard junctions (`//x`) are supported —
 * every path this host builds uses them, and a soft junction would silently
 * produce a different address.
 */
export function deriveFromUri(uri: string): DevKeypair {
  if (uri.includes('/') && !uri.startsWith('//')) {
    throw new Error(`unsupported derivation URI: ${uri}`);
  }
  const junctions = uri.split('//').filter((part) => part.length > 0);
  return deriveDev(...junctions);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/dev-accounts.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/dev-accounts.ts src/browser/dev-accounts.spec.ts
git commit -m "feat: derive dev accounts with scure sr25519, keeping canonical addresses"
```

---

### Task 3: Session blob codec

**Files:**
- Create: `src/browser/sso/session-blob.ts`
- Test: `src/browser/sso/session-blob.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SsoSessionInfo` and `SessionInfo` scale-ts codecs
  - `encodePersistedSession(info): Uint8Array`
  - `interface ExternalSessionOptions { rootPublicKey; identityAccountId; rootEntropySource?; encSecret; peerEncPubkey; ssSecret; ssPublicKey; sessionIdOwn; sessionIdPeer }`
  - `encodeExternalPairedSession(options: ExternalSessionOptions): Uint8Array`

Layout source: `rust/crates/truapi-server/src/host_logic/session.rs` in `../host-rust-core`. The blob is `0x01` followed by a bare positional SCALE struct.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/sso/session-blob.spec.ts
import { describe, expect, it } from 'vitest';
import { SessionInfo, encodeExternalPairedSession } from './session-blob.js';

const bytes = (fill: number, length = 32) => new Uint8Array(length).fill(fill);

describe('session blob', () => {
  const options = {
    rootPublicKey: bytes(1),
    identityAccountId: bytes(2),
    encSecret: bytes(3),
    peerEncPubkey: bytes(4),
    ssSecret: bytes(5, 64),
    ssPublicKey: bytes(6),
    sessionIdOwn: bytes(7),
    sessionIdPeer: bytes(8),
  };

  it('prefixes the blob with the v1 layout tag', () => {
    expect(encodeExternalPairedSession(options)[0]).toBe(1);
  });

  it('round-trips through the SessionInfo codec', () => {
    const decoded = SessionInfo.dec(encodeExternalPairedSession(options).slice(1));
    expect(decoded.public_key).toEqual(options.rootPublicKey);
    expect(decoded.sso?.session_id_own).toEqual(options.sessionIdOwn);
    expect(decoded.sso?.peer_enc_pubkey).toEqual(options.peerEncPubkey);
    expect(decoded.identity_account_id).toEqual(options.identityAccountId);
  });

  it('leaves usernames unset so the runtime resolves them itself', () => {
    const decoded = SessionInfo.dec(encodeExternalPairedSession(options).slice(1));
    expect(decoded.lite_username).toBeUndefined();
    expect(decoded.full_username).toBeUndefined();
  });

  it('consumes the blob exactly, with no trailing bytes', () => {
    const body = encodeExternalPairedSession(options).slice(1);
    expect(SessionInfo.enc(SessionInfo.dec(body))).toEqual(body);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/sso/session-blob.spec.ts`
Expected: FAIL — cannot resolve `./session-blob.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/sso/session-blob.ts
/**
 * Codec for the core-owned persisted-session blob.
 *
 * Mirrors `SessionInfo` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/session.rs`.
 * The layout is positional and core-private; the leading version tag is what
 * turns an upstream layout change into a decode failure rather than silent
 * drift, so it must never be dropped.
 */
import { Bytes, Option, Struct, str, u8 } from 'scale-ts';

/** `PERSISTED_SESSION_V1`. */
const PERSISTED_SESSION_V1 = 1;

const Bytes32 = Bytes(32);
const Bytes64 = Bytes(64);

export const SsoSessionInfo = Struct({
  ss_secret: Bytes64,
  ss_public_key: Bytes32,
  enc_secret: Bytes32,
  peer_enc_pubkey: Bytes32,
  identity_account_id: Bytes32,
  session_id_own: Bytes32,
  session_id_peer: Bytes32,
  request_channel: Bytes32,
  response_channel: Bytes32,
  peer_request_channel: Bytes32,
});

export const SessionInfo = Struct({
  public_key: Bytes32,
  sso: Option(SsoSessionInfo),
  root_entropy_source: Option(Bytes32),
  identity_account_id: Option(Bytes32),
  identity_chat_private_key: Option(Bytes32),
  device_enc_public_key: Option(Bytes32),
  lite_username: Option(str),
  full_username: Option(str),
});

export function encodePersistedSession(
  info: Parameters<typeof SessionInfo.enc>[0],
): Uint8Array {
  const body = SessionInfo.enc(info);
  const blob = new Uint8Array(1 + body.length);
  blob[0] = u8.enc(PERSISTED_SESSION_V1)[0];
  blob.set(body, 1);
  return blob;
}

export interface ExternalSessionOptions {
  /** The signer's sr25519 root public key. */
  rootPublicKey: Uint8Array;
  identityAccountId: Uint8Array;
  rootEntropySource?: Uint8Array;
  /** Host's X25519 secret. */
  encSecret: Uint8Array;
  /** The local peer's X25519 public key. */
  peerEncPubkey: Uint8Array;
  /** Host's 64-byte statement-store signing secret. */
  ssSecret: Uint8Array;
  ssPublicKey: Uint8Array;
  /** Topic the host publishes requests on. */
  sessionIdOwn: Uint8Array;
  /** Topic the peer publishes replies on. */
  sessionIdPeer: Uint8Array;
}

/**
 * Encode an already-paired session, as `encode_external_paired_session` does.
 *
 * Usernames are deliberately absent: the runtime resolves and persists those
 * through its own identity lookup.
 */
export function encodeExternalPairedSession(
  options: ExternalSessionOptions,
): Uint8Array {
  const { rootEntropySource = new Uint8Array(32) } = options;
  return encodePersistedSession({
    public_key: options.rootPublicKey,
    sso: {
      ss_secret: options.ssSecret,
      ss_public_key: options.ssPublicKey,
      enc_secret: options.encSecret,
      peer_enc_pubkey: options.peerEncPubkey,
      identity_account_id: options.identityAccountId,
      session_id_own: options.sessionIdOwn,
      session_id_peer: options.sessionIdPeer,
      request_channel: new Uint8Array(32),
      response_channel: new Uint8Array(32),
      peer_request_channel: new Uint8Array(32),
    },
    root_entropy_source: rootEntropySource,
    identity_account_id: options.identityAccountId,
    identity_chat_private_key: undefined,
    device_enc_public_key: undefined,
    lite_username: undefined,
    full_username: undefined,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/sso/session-blob.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sso/session-blob.ts src/browser/sso/session-blob.spec.ts
git commit -m "feat: encode the core session blob in JS"
```

---

### Task 4: SSO channel crypto

**Files:**
- Create: `src/browser/sso/crypto.ts`
- Test: `src/browser/sso/crypto.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sessionAeadKey(encSecret: Uint8Array, peerEncPubkey: Uint8Array): Uint8Array` — 32 bytes
  - `seal(key: Uint8Array, plaintext: Uint8Array, nonce?: Uint8Array): Uint8Array` — `nonce || ciphertext`
  - `open(key: Uint8Array, blob: Uint8Array): Uint8Array`
  - `AEAD_NONCE_LEN = 12`

Matches `session_aead_key` in `rust/crates/truapi-server/src/host_logic/sso/pairing.rs`: HKDF-SHA256 over the X25519 shared secret, empty salt and info, then ChaCha20-Poly1305.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/sso/crypto.spec.ts
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { open, seal, sessionAeadKey } from './crypto.js';

describe('sso channel crypto', () => {
  const hostSecret = x25519.utils.randomSecretKey();
  const peerSecret = x25519.utils.randomSecretKey();
  const hostPublic = x25519.getPublicKey(hostSecret);
  const peerPublic = x25519.getPublicKey(peerSecret);

  it('derives the same key from either side of the channel', () => {
    expect(sessionAeadKey(hostSecret, peerPublic)).toEqual(
      sessionAeadKey(peerSecret, hostPublic),
    );
  });

  it('round-trips a payload', () => {
    const key = sessionAeadKey(hostSecret, peerPublic);
    const message = new TextEncoder().encode('sign this');
    expect(open(key, seal(key, message))).toEqual(message);
  });

  it('rejects an all-zero peer key as non-contributory', () => {
    expect(() => sessionAeadKey(hostSecret, new Uint8Array(32))).toThrow(
      /invalid X25519 public key/,
    );
  });

  it('fails to open under the wrong key', () => {
    const sealed = seal(sessionAeadKey(hostSecret, peerPublic), new Uint8Array([1, 2, 3]));
    const wrong = sessionAeadKey(x25519.utils.randomSecretKey(), peerPublic);
    expect(() => open(wrong, sealed)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/sso/crypto.spec.ts`
Expected: FAIL — cannot resolve `./crypto.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/sso/crypto.ts
/**
 * Channel crypto for the SSO session, matching `session_aead_key` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/sso/pairing.rs`.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const AEAD_NONCE_LEN = 12;

/**
 * HKDF-SHA256 over the X25519 shared secret, with empty salt and info.
 *
 * An all-zero (or otherwise small-order) peer key yields a non-contributory
 * exchange. The core rejects that as `invalid X25519 public key`, so this
 * throws the same way rather than deriving a key from a degenerate secret.
 */
export function sessionAeadKey(
  encSecret: Uint8Array,
  peerEncPubkey: Uint8Array,
): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(encSecret, peerEncPubkey);
  } catch (cause) {
    throw new Error('invalid X25519 public key', { cause });
  }
  if (shared.every((byte) => byte === 0)) {
    throw new Error('invalid X25519 public key');
  }
  return hkdf(sha256, shared, undefined, undefined, 32);
}

/** Encrypt, returning `nonce || ciphertext`. */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(AEAD_NONCE_LEN)),
): Uint8Array {
  const ciphertext = chacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Decrypt a `nonce || ciphertext` blob. Throws if authentication fails. */
export function open(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length <= AEAD_NONCE_LEN) {
    throw new Error('sso payload too short');
  }
  const nonce = blob.subarray(0, AEAD_NONCE_LEN);
  const ciphertext = blob.subarray(AEAD_NONCE_LEN);
  return chacha20poly1305(key, nonce).decrypt(ciphertext);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/sso/crypto.spec.ts`
Expected: PASS, 4 tests.

If the nonce layout turns out to be prefixed differently, confirm against `encrypt_chacha20_poly1305_with_nonce` in the Rust before changing the test — the wire layout is the core's, not ours.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sso/crypto.ts src/browser/sso/crypto.spec.ts
git commit -m "feat: implement SSO channel AEAD and key derivation"
```

---

### Task 5: Statement codec and proof

**Files:**
- Create: `src/browser/sso/statement.ts`
- Test: `src/browser/sso/statement.spec.ts`

**Interfaces:**
- Consumes: `deriveDev` from `../dev-accounts.js` (tests only).
- Produces:
  - `interface Statement { proof?: { signature: Uint8Array; signer: Uint8Array }; decryptionKey?: Uint8Array; expiry?: bigint; channel?: Uint8Array; topics?: Uint8Array[]; data?: Uint8Array }`
  - `encodeStatement(statement: Statement): Uint8Array`
  - `decodeStatement(bytes: Uint8Array): Statement`
  - `signStatement(secretKey: Uint8Array, statement: Statement): Statement` — sr25519 proof
  - `matchesTopics(statement: Statement, kind: 'MatchAll' | 'MatchAny', topics: Uint8Array[]): boolean`

Field layout reference: `@novasamatech/sdk-statement`'s `codec/codec.js` (read at `../signing-bot/node_modules/@novasamatech/sdk-statement/dist/`) and the statement-store primitives in `../host-rust-core`. A statement is a SCALE `Vec` of index-tagged fields; the proof covers the encoded unsigned statement with its compact length prefix stripped.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/sso/statement.spec.ts
import { describe, expect, it } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import { decodeStatement, encodeStatement, matchesTopics, signStatement } from './statement.js';

const topic = (fill: number) => new Uint8Array(32).fill(fill);

describe('statement codec', () => {
  const base = {
    topics: [topic(7)],
    data: new Uint8Array([1, 2, 3, 4]),
    expiry: 1000n,
  };

  it('round-trips an unsigned statement', () => {
    expect(decodeStatement(encodeStatement(base))).toMatchObject(base);
  });

  it('attaches an sr25519 proof carrying the signer public key', () => {
    const alice = deriveDev('Alice');
    const signed = signStatement(alice.secretKey, base);
    expect(signed.proof?.signer).toEqual(alice.publicKey);
    expect(signed.proof?.signature).toHaveLength(64);
  });

  it('round-trips a signed statement', () => {
    const signed = signStatement(deriveDev('Alice').secretKey, base);
    expect(decodeStatement(encodeStatement(signed)).proof?.signature).toEqual(
      signed.proof?.signature,
    );
  });

  it('matches MatchAll only when every topic is present', () => {
    const statement = { ...base, topics: [topic(1), topic(2)] };
    expect(matchesTopics(statement, 'MatchAll', [topic(1), topic(2)])).toBe(true);
    expect(matchesTopics(statement, 'MatchAll', [topic(1), topic(3)])).toBe(false);
  });

  it('matches MatchAny when one topic is present', () => {
    const statement = { ...base, topics: [topic(1)] };
    expect(matchesTopics(statement, 'MatchAny', [topic(1), topic(3)])).toBe(true);
    expect(matchesTopics(statement, 'MatchAny', [topic(3)])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/sso/statement.spec.ts`
Expected: FAIL — cannot resolve `./statement.js`.

- [ ] **Step 3: Implement**

Field indices are taken from `@novasamatech/sdk-statement`'s `codec/codec.js`
(readable at `../signing-bot/node_modules/@novasamatech/sdk-statement/dist/`):
`proof` 0, `decryptionKey` 1, `expiry` 2, `channel` 3, `topic1..topic4` 4–7,
`data` 8. Fields are emitted in ascending index order and `topics` expands to
the numbered variants, at most four.

```ts
// src/browser/sso/statement.ts
/**
 * Statement-store `Statement` codec and sr25519 proof.
 *
 * A statement is a SCALE `Vec` of index-tagged fields, ordered by index. The
 * proof covers the encoded unsigned statement with its outer compact length
 * prefix removed — signing the prefixed form yields a statement the store
 * rejects.
 */
import { getPublicKey, sign } from '@scure/sr25519';
import { Bytes, Enum, Struct, Vector, u64 } from 'scale-ts';

const Bytes32 = Bytes(32);
const Bytes64 = Bytes(64);

/** Declaration order is the wire index — see the note above. */
const Field = Enum({
  proof: Enum({
    sr25519: Struct({ signature: Bytes64, signer: Bytes32 }),
    ed25519: Struct({ signature: Bytes64, signer: Bytes32 }),
    ecdsa: Struct({ signature: Bytes(65), signer: Bytes(33) }),
    onChain: Struct({ who: Bytes32, blockHash: Bytes32, event: u64 }),
  }),
  decryptionKey: Bytes32,
  expiry: u64,
  channel: Bytes32,
  topic1: Bytes32,
  topic2: Bytes32,
  topic3: Bytes32,
  topic4: Bytes32,
  data: Bytes(),
});

const StatementFields = Vector(Field);

export interface StatementProof {
  signature: Uint8Array;
  signer: Uint8Array;
}

export interface Statement {
  proof?: StatementProof;
  decryptionKey?: Uint8Array;
  expiry?: bigint;
  channel?: Uint8Array;
  topics?: Uint8Array[];
  data?: Uint8Array;
}

export type TopicFilterKind = 'MatchAll' | 'MatchAny';

const TOPIC_TAGS = ['topic1', 'topic2', 'topic3', 'topic4'] as const;

export function encodeStatement(statement: Statement): Uint8Array {
  const fields: Array<{ tag: string; value: unknown }> = [];

  if (statement.proof) {
    fields.push({ tag: 'proof', value: { tag: 'sr25519', value: statement.proof } });
  }
  if (statement.decryptionKey) {
    fields.push({ tag: 'decryptionKey', value: statement.decryptionKey });
  }
  if (statement.expiry !== undefined) {
    fields.push({ tag: 'expiry', value: statement.expiry });
  }
  if (statement.channel) {
    fields.push({ tag: 'channel', value: statement.channel });
  }
  const topics = statement.topics ?? [];
  if (topics.length > 4) {
    throw new Error(`max topics length is 4, received ${topics.length}`);
  }
  topics.forEach((topic, index) => {
    fields.push({ tag: TOPIC_TAGS[index], value: topic });
  });
  if (statement.data) {
    fields.push({ tag: 'data', value: statement.data });
  }

  return StatementFields.enc(fields as never);
}

export function decodeStatement(bytes: Uint8Array): Statement {
  const statement: Statement = {};
  for (const field of StatementFields.dec(bytes) as Array<{ tag: string; value: never }>) {
    if (field.tag === 'proof') {
      const proof = field.value as unknown as { tag: string; value: StatementProof };
      if (proof.tag !== 'sr25519') {
        throw new Error(`unsupported proof type: ${proof.tag}`);
      }
      statement.proof = proof.value;
    } else if (field.tag.startsWith('topic')) {
      (statement.topics ??= []).push(field.value);
    } else {
      (statement as Record<string, unknown>)[field.tag] = field.value;
    }
  }
  return statement;
}

/** Sign the unsigned form and return the statement with its proof attached. */
export function signStatement(secretKey: Uint8Array, statement: Statement): Statement {
  const { proof: _drop, ...unsigned } = statement;
  const encoded = encodeStatement(unsigned);
  const signature = sign(secretKey, stripCompactPrefix(encoded));
  return { ...statement, proof: { signature, signer: getPublicKey(secretKey) } };
}

function stripCompactPrefix(encoded: Uint8Array): Uint8Array {
  const marker = encoded[0] & 0b11;
  // Big-integer mode stores (byteCount - 4) in the upper six bits, so the
  // prefix is the mode byte plus 4 plus that remainder.
  const prefixLen = marker === 0 ? 1 : marker === 1 ? 2 : marker === 2 ? 4 : 5 + (encoded[0] >> 2);
  return encoded.subarray(prefixLen);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

export function matchesTopics(
  statement: Statement,
  kind: TopicFilterKind,
  topics: Uint8Array[],
): boolean {
  const present = statement.topics ?? [];
  const has = (topic: Uint8Array) => present.some((candidate) => sameBytes(candidate, topic));
  return kind === 'MatchAll' ? topics.every(has) : topics.some(has);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/sso/statement.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sso/statement.ts src/browser/sso/statement.spec.ts
git commit -m "feat: encode and sign statement-store statements"
```

---

### Task 6: SSO message codecs

**Files:**
- Create: `src/browser/sso/messages.ts`
- Test: `src/browser/sso/messages.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StatementData` codec — `Enum({ request: Struct({ requestId: str, data: Vector(Bytes()) }), response: Struct({ requestId: str, responseCode: u8 }) })`
  - `RemoteMessage` codec — the versioned enum
  - `VersionedRemoteMessage` codec — `Enum({ V1: RemoteMessage })`

**The variant order is the wire protocol.** Copy it verbatim from `../host-rust-core/rust/crates/truapi-server/src/host_logic/sso/messages/v1.rs`, including the explicit indices 14–23. `scale-ts`'s `Enum` assigns indices by declaration order, so every variant — including responses this host never sends — must be declared, in order, or every later index shifts.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/sso/messages.spec.ts
import { describe, expect, it } from 'vitest';
import { REMOTE_MESSAGE_VARIANTS, StatementData } from './messages.js';

describe('sso messages', () => {
  it('round-trips a request envelope', () => {
    const value = { requestId: 'abc', data: [new Uint8Array([1, 2])] };
    const encoded = StatementData.enc({ tag: 'request', value });
    expect(StatementData.dec(encoded)).toEqual({ tag: 'request', value });
  });

  it('round-trips a response envelope with an accepted code', () => {
    const value = { requestId: 'abc', responseCode: 0 };
    expect(StatementData.dec(StatementData.enc({ tag: 'response', value }))).toEqual({
      tag: 'response',
      value,
    });
  });

  it('pins the RemoteMessage variant order to the Rust wire protocol', () => {
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('Disconnected')).toBe(0);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('SignRequest')).toBe(1);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('SignVrfRequest')).toBe(14);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('ProductSubtreeRequest')).toBe(16);
    expect(REMOTE_MESSAGE_VARIANTS.indexOf('RingVrfSignResponse')).toBe(23);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/sso/messages.spec.ts`
Expected: FAIL — cannot resolve `./messages.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/sso/messages.ts
/**
 * SSO statement payload and remote-message codecs.
 *
 * `REMOTE_MESSAGE_VARIANTS` is the wire protocol: scale-ts assigns enum
 * indices by declaration order, so entries may only be appended, never
 * reordered. It mirrors `v1::RemoteMessage` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/sso/messages/v1.rs`.
 */
import { Bytes, Enum, Struct, Vector, str, u8 } from 'scale-ts';

export const StatementRequest = Struct({
  requestId: str,
  data: Vector(Bytes()),
});

export const StatementResponse = Struct({
  requestId: str,
  responseCode: u8,
});

export const StatementData = Enum({
  request: StatementRequest,
  response: StatementResponse,
});

/** Declaration order is the wire format — append only. */
export const REMOTE_MESSAGE_VARIANTS = [
  'Disconnected',
  'SignRequest',
  'SignResponse',
  'GetAccountAliasRequest',
  'GetAccountAliasResponse',
  'ResourceAllocationRequest',
  'ResourceAllocationResponse',
  'CreateTransactionRequest',
  'CreateTransactionResponse',
  'CreateTransactionWithLegacyAccountRequest',
  'SignRawWithLegacyAccountRequest',
  'SignRawWithLegacyAccountResponse',
  'CreateAccountProofRequest',
  'CreateAccountProofResponse',
  'SignVrfRequest',
  'SignVrfResponse',
  'ProductSubtreeRequest',
  'ProductSubtreeResponse',
  'RegisterRingVrfKeyRequest',
  'RegisterRingVrfKeyResponse',
  'ListRingVrfKeysRequest',
  'ListRingVrfKeysResponse',
  'RingVrfSignRequest',
  'RingVrfSignResponse',
] as const;

export type RemoteMessageVariant = (typeof REMOTE_MESSAGE_VARIANTS)[number];
```

Then declare the `RemoteMessage` `Enum` with one entry per name above, in that exact order, giving each its payload codec. Build payload codecs from the request/response types in `@parity/truapi`'s generated `types.d.ts` — they are already exported as `S.Codec` values (for example `HostSignPayloadRequest`, `HostAccountCreateProofRequest`), so import those rather than re-deriving them. Export `VersionedRemoteMessage = Enum({ V1: RemoteMessage })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/sso/messages.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sso/messages.ts src/browser/sso/messages.spec.ts
git commit -m "feat: add SSO statement and remote-message codecs"
```

---

### Task 7: Loopback statement store

**Files:**
- Create: `src/browser/loopback-chain.ts`
- Test: `src/browser/loopback-chain.spec.ts`

**Interfaces:**
- Consumes: `Statement`, `decodeStatement`, `encodeStatement`, `matchesTopics` from `./sso/statement.js`.
- Produces:
  - `interface LoopbackStore { connect(onResponse: (json: string) => void): { send(request: string): void; close(): void }; publish(statement: Statement): void; onSubmit(listener: (statement: Statement) => void): () => void; }`
  - `createLoopbackStore(): LoopbackStore`

Serves exactly three JSON-RPC methods: `statement_submit`, `statement_subscribeStatement`, `statement_unsubscribeStatement`. `statement_submit` always answers `"new"` — the host is the store, so there is no allowance to fail.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/loopback-chain.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { createLoopbackStore } from './loopback-chain.js';
import { encodeStatement } from './sso/statement.js';

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const topic = (fill: number) => new Uint8Array(32).fill(fill);

describe('loopback statement store', () => {
  it('accepts a submitted statement as new', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    const statement = { topics: [topic(1)], data: new Uint8Array([9]) };

    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement(statement))],
      }),
    );

    expect(JSON.parse(onResponse.mock.calls[0][0]).result).toBe('new');
  });

  it('reports submitted statements to listeners', () => {
    const store = createLoopbackStore();
    const seen = vi.fn();
    store.onSubmit(seen);
    const connection = store.connect(() => {});
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'statement_submit',
        params: [toHex(encodeStatement({ topics: [topic(2)], data: new Uint8Array([1]) }))],
      }),
    );
    expect(seen).toHaveBeenCalledOnce();
  });

  it('delivers published statements to matching subscribers only', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(3))] }],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(9)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();

    store.publish({ topics: [topic(3)], data: new Uint8Array([2]) });
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribe', () => {
    const store = createLoopbackStore();
    const onResponse = vi.fn();
    const connection = store.connect(onResponse);
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [toHex(topic(4))] }],
      }),
    );
    const subscriptionId = JSON.parse(onResponse.mock.calls[0][0]).result;
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'statement_unsubscribeStatement',
        params: [subscriptionId],
      }),
    );
    onResponse.mockClear();

    store.publish({ topics: [topic(4)], data: new Uint8Array([1]) });
    expect(onResponse).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/loopback-chain.spec.ts`
Expected: FAIL — cannot resolve `./loopback-chain.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/loopback-chain.ts
/**
 * In-memory statement store behind `chain.connect`.
 *
 * The core reaches its paired peer by submitting and subscribing to statements
 * on the People chain. Serving that surface in-page is what keeps signing local:
 * no node, no network, no allowance to register.
 */
import {
  type Statement,
  type TopicFilterKind,
  decodeStatement,
  encodeStatement,
  matchesTopics,
} from './sso/statement.js';

interface Subscription {
  id: string;
  kind: TopicFilterKind;
  topics: Uint8Array[];
  notify: (json: string) => void;
}

const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

const fromHex = (value: string): Uint8Array => {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export interface LoopbackConnection {
  send(request: string): void;
  close(): void;
}

export interface LoopbackStore {
  connect(onResponse: (json: string) => void): LoopbackConnection;
  /** Deliver a statement to every matching subscriber. */
  publish(statement: Statement): void;
  /** Observe statements the core submits. Returns the unsubscribe. */
  onSubmit(listener: (statement: Statement) => void): () => void;
}

export function createLoopbackStore(): LoopbackStore {
  const subscriptions = new Set<Subscription>();
  const submitListeners = new Set<(statement: Statement) => void>();
  let nextSubscriptionId = 1;

  /** Accepts `{ MatchAll: [...] }` / `{ MatchAny: [...] }` and the bare array form. */
  function parseFilter(raw: unknown): { kind: TopicFilterKind; topics: Uint8Array[] } {
    if (Array.isArray(raw)) {
      return { kind: 'MatchAll', topics: raw.map((t) => fromHex(String(t))) };
    }
    const filter = (raw ?? {}) as Record<string, unknown>;
    const kind: TopicFilterKind = 'MatchAny' in filter ? 'MatchAny' : 'MatchAll';
    const topics = (filter[kind] as unknown[] | undefined) ?? [];
    return { kind, topics: topics.map((t) => fromHex(String(t))) };
  }

  return {
    connect(onResponse) {
      const owned = new Set<Subscription>();

      return {
        send(request: string) {
          const { id, method, params = [] } = JSON.parse(request) as {
            id: number | string;
            method: string;
            params?: unknown[];
          };
          const reply = (result: unknown) =>
            onResponse(JSON.stringify({ jsonrpc: '2.0', id, result }));

          switch (method) {
            case 'statement_submit': {
              const statement = decodeStatement(fromHex(String(params[0])));
              // The host owns the store, so nothing can be rejected here.
              reply('new');
              for (const listener of submitListeners) listener(statement);
              return;
            }
            case 'statement_subscribeStatement': {
              const { kind, topics } = parseFilter(params[0]);
              const subscriptionId = `sub-${nextSubscriptionId++}`;
              const subscription: Subscription = {
                id: subscriptionId,
                kind,
                topics,
                notify: onResponse,
              };
              subscriptions.add(subscription);
              owned.add(subscription);
              reply(subscriptionId);
              return;
            }
            case 'statement_unsubscribeStatement': {
              const target = String(params[0]);
              for (const subscription of owned) {
                if (subscription.id !== target) continue;
                subscriptions.delete(subscription);
                owned.delete(subscription);
              }
              reply(true);
              return;
            }
            default:
              onResponse(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  error: { code: -32601, message: `unsupported method: ${method}` },
                }),
              );
          }
        },
        close() {
          for (const subscription of owned) subscriptions.delete(subscription);
          owned.clear();
        },
      };
    },

    publish(statement) {
      const result = toHex(encodeStatement(statement));
      for (const subscription of subscriptions) {
        if (!matchesTopics(statement, subscription.kind, subscription.topics)) continue;
        subscription.notify(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'statement_subscribeStatement',
            params: { subscription: subscription.id, result },
          }),
        );
      }
    },

    onSubmit(listener) {
      submitListeners.add(listener);
      return () => submitListeners.delete(listener);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/loopback-chain.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/loopback-chain.ts src/browser/loopback-chain.spec.ts
git commit -m "feat: serve an in-page loopback statement store"
```

---

### Task 8: Port the signing core

**Files:**
- Create: `src/browser/signing/extrinsic.ts`
- Create: `src/browser/signing/index.ts`
- Test: `src/browser/signing/extrinsic.spec.ts`
- Reference: `src/browser/host-runtime.ts:203-250` (the existing `buildSignedV4Extrinsic`)

**Interfaces:**
- Consumes: `DevKeypair` from `../dev-accounts.js`.
- Produces:
  - `buildSignedV4Extrinsic(keypair: DevKeypair, callData: Uint8Array, extensions: ReadonlyArray<{ extra: Uint8Array; additionalSigned: Uint8Array }>): Uint8Array`
  - `signRawBytes(keypair: DevKeypair, payload: { tag: 'Bytes'; value: Uint8Array } | { tag: 'Payload'; value: string }): Uint8Array`

This is a port, not a rewrite: the extrinsic layout logic moves across unchanged. Only `pair.sign` becomes `@scure/sr25519`'s `sign(secretKey, message)` and `pair.publicKey` becomes `keypair.publicKey`, dropping `@polkadot/keyring`.

`blake2AsU8a` is replaced by `@noble/hashes`' `blake2b` with `dkLen: 32`.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/signing/extrinsic.spec.ts
import { verify } from '@scure/sr25519';
import { describe, expect, it } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import { buildSignedV4Extrinsic, signRawBytes } from './extrinsic.js';

describe('extrinsic signing', () => {
  const alice = deriveDev('Alice');
  const callData = new Uint8Array([0x00, 0x01, 0x02]);
  const extensions = [
    { extra: new Uint8Array([0xaa]), additionalSigned: new Uint8Array([0xbb]) },
  ];

  // Inner length here is 1 + 1 + 32 + 1 + 64 + 1 (extras) + 3 (callData) = 103.
  // 103 >= 64, so the SCALE compact prefix is TWO bytes, not one — every field
  // sits one byte later than a single-byte prefix would put it.
  it('emits a signed v4 extrinsic with the expected header', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    // [compact len ×2][0x84 version+signed][0x00 MultiAddress::Id][32B account]
    expect(extrinsic[2]).toBe(0x84);
    expect(extrinsic[3]).toBe(0x00);
    expect(extrinsic.slice(4, 36)).toEqual(alice.publicKey);
  });

  it('marks the signature as MultiSignature::Sr25519', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    expect(extrinsic[36]).toBe(0x01);
  });

  it('declares a length matching the bytes that follow', () => {
    const extrinsic = buildSignedV4Extrinsic(alice, callData, extensions);
    const declared = ((extrinsic[0] | (extrinsic[1] << 8)) >> 2);
    expect(declared).toBe(extrinsic.length - 2);
  });

  it('signs raw bytes verifiably', () => {
    const message = new Uint8Array([1, 2, 3]);
    const signature = signRawBytes(alice, { tag: 'Bytes', value: message });
    expect(verify(message, signature, alice.publicKey)).toBe(true);
  });

  it('signs a text payload as its UTF-8 bytes', () => {
    const signature = signRawBytes(alice, { tag: 'Payload', value: 'hello' });
    expect(
      verify(new TextEncoder().encode('hello'), signature, alice.publicKey),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/signing/extrinsic.spec.ts`
Expected: FAIL — cannot resolve `./extrinsic.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/signing/extrinsic.ts
/**
 * Extrinsic construction and raw signing.
 *
 * Ported from the pre-migration `host-runtime.ts`; the layout is unchanged, only
 * the key source moved from @polkadot/keyring to @scure/sr25519.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { sign } from '@scure/sr25519';
import type { DevKeypair } from '../dev-accounts.js';

/** SCALE compact encoding for a length. */
function compactLength(value: number): Uint8Array {
  if (value < 64) return new Uint8Array([value << 2]);
  if (value < 2 ** 14) {
    const n = (value << 2) | 0b01;
    return new Uint8Array([n & 0xff, n >> 8]);
  }
  if (value < 2 ** 30) {
    const n = (value << 2) | 0b10;
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  }
  throw new Error(`length too large for compact encoding: ${value}`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build a v4 signed extrinsic:
 *   [compact len][0x84][0x00][AccountId32][0x01][signature 64B][extras][callData]
 *
 * The signing payload is `callData || extras || additionalSigned`, hashed with
 * blake2-256 when it exceeds 256 bytes, per Substrate convention.
 */
export function buildSignedV4Extrinsic(
  keypair: DevKeypair,
  callData: Uint8Array,
  extensions: ReadonlyArray<{ extra: Uint8Array; additionalSigned: Uint8Array }>,
): Uint8Array {
  const extras = concat(extensions.map((extension) => extension.extra));
  const additional = concat(extensions.map((extension) => extension.additionalSigned));

  const payload = concat([callData, extras, additional]);
  const toSign = payload.length > 256 ? blake2b(payload, { dkLen: 32 }) : payload;
  const signature = sign(keypair.secretKey, toSign);

  const inner = concat([
    new Uint8Array([0x84, 0x00]),
    keypair.publicKey,
    new Uint8Array([0x01]),
    signature,
    extras,
    callData,
  ]);

  return concat([compactLength(inner.length), inner]);
}

/** Sign raw bytes, or the UTF-8 bytes of a text payload. */
export function signRawBytes(
  keypair: DevKeypair,
  payload: { tag: 'Bytes'; value: Uint8Array } | { tag: 'Payload'; value: string },
): Uint8Array {
  const data =
    payload.tag === 'Bytes' ? payload.value : new TextEncoder().encode(payload.value);
  return sign(keypair.secretKey, data);
}
```

```ts
// src/browser/signing/index.ts
export { buildSignedV4Extrinsic, signRawBytes } from './extrinsic.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/signing/extrinsic.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Drop the polkadot keyring dependencies**

```bash
pnpm remove @polkadot/keyring @polkadot/util-crypto
```

`@polkadot/types` stays until Task 9 decides whether the `ExtrinsicPayload` path is still needed.

- [ ] **Step 6: Commit**

```bash
git add src/browser/signing package.json pnpm-lock.yaml
git commit -m "feat: port extrinsic and raw signing off @polkadot/keyring"
```

---

### Task 9: SSO responder

**Files:**
- Create: `src/browser/sso/responder.ts`
- Test: `src/browser/sso/responder.spec.ts`

**Interfaces:**
- Consumes: `createLoopbackStore` (`../loopback-chain.js`), `sessionAeadKey`/`seal`/`open` (`./crypto.js`), `StatementData`/`VersionedRemoteMessage` (`./messages.js`), `signStatement` (`./statement.js`), `buildSignedV4Extrinsic`/`signRawBytes` (`../signing/index.js`), `deriveDev`/`deriveFromUri` (`../dev-accounts.js`).
- Produces:
  - `interface SigningLogEntry { type: 'payload' | 'raw' | 'createTransaction'; payload: unknown; timestamp: number }`
  - `interface ResponderOptions { store: LoopbackStore; session: ExternalSessionOptions & { peerEncSecret: Uint8Array }; resolveAccount(dotNsIdentifier: string, derivationIndex: unknown): DevKeypair }`
  - `createSsoResponder(options: ResponderOptions): { getSigningLog(): SigningLogEntry[]; clearSigningLog(): void; dispose(): void }`

The responder subscribes to submitted statements, decrypts each `StatementData.request`, decodes each `RemoteMessage`, answers it, and publishes the reply encrypted on `sessionIdPeer`. It answers all eleven request variants from the spec.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/sso/responder.spec.ts
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveDev } from '../dev-accounts.js';
import { createLoopbackStore } from '../loopback-chain.js';
import { sessionAeadKey, seal } from './crypto.js';
import { StatementData } from './messages.js';
import { createSsoResponder } from './responder.js';
import { encodeStatement, signStatement } from './statement.js';

const topic = (fill: number) => new Uint8Array(32).fill(fill);

function harness() {
  const alice = deriveDev('Alice');
  const hostEncSecret = x25519.utils.randomSecretKey();
  const peerEncSecret = x25519.utils.randomSecretKey();
  const store = createLoopbackStore();
  const session = {
    rootPublicKey: alice.publicKey,
    identityAccountId: alice.publicKey,
    encSecret: hostEncSecret,
    peerEncPubkey: x25519.getPublicKey(peerEncSecret),
    peerEncSecret,
    ssSecret: deriveDev('Alice', 'ss').secretKey,
    ssPublicKey: deriveDev('Alice', 'ss').publicKey,
    sessionIdOwn: topic(1),
    sessionIdPeer: topic(2),
  };
  const responder = createSsoResponder({
    store,
    session,
    resolveAccount: () => alice,
  });
  const key = sessionAeadKey(hostEncSecret, session.peerEncPubkey);
  return { alice, store, session, responder, key };
}

/** Submit an encrypted request batch the way the core would. */
function submitRequest(h: ReturnType<typeof harness>, requestId: string, messages: Uint8Array[]) {
  const data = StatementData.enc({ tag: 'request', value: { requestId, data: messages } });
  const statement = signStatement(h.session.ssSecret, {
    topics: [h.session.sessionIdOwn],
    data: seal(h.key, data),
  });
  const connection = h.store.connect(() => {});
  const toHex = (b: Uint8Array) =>
    `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  connection.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'statement_submit',
      params: [toHex(encodeStatement(statement))],
    }),
  );
}

describe('sso responder', () => {
  it('starts with an empty signing log', () => {
    expect(harness().responder.getSigningLog()).toEqual([]);
  });

  it('publishes an encrypted reply on the peer topic for a sign request', async () => {
    const h = harness();
    const replies: Uint8Array[] = [];
    h.store.onSubmit(() => {});
    const connection = h.store.connect((json) => {
      const message = JSON.parse(json);
      if (message.method === 'statement_subscribeStatement') replies.push(message.params.result);
    });
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'statement_subscribeStatement',
        params: [{ MatchAll: [`0x${'02'.repeat(32)}`] }],
      }),
    );

    submitRequest(h, 'req-1', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
  });

  it('records signing activity in the log', async () => {
    const h = harness();
    submitRequest(h, 'req-2', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(h.responder.getSigningLog()).toHaveLength(1));
    expect(h.responder.getSigningLog()[0].type).toBe('raw');
  });

  it('clears the signing log on request', async () => {
    const h = harness();
    submitRequest(h, 'req-3', [buildSignRawMessage()]);
    await vi.waitFor(() => expect(h.responder.getSigningLog()).toHaveLength(1));
    h.responder.clearSigningLog();
    expect(h.responder.getSigningLog()).toEqual([]);
  });
});
```

`buildSignRawMessage()` is a local helper in the spec file that encodes a
`VersionedRemoteMessage` `SignRequest` for `test-product.dot` index 0, using the
codecs from Task 6.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/sso/responder.spec.ts`
Expected: FAIL — cannot resolve `./responder.js`.

- [ ] **Step 3: Implement**

Build `createSsoResponder` so that it:

1. Calls `store.onSubmit` and ignores statements whose topics do not include `sessionIdOwn`.
2. Derives the channel key once with `sessionAeadKey(session.encSecret, session.peerEncPubkey)`.
3. `open`s the statement `data`, decodes `StatementData`, and ignores the `response` variant.
4. Decodes each entry of `value.data` as `VersionedRemoteMessage`.
5. Dispatches on the variant, producing the matching response variant:
   - `SignRequest` → `signRawBytes` or the payload path; log `'raw'` / `'payload'`
   - `CreateTransactionRequest` / `CreateTransactionWithLegacyAccountRequest` → `buildSignedV4Extrinsic`; log `'createTransaction'`
   - `SignRawWithLegacyAccountRequest` → `signRawBytes`; log `'raw'`
   - `ResourceAllocationRequest` → a granted allowance slot for the requested resource
   - `ProductSubtreeRequest` → `resolveAccount(productId, …).publicKey`
   - `GetAccountAliasRequest` / `CreateAccountProofRequest` / `SignVrfRequest` → deterministic stand-ins derived from the account public key, matching the pre-migration handlers
   - `RegisterRingVrfKeyRequest` / `ListRingVrfKeysRequest` / `RingVrfSignRequest` → an in-memory `Map` registry
   - `Disconnected` → stop responding
6. Encodes the replies as one `StatementData.response`-bearing batch, `seal`s it, signs with `signStatement(session.ssSecret, …)` on `topics: [session.sessionIdPeer]`, and calls `store.publish`.

Keep each variant handler a small named function in this file; if the dispatch grows past roughly 200 lines, split the ring-VRF handlers into `src/browser/sso/ring-vrf.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/sso/responder.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/sso/responder.ts src/browser/sso/responder.spec.ts
git commit -m "feat: answer SSO signing requests from an in-page responder"
```

---

### Task 10: Host callback groups

**Files:**
- Create: `src/browser/callbacks/state.ts`, `storage.ts`, `navigation.ts`, `notifications.ts`, `permissions.ts`, `features.ts`, `passive.ts`, `chain.ts`, `index.ts`
- Test: `src/browser/callbacks/index.spec.ts`

`chain.ts` is created here as a minimal router only — loopback for
`PEOPLE_GENESIS_HASH`, throw otherwise — because this task's test dispatches
through `createHostCallbacks`, so the module must exist. Task 11 replaces its
body with the full routing and adds its own tests.

**Interfaces:**
- Consumes: `PEOPLE_GENESIS_HASH` (`../constants.js`), `LoopbackStore` (`../loopback-chain.js`).
- Produces:
  - `interface HostState { permissionBehavior; grantedPermissions: Set<string>; permissionLog; navigationLog; notificationLog; theme; preimages }`
  - `createHostCallbacks(options: { state: HostState; store: LoopbackStore; networks: ChainRuntimeConfig[] }): RequiredHostCallbacks`

`theme`, `locale` and `preimage` are `AsyncIterable` subscriptions, so they need a small push-to-async-iterator bridge; put it in `passive.ts` and reuse it for all three.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/callbacks/index.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { createLoopbackStore } from '../loopback-chain.js';
import { createHostCallbacks, createHostState } from './index.js';

const build = () =>
  createHostCallbacks({
    state: createHostState(),
    store: createLoopbackStore(),
    networks: [],
  });

describe('host callbacks', () => {
  it('supplies every required group', () => {
    const callbacks = build();
    for (const group of [
      'navigation', 'notifications', 'permissions', 'features', 'productStorage',
      'coreStorage', 'chain', 'auth', 'userConfirmation', 'theme', 'locale', 'preimage',
    ]) {
      expect(callbacks).toHaveProperty(group);
    }
  });

  it('records navigation attempts instead of navigating', async () => {
    const state = createHostState();
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    await callbacks.navigation.navigateTo('https://example.test/x');
    expect(state.navigationLog).toHaveLength(1);
    expect(state.navigationLog[0].url).toBe('https://example.test/x');
  });

  it('approves permissions by default and remembers the grant', async () => {
    const state = createHostState();
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    const response = await callbacks.permissions.remotePermission({ tag: 'ChainSubmit' } as never);
    expect(response).toBeTruthy();
    expect(state.permissionLog[0].approved).toBe(true);
  });

  it('rejects every permission under reject-all', async () => {
    const state = createHostState();
    state.permissionBehavior = 'reject-all';
    const callbacks = createHostCallbacks({
      state, store: createLoopbackStore(), networks: [],
    });
    await callbacks.permissions.remotePermission({ tag: 'ChainSubmit' } as never);
    expect(state.permissionLog[0].approved).toBe(false);
  });

  it('round-trips product storage', async () => {
    const callbacks = build();
    const value = new TextEncoder().encode('v');
    await callbacks.productStorage.write('k', value);
    expect(await callbacks.productStorage.read('k')).toEqual(value);
    await callbacks.productStorage.clear('k');
    expect(await callbacks.productStorage.read('k')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/callbacks/index.spec.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Implement**

Write one file per group, then compose in `index.ts`:

```ts
// src/browser/callbacks/index.ts
import type { RequiredHostCallbacks } from '@parity/truapi-host';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { LoopbackStore } from '../loopback-chain.js';
import { createChainCallbacks } from './chain.js';
import { createFeatureCallbacks } from './features.js';
import { createNavigationCallbacks } from './navigation.js';
import { createNotificationCallbacks } from './notifications.js';
import { createPassiveCallbacks } from './passive.js';
import { createPermissionCallbacks } from './permissions.js';
import { createCoreStorageCallbacks, createProductStorageCallbacks } from './storage.js';
export { createHostState, type HostState } from './state.js';
```

`createHostState()` returns the mutable logs and behavior switches the control
API reads. Keep it a plain object so `__TEST_HOST__` can mutate it directly.

For `coreStorage`, back the slots with an in-memory `Map` keyed by
`encodeCoreStorageKey(key).join(',')` — imported from `@parity/truapi-host`.
Do not persist it: every run starts from a clean session.

`chain.connect` is filled in by Task 11; for now return the loopback connection
for `PEOPLE_GENESIS_HASH` and throw otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/callbacks/index.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser/callbacks
git commit -m "feat: implement the twelve host callback groups"
```

---

### Task 11: Chain provider

**Files:**
- Rewrite: `src/browser/callbacks/chain.ts` (Task 10 created it as a loopback-only stub)
- Test: `src/browser/callbacks/chain.spec.ts`

**Interfaces:**
- Consumes: `PEOPLE_GENESIS_HASH` (`../constants.js`), `LoopbackStore` (`../loopback-chain.js`).
- Produces: `createChainCallbacks(options: { store: LoopbackStore; networks: ChainRuntimeConfig[] }): { chain: { connect(genesisHash: Uint8Array): Promise<JsonRpcConnection> } }`

Routing: `PEOPLE_GENESIS_HASH` → the loopback store; any configured network with an `rpcUrl` → `polkadot-api` v3's `getWsProvider`; anything else → throw, so an unroutable chain fails loudly instead of hanging.

- [ ] **Step 1: Write the failing test**

```ts
// src/browser/callbacks/chain.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import { createLoopbackStore } from '../loopback-chain.js';
import { createChainCallbacks } from './chain.js';

describe('chain routing', () => {
  it('routes the People genesis to the loopback store', async () => {
    const store = createLoopbackStore();
    const { chain } = createChainCallbacks({ store, networks: [] });
    const onResponse = vi.fn();
    const connection = await chain.connect(PEOPLE_GENESIS_HASH, onResponse);

    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'statement_submit', params: ['0x00'] }),
    );
    expect(onResponse).toHaveBeenCalled();
  });

  it('rejects a genesis hash no network declares', async () => {
    const { chain } = createChainCallbacks({ store: createLoopbackStore(), networks: [] });
    await expect(chain.connect(new Uint8Array(32).fill(9), () => {})).rejects.toThrow(
      /no chain configured/i,
    );
  });
});
```

The first test's statement body is deliberately malformed; assert only that the
loopback answered, not what it answered.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/browser/callbacks/chain.spec.ts`
Expected: FAIL — cannot resolve `./chain.js`.

- [ ] **Step 3: Implement**

```ts
// src/browser/callbacks/chain.ts
/**
 * Chain routing.
 *
 * The People genesis is served in-page by the loopback statement store — that
 * is what keeps signing local. Product chains are matched by genesis against
 * the configured networks and opened over WebSocket.
 */
import { getWsProvider } from 'polkadot-api/ws-provider/web';
import { PEOPLE_GENESIS_HASH } from '../constants.js';
import type { LoopbackStore } from '../loopback-chain.js';

export interface ChainRuntimeConfig {
  genesisHash: string;
  rpcUrl: string;
  name: string;
}

const normalize = (value: Uint8Array | string): string => {
  if (typeof value === 'string') {
    return (value.startsWith('0x') ? value.slice(2) : value).toLowerCase();
  }
  return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
};

export function createChainCallbacks(options: {
  store: LoopbackStore;
  networks: ChainRuntimeConfig[];
}) {
  const { store, networks } = options;

  return {
    chain: {
      async connect(genesisHash: Uint8Array, onResponse: (json: string) => void) {
        if (normalize(genesisHash) === normalize(PEOPLE_GENESIS_HASH)) {
          return store.connect(onResponse);
        }

        const match = networks.find(
          (network) => normalize(network.genesisHash) === normalize(genesisHash),
        );
        if (!match) {
          throw new Error(`no chain configured for genesis 0x${normalize(genesisHash)}`);
        }

        const provider = getWsProvider(match.rpcUrl);
        const connection = provider((message: string) => onResponse(message));
        return {
          send: (request: string) => connection.send(request),
          close: () => connection.disconnect(),
        };
      },
    },
  };
}
```

Confirm the `polkadot-api` v3 ws-provider entry point and connection shape
before finalising — v3 moved these paths relative to v2.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/browser/callbacks/chain.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into the callback composition**

Replace the placeholder `chain` group in `src/browser/callbacks/index.ts` with `createChainCallbacks({ store, networks })`.

Run: `pnpm vitest run src/browser/callbacks`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/browser/callbacks/chain.ts src/browser/callbacks/chain.spec.ts src/browser/callbacks/index.ts
git commit -m "feat: route People traffic to the loopback store and products to WS"
```

---

### Task 12: Host runtime boot

**Files:**
- Rewrite: `src/browser/host-runtime.ts`
- Delete: `src/browser/truapi-port-handoff.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–11.
- Produces: `window.__TEST_HOST__` implementing the reduced `TestHostAPI`, and `window.__TEST_HOST_CONFIG__` as before.

Boot order, which matters: create the store and responder, mint the session, create the runtime, `activateExternalSession`, then `createProvider` and `createIframeHost`.

- [ ] **Step 1: Trim the public types**

In `src/types.ts`, delete `PaymentLogEntry`, `PaymentTopUpBehavior`, `StatementSubmissionLogEntry`, `LoginBehavior` and their `TestHostAPI` members (`setPaymentBalance`, `getPaymentLog`, `clearPaymentLog`, `setPaymentTopUpBehavior`, `simulatePaymentStatus`, `getSubmittedStatements`, `injectStatement`, `clearStatements`, `setLoginBehavior`, `getIsAuthenticated`, `simulateDisconnect`, `simulateReconnect`). Replace the `HexString` re-export from `@novasamatech/host-api` with a local `export type HexString = \`0x${string}\`;`.

- [ ] **Step 2: Rewrite the runtime**

```ts
// src/browser/host-runtime.ts
import { createIframeHost, createWebWorkerPairingHostRuntime } from '@parity/truapi-host/web';
import HostWorker from '@parity/truapi-host/worker-runtime?worker';
import { x25519 } from '@noble/curves/ed25519.js';
import { PEOPLE_GENESIS_HASH, ZERO_HASH } from './constants.js';
import { createHostCallbacks, createHostState } from './callbacks/index.js';
import { deriveDev, deriveFromUri } from './dev-accounts.js';
import { createLoopbackStore } from './loopback-chain.js';
import { encodeExternalPairedSession } from './sso/session-blob.js';
import { createSsoResponder } from './sso/responder.js';

async function init(): Promise<void> {
  const config = window.__TEST_HOST_CONFIG__;
  const store = createLoopbackStore();
  const state = createHostState();

  const signer = deriveFromUri(config.accounts[0].uri);
  const hostEncSecret = x25519.utils.randomSecretKey();
  const peerEncSecret = x25519.utils.randomSecretKey();
  const session = {
    rootPublicKey: signer.publicKey,
    identityAccountId: signer.publicKey,
    encSecret: hostEncSecret,
    peerEncPubkey: x25519.getPublicKey(peerEncSecret),
    peerEncSecret,
    ssSecret: deriveDev('Alice', 'statement-store').secretKey,
    ssPublicKey: deriveDev('Alice', 'statement-store').publicKey,
    sessionIdOwn: crypto.getRandomValues(new Uint8Array(32)),
    sessionIdPeer: crypto.getRandomValues(new Uint8Array(32)),
  };

  const responder = createSsoResponder({
    store,
    session,
    resolveAccount: (dotNsIdentifier, derivationIndex) =>
      resolveProductAccount(config, dotNsIdentifier, derivationIndex),
  });

  const runtime = await createWebWorkerPairingHostRuntime(
    new HostWorker(),
    createHostCallbacks({ state, store, networks: config.networks }),
    {
      hostConfig: {
        host: { name: 'Test Host', platform: 'Web' },
        people: { genesisHash: PEOPLE_GENESIS_HASH },
        bulletin: { genesisHash: ZERO_HASH },
        assetHub: { genesisHash: ZERO_HASH },
        pairing: { deeplinkScheme: 'testhost' },
      },
    },
  );

  await runtime.activateExternalSession(encodeExternalPairedSession(session));

  const productId = config.productId ?? 'test-product.dot';
  const provider = await runtime.createProvider({ productId });
  const iframeHost = createIframeHost({
    iframeUrl: config.productUrl,
    container: document.body,
    onPort: (port) => bridgePortToProvider(port, provider),
  });

  window.__TEST_HOST__ = buildControlApi({ state, responder, runtime, iframeHost });
}

void init().catch((error) => console.error('[test-host] Init failed:', error));
```

Three helpers this file also defines:

```ts
/**
 * Relay the product's MessagePort to the core provider.
 *
 * Both sides carry raw `Uint8Array` wire frames, so this is a direct pipe with
 * no translation.
 */
function bridgePortToProvider(port: MessagePort, provider: TrUApiProductProvider): void {
  port.onmessage = (event: MessageEvent) => {
    if (event.data instanceof Uint8Array) provider.postMessage(event.data);
  };
  provider.subscribe((frame) => port.postMessage(frame));
  port.start();
}

/**
 * Resolve `[dotNsIdentifier, derivationIndex]` to the keypair that signs for it.
 *
 * A `productAccounts` entry wins; otherwise derive under the selected account,
 * matching the pre-migration `//Selected//dotnsId/index` path so configured
 * addresses do not move.
 */
function resolveProductAccount(
  config: HostConfig,
  dotNsIdentifier: string,
  derivationIndex: { tag: 'Index'; value: number } | { tag: 'Raw'; value: Uint8Array },
): DevKeypair {
  const index =
    derivationIndex.tag === 'Index'
      ? String(derivationIndex.value)
      : `0x${Array.from(derivationIndex.value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const override = config.productAccounts?.[`${dotNsIdentifier}/${index}`];
  if (override) return deriveFromUri(override.uri);
  return deriveFromUri(`${config.accounts[0].uri}//${dotNsIdentifier}/${index}`);
}
```

`buildControlApi` is implemented in this task; its full member list is written
out in Task 14 Step 1. It closes over `state`, `responder`, `runtime` and
`iframeHost`, and returns the trimmed `TestHostAPI`.

- [ ] **Step 3: Delete the obsolete channel shim**

```bash
git rm src/browser/truapi-port-handoff.ts
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. `tsconfig.json` excludes `src/browser/**`, so also run `pnpm exec tsc --noEmit -p tsconfig.json --include 'src/browser/**/*.ts'` or temporarily drop the exclude to check this file.

- [ ] **Step 5: Commit**

```bash
git add -A src/browser src/types.ts
git commit -m "feat: boot the truapi worker runtime with a self-minted session"
```

---

### Task 13: Build and serve the new assets

**Files:**
- Modify: `build.mjs`
- Modify: `src/server.ts`
- Modify: `src/host-page.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `dist/host-bundle.js` (ES module), `dist/truapi_server_bg.wasm`, `dist/truapi_provider_bg.wasm`, and a server that serves them.

The IIFE bundle cannot survive: the worker must be a separate chunk, and esbuild will not emit `.wasm` referenced via `new URL(..., import.meta.url)`.

- [ ] **Step 1: Switch the browser build to ESM with splitting**

In `build.mjs`, replace the first `build()` call:

```js
await build({
  entryPoints: ['src/browser/host-runtime.ts'],
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist/host',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  conditions: ['browser'],
});
```

- [ ] **Step 2: Copy the WASM payloads**

Append to `build.mjs`:

```js
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// esbuild passes `new URL(..., import.meta.url)` through verbatim, so the wasm
// the glue resolves at runtime is never emitted. Copy it next to the chunks.
for (const spec of [
  '@parity/truapi-host/dist/wasm/web/truapi_server_bg.wasm',
  '@parity/truapi-provider/dist/truapi_provider_bg.wasm',
]) {
  const from = require.resolve(spec);
  copyFileSync(from, `dist/host/${from.split('/').pop()}`);
}
console.log('WASM payloads copied into dist/host/');
```

- [ ] **Step 3: Serve the directory**

Rewrite the request handler in `src/server.ts` so `/` returns the generated HTML and any other path is served from `dist/host/`, with `.wasm` as `application/wasm` and `.js` as `text/javascript`. Keep the existing `Permissions-Policy` header on the HTML response.

- [ ] **Step 4: Load the bundle as a module**

In `src/host-page.ts`, replace the inline `<script>${bundleScript}</script>` with `<script type="module" src="/host-runtime.js"></script>`, and stop reading `host-bundle.js` from disk. Keep the inline `window.__TEST_HOST_CONFIG__` script.

- [ ] **Step 5: Build and verify the assets exist**

```bash
pnpm build
ls dist/host/truapi_server_bg.wasm dist/host/truapi_provider_bg.wasm
```

Expected: both files listed, build exits 0.

- [ ] **Step 6: Commit**

```bash
git add build.mjs src/server.ts src/host-page.ts
git commit -m "build: emit an ESM worker bundle and serve the wasm payloads"
```

---

### Task 14: Control API and Playwright fixture

**Files:**
- Modify: `src/playwright/fixture.ts`
- Modify: `src/index.ts`
- Modify: `test-exports-esm.mjs`, `test-exports-cjs.cjs`

**Interfaces:**
- Consumes: `window.__TEST_HOST__` as Task 12 built it.
- Produces: a Playwright fixture and package exports matching the trimmed `TestHostAPI`.

`buildControlApi` itself is implemented in Task 12, which needs it to typecheck.
Its member list is below for reference — Task 12 owns the code; this task only
consumes it.

- [ ] **Step 1: Confirm the control API surface**

`buildControlApi` (Task 12) returns an object reading and mutating `HostState` plus the responder:

- `getSigningLog` / `clearSigningLog` → the responder
- `setPermissionBehavior`, `grantPermission`, `revokePermission`, `getGrantedPermissions`, `getPermissionLog`, `clearPermissionLog` → `state`
- `getNavigationLog` / `clearNavigationLog`, `getNotificationLog` / `clearNotificationLog` → `state`
- `getTheme` / `setTheme` → `state.theme` plus the theme subscriber push
- `getPreimages` / `seedPreimage` / `clearPreimages` → `state.preimages`
- `getChatRooms`, `getChatBots`, `getChatMessageLog`, `clearChatState`, `injectChatAction` → the optional `chat` group's state
- `getConnectionStatus` / `getChainStatus` → `'connected'` once `activateExternalSession` resolves
- `switchAccount(name)` / `setAccounts(names)` → re-mint the session for the new signer, re-run `activateExternalSession`, and re-create the provider
- `dispose()` → `runtime.dispose()` and `iframeHost.dispose()`

`seedPreimage` keeps its blake2b-256 key derivation, now from `@noble/hashes`.

- [ ] **Step 2: Update the fixture's waits**

In `src/playwright/fixture.ts`, replace any wait keyed on the old container
handshake with one that waits for `window.__TEST_HOST__` and then for
`getConnectionStatus() === 'connected'`. Remove references to deleted controls
(payments, statements, login).

- [ ] **Step 3: Update the package exports**

In `src/index.ts`, drop the type exports deleted in Task 12 (`PaymentLogEntry`, `PaymentTopUpBehavior`, `StatementSubmissionLogEntry`, `LoginBehavior`).

- [ ] **Step 4: Verify exports still load**

Run: `pnpm build && pnpm test`
Expected: PASS — the export smoke tests load both ESM and CJS builds.

Update `test-exports-esm.mjs` and `test-exports-cjs.cjs` to stop asserting the removed type exports if they reference them.

- [ ] **Step 5: Commit**

```bash
git add src/playwright/fixture.ts src/index.ts test-exports-esm.mjs test-exports-cjs.cjs
git commit -m "feat: expose the migrated fixture and package exports"
```

---

### Task 15: Integration tests

**Files:**
- Modify: `test/test-product.ts`
- Modify: `test/integration.spec.ts`
- Delete: `test/test-product-truapi.ts`, `test/truapi-product.spec.ts`
- Modify: `test/build-test-product.mjs`

**Interfaces:**
- Consumes: the built `dist/` package.
- Produces: a passing `pnpm test:integration`.

The dual-channel handoff is gone, so the two product variants collapse into one
built on `@parity/truapi/sandbox`.

- [ ] **Step 1: Collapse the test products**

Delete `test/test-product-truapi.ts` and `test/truapi-product.spec.ts` — the
handoff they covered no longer exists. Rewrite `test/test-product.ts` against
`@parity/truapi/sandbox` + `createClient`, keeping the same exercised surface
(localStorage round-trip, product-account fetch, signing, permissions).

Reduce `test/build-test-product.mjs` to the single remaining product:

```js
const products = [
  { entry: 'test/test-product.ts', outfile: 'test/test-product-bundle.js' },
];
```

- [ ] **Step 2: Delete tests for removed controls**

In `test/integration.spec.ts`, remove the describe blocks covering payments,
statement store and login. Keep signing, permissions, navigation,
notifications, theme, preimages, chat and storage.

- [ ] **Step 3: Add the end-to-end signing assertion**

```ts
test('signs a raw payload locally with no network', async ({ page }) => {
  const product = page.frameLocator('#product-frame');
  await product.getByTestId('sign-raw').click();
  await expect(product.getByTestId('signature')).not.toBeEmpty();

  const log = await page.evaluate(() => window.__TEST_HOST__.getSigningLog());
  expect(log).toHaveLength(1);
  expect(log[0].type).toBe('raw');
});
```

- [ ] **Step 4: Run the suite**

Run: `pnpm build && pnpm test:integration`
Expected: PASS.

Signing is now an async round trip through the worker, so any assertion that
previously read a signature synchronously after an action needs an `await
expect(...)` — fix those as they surface rather than adding blanket waits.

- [ ] **Step 5: Commit**

```bash
git add -A test
git commit -m "test: exercise the migrated host end to end"
```

---

### Task 16: Release checklist

**Files:**
- Modify: `package.json`, `CHANGELOG.md`, `forum-post.md`, `README.md`

`CLAUDE.md` requires all four to move with the code as one atomic unit.

- [ ] **Step 1: Bump the version**

This is a breaking change — the protocol, the peer dependency contract and the
control API all change. Set `"version": "0.13.0"` in `package.json`.

- [ ] **Step 2: Write the changelog entry**

Add a `## 0.13.0` section covering: the move to `@parity/truapi` 0.17,
`truapi-host` 0.17 and `truapi-provider` 0.2; `polkadot-api` v3; the removal of
every `@novasamatech/*` dependency; local signing via an in-page loopback
statement store; and the removed controls (payments, statement store, login),
naming each one so upgraders can grep.

- [ ] **Step 3: Update the forum post**

Add a `0.13.0` section explaining, for product authors: products must now be on
`@parity/truapi` 0.17's sandbox bootstrap; the host no longer speaks the old
`host-container` protocol; dev-account addresses are unchanged. Include a
working `createTestHostFixture` snippet.

- [ ] **Step 4: Update the README**

Rewrite the "Upstream contract" note to name the new packages and versions.
Replace the `@novasamatech/host-container` references in the intro and "Why"
sections. Remove documentation for the deleted controls. Verify every code
sample still matches the exported API.

- [ ] **Step 5: Full verification**

```bash
pnpm typecheck && pnpm test:unit && pnpm build && pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 6: Confirm the dependency goal**

```bash
grep -r "@novasamatech" package.json src/ test/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add package.json CHANGELOG.md forum-post.md README.md
git commit -m "release: 0.13.0 — migrate to @parity/truapi 0.17 and polkadot-api v3"
```

---

## Follow-up (not in this plan)

`../host-playground` pins `@parity/host-api-test-sdk` at `0.12.1` and uses the
old product bootstrap. It needs its own update once `0.13.0` ships.
