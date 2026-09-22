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

---

# host-api-test-sdk 0.12.0

Tracks upstream `@novasamatech/*@^0.9.1` ([triangle-js-sdks#239](https://github.com/paritytech/triangle-js-sdks/pull/239)) and serves products on `@parity/truapi@^0.6.0`. v0.9 is **wire-incompatible** with v0.8: RFC-0022 changes `DerivationIndex` from a bare `u32` to `Enum{Index(u32), Raw([u8; 32])}`, so your product side has to move in the same commit.

Against `0.11.0` a truapi-0.6 product fails quietly: the wrong account for any index other than `0`, `signRaw` over a different payload than the one requested, and `createTransaction` dropped without a reply. `product-sdk`'s E2E suite goes from 2 failed to 54 passed on this release.

## What changed on our side

### Product accounts take a selector, not a number (breaking)

`Index(n)` resolves exactly as the plain `n` did, so `productAccounts` keys and derived addresses are unchanged. Raw 32-byte selectors are new, keyed by hex (`"myapp.dot/0x1234…"`). The wrapper takes `number | Uint8Array` and normalises for you; hand-built requests wrap the index:

```diff
-hostApi.signRaw(enumValue("v1", { account: [dotnsId, 0], payload }));
+hostApi.signRaw(enumValue("v1", { account: [dotnsId, derivationIndexOf(0)], payload }));
```

### `accountCreateProof` returns a struct (breaking)

```diff
-const proofHex = u8aToHex(result.value);
+const proofHex = u8aToHex(result.value.proof);
```

Plus `contextualAlias`, `ringIndex`, `ringRevision`.

### `accountGetAlias` rejects with `GetAliasErr` (breaking)

Alias errors moved out of `RequestCredentialsErr` into their own enum (`RingNotFound` / `NotMember` / `Rejected` / `Unknown`).

### `SmartContractAllowance` carries a selector (breaking)

```diff
-{ tag: "SmartContractAllowance", value: 0 }
+{ tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } }
```

`handleAccountSignVrf` (RFC-0023, new upstream) is not implemented — the container answers `SignVrfErr.Unknown`.

## What you need to do

1. Upgrade to `0.12.0` and move your product side to `@parity/truapi@^0.6.0` or `@novasamatech/host-api-wrapper@^0.9.1` in the same commit.
2. Through the wrapper, nothing else. Hand-built requests: wrap indices in `derivationIndexOf()` and adjust the three shapes above.
3. If your fixtures still pass `chain:`, see 0.10.0 — it is silently ignored, so any `rpcUrl` override you set is being dropped.

---

# host-api-test-sdk 0.12.1

One fix. Drop-in upgrade from `0.12.0`.

## Fixed

- **All three built-in network genesis hashes refreshed after chain resets.** `PASEO_ASSET_HUB`, `PREVIEWNET`, and `PREVIEWNET_ASSET_HUB` were all pinned to genesis values from earlier deployments of those chains, verified dead against live RPC:

  | Constant | Was | Now |
  |---|---|---|
  | `PASEO_ASSET_HUB` | `0xbf0488…ef19f` | `0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6` |
  | `PREVIEWNET` | `0x477dd8…12525` | `0x8c27ddf678c2ae9bef0efebfc485a9309f3d735c6d3fbb8d947afc3ace0e80f4` |
  | `PREVIEWNET_ASSET_HUB` | `0x860d75…c7867c` | `0x4d11c803cc6921429e3876638977ad006ea1bba8cd3976a0bca2f164e7026210` |

The host routes each connection request to a network by genesis hash, so a stale pin means the host does not recognise the chain your product is asking for. The symptom is the product stuck at `connection-status: "connecting"` until the test times out, with a reachable RPC endpoint and nothing obviously wrong in the logs.

One thing worth calling out: before this release the pins were wrong but *consistent*. A test host and a set of descriptors both generated against the same dead chain agree with each other perfectly, so a suite can be green while connected to a chain that no longer exists. If your e2e went green across one of these resets without you touching anything, that is what happened.

## What you need to do

- Upgrade to `0.12.1`. If you use the built-in network configs, that is the whole change — the correct hashes come with the upgrade.
- If you hard-coded any of the three old hashes in your own `NetworkConfig` or in test assertions, update them. Better still, read them off the exported config (`PASEO_ASSET_HUB.genesisHash`) so the next reset costs you nothing.
- These chains reset periodically. Treat a genesis literal in your own repo as something that will go stale, not as a constant.

# host-api-test-sdk 0.13.0

This is the big one. The test host no longer speaks the old `@novasamatech/host-container` protocol — it **runs the TrUAPI core itself**, `truapi-server` compiled to WebAssembly in a Web Worker, exactly the core a real host runs. Everything below the public API changed; most of what you write in a test did not.

**You need to move your product with it:** `@parity/truapi` `0.17`, booting through `@parity/truapi/sandbox`. There is no compatibility path — the old protocol is gone, not deprecated.

## What still works unchanged

- `createTestHostFixture` / `createTestHostServer` and the shape of their options — two of them changed meaning, and both have their own section below: `productAccounts` keys, and what `accounts` beyond the first one does
- Dev accounts and their addresses — `//Alice` is still `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`
- The signing log, the permission log, navigation, notifications, preimages, theme, chat state
- Auto-signing with no prompts, which is the whole point of the package

```ts
import { test as base, expect } from "@playwright/test";
import {
  createTestHostFixture,
  PASEO_ASSET_HUB,
} from "@parity/host-api-test-sdk/playwright";

const { testHost } = createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: ["alice"],
  networks: [PASEO_ASSET_HUB],
});

export const test = base.extend({ testHost });
export { expect };

test("signs without a prompt", async ({ testHost }) => {
  await testHost.waitForConnection();
  await testHost.productFrame().getByRole("button", { name: "Send" }).click();

  const log = await testHost.getSigningLog();
  expect(log).toHaveLength(1);
});
```

## Signing is a round trip now

The core never signs. It encrypts each signing request to its paired signer and publishes it as a statement on the People chain; a real host forwards that to your phone, and you tap approve.

There is no phone here and, deliberately, no network: the People chain is a **loopback statement store inside the page**, and the host mints both halves of the SSO session at boot and answers as the peer. That is what keeps "no Docker, no network, no prompts" true while running the genuine protocol.

For your tests this means one thing: a signature is asynchronous. Await the product's own promise before reading `getSigningLog()`.

## Product accounts: keyed by product, not by index

The core stopped asking the host which account a product's index `n` is. It asks once for the product's **hard subtree** and then derives every account from it itself, as one soft junction over the subtree public key.

So the host's only say is *which keypair the subtree is*, and `productAccounts` follows:

```diff
 createTestHostFixture({
   productUrl: "http://localhost:3000",
   accounts: ["bob"],
   productAccounts: {
-    "myapp.dot/0": "charlie",
-    "myapp.dot/2": "dave",
+    "myapp.dot": "charlie",   // moves EVERY index of myapp.dot
   },
 });
```

A per-index key is now an error rather than a silent no-op, and it tells you what to write instead.

**Product-account addresses have moved** as a consequence — index `n` under a subtree is now its soft child at `index_bytes(n)`, not the hard junction `…/n`. Root dev accounts have not moved. If a test pins a product-account address, re-read it from the host once and update the literal.

This also fixes a genuine bug in the 0.13 pre-release: the host was reporting one key and signing with another, so a product's own signature did not verify against its own address. It now signs with the same derivation the core reports — checked against schnorrkel's own test vector, and there is an E2E test that takes the address the core hands the product, signs, and verifies against it.

## Chat needs `executionKind: 'Worker'`

The core decides what a connection may reach from the *kind* of executable the host says it is running, and Chat is the strictest one: `chat_platform_for` denies every Chat entry point unless the kind is `Worker`. An iframe-embedded product is an `App`, which is what this host declares by default — so until now every chat call came back `Denied`.

There is now an option for it, on both entry points:

```ts
// Playwright fixture
const { testHost } = createTestHostFixture({
  productUrl: "http://localhost:3000",
  executionKind: "Worker", // only for tests that drive chat
});

// or directly
const host = await createTestHostServer({
  productUrl: "http://localhost:3000",
  executionKind: "Worker",
});
```

It takes `'App'` (the default), `'Widget'` or `'Worker'`, and the type is exported as `ProductExecutionKind`. Leave it alone unless you are testing chat: `App` is what an iframe-embedded product actually is, and declaring every product headless just to unlock one modality would misreport what the host is running.

With it set, the whole chat surface works — `chatCreateRoom`, `chatRegisterBot`, `chatPostMessage`, the room subscription, and `injectChatAction` from the host side:

```ts
await product.evaluate(() =>
  client.chat.createRoom({ roomId: "r1", name: "Room 1", icon: "" }),
);
expect(await testHost.getChatRooms()).toHaveLength(1);
```

One thing to know while you are there: a chat `icon` is validated by the core, not passed through. It must be empty, an `https` URL, or an inline `data:` image of an allowed type — anything else (a placeholder like `"icon-data"`, say) is refused with *"icon carries a scheme that cannot be rendered"*.

`injectChatAction` is also asynchronous now, and takes the protocol's own action type (`ChatActionInput`, exported from the package root). `await` it — it rejects if the action could not be delivered.

## `accounts` is a roster, and only the first one signs

This one is a clarification and a bug fix in the same place.

The SSO session carries exactly **one** identity, so the first entry in `accounts` is the account that signs; the rest are targets you can switch to later. That was already the behaviour — it just was not what the docs implied, and `getLegacyAccounts()` returning `[]` no matter what you configured made it look like the roster was ignored entirely. It is not ignored, but nothing beyond the first entry is active until you switch to it, and a legacy-account request naming any *other* account is refused by the core.

The bug: `switchAccount(name)` used to synthesise `//Name` from the name you passed, ignoring the roster. So a custom account could never actually be switched to —

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: ["alice", { name: "Derived", uri: "//Alice//custom" }],
});

// Before: signed as //Derived, silently — the configured URI was ignored.
// Now: signs as //Alice//custom, the URI you configured.
await testHost.switchAccount("Derived");
```

Names are matched against the roster case-insensitively. A dev name the roster does not carry still falls back to the bare derivation, so `switchAccount("charlie")` gives you `//Charlie` whether or not Charlie was listed at boot.

## Controls that are gone

The host used to simulate several things the core now owns, or that the new stack has no equivalent for. Grep your tests for these; each one is a compile error or a `TypeError`, not a silent change in behaviour:

- **Statement store**: `getSubmittedStatements`, `injectStatement`, `clearStatements`
- **Login**: `setLoginBehavior`, `getIsAuthenticated`, `simulateDisconnect`, `simulateReconnect`
- **Payments**: `setPaymentBalance`, `getPaymentLog`, `clearPaymentLog`, `setPaymentTopUpBehavior`, `simulatePaymentStatus`
- **`setEnforcePermissions`** — this one was already doing nothing. Signing is not gated by the host (real hosts do not gate it either), and `ChainSubmit` is enforced by the core at `transaction_broadcast`, after signing. A method that silently does nothing is worse than an absent one, so it is absent.

Removed types: `LoginBehavior`, `PaymentLogEntry`, `PaymentTopUpBehavior`, `StatementSubmissionLogEntry`.

## Smaller things

- **`getChainStatus()`** joins `getConnectionStatus()`: the first is the *host's* session, the second is the *product's* connection. Signing rides on the session, so if a switch leaves it `'disconnected'`, no signature is coming.
- **`NetworkConfig.chain`** declares a network's protocol role (`'Relay' | 'AssetHub' | 'People' | 'Bulletin'`) for `supportedChains()`. Omit it and the network is simply left out of that report instead of being labelled by guesswork — it is still routable by genesis hash.
- **`accounts[].uri` is hard junctions only.** Keys are derived in the page with `@scure/sr25519`; there is no keyring any more. `'//Alice//custom'` is fine; a mnemonic or hex seed now throws.
- **`featureSupported` now agrees with `supportedChains()` about the People chain.** The host always advertises its in-page People loopback, but the feature probe only ever matched the configured `networks` — which never contain the People genesis, because that chain is served in the page. Asking whether the one chain every signature travels over was supported got you `false`.
- **Three bugs in the loopback store** that between them blocked every signature are fixed: the `statement_submit` reply shape, the `newStatements` subscription envelope, and the topic-filter key spelling (which had been quietly turning every filter into a firehose). Also the AutoSigning grant, which was refused as an "invalid subtree secret" because schnorrkel has two 64-byte secret encodings and this host was handing over the wrong one.
- **`clearChatState` is now `clearChat`.** Same behaviour, shorter name, in line with the new `seedChatRoom` / `seedChatBot` pair below.

## Overriding host conditions

Beyond theme, a product can now be exercised under a much wider set of conditions than "what the host does by default" — either live from a test, or pre-configured before the product's first frame.

Two families, named consistently:

- **Ambient data** the host reports — device-permission status, locale, feature support, the supported chain set, product storage, plus seeding chat rooms and bots. `get<Thing>` reads it, `set<Thing>` / `seed<Thing>` writes it, `clear<Thing>` resets it: `setDevicePermissionStatus` / `getDevicePermissionStatuses`, `seedChatRoom`, `seedChatBot`, `getLocale` / `setLocale`, `setFeatureSupport` / `getFeatureSupport`, `setSupportedChains` / `getSupportedChains`, `seedProductStorage` / `getProductStorage` / `clearProductStorage`. The per-key ones take `undefined` to put the host's own answer back.
- **Decisions** the host makes on the product's behalf — confirmations, navigation, notifications. `set<Thing>Behavior(b)` takes `'approve-all'` (default), `'reject-all'`, or, in-page only, a function of the request — a notification's carries `{ text, deeplink, scheduledAt }`, so a test can refuse only the scheduled ones. `get<Thing>Log` / `clear<Thing>Log` inspect what was asked and how it was answered: `setUserConfirmationBehavior`, `getUserConfirmationLog` / `clearUserConfirmationLog`, `setNavigationBehavior`, `setNotificationBehavior`.

Both families can be set up front, via `initialState` and `behaviors` on `createTestHostFixture` / `createTestHostServer`, so the product never sees the default:

```ts
const { testHost } = createTestHostFixture({
  productUrl: "http://localhost:3000",
  initialState: {
    locale: "pt-BR",
    theme: "dark",
    devicePermissionStatuses: { Camera: "Denied" },
    features: { Chain: false },
    supportedChains: [{ identifier: "AssetHub", genesisHash: "0x23e7..." }],
    grantedPermissions: ["ChainSubmit"],
  },
  behaviors: {
    userConfirmation: "reject-all",
  },
});
```

Two things worth knowing before you reach for these: `seedProductStorage` only replays a key `getProductStorage()` has already reported — the core namespaces storage per product, so a key the product has never written can't be hand-constructed, in `initialState.productStorage` as much as in the live call. And the function form of a behavior only works in-page, via `window.__TEST_HOST__` — the Playwright fixture's setters and the `behaviors` boot option take `'approve-all' | 'reject-all'` only.

See the README's [Overriding host conditions](https://github.com/paritytech/host-api-test-sdk#overriding-host-conditions) section for the full member table.

## If you maintain a host-playground

`../host-playground` still pins `0.12.1` and the old bootstrap. It needs its own pass against 0.13.0: the truapi 0.17 sandbox bootstrap, the `productAccounts` key change, and any assertion pinning a product-account address. Then 0.13.1: `productId`, if it signs under anything but `test-product.dot`.


---

# host-api-test-sdk 0.13.1

Three things 0.13.0 shipped dead. If you tried `getUserId`, `preimage.submit`, or signing under your own product name and got a flat refusal with nothing in any log, this is why.

## `getUserId()` works

`account.getUserId()` failed for every product, always, with `Unknown: No primary username for this session`.

The host minted its SSO session leaving both username fields empty, on the reasonable-looking assumption that the core fills them in. It does — but only by reading the dotNS contracts on Asset Hub, and it gives up the moment the host declares it has no Asset Hub, which this host did unconditionally. So the session had no username and never would.

Sessions now carry one. It defaults to `"<name>.01"` for the active account — `alice.01`, `bob.01` — which is the shape of a real attested lite username, and it follows `switchAccount`. Override it when a test asserts on what gets displayed:

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  accounts: [{ name: "Alice", uri: "//Alice", username: "zaphod.07" }],
});
```

## `productId` — sign as your own product

This one was the quiet killer. The core refuses any call that acts *as* a product account when the `dotNsIdentifier` is not the id the host declared the product under: `signRaw`, `signPayload` and `createTransaction` answer `PermissionDenied`, `statementStore.createProofAuthorized` answers `UnknownAccount`. The host hard-coded that id to `test-product.dot` and offered no way to change it.

So if your product signed as `myapp.dot`, every signature was refused — and `PermissionDenied` reads like a permissions problem, which sent people off pre-granting `ChainSubmit` and requesting `AutoSigning`, neither of which is the gate. Nothing appeared in `getSigningLog()`, because the core never got as far as asking the host to sign.

```ts
createTestHostFixture({
  productUrl: "http://localhost:3000",
  productId: "myapp.dot",
});
```

`productId` is also what the core namespaces product storage and permissions under. It is *not* what `productAccounts` is keyed by — that is the `dotNsIdentifier` the product asks to sign with, which the gate normally forces to the same value.

One escape hatch worth knowing about: `'localhost'` and `'localhost:<port>'` are development wildcards. The core admits them as callers for *any* `dotNsIdentifier`, so `productId: 'localhost:3000'` makes everything pass — handy against a dev server, but your suite is then not exercising the check at all.

## `chain: 'Bulletin'` actually reaches the core

`preimage.submit()` could not work. The core asked the host to connect to the all-zero genesis and got back `bulletin chain unavailable: … no chain configured for genesis 0x0000…`, no matter what you configured.

The reason is worth knowing, because it is not what `supportedChains()` suggests. The core reaches two chains on its own account — Bulletin for preimage submission, Asset Hub for dotNS — and it picks them by the genesis hashes the host handed it at boot, not by anything the chain-set report says. The host was hard-coding both to all-zero, which the core reads as "this host deliberately has no such chain".

They now come from whichever configured network declares that role:

```ts
networks: [
  PASEO_ASSET_HUB,
  {
    id: "paseo-bulletin",
    name: "Paseo Bulletin",
    genesisHash: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
    rpcUrl: "wss://paseo-bulletin-next-rpc.polkadot.io",
    tokenSymbol: "PAS",
    tokenDecimals: 10,
    chain: "Bulletin",
  },
],
```

One consequence to be aware of: `chain: 'AssetHub'` now has an effect too. The core reads product manifests and `trustedProducts` grants from dotNS there, so a cross-product grant that used to be refused instantly now costs a real round trip to that network's `rpcUrl`. Signing is untouched — still the in-page People loopback, still no network.

## Upgrading

Nothing to change. Set `productId` if your product signs under its own dotNS name, and add a `chain: 'Bulletin'` network if you test preimage submission.

---

# host-api-test-sdk 0.14.0

truapi `0.18`. The core changed how it asks the host for consent, added two
services every host has to implement, and stopped rewriting dotNS links on their
way out to `navigateTo`.

**Before you upgrade:** both sides of the wire move together, so your product
must be on `@parity/truapi` `0.18` and boot through `@parity/truapi/sandbox`. If
it goes through `@parity/product-sdk` instead, check first — `@parity/product-sdk-host`
pins `@parity/truapi` `^0.17.0` as of `0.21.0`, the newest release at the time of
writing, and a caret on a `0.x` version excludes `0.18`. Stay on `0.13.x` until a
product-sdk release moves over.

## A permission answer now has a lifetime

The core used to take a yes or a no. It now takes `'AllowOnce'`, `'AllowAlways'`
or `'Deny'`, and it acts on the difference: a lasting grant is stored and the
product is never prompted again, a one-use grant is consumed by a single
permission-gated operation and the next request prompts afresh.

That is a real branch in your product's code — the second request after a one-use
grant goes back through the prompt — and it was not testable before. Now it is:

```ts
test("survives being re-prompted", async ({ testHost }) => {
  await testHost.setPermissionBehavior("approve-once");

  // ... drive the product through two gated operations ...

  const log = await testHost.getPermissionLog();
  expect(log).toHaveLength(2);                      // asked each time
  expect(log.every((e) => e.approved)).toBe(true);
  expect(log[0].decision).toBe("AllowOnce");
});
```

`'approve-all'` (still the default) and `'reject-all'` keep behaving as they did —
one prompt, then the stored answer. The third mode is the new one.

Log entries carry both readings. `approved` means what it always did: `false`
only for a denial, so a one-use grant reads as an approval. `decision` is the
lifetime itself. **If you deep-equal a whole log entry, that assertion needs the
new field**; an assertion on `approved` or `tag` is untouched.

The in-page function form takes either answer, so a test can be selective about
lifetimes as well as verdicts:

```ts
window.__TEST_HOST__.setPermissionBehavior((request) =>
  request.tag === "ChainSubmit" ? "AllowOnce" : "Deny",
);
```

All of the above applies to `setUserConfirmationBehavior` too, because the core
asks for identity and account disclosures through a review that keeps its
lifetime — a second entry point, `confirmPermission`, which the host now serves.
One behavior answers both, so you set a policy once. `lifetimeAsked` on the log
entry says which way the core asked.

## `navigateTo`: dotNS links pass through, external URLs are gated

Two changes, and the first one will break an assertion if you have it.

A dotNS link is no longer rewritten. `polkadot://foo.dot` reaches the host as
`polkadot://foo.dot` — where it used to arrive as `https://foo.dot` — because the
core now treats the dotNS schemes as app handoffs for the host's own URL handler
rather than web addresses. `dot://foo.dot` is normalized to the `polkadot://`
spelling. If a test asserts on `getNavigationLog()[n].url` for such a URL, change
what it expects.

Second: an external URL is now gated by a new device permission, `OpenUrl`. It
prompts on first use, and under a denial `navigateTo('https://…')` fails with
`PermissionDenied` and never reaches the navigation log at all:

```ts
await testHost.setPermissionBehavior("reject-all");

// Refused, and not logged as a navigation.
expect(await product.navigateTo("https://example.com/page")).toMatchObject({
  ok: false,
  error: "PermissionDenied",
});

// A dotNS link is not gated, so it still arrives.
await product.navigateTo("polkadot://ok.dot");
expect(await testHost.getNavigationLog()).toHaveLength(1);
```

The grant is device-wide rather than per-host, so approving it once covers every
later URL. Worth knowing because the generated doc on `navigateTo` says
`mailto:` and `tel:` consume no grant — as far as this host can observe, only the
dotNS pair behaves that way; a `mailto:` URL goes through `OpenUrl` like any
other.

## Two new services the host now answers

**`localStorage.subscribe`.** The core's storage trait gained a subscription:
your product can watch one key and get its current value, then every later write
or clear. The host serves it off the same in-memory map product storage already
used — which means a test's own `seedProductStorage(key, value)` and
`clearProductStorage()` reach a subscribed product exactly as the product's own
writes do. A cleared key arrives as an absent value; the stream stays open.

**`worker.beginOperation` / `endOperation`.** How a `Worker` product tells the
core it has work pending, so the runtime is held up until it finishes. The host
records them rather than acting on them, and hands you the record:

```ts
const open = await testHost.getOpenOperations();
expect(open).toEqual([]);           // nothing is holding the runtime up
```

`getOpenOperations()` is the oracle for a product leaking its own runtime —
anything still listed after the work should have finished was never ended.
`getOperationLog()` is every operation in the order opened, with `endedAt` set
once closed, and `clearOperationLog()` drops the log while leaving open
operations endable. Nothing is ever refused: a real host's `TooManyOpen` is
back-pressure, and a test host imposing its own limit would fail products for
reasons production never reproduces.

## The statement store works again

This one is a regression fix, and it goes back to 0.13.0.

When the host moved onto the TrUAPI core, statement traffic moved with it — onto
the in-page People loopback that also carries signing. Three test controls were
dropped in that move and never replaced: `getSubmittedStatements`,
`injectStatement` and `clearStatements`. What took over was a relay rather than a
store, and it showed in two ways. A submitted statement reached the SSO responder
and stopped — no subscriber ever got it. And a subscribe got an id and nothing
else, where the protocol promises a historical dump first; that is what
`isComplete` on a subscription item marks. So seeding a statement before the
product subscribed lost it, and seeding after was a race.

All of it is back, and the store is a store:

```ts
// Seeded first. The product has not subscribed yet, and does not have to have —
// a subscription opened later is replayed everything that matches.
await testHost.injectStatement({ topics: [TOPIC], data: "0xdead" });

const frame = testHost.productFrame();
await frame.getByRole("button", { name: "Watch topic" }).click();
await expect(frame.getByText("0xdead")).toBeVisible();

// And the other direction: what did the product publish?
const submitted = await testHost.getSubmittedStatements();
expect(submitted[0].data).toBe("0xcafe");
```

`getStatements()` is everything the store holds, `getSubmittedStatements()` is
the `fromProduct` subset, and `clearStatements()` wipes the retained set while
leaving live subscriptions open.

Two differences from the pre-0.13 version, both forced by the core being real
now. An injected statement is **signed for you** with the active session
identity — the core validates the proof and silently drops an unproven statement,
so `injectStatement` takes `{ topics, data }` rather than a raw statement. And
the host's **own signing traffic is excluded** from the log and from delivery: it
rides the same store, so without that exclusion every read would be a stream of
encrypted session frames, and a re-subscribing session would be replayed stale
signing requests. `getSigningLog()` is still the oracle for signing.

One gotcha: identical topics, data and proof encode to identical bytes, and the
core treats a repeat as a duplicate. Vary `data` when a test needs two distinct
deliveries.

## Upgrading

Move your product to truapi `0.18` first — or stay here until product-sdk does.
Then, in your suite:

- Change any expectation on a dotNS `navigateTo` URL from the `https://` form to
  `polkadot://`.
- If a test denies permissions and expects an external navigation to be logged,
  it no longer is.
- If a test deep-equals a permission or confirmation log entry, add `decision`
  (and `lifetimeAsked` for confirmations).
- If you worked around the missing statement-store controls — or parked a test
  because of them — pick them back up.

Everything else is additive.

---

# host-api-test-sdk 0.15.0

One fix, from a report out of a product-sdk migration: `getSigningLog()` came
back empty for a `signRaw()` that demonstrably succeeded. So did
`getUserConfirmationLog()` and `getPermissionLog()`. Cleared right before the
call, dumped right after — all three `[]`, while the product UI rendered a valid
signature.

It was not a broken accessor, and not a regression in the accessor's shape.

## Why the logs were empty

The product had been granted **`AutoSigning`**.

That capability hands the core `productRootPrivateKey` — the product's whole
subtree secret. From that moment the core derives every product account and signs
**inside its own worker**. There is no SSO round trip, so no host callback runs,
so there is nothing for any log to record. The host cannot see those signatures
because it gave the key away.

This has been true since 0.13.0 wired the capability. It went unnoticed here
because nothing in this repo granted auto-signing and *then* asserted on signing
— a product-sdk product asks for it at boot, which is how the report surfaced it.

## The fix: decline the grant

The host cannot observe an in-core signature, so the only honest fix is to let a
suite refuse the capability. `behaviors.resourceAllocation` and
`setResourceAllocationBehavior()` choose what gets allocated:

```ts
const { testHost } = createTestHostFixture({
  productUrl: "http://localhost:3000",
  behaviors: { resourceAllocation: { AutoSigning: false } },
});
```

The core then falls back to asking the host per signature, and every one lands in
`getSigningLog()` and `getUserConfirmationLog()` again — verified end to end, in
both directions, in the integration suite.

The record form grants anything it does not mention, so this withholds
auto-signing and leaves `StatementStoreAllowance` and `BulletinAllowance`
untouched; `statementStore.createProofAuthorized` keeps working. `'approve-all'`
(the default, and what every earlier release did) and `'reject-all'` are there
too, and in-page you can pass a function.

**Use the boot option rather than the setter** when the product asks at startup:
by the time a setter could run, the grant is already made.

## And an accessor so this is diagnosable

The deeper problem was that an empty log looked identical to a broken API. It no
longer does:

```ts
expect(await testHost.getResourceAllocationLog()).toEqual([
  { productId: "myapp.dot", resource: "AutoSigning", granted: true, timestamp: expect.any(Number) },
]);
```

An empty signing log now has that entry sitting in front of it, saying exactly
why. `clearResourceAllocationLog()` resets it. New exported types:
`AllocatableResourceTag`, `ResourceAllocationBehavior`,
`ResourceAllocationLogEntry`.

`SigningLogEntry`'s own doc comment now states what does not reach it, and points
at the option that fixes it.

## Upgrading

Nothing to change — `'approve-all'` is the default. Add the boot option to any
suite that asserts on signing.

## Also in 0.15.0, from the same migration

**Product storage is addressable by the key your product used.**
`getProductStorage()` is keyed by the namespaced form the core hands the host —
`truapi:product-storage:v1:<productIdLength>:<productId>:<localKey>` — so
matching it meant suffix-matching, which is ambiguous the moment a local key
contains a colon. `getProductStorageValue("mykey")` and
`getProductStorageEntries()` (which carries `localKey` beside `key`) match
exactly instead.

**The package ships its CHANGELOG.** `files` was `["dist"]`, so npm carried the
README and LICENSE but not the changelog — which is how you end up diffing
`.d.ts` files across four published versions to find a breaking change.

**`TRUAPI_WIRE_SCHEMA_HASH`**, exported from the package root. The core ships as
a vendored `.wasm`, so the declared `@parity/truapi` version tells you what the
JS codecs were built against, not what the binary speaks — and the binary is
what your product has to match. The build reads the value out of the compiled
core and fails if it drifts from the constant, so the export cannot go stale.

**An account switch is observable by the product** — this one needed no code
change, only saying so. `account.connectionStatusSubscribe()` delivers
`Disconnected` then `Connected` across a `switchAccount()`, and the product keeps
working with no reload. What hangs is gating on `waitForConnection()` afterwards:
`getConnectionStatus()` tracks the *product* connection and only moves when a
frame arrives, so it sits at `'disconnected'` until the product next talks.
`getChainStatus()` is the host-session one and reads `'connected'` immediately.

## The bug we found on the way: `revokePermission()` did not revoke

This one came out of a side remark while we were comparing notes — "I'd cleared
the log but not revoked" — and it turned out to be worse than the thing we were
chasing.

`revokePermission(tag)` deleted the tag from the host's own set. That set drives
`getGrantedPermissions()` and the iframe's Permissions Policy. It is not what
gates the product: the core keeps its own authorization store, and that is the
one it acts on. So a revoked permission went on being served from the stored
`AllowAlways` — no fresh prompt, nothing in `getPermissionLog()`, and
`getGrantedPermissions()` describing a state the core would not honour. Silent in
all three directions at once. Any suite that revoked and asserted the product was
re-asked, or blocked, was asserting nothing.

Both `grantPermission()` and `revokePermission()` now write the core's decision
as well, and both are `Promise<void>`. The Playwright fixture already declared
them async, so fixture users change nothing; a test driving
`window.__TEST_HOST__` directly should `await` them.

```ts
await testHost.revokePermission("ChainSubmit");
await testHost.setPermissionBehavior("reject-all");
// Now the next signing attempt is asked, refused, and fails.
```

Revoking writes *undetermined*, not denied — it means "ask me again", and the
behavior decides the answer. Collapsing it to a denial would have made
`setPermissionBehavior` unobservable on that path, which is one silent wrong
answer traded for another.

Two smaller things fell out of fixing it. A grant the core could not store used
to fail inside a `catch` that only logged: `grantPermission('TransactionSubmit')`
— a name this very post shows from a 0.6-era release — left the tag in
`getGrantedPermissions()` and nothing anywhere else. Unknown tags now reject, and
name what would have been accepted. And `Remote`, alone among the remote
permissions, is stored under its payload as well as its tag, so it takes one:

```ts
await testHost.grantPermission("Remote", { domains: ["example.dot"] });
```

`setResourceAllocationBehavior()` picked up the same validation its boot-option
twin already had, for the same reason: `{ AutoSignin: false }` used to be
accepted and would then grant the resource it was written to withhold.

One for contributors rather than users: `pnpm test:integration` now rebuilds the
host bundle. The browser runs `dist/host/`, and the script built only the test
product — so an edit under `src/browser/` was tested against the previous build
unless you remembered to build first, and the suite passed and said nothing. CI
always built first, so this only ever misled local runs.
