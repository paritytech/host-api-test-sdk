# Migrating host-api-test-sdk to TrUAPI 0.17 + polkadot-api v3

Status: draft, awaiting review
Date: 2026-09-17

## Goal

Replace `@novasamatech/host-container` with `@parity/truapi@0.17.0`,
`@parity/truapi-host@0.17.0` and `@parity/truapi-provider@0.2.0`, and move
`polkadot-api` to v3 — while keeping what this SDK is for:

- one `pnpm add -D`, no Docker, no external process, no network
- dev accounts that auto-sign with no prompts
- simple, stable dev-account addresses (`//Alice` stays `5Grwva…GKutQY`)
- a control API Playwright tests can assert against

Everything happens locally, in the host page. Nothing binds to another host.

## What the new stack is

`truapi-host` is not a drop-in for `host-container`. It is a Rust core compiled
to WASM, running in a Web Worker, with the host supplying typed callbacks.

| Layer | Today | After |
| --- | --- | --- |
| Protocol core | `createContainer` (JS, in-page) | `createWebWorkerPairingHostRuntime` (WASM in a Worker) |
| Product channel | `createDualChannelIframeProvider` | `createIframeHost` → `MessagePort` |
| Handler surface | ~40 `container.handleXxx` | 12 required callback groups + optional `chat` |
| Chain access | `polkadot-api` `getWsProvider` | `@parity/truapi-provider` (smoldot / `addRpcChain`) |
| Signing | 6 in-page handlers | local responder over a loopback statement store |

The required groups are `navigation`, `notifications`, `permissions`,
`features`, `productStorage`, `coreStorage`, `chain`, `auth`,
`userConfirmation`, `theme`, `locale`, `preimage`.

There is no signing callback. Signing, accounts, payments, statements, login
and `createTransaction` all moved inside the core.

## Signing: how it stays local

This is the heart of the migration, and it is settled by spike, not inference.

### What the spike established

Run in headless Chrome against `truapi-host@0.17.0`, no network:

1. **Dev accounts stay simple.** `@scure/sr25519`'s `HDKD.secretHard` over
   `DEV_MINI_SECRET` reproduces `//Alice` → `5GrwvaEF…GKutQY` and `//Bob` →
   `5FHneW…M694ty`, and yields the 64-byte expanded secret the core wants.
2. **The host can mint its own session.** `encode_persisted_session` is
   `0x01 ++ SCALE(SessionInfo)` — eight positional fields. A 456-byte blob built
   in JS with `scale-ts` was accepted by `activateExternalSession`, and auth went
   `Disconnected → Connected`. No pairing, no peer, no network.
3. **Host callbacks satisfy the core.** All 12 groups stubbed; `coreStorage`
   backed by a plain `Map`.
4. **Reviews reach the host.** `confirmUserAction` fired with a `SignRaw` review.
5. **AutoSigning does not cover transactions.** `CoreStorageKey::AutoSigningKeys`
   looks seedable, but `auto_signing_key()` has exactly four callers —
   `sign_vrf`, `register_ring_vrf_key`, `local_ring_vrf_entropy`,
   `product_subtree_public_key`. RFC-0010 AutoSigning is ring-VRF only.
   `sign_raw`, `sign_payload` and `create_transaction` call `remote_*`
   unconditionally, with no local branch.
6. **The remote path lands on a seam we own.** With valid X25519 keys the
   channel crypto succeeds and the request fails at
   `SSO statement-store connect failed` — i.e. inside our own `chain.connect`.

So signing always goes to "the peer". The design makes the host *be* the peer,
because the host mints both halves of the session and owns the only transport.

### The mechanism

```
product → core → chain.connect(people genesis) → statement_submit
                                                      │
                                       loopback statement store (in-page)
                                                      │
                                       local responder: decrypt, sign, re-encrypt
                                                      │
                                     statement on session_id_peer topic → core
```

The loopback chain needs exactly three JSON-RPC methods:

- `statement_submit` — hex SCALE statement; `new`/`known` means accepted
- `statement_subscribeStatement` — topic filter (`MatchAll` / `MatchAny`)
- `statement_unsubscribeStatement`

The envelope, all reproducible in JS:

- AEAD key = `HKDF-SHA256(ikm = X25519(enc_secret, peer_enc_pubkey), salt = none, info = empty)`
- payload = ChaCha20-Poly1305 over `SCALE(SsoStatementData)`
- statement signed sr25519 with `ss_secret`, published on `session_id_own`;
  replies arrive on `session_id_peer`

The host chooses `enc_secret`, `peer_enc_pubkey`, `ss_secret` and both topic
ids when it mints the session, so it holds both sides of the ECDH and can
decrypt requests and encrypt replies.

### What the responder must answer

`RemoteMessage` is a versioned SCALE enum whose **variant order is the wire
protocol** (indices 14+ are pinned explicitly). The full request set:

| Request | Answered with |
| --- | --- |
| `SignRequest` (payload / raw, watermarked or not) | existing payload + raw signing |
| `CreateTransactionRequest` | `buildSignedV4Extrinsic` |
| `CreateTransactionWithLegacyAccountRequest` | same, pair by pubkey |
| `SignRawWithLegacyAccountRequest` | existing raw signing, pair by address |
| `ResourceAllocationRequest` | canned allowance slots (see below) |
| `ProductSubtreeRequest` | derived subtree public key |
| `GetAccountAliasRequest` | existing deterministic alias stand-in |
| `CreateAccountProofRequest` | existing sr25519 proof stand-in |
| `SignVrfRequest` | sr25519 VRF |
| `RegisterRingVrfKeyRequest` / `ListRingVrfKeysRequest` / `RingVrfSignRequest` | in-memory key registry |
| `Disconnected` | tear the session down |

Most of these already exist in `host-runtime.ts` as container handlers
(`handleAccountGetAlias`, `handleAccountCreateProof`, the six signing
handlers); the logic ports over, only the key source and transport change.

**Allowances never touch the chain.** `register_statement_account` — which does
submit `Resources.set_statement_store_account` via
`author_submitAndWatchExtrinsic` — belongs to the *signing-host* role. The
pairing host obtains allowances by asking the peer
(`remote_allowance_slot` → `ResourceAllocationRequest`), so the local responder
answers them and no extrinsic is ever built. This is what keeps "no network"
true.

The envelope payload is `SsoStatementData`, a two-variant enum:

```
Request  { request_id: String, data: Vec<Vec<u8>> }   // SCALE-encoded RemoteMessages
Response { request_id: String, response_code: u8 }    // 0 == accepted
```

The Rust notes this mirrors `@novasamatech/statement-store`'s session statement
data, which is checked out at `../triangle-js-sdks` — a JS reference for these
codecs to read against, not a dependency to add.

### Libraries

`@noble/hashes` (HKDF/SHA-256), `@noble/ciphers` (ChaCha20-Poly1305),
`@noble/curves` (X25519), `@scure/sr25519` (keys and signing), `scale-ts`
(codecs). All already transitive dependencies of the target stack.

## Components

| Path | Role |
| --- | --- |
| `src/browser/constants.ts` | synthetic People genesis hash, zero hash |
| `src/browser/dev-accounts.ts` | `//Alice`-style derivation, 64-byte secrets |
| `src/browser/sso/session-blob.ts` | SCALE codec for the core's `SessionInfo` blob |
| `src/browser/sso/crypto.ts` | X25519 + HKDF key derivation, ChaCha20-Poly1305 |
| `src/browser/sso/statement.ts` | statement codec, sr25519 proof, topic matching |
| `src/browser/sso/messages.ts` | `StatementData` and `RemoteMessage` codecs |
| `src/browser/sso/responder.ts` | answers signing requests; owns the signing log |
| `src/browser/signing/` | ported `buildSignedV4Extrinsic` + raw signing |
| `src/browser/loopback-chain.ts` | in-memory statement store behind `chain.connect` |
| `src/browser/callbacks/` | the 12 callback groups, one file each |
| `src/browser/host-runtime.ts` | boots the worker runtime, wires `__TEST_HOST__` |

`src/browser/truapi-port-handoff.ts` is deleted — `createIframeHost` owns the
channel now.

## Build

The single inlined IIFE cannot survive: the worker must be a code-split ES
chunk, and esbuild will not emit `.wasm` referenced through
`new URL(…, import.meta.url)`.

- `truapi_server_bg.wasm` and `truapi_provider_bg.wasm` are copied into `dist/`
- `src/server.ts` becomes a small static server instead of a one-string responder
- the host page loads a module script rather than an inline bundle

CJS output stays, since Playwright's default loader needs it.

## Control API

`TestHostAPI` is re-derived onto the new seams. Kept, with new sources:

| Control | New source |
| --- | --- |
| `getSigningLog` / `clearSigningLog` | the local responder |
| `setPermissionBehavior`, `getPermissionLog` | `permissions` group |
| `getNavigationLog` | `navigation` |
| `getNotificationLog` | `notifications` |
| `getTheme` / `setTheme` | `theme` subscription |
| `getPreimages` / `seedPreimage` | `preimage` |
| chat controls | optional `chat` group |
| `switchAccount` / `setAccounts` | re-mint session, re-create providers |

Payments, statement-store and login controls have no host-side equivalent —
they are core-internal now. They are dropped in the first cut and revisited
only if a consumer needs them.

## Risks

1. **Private SCALE layouts.** `SessionInfo` and the SSO structures are
   core-owned and explicitly not a public contract. Mitigated by the version
   tag (a layout change surfaces as a decode failure, not silent drift) and by
   a test that asserts the blob still activates.
2. **SSO wire surface is wide.** Eleven request variants, not the four first
   assumed, and `RemoteMessage`'s variant order is load-bearing. `SsoStatementData`
   and `RemoteMessage` are now both read; the remaining shape is the outer
   statement-store `Statement` (proof, topics, data), with a JS reference in
   `../triangle-js-sdks`.
3. **Dev-account addresses.** Verified stable for `//Alice` and `//Bob`.
4. **host-playground.** Consumes this SDK; needs a matching update.
5. **Signing latency.** Every signature is now an async round trip through the
   worker and the loopback store, where today it is a synchronous in-page call.
   Tests asserting immediately after an action may need to await.

## Out of scope

No external signer, no `truapi-host` CLI, no signing-bot, no `host-papp`, no
custom WASM build. Nothing leaves the page.
