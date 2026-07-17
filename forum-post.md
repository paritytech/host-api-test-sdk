# host-api-test-sdk 0.4.0

## Product account mapping

New `productAccounts` option maps `getProductAccount(dotnsId, index)` requests to specific accounts. Unmapped identities use production-style derivation.

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: ["bob"],
  productAccounts: {
    "myapp.dot/0": "bob", // → //Bob (funded)
    "myapp.dot/2": "charlie", // → //Charlie (funded)
    "myapp.dot/5": { name: "Custom", uri: "//My//Path" },
  },
});
```

## Custom accounts

`accounts` (root) and `productAccounts` now accept `{ name, uri }` objects — any Substrate URI that `@polkadot/keyring.addFromUri()` supports (dev paths, mnemonics, hex seeds).

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: [
    "bob",
    { name: "From mnemonic", uri: "word1 word2 word3 ... word12" },
  ],
});
```

## Integration tests

Added Playwright tests that verify product account derivation and mapping end-to-end with a real product in an iframe.

---

# host-api-test-sdk 0.5.0

## Permission enforcement (breaking change)

The test host previously auto-approved all permission requests silently. This meant products that forgot to call `hostApi.permission()` before signing would pass E2E tests but fail in production — real hosts (polkadot-desktop, dot.li) require `TransactionSubmit` to be granted before signing works.

Now the test host enforces this too. Signing without a prior `TransactionSubmit` permission grant fails with `SigningErr::PermissionDenied`.

Products that already request permissions correctly are unaffected. For tests that don't exercise the permission flow, there's an escape hatch:

```ts
await testHost.setEnforcePermissions(false);
```

## Device permissions

The test host now handles `handleDevicePermission` requests (Camera, Microphone, Location, Bluetooth). When granted, the iframe `allow` attribute is updated with the corresponding Permissions Policy directive, matching how dot.li enforces device access at the browser level.

## Permission control API

Tests can pre-grant, revoke, and inspect permissions:

```ts
// Pre-grant without product requesting
await testHost.grantPermission("TransactionSubmit");

// Revoke a grant
await testHost.revokePermission("TransactionSubmit");

// Inspect granted set
const granted = await testHost.getGrantedPermissions();

// Reject all permission requests
await testHost.setPermissionBehavior("reject-all");

// Check what was requested
const log = await testHost.getPermissionLog();
```

## Updated dependencies

`@novasamatech/host-api`, `@novasamatech/host-container`, and `@novasamatech/product-sdk` updated to `0.6.17`.

---

# host-api-test-sdk 0.6.0

Most of the Spektr host surface is now testable. Product authors can write E2E tests that exercise the full product-to-host protocol without mocking — the test host answers each protocol call and records what happened for assertions.

## What's newly testable

**Navigation** — when a product calls `hostApi.navigateTo(url)` (opening another product, external link, or a deeplink), the test host records it instead of navigating. Tests can assert exactly what the product tried to navigate to.

**Push notifications** — `hostApi.pushNotification({ text, deeplink })` is recorded with its text and optional deeplink. Useful for testing flows that notify the user after an action completes.

**Account alias (Ring VRF)** — `hostApi.accountGetAlias(dotnsId, index)` returns a stable, deterministic alias per account. Same account → same alias across test runs, different accounts → different aliases.

**Chat** — create rooms, register bots, post messages, subscribe to the room list, and subscribe to incoming actions. All backed by an in-memory store. Tests can inspect rooms/bots/messages and inject incoming peer messages to exercise reception flows.

**Preimages** — products can submit preimages (they get back the blake2b-256 key) and subscribe to lookup a preimage by key. Tests can seed the store ahead of time or observe what products submit.

**Statement store** — products can subscribe to statements filtered by topics, create proofs signed with their product account (real sr25519 signatures), and submit signed statements. Tests can inject statements to simulate incoming activity and inspect what products submitted.

## Cleaner state between tests

Permission grants, activity logs (navigation, notifications), chat state, preimages, and statement store entries are now all cleared whenever the container is recreated (e.g. when a test switches accounts). Each session starts fresh, matching real host behavior.

---

# host-api-test-sdk 0.7.0

Follows `@novasamatech/*` 0.7.0 release. This is a **breaking change** release — test code that references the old permission names or signing API will need updating.

## Breaking changes

**Permission renames** — `TransactionSubmit` is now `ChainSubmit`. The test host enforces `ChainSubmit` for signing. If your tests pre-grant or assert `TransactionSubmit`, rename it:

```ts
// before
await testHost.grantPermission("TransactionSubmit");
// after
await testHost.grantPermission("ChainSubmit");
```

`ExternalRequest` is replaced by `Remote` — the host API now accepts batched permission requests with domain patterns instead of single URLs.

**Legacy account rename** — `getNonProductAccounts` and friends are now `getLegacyAccounts`, `getLegacyAccountSigner`, `createTransactionWithLegacyAccount`. The test host handler is `handleGetLegacyAccounts`.

**Signing uses ProductAccountId** — `handleSignPayload` and `handleSignRaw` now receive `{ account: [dotnsId, derivationIndex], payload: ... }` instead of `{ address: string, data: ... }`. Legacy address-based signing is available via the new `handleSignPayloadWithLegacyAccount` and `handleSignRawWithLegacyAccount` handlers.

**Statement store subscribe** — the subscribe API now takes a `TopicFilter` (`{ matchAll: Topic[] }` or `{ matchAny: Topic[] }`) instead of a flat `Topic[]` array, and delivers `SignedStatementsPage` objects (`{ statements, isComplete }`) instead of raw arrays.

**Device permissions expanded** — 9 variants now: Camera, Microphone, Location, Bluetooth, Notifications, NFC, Clipboard, OpenUrl, Biometrics.

## New features

**Theme** — products can subscribe to host theme changes (light/dark). Tests can drive it:

```ts
// switch theme and verify the product reacts
await testHost.setTheme("dark");
const theme = await testHost.getTheme(); // "dark"

// product side (via product-sdk)
const themeProvider = createThemeProvider();
themeProvider.subscribeTheme((theme) => {
  document.body.className = theme; // "light" | "dark"
});
```

**Entropy derivation (RFC-0007)** — deterministic 32-byte entropy from a caller key, product-scoped. Same key always produces the same output on any conforming host. Useful for deriving stable keypairs (e.g. X25519 for encrypted messaging) without storing secrets product-side.

```ts
// product side
import { deriveEntropy } from "@novasamatech/product-sdk";

const key = new TextEncoder().encode("my-x25519-key");
const result = await deriveEntropy(key);
result.match(
  (entropy) => console.log("32 bytes:", entropy), // Uint8Array(32)
  (err) => console.error(err),
);

// test side — entropy is deterministic, so you can derive the expected
// value and assert the product used it correctly
```

**Root account access (RFC-0010)** — products can request the user's primary DotNS-linked account. The test host returns the first configured account. Uses JIT permission — the host prompts the user on first call.

```ts
// product side
const accountsProvider = createAccountsProvider();
const root = await accountsProvider.getRootAccount();
root.match(
  (account) => console.log(account.name, toHex(account.publicKey)),
  (err) => console.error(err), // Rejected | NotConnected
);
```

**Login flow (RFC-0009)** — products can load without requiring login, then trigger it explicitly when the user wants to act. The test host simulates auth state so you can test both unauthenticated and authenticated flows:

```ts
// simulate unauthenticated state
await testHost.simulateDisconnect();

// product calls requestLogin — test host can approve or reject
await testHost.setLoginBehavior("success");
// or reject:  await testHost.setLoginBehavior("reject");
// or custom:  await testHost.setLoginBehavior((reason) => reason === "purchase");

// product side
const result = await accountsProvider.requestLogin("Please sign in to purchase");
// result: "success" | "alreadyConnected" | "rejected"

// restore auth
await testHost.simulateReconnect();
```

**Payment API (RFC-0006)** — balance subscribe, top-up, payment request, and status tracking. All backed by in-memory state with test controls:

```ts
// seed a balance before the product loads
await testHost.setPaymentBalance(1_000_000_000_000n);

// product side
const pm = createPaymentManager();

pm.subscribeBalance((balance) => {
  console.log("Available:", balance.available); // bigint
});

await pm.topUp(500_000_000_000n, {
  type: "productAccount",
  dotNsIdentifier: "myapp.dot",
  derivationIndex: 0,
});

const receipt = await pm.requestPayment(100_000_000_000n, destinationAccountId);
console.log("Payment ID:", receipt.id);

// test side — inspect what happened
const log = await testHost.getPaymentLog();
// [{ type: "top-up", amount: 500000000000n, ... }, { type: "request", amount: 100000000000n, paymentId: "pay-1", ... }]

// simulate a payment failure for edge-case testing
await testHost.simulatePaymentStatus("pay-1", { tag: "Failed", value: "insufficient gas" });
```

## Updated dependencies

- `@novasamatech/host-api`, `host-container`, `product-sdk` → 0.7.0
- `polkadot-api` → ^2.0.0

---

# host-api-test-sdk 0.7.1 – 0.7.3

Follow-up fixes tracking upstream `@novasamatech/*` 0.7.1–0.7.4 changes.

## 0.7.1 — Signing permission fix

Signing (`handleSignPayload`, `handleSignRaw`) was incorrectly gated behind `ChainSubmit` permission. Real Spektr hosts don't do this — `ChainSubmit` is enforced by the container at the `transaction_broadcast` level, not at signing. Fixed: signing now works without any prior permission request.

## 0.7.2 — Permission format fix

Upstream 0.7.2 changed `handlePermission` from batched (`RemotePermission[]`) back to a single `RemotePermission` per request. The test host now matches.

## 0.7.3 — User identity (RFC-0014)

Upstream 0.7.4 replaced `handleAccountGetRoot` with `handleGetUserId` (RFC-0014: Get User Primary DotNS Name). The new method returns `{ primaryUsername: string }` instead of `{ publicKey, name }`.

```ts
// The test host returns the first account's name as primaryUsername
// Product side:
const result = await accountsProvider.getUserId();
result.match(
  (id) => console.log(id.primaryUsername), // e.g. "Alice"
  (err) => console.error(err),
);
```

Updated dependencies: `@novasamatech/*` → ^0.7.4.

---

# host-api-test-sdk 0.7.4

## Resource allocation (RFC-0010)

Products can now request resource allowances from the host — statement store, bulletin, smart contract, and auto-signing. The test host auto-allocates all requested resources.

```ts
// product side
const result = await hostApi.requestResourceAllocation({
  tag: "v1",
  value: [
    { tag: "StatementStoreAllowance", value: undefined },
    { tag: "BulletInAllowance", value: undefined },
    { tag: "SmartContractAllowance", value: 0 },  // derivation index
    { tag: "AutoSigning", value: undefined },
  ],
});
// Each resource gets an outcome: Allocated | Rejected | NotAvailable
```

## Authorized statement proofs

`handleStatementStoreCreateProofAuthorized` creates statement proofs using the host's internal allowance account — no product account ID required. Useful for products that obtained a StatementStoreAllowance via resource allocation.

## Updated dependencies

`@novasamatech/*` → ^0.7.7.

---

# host-api-test-sdk 0.7.5

## Full handler coverage

Two previously missing handlers are now implemented:

- **`handleCreateTransaction`** — product accounts can create transactions. The test host returns the call data as-is for assertions.
- **`handleAccountCreateProof`** — Ring VRF proof creation. The test host signs the message with the product account's sr25519 key as a stand-in for actual ring VRF.

The only remaining unimplemented handler is `renderChatCustomMessage` (custom chat renderer callback).

## Comprehensive integration tests

12 new integration tests bring the total from 34 to **46**, covering every major handler:

- Theme subscribe (host→product theme changes)
- Entropy derivation (deterministic, same-key-same-result)
- Login flow (authenticated, rejected, disconnect/reconnect)
- User identity (`getUserId` returns `primaryUsername`)
- Resource allocation (all 4 resource types allocated)
- Feature check (configured chain matches, unknown chain doesn't)
- Local storage (write, read, clear round-trip)
- Statement store proof creation
- Create transaction for product accounts
- Account create proof (Ring VRF)

## Updated dependencies

`@novasamatech/*` → ^0.7.8.

---

# host-api-test-sdk 0.7.6

## Refreshed chain constants

`PASEO_ASSET_HUB` previously pointed at Paseo Next v1, which was deprecated on 2026-05-20. Both its `genesisHash` and `rpcUrl` are now updated to Paseo Asset Hub v2:

```ts
import { PASEO_ASSET_HUB } from "@parity/host-api-test-sdk";

// Now resolves to the v2 chain — no code change needed on your side.
createTestHostFixture({
  productUrl: "http://localhost:3000",
  chain: PASEO_ASSET_HUB,
});
```

While verifying the v2 values live, we also found `PREVIEWNET` and `PREVIEWNET_ASSET_HUB` carrying genesis hashes from prior redeployments that no longer matched what those chains return. Both refreshed in the same release.

All three values were queried live via `chain_getBlockHash[0]`. If your product was hitting genesis-hash mismatches against any of these chains, upgrade to 0.7.6 and the failures will clear without any code change.

If you hardcoded the literal hash strings anywhere in your tests, update them — the constants are the source of truth.

_Thanks to [@TarikGul](https://github.com/TarikGul) for spotting and fixing this in [#20](https://github.com/paritytech/host-api-test-sdk/pull/20)._

---

# host-api-test-sdk 0.8.3

Single rollup for everything that landed in the `0.8` line. `0.8.0`–`0.8.2` were never posted; `0.8.3` is the version to upgrade to and the rest of this section explains everything that's changed since `0.7.6`.

## TL;DR

- Upstream `@novasamatech/*` bumped to `^0.7.9` (final).
- `@novasamatech/product-sdk` renamed to `@novasamatech/host-api-wrapper`. No compat re-export.
- `handleCreateTransaction` request shape was redesigned and the handler now returns a real signed v4 extrinsic on the wire (not echoed `callData`).
- Push notifications gained scheduling + cancellation.

## Breaking changes since `0.7.6`

### 1. Upstream package rename: `product-sdk` → `host-api-wrapper`

`@novasamatech/product-sdk` is gone. Use `@novasamatech/host-api-wrapper`. There is no compat re-export under the old name. Update both your `package.json` and your source imports — usually a one-line dep change plus a find-replace.

### 2. `handleCreateTransaction` request shape

`host_create_transaction` was redesigned upstream. The request is now a flat object — no more outer tuple, no more inner versioned envelope around the payload, no `context` block, and `genesisHash` is required at the top level.

```ts
// 0.7.6 — old
container.handleCreateTransaction(([[dotnsId, idx], payload], { ok }) => {
  return ok(payload.callData);
});

// 0.8.3 — new
container.handleCreateTransaction((params, { ok }) => {
  // params: {
  //   signer: [dotnsId, idx],           // ProductAccountId tuple
  //   genesisHash: Uint8Array,           // required
  //   callData: Uint8Array,              // was HexString
  //   extensions: { id, extra: Uint8Array, additionalSigned: Uint8Array }[],
  //   txExtVersion: number,
  // }
  return ok(buildSignedV4Extrinsic(...));
});
```

`handleCreateTransactionWithLegacyAccount` got the same flattening; its `signer` is now `Uint8Array` (raw AccountId) instead of an SS58 string. Exports `VersionedPublicTxPayload` / `TxPayloadV1Public` are gone — use `ProductAccountTransaction` / `LegacyTransaction`.

### 3. `handleCreateTransaction` return value is now a real signed extrinsic

In `0.7.x` the handler returned `callData` straight through. That worked for tests that only checked `result.ok === true`, but as soon as a product tried to **submit** the returned bytes — for instance via polkadot-api's `signer.signTx(...)` against paseo-asset-hub-next — the extrinsic codec rejected them.

`0.8.3` signs and frames the extrinsic. No product-side code change required — the wrapper API didn't move. What changes is the byte content of the response.

What the handler does now:

1. Resolves the keypair from `params.signer`:
   - Product flow: `[dotNsId, derivationIndex]` → derived child of the host's configured root account (or the `productAccounts` override map).
   - Legacy flow: raw 32-byte sr25519 public key → matched against `accounts[i].publicKey`.
2. Concatenates `extra` and `additionalSigned` from each entry in `params.extensions`, in order.
3. Signs `callData || extras || additionalSigned` with sr25519. Payloads longer than 256 bytes are blake2_256-hashed first, matching `polkadot-sdk`'s `SignedPayload::using_encoded`.
4. Returns the full v4 wire form (with the SCALE-compact length prefix that RPC and polkadot-api decoders expect):

   ```
   [compact len]                       length of the bytes that follow
   [0x84]                              v4 + signed bit
   [0x00 + AccountId32 (32 bytes)]     MultiAddress::Id
   [0x01 + signature (64 bytes)]       MultiSignature::Sr25519
   [extras concat]                     each extension's `extra`, in order
   [callData]
   ```

`extrinsic.version` on paseo-asset-hub-next is `[4]` — there is no v5 in that runtime. So `0.8.3` ships v4-signed only. If your target runtime negotiates v5 general extrinsics, file an issue — v5 support is a follow-up.

### 4. Push notification protocol

- `host_push_notification` request gained an optional `scheduledAt: bigint` (epoch-ms) for future-delivery notifications.
- Response is now `Result<NotificationId, PushNotificationError>` instead of `Result<void, GenericError>`. The host returns a `u32` id; products can hold on to it.
- New `handlePushNotificationCancel(id)` handler. The test host marks the matching log entry's `cancelled = true`.
- New `PushNotificationError::ScheduleLimitReached` variant available for hosts that want to reject when their queue is full.
- `NotificationLogEntry` gained `id`, `scheduledAt`, and `cancelled`. Tests that snapshot the whole entry need updating; spot-checks on individual fields still work.

## Non-breaking notes

- Attestation has moved off the Host onto the paired Polkadot Mobile app — no SDK-facing change, but if you assert on SSO traffic in product tests, expect different message shapes.
- `getProductAccountSigner` (in `host-api-wrapper`) now routes `signTx` through `host_create_transaction` and returns the full signed extrinsic by default. Pass `'signPayload'` as the second argument to opt back into the previous behaviour.

## What you need to do

- Upgrade to `0.8.3` (drop `0.8.0`/`0.8.1`/`0.8.2` if you ever pinned them).
- Replace `@novasamatech/product-sdk` with `@novasamatech/host-api-wrapper` in your `package.json` and imports.
- If you constructed `createTransaction` requests by hand, switch to the flat `ProductAccountTransaction` shape and include `genesisHash`.
- If your tests asserted on the bytes being equal to `callData`, drop that assumption and decode the response as a v4 extrinsic instead.
- If you have a custom `handlePushNotification`, change `ok(undefined)` → `ok(<id>)`.

---

# host-api-test-sdk 0.8.6

One fix. Drop-in upgrade from `0.8.5`.

## Fixed

- **`PASEO_ASSET_HUB.genesisHash` refreshed after the Paseo Asset Hub chain reset.** The `paseo-asset-hub-next` chain was reset, so its genesis changed from `0x173cea…` to `0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f`. The built-in `PASEO_ASSET_HUB` config carried the old hash, so the host's chain-feature handshake rejected any product descriptors regenerated against the new chain — the product app would sit `disconnected` in E2E even though the RPC was reachable. The new value is verified against the live chain via `chain_getBlockHash(0)`.

## What you need to do

- Upgrade to `0.8.6`. If you only use the built-in `PASEO_ASSET_HUB` config, no code changes are needed — the correct genesis comes with the upgrade.
- If you hardcoded the old genesis (`0x173cea…`) in your own `ChainConfig` or test assertions, update it to `0xbf0488…`.

---

# host-api-test-sdk 0.8.5

One fix. Drop-in upgrade from `0.8.4`. Thanks to [@BigTava](https://github.com/BigTava) for spotting this and contributing the initial fix.

## Fixed

- **Account handlers no longer throw on unsigned hosts** ([#31](https://github.com/paritytech/host-api-test-sdk/pull/31)). If you ran the test host with `accounts: []` (i.e. simulating "user hasn't logged in yet") and the product called `getProductAccount(...)` or `getProductAccountAlias(...)`, the handler tried to index `pairs[0]` and threw a synchronous `TypeError` inside the container. Now both handlers return `err(RequestCredentialsErr.NotConnected)`, which is what `polkadot-desktop` returns in the same state — your product gets the same `Result.err` it would see in production, and your tests can assert on it directly.

The `productAccounts` override still wins, so this also works:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  accounts: [],                              // unsigned
  productAccounts: { 'myapp.dot/0': 'bob' }, // explicit map still served
});
```

Unmapped identities on an unsigned host now produce `NotConnected` instead of a thrown error.

## What you need to do

- Upgrade to `0.8.5`.
- If a test was relying on the previous throw (very unlikely), switch it to assert on the `Result.err` returned by the product-sdk call.

---

# host-api-test-sdk 0.8.4

Two fixes addressing developer-reported issues. Drop-in upgrade from `0.8.3`.

## Fixed

- **`getIsAuthenticated()` now reflects login state** ([#25](https://github.com/paritytech/host-api-test-sdk/issues/25)). Previously the flag defaulted to `true` on page load, so `setLoginBehavior('reject')` was silently ignored — the host short-circuited login with `'alreadyConnected'`. Now it starts `false`, flips `true` on successful login (or `simulateReconnect()`), and resets to `false` on a rejected login. If your tests want a session pre-authenticated (e.g. for `getUserId`), call `simulateReconnect()` after `loadHostAndProduct`.

## Documented

- **What `permissionLog` records (and what it doesn't)** ([#24](https://github.com/paritytech/host-api-test-sdk/issues/24)). New README section makes the semantics explicit: signing isn't gated behind ChainSubmit at the test-sdk level (deliberate 0.7.1 design), `permissionLog` only records explicit `hostApi.permission(...)` calls, and `transaction_broadcast` denials happen inside `host-container` and aren't observable from the test-sdk today. If your assertion was "rejected permission prevented submission", the right oracle is the product's error UI, not the permission log.

## What you need to do

- Upgrade to `0.8.4`.
- If any test relies on `getIsAuthenticated()` returning `true` on a fresh page, add `await testHost.simulateReconnect()` (or run a login) before the assertion.

---

# host-api-test-sdk 0.9.0

Tracks upstream `@novasamatech/*@^0.8.0` ([triangle-js-sdks#179](https://github.com/paritytech/triangle-js-sdks/pull/179)). v0.8 is **wire-incompatible** with v0.7 — there is no compatibility shim, so your product side must be on `@novasamatech/host-api@^0.8.0` too. The [v0.8 migration guide](https://github.com/paritytech/triangle-js-sdks/blob/release/0.8/docs/migration/v0.8.md) lists all the product-side touchpoints; most products that use `createPapiProvider` for chain access and `@novasamatech/product-react-renderer` for custom chat don't need code changes.

## What changed on our side

### Theme subscription is a struct now

The host now delivers a `Theme` struct on `host_theme_subscribe` instead of the flat `'light' | 'dark'` enum:

```ts
type Theme = {
  name: { tag: 'Default'; value: undefined } | { tag: 'Custom'; value: string };
  variant: 'Light' | 'Dark';
};
```

`setTheme('light' | 'dark')` keeps working as a shorthand — it maps to `{ name: { tag: 'Default', value: undefined }, variant: 'Light' | 'Dark' }`. New: you can pass the full struct to test product branches that read `theme.name`:

```ts
await testHost.setTheme({
  name: { tag: 'Custom', value: 'midnight' },
  variant: 'Dark',
});
```

`getTheme()` returns the struct — use `theme.variant` where you previously had `'light'/'dark'`.

### Payment log records the purse selector

Upstream v0.8 added an optional purse selector to `topUp` (`into`) and `requestPayment` (`from`) per RFC-0017. The test host now surfaces the selector on `PaymentLogEntry.purse`:

```ts
await testHost.getPaymentLog();
// → [{ type: 'top-up', amount: 1000n, purse: 7, ... },
//    { type: 'request', amount: 500n, purse: 7, ... }]
```

Calls that omit the selector still target the main purse and the log entry's `purse` is `undefined`.

### Variant rename: `BulletInAllowance` → `BulletinAllowance`

If you hand-build resource-allocation requests in a test, rename the tag. Products going through the wrapper need no change.

## What you need to do

1. Upgrade to `0.9.0` and bump your product's `@novasamatech/host-api` (and related) to `^0.8.0` at the same time.
2. If you call `subscribeTheme(cb)` in your product or `getTheme()` in tests, switch to reading `theme.variant` (note the capitalization: `'Light' | 'Dark'`). Or branch on `theme.name.tag === 'Custom'` if you support custom themes.
3. Grep tests for `BulletInAllowance` and rename to `BulletinAllowance`.
4. Re-verify any custom signing flows (`withSignedTransaction`) and custom chat renderers — the upstream `OptionBool` encoding fix flips `true`/`false` against older peers. The test SDK rides through the upstream fix transparently; you should not need to change code, just re-run your suite.

---

# host-api-test-sdk 0.9.2

Tracks upstream `@novasamatech/*@^0.8.8`. Pure version bump — no API changes, no test changes, no breaking changes. Existing `0.9.1` tests continue to work without modification.

## What changed upstream

- **`0.8.7`**: statement-store rework on the SSO peer side — concurrent request tracking, transient-failure retry/backoff, statement priority counted from a spec epoch (so TS-written statements no longer outrank iOS/Android ones), `ExpiryTooLow` / `AccountFull` absorbed once a submission is superseded. Also bumps `polkadot-api` to `2.1.6` (double-notification fix) and ships `LICENSE` + `THIRD_PARTY_NOTICES` in every package.
- **`0.8.8`**: SSO `UserSession` gains `signRawLegacy` and `createTransactionLegacy` for legacy `AccountId`-based sign requests routed through a paired authorising device.

## Why no SDK-side changes

Both releases land in `host-papp` (the SSO peer / authorising-device path). This test SDK simulates the in-process host that products call directly via `host-container` + `host-api` + `host-api-wrapper`, and the public surface of those three packages is byte-identical to `0.8.6`. No new handlers to write, no codecs to register.

## What you need to do

1. Upgrade to `0.9.2`. Bump your product's `@novasamatech/host-api` (and friends) to `^0.8.8` at the same time — matched versions stay the safest pairing.
2. Nothing else.

---

# host-api-test-sdk 0.9.1

Tracks upstream `@novasamatech/*@^0.8.6`. Drop-in upgrade from `0.9.0` for existing tests — nothing renames, nothing moves. What's new is an extra error path you can now drive: RFC-0021 partial coin top-ups.

## What changed on our side

### RFC-0021 coin top-ups land in the payment log

Upstream `0.8.3` added a third `PaymentTopUpSource` variant, `Coins`, alongside `ProductAccount` and `PrivateKey`. A product calling `paymentManager.topUp(amount, { type: 'coins', keys: [...] })` skips the on-chain round-trip and credits a balance directly from raw sr25519 coin secret keys.

`handlePaymentTopUp` already forwarded the source verbatim to the log, so the new variant lands in `paymentLog[i].source` as:

```ts
{ tag: 'Coins', value: [Uint8Array(64), Uint8Array(64), ...] }
```

`0.8.4` then fixed the codec — keys are now 64-byte sr25519 secrets, not the 32-byte ed25519 keys briefly shipped in `0.8.3`. If you write tests that pass `privateKey` or `coins` sources by hand, allocate 64-byte buffers (e.g. `new Uint8Array(64).fill(...)`).

### `setPaymentTopUpBehavior` for partial-credit and reject paths

RFC-0021 introduced `PaymentTopUpErr.PartialPayment({ credited })` — a real host returns it when only some of the submitted coins could be claimed, and the product needs to reconcile the actual `credited` amount against what it asked for. The new `setPaymentTopUpBehavior` test control drives the host into that error path:

```ts
// Default: full credit + ok(undefined)
await testHost.setPaymentTopUpBehavior('ok');

// Credit only `credited` and reject with PartialPayment({ credited })
await testHost.setPaymentTopUpBehavior({ type: 'partial', credited: 200n });

// Credit nothing and reject
await testHost.setPaymentTopUpBehavior({ type: 'reject', reason: 'InvalidSource' });
await testHost.setPaymentTopUpBehavior({ type: 'reject', reason: 'InsufficientFunds' });
```

The balance subscription receives the partial credit before the promise rejects, so a product UI that subscribes to `paymentManager.subscribeBalance` will see the same sequence it would in production. `paymentLog` always records the attempted `amount` and `source` regardless of outcome — what changes is what `paymentManager.topUp(...)` resolves to.

`PaymentTopUpBehavior` is exported from the package root for typing.

## What you need to do

1. Upgrade to `0.9.1`. Bump your product's `@novasamatech/host-api` (and friends) to `^0.8.6` at the same time — wire-compatible with `0.8.3+` but matched-version is the safest.
2. No code changes required for existing tests. Theme, payments, signing, statement-store, and chat handlers behave identically.
3. If you want to exercise the partial-payment branch of your product, drop `await testHost.setPaymentTopUpBehavior({ type: 'partial', credited: ... })` before the call.

---

# host-api-test-sdk 0.10.0

The single `chain` option becomes a `networks` array, and the host now routes a product's connection requests to whichever configured network matches the requested genesis hash. This lets one test host serve a product that talks to more than one chain in the same session — for example an Asset Hub plus the People network.

## What changed on our side

### `chain` → `networks` (breaking)

`createTestHostServer` and `createTestHostFixture` no longer take a single `chain`. They take a `networks` array instead. The first entry is the default, and each connection request is matched to a network by genesis hash. Wrap your existing value to migrate:

```diff
 createTestHostFixture({
   productUrl: "http://localhost:3000",
   accounts: ["alice"],
-  chain: PASEO_ASSET_HUB,
+  networks: [PASEO_ASSET_HUB],
 });
```

To serve more than one network, list them all — order only decides the default:

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: ["alice"],
  networks: [PASEO_ASSET_HUB, PREVIEWNET, PREVIEWNET_ASSET_HUB],
});
```

A product that switches genesis mid-session now connects to the matching RPC instead of being rejected. Requests for a genesis hash you didn't configure are reported as `Unsupported chain requested`, listing the genesis hashes the host can route.

### `ChainConfig` → `NetworkConfig` (breaking)

The config type is renamed. The shape is identical (`id`, `name`, `genesisHash`, `rpcUrl`, `tokenSymbol`, `tokenDecimals`) — only the name changed, so update your type imports:

```diff
-import type { ChainConfig } from "@parity/host-api-test-sdk";
+import type { NetworkConfig } from "@parity/host-api-test-sdk";
```

## What you need to do

1. Upgrade to `0.10.0`.
2. Rename `chain: X` to `networks: [X]` in your `createTestHostServer` / `createTestHostFixture` calls.
3. Rename any `ChainConfig` type imports to `NetworkConfig`.
4. Optionally, add the extra networks your product connects to so mid-session chain switches resolve.

---

# host-api-test-sdk 0.11.0

## `@parity/truapi` 0.4 products connect out of the box

Products that upgraded to `@parity/truapi` 0.4 (including everything built on
recent `@parity/product-sdk`) change how the iframe channel is opened: instead
of exchanging frames directly over window postMessage, the product posts
`{ type: "truapi-ready" }` and expects the host to answer with
`{ type: "truapi-init" }` carrying a transferred `MessagePort`. Against older
test-sdk releases, that handshake went unanswered — the product waited 20
seconds for a port that never arrived and `waitForConnection()` timed out.

The test host now answers the handshake and serves all traffic over the
transferred port. No test changes are needed:

```ts
const bobFixture = createTestHostFixture({
  productUrl: "http://localhost:5260",
  accounts: ["bob"],
  networks: [PASEO_ASSET_HUB],
});
// waitForConnection() now resolves for truapi-0.4 products too
```

Products on the 0.3 bootstrap (`@novasamatech/host-api-wrapper`) are
unaffected — the direct window postMessage channel is still served, and both
kinds of product talk to the same container with the same handlers, logs, and
permission model.

## What you need to do

1. Upgrade to `0.11.0`.
2. Nothing else — both product generations connect without configuration.
