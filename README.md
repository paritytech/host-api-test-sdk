# @parity/host-api-test-sdk

[![CI](https://github.com/paritytech/host-api-test-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/paritytech/host-api-test-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@parity/host-api-test-sdk)](https://www.npmjs.com/package/@parity/host-api-test-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Lightweight test host for E2E testing embedded Polkadot products built on [TrUAPI](https://github.com/paritytech/truapi) — dev accounts that auto-sign with no prompts, no Docker, no wallet, and no network.

> **Upstream contract:** `0.13.x` runs the TrUAPI core itself — `@parity/truapi-host` `0.17.0` (the Rust core compiled to WebAssembly), `@parity/truapi-provider` `0.2.0` for chain transport, and `@parity/truapi` `0.17.0` for the protocol codecs. **Your product must boot through `@parity/truapi/sandbox` on the same `0.17` minor.** A product on `@novasamatech/host-api-wrapper`, or on any earlier truapi minor, will not connect: the old `@novasamatech/host-container` protocol is gone entirely.

## Why

A TrUAPI product runs inside an iframe and speaks the protocol over a `MessagePort` to a host that runs the core. In production that host is a real wallet: accounts, an SSO pairing with a signing device, a chain connection, and a human tapping "approve" on every signature.

To E2E test a product you do not want any of that. This package gives you a **thin host page** that:

- Embeds your product in an iframe and runs the real TrUAPI core (as WebAssembly, in a Web Worker)
- Provides dev accounts (Alice, Bob, …) with known keypairs
- **Auto-signs every signing request, with no prompts** — the host plays both ends of the SSO session in-page, for the product id it was configured with (`productId`)
- Routes product chain traffic by genesis hash to the RPC endpoints you configure
- Exposes a control API for Playwright assertions (signing log, permission log, account switching, chat, preimages, theme)
- Answers remote and device permission requests (auto-approve by default, configurable per test)

No Docker, no React, no wallet UI. Just `pnpm add -D` and write tests.

## Install

```bash
pnpm add -D @parity/host-api-test-sdk
```

Both ESM (`import`) and CommonJS (`require`) are supported.

## Quick start with Playwright

```ts
// e2e/setup.ts
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
```

```ts
// e2e/transfer.spec.ts
import { test, expect } from "./setup";

test("transfer flow", async ({ testHost }) => {
  // Wait until the product has actually spoken to the host.
  await testHost.waitForConnection();
  const frame = testHost.productFrame();

  await frame.getByRole("button", { name: "Transfer" }).click();

  // Signing happens automatically — verify it was requested.
  const log = await testHost.getSigningLog();
  expect(log).toHaveLength(1);
  expect(log[0].type).toBe("payload");
});

test("multi-account", async ({ testHost }) => {
  await testHost.switchAccount("bob");
  const frame = testHost.productFrame();
  await expect(frame.getByText("Bob")).toBeVisible();
});
```

## Usage without Playwright

The core server works with any test framework or manual browser testing:

```ts
import { createTestHostServer } from "@parity/host-api-test-sdk";

const server = await createTestHostServer({
  // Alice is the active signing identity; Bob is a switch target.
  // See "Dev accounts" for what the rest of the roster does.
  productUrl: "http://localhost:3000",
  accounts: ["alice", "bob"],
});

console.log("Open in browser:", server.url);
// → http://127.0.0.1:43210

// Cleanup when done
await server.close();
```

## Custom network config

The host routes each connection request to the matching network by genesis hash, and the first entry is the default. For public testnets, use the built-in network configs:

```ts
import { PASEO_ASSET_HUB, PREVIEWNET } from "@parity/host-api-test-sdk";

const server = await createTestHostServer({
  productUrl: "http://localhost:3000",
  networks: [PASEO_ASSET_HUB, PREVIEWNET],
});
```

For local networks where the genesis hash changes on each restart, construct a `NetworkConfig` directly:

```ts
import { createTestHostServer } from "@parity/host-api-test-sdk";
import type { NetworkConfig } from "@parity/host-api-test-sdk";

const network: NetworkConfig = {
  id: "local-asset-hub",
  name: "Local Asset Hub",
  genesisHash: process.env.GENESIS_HASH as `0x${string}`,
  rpcUrl: "ws://127.0.0.1:9944",
  tokenSymbol: "WND",
  tokenDecimals: 12,
  chain: "AssetHub", // optional protocol role, reported via supportedChains()
};

const server = await createTestHostServer({
  productUrl: "http://localhost:3000",
  networks: [network],
});
```

A network with no `chain` is still routable by genesis hash; it is simply left out of `supportedChains()` rather than labelled by guesswork.

`chain` is not only a label. The core reaches two chains on its own account, and picks them by the genesis hash the host declared at boot rather than by anything `supportedChains()` reports:

| Role | What the core uses it for | Without it |
|------|---------------------------|------------|
| `'Bulletin'` | `preimage.submit()` | Every submit fails: `bulletin chain unavailable … no chain configured for genesis 0x0000…` |
| `'AssetHub'` | dotNS lookups — product manifests, and the `trustedProducts` grants that carry cross-product access | Every grant not already cached is refused, indistinguishably from the other product having granted nothing |

So a test that exercises preimage submission needs a network with `chain: 'Bulletin'`, and one that exercises cross-product grants needs `chain: 'AssetHub'`. Both talk to the real `rpcUrl`.

**Signing never touches a network.** The People chain is served in-page by a loopback statement store, which is what carries the SSO signing round trip. Only a product's own chain calls go out to `rpcUrl`, so a test that never reads chain state runs fully offline.

## Permission testing

The test host auto-approves all permission requests by default. You can change this per test to verify your product handles rejections correctly:

```ts
test("handles permission rejection", async ({ testHost }) => {
  // Reject all permission requests
  await testHost.setPermissionBehavior("reject-all");

  const frame = testHost.productFrame();
  await frame.getByRole("button", { name: "Connect external" }).click();

  // Product should show an error or fallback UI
  await expect(frame.getByText("Permission denied")).toBeVisible();

  // Verify the request was made and rejected
  const log = await testHost.getPermissionLog();
  expect(log).toHaveLength(1);
  expect(log[0].tag).toBe("Remote");
  expect(log[0].approved).toBe(false);
});

test("selective permissions", async ({ page, testHost }) => {
  // The fixture's setters take a named mode only. A function has to be
  // installed in the page, where it can actually be called.
  await page.evaluate(() =>
    window.__TEST_HOST__.setPermissionBehavior(
      (request) => request.tag === "ChainSubmit",
    ),
  );

  // ... test product behavior ...
});
```

Without the Playwright fixture, use `page.evaluate` directly:

```ts
await page.evaluate(() =>
  window.__TEST_HOST__.setPermissionBehavior("reject-all")
);

const log = await page.evaluate(() =>
  window.__TEST_HOST__.getPermissionLog()
);
```

### What `permissionLog` records (and what it doesn't)

The permission log is narrower than the name suggests. It records the two prompts the host is actually asked to answer — **remote permission requests** (`RemotePermission`, one entry per request, with its `tag` and `value`) and **device permission requests** (`Camera`, `Microphone`, `Location`, `Bluetooth`, recorded under the request name with `value: undefined`). A granted device permission also updates the iframe's `allow` attribute, matching how a real host delegates browser-level access.

It does **not** record:

- **Signing requests.** Signing is not gated behind a permission here, deliberately: real hosts do not gate it either. A signing request leaves for the paired signer over the SSO channel and comes back as a signature. Use `getSigningLog()` as the oracle for "did signing happen".
- **Transaction broadcast denials.** `ChainSubmit` is enforced by the core itself, at `transaction_broadcast`, after signing. It never reaches the host's permission callback, so it never lands in `permissionLog`. The oracle for "broadcast was denied" is whatever error your product surfaces.

A typical flow:

```
product → requestRemotePermission(ChainSubmit) → host callback → permissionLog ✅
product → signing.signRaw(...)                 → SSO round trip → signingLog   ✅
product → submit signed bytes                   → the core's broadcast gate     ❌ invisible
```

## How it works

```
Playwright test
  → createTestHostServer() starts a Node HTTP server
  → it serves an HTML shell plus dist/host/: the two entry chunks
    (host-runtime.js, worker-runtime.js), the shared chunks esbuild splits out,
    the two wasm-glue chunks and the two .wasm payloads — eight files in all
  → the page starts the TrUAPI core in a Web Worker (Rust → WebAssembly)
  → the page mints an SSO session for the selected dev account and activates it
  → the page creates an <iframe src="productUrl"> and answers the product's
    truapi-ready handshake with a transferred MessagePort

Product (in iframe, @parity/truapi/sandbox)
  → posts truapi-ready, receives truapi-init with the port, speaks the protocol
  → account.getAccount(productAccountId) → the core derives the address from the
    product subtree the host reported
  → signing.signRaw / createTransaction → the core sends an encrypted request
    over the People statement store → the in-page responder signs with the dev
    key → the signature comes back the same way
```

The People chain is a **loopback statement store inside the page**: no node, no network, no Docker. That is what makes auto-signing possible without a wallet, and it is also why the assets above are all a consumer needs — they are pre-built and shipped, so there are zero build-time dependencies for you. A boot fetches six of the eight; the JSON-RPC provider's glue and `.wasm` are loaded only when a test actually opens one of the configured networks, so a signing-only run never downloads them.

## API reference

### Fixture API (`@parity/host-api-test-sdk/playwright`)

| Method | Description |
|--------|-------------|
| `testHost.page` | The host page (contains the iframe) |
| `testHost.productFrame()` | Playwright `FrameLocator` for the product iframe |
| `testHost.waitForConnection(timeout?)` | Wait until the product's first wire frame reaches the host |
| `testHost.getConnectionStatus()` | Product connection: `'disconnected'` until that first frame, then `'connected'` |
| `testHost.getChainStatus()` | The host's own session: `'connecting'`, `'connected'`, or `'disconnected'` |
| `testHost.switchAccount(name)` | Re-mint the session under one account from the roster (the iframe is **not** reloaded) |
| `testHost.setAccounts(names)` | Replace the roster; the first name becomes the active identity |
| `testHost.getSigningLog()` | All auto-signed requests since last clear |
| `testHost.clearSigningLog()` | Reset the signing log |
| `testHost.setPermissionBehavior(behavior)` | `'approve-all'` or `'reject-all'`; the `(request) => boolean` form works in-page only |
| `testHost.grantPermission(tag)` / `revokePermission(tag)` / `getGrantedPermissions()` | Pre-grant, revoke, inspect |
| `testHost.getPermissionLog()` / `clearPermissionLog()` | Permission requests and outcomes |
| `testHost.getNavigationLog()` / `clearNavigationLog()` | `navigateTo` attempts from the product |
| `testHost.getNotificationLog()` / `clearNotificationLog()` | Push notifications, including scheduled and cancelled ones |
| `testHost.getChatRooms()` / `getChatBots()` / `getChatMessageLog()` / `clearChat()` | Chat state (needs `executionKind: 'Worker'`) |
| `testHost.seedChatRoom(room)` / `seedChatBot(bot)` | Add a room/bot without the product creating it |
| `testHost.injectChatAction(action)` | Deliver an incoming chat action to the product; rejects if it cannot be delivered |
| `testHost.getPreimages()` / `seedPreimage(value)` / `clearPreimages()` | Preimage store |
| `testHost.getTheme()` / `setTheme(theme)` | Host theme (`{ name, variant }`, or the `'light' \| 'dark'` shorthand) |

See [Overriding host conditions](#overriding-host-conditions) for the rest of the ambient-data and decision controls (locale, device-permission status, feature support, supported chains, product storage, user confirmation, navigation, notifications).

Fixture options: `productUrl`, `productId` (see [Product identity](#product-identity)), `accounts`, `networks`, `productAccounts`, `executionKind` (see [Execution kind](#execution-kind)), `initialState`, `behaviors` (see [Overriding host conditions](#overriding-host-conditions)).

Every one of these is also on `window.__TEST_HOST__` inside the host page, synchronously, for tests that do not use the fixture.

### Dev accounts

| Name | URI | SS58 (generic) |
|------|-----|-----------------|
| `alice` | `//Alice` | `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY` |
| `bob` | `//Bob` | `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty` |
| `charlie` | `//Charlie` | `5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y` |
| `dave` | `//Dave` | `5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy` |
| `eve` | `//Eve` | `5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw` |
| `ferdie` | `//Ferdie` | `5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSneWj6JDfPN` |

These are the standard Substrate dev accounts (sr25519, ss58Format=42), and they have not moved across any release. Products may re-encode them to a different SS58 prefix — the host matches by public key.

Both `accounts` and `productAccounts` accept dev account names or custom `{ name, uri }` objects:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  accounts: [
    'bob',
    { name: 'Derived', uri: '//Alice//custom' },
  ],
});
```

`accounts` is a **roster**, not a set of simultaneously active identities:

- The **first** entry is the active identity. The SSO session is minted for it, and it is the only account that signs.
- The rest are **switch targets**. `switchAccount('Derived')` matches a name against the roster case-insensitively and re-mints the session under that entry's own `uri` — which is the only way a custom `{ name, uri }` account can ever sign. A dev name that is not in the roster still works and falls back to the bare derivation, so `switchAccount('charlie')` gives you `//Charlie`.
- `setAccounts([...])` replaces the roster wholesale, first entry active, same resolution rules.

Because the session carries exactly one identity, a legacy-account request naming any *other* account is refused by the core, and `getLegacyAccounts()` answers with an empty list whatever the roster holds.

Each account also carries the **primary username** the core reports through `account.getUserId()`, defaulting to `"<name>.01"` — `alice.01`, `bob.01`. A real host resolves that name from the dotNS contracts on Asset Hub; this one has no reachable Asset Hub in the general case, so it mints the name along with the session. Override it per account when a test asserts on what is displayed:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  accounts: [{ name: 'Alice', uri: '//Alice', username: 'zaphod.07' }],
});
```

The username follows the active identity, so `switchAccount('bob')` moves `getUserId()` to `bob.01`.

> [!IMPORTANT]
> **`uri` is a path of hard junctions, not a full polkadot-js SURI.** The host derives keys in-page with `@scure/sr25519`: the string is split on `//` and every segment becomes one hard-junction **label**, verbatim. Nothing else is interpreted. So `'//Alice'` and `'//Alice//custom'` work; a `/` inside a segment (`'//Alice//custom/0'`) is part of that junction's label and will not produce the address polkadot-js would; and a mnemonic or hex seed is not read as a seed at all — it becomes a junction label, and since a label is capped at 31 bytes, a real mnemonic or a `0x`-prefixed 32-byte seed throws on that limit. A *short* hex string does not throw: it silently derives a real but unintended account. Pass neither.

### Product accounts

In production a product gets its own keypairs, derived from the account holder's key rather than shared with it. The core does that derivation itself: it asks the host **once** for the product's hard subtree and then derives every indexed account from it as a soft junction, `index_bytes(n)`. The host's whole say in the matter is which keypair that subtree is.

By default the subtree is `//Selected//dotnsId` under the selected account, so `getAccount("myapp.dot", 0)` for `accounts: ['bob']` lands on the soft child of `//Bob//myapp.dot`.

Use `productAccounts` to point a product's subtree somewhere else — a funded account, say. Keys are **bare product identifiers**:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  accounts: ['bob'],
  productAccounts: {
    'myapp.dot': 'charlie',                              // subtree → //Charlie
    'other.dot': { name: 'Custom', uri: '//My//Custom' },
  },
});
```

Unmapped products fall back to the default subtree. Because the entry replaces the subtree, it moves **all** of that product's indexed accounts together — index 0, index 5 and a `Raw` selector alike.

> [!WARNING]
> **Per-index keys are gone.** `productAccounts: { 'myapp.dot/0': 'bob' }` threw away half the story — the core never asks the host about index `0`, so such a key could not move the address — and it is now rejected with an error naming the replacement. Use the bare product id. See [Migrating to 0.13](#migrating-from-012x-to-0130).

### Product identity

The host declares your product to the core under a dotNS identifier, `productId`, which defaults to `test-product.dot`. The core checks it on every call that acts *as* a product account: `signRaw`, `signPayload` and `createTransaction` refuse a `dotNsIdentifier` naming another product with `PermissionDenied`, and `statementStore.createProofAuthorized` refuses it with `UnknownAccount`. So if your product signs as `myapp.dot`, say so:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  productId: 'myapp.dot',
});
```

`productId` is also the key `productAccounts` is looked up by, and the namespace the core scopes product storage and permissions to.

### Execution kind

The core decides what a connection may reach from the trusted *kind* of executable the host declares, and Chat is the one gated surface: every Chat entry point is denied unless the kind is `Worker`. This host declares `'App'` by default, because that is what an iframe-embedded product is. A test that drives chat must ask for `'Worker'`:

```ts
createTestHostFixture({
  productUrl: 'http://localhost:3000',
  executionKind: 'Worker', // 'App' (default) | 'Widget' | 'Worker'
});
```

The same option is accepted by `createTestHostServer`, and the type is exported as `ProductExecutionKind`. Leave it at the default unless you are testing chat.

A chat `icon` is validated by the core, not passed through: it must be empty, an `https` URL, or an inline `data:` image of an allowed media type. Anything else is refused with *"icon carries a scheme that cannot be rendered"*.

### Theme control

The host delivers the theme subscription as a `{ name, variant }` struct. `setTheme('light' | 'dark')` is a shorthand that maps to `{ name: { tag: 'Default', value: undefined }, variant: 'Light' | 'Dark' }`; pass the full struct to exercise custom-named theme branches:

```ts
await testHost.setTheme('dark'); // shorthand → Default / Dark
await testHost.setTheme({
  name: { tag: 'Custom', value: 'midnight' },
  variant: 'Dark',
});

const theme = await testHost.getTheme();
// theme.variant: 'Light' | 'Dark'
// theme.name.tag: 'Default' | 'Custom'
```

The same value can be set at boot instead, via `initialState.theme` — see [Overriding host conditions](#overriding-host-conditions).

### Overriding host conditions

Theme, above, is one instance of a general pattern: every ambient condition the host reports, and every decision the host makes on the product's behalf, can be overridden from a test — live, through `window.__TEST_HOST__` / the fixture, or up front, via the `initialState` and `behaviors` options on `createTestHostFixture` / `createTestHostServer`.

Two families cover the whole surface:

- **Ambient data** — what the host reports. `get<Thing>()` reads it, `set<Thing>()` / `seed<Thing>()` writes it, `clear<Thing>()` resets it.
- **Decisions** — how the host answers a request the product makes. `set<Thing>Behavior(b)` picks the policy — `'approve-all'` (default) or `'reject-all'`, or, in-page only, a function `(request) => boolean`. `get<Thing>Log()` / `clear<Thing>Log()` inspect what was asked and how it was answered.

| Member | Family | Description |
|--------|--------|-------------|
| `setDevicePermissionStatus(type, status)` / `getDevicePermissionStatuses()` | data | Force the OS status `permissionStatus.devicePermissionStatus` reports for one `HostDevicePermissionRequest` (`'Granted' \| 'Denied' \| 'NotDetermined' \| 'NotApplicable'`); `undefined` restores the default |
| `seedChatRoom(room)` / `seedChatBot(bot)` | data | Add a chat room/bot without the product creating it; live subscribers are notified (needs `executionKind: 'Worker'`) |
| `getLocale()` / `setLocale(languageTag)` | data | The BCP 47 tag the host reports to products |
| `setFeatureSupport(feature, supported)` / `getFeatureSupport()` | data | Force `featureSupported` for one feature tag; `undefined` restores the derived answer |
| `setSupportedChains(chains)` / `getSupportedChains()` | data | Replace the advertised chain set (`ChainEntry[]`); `undefined` restores the one derived from `networks`, which the getter also reports |
| `seedProductStorage(key, value)` / `getProductStorage()` / `clearProductStorage()` | data | Pre-populate, read, or wipe product-storage entries (see limitation below) |
| `setUserConfirmationBehavior(b)` / `getUserConfirmationLog()` / `clearUserConfirmationLog()` | decision | How the host answers `confirmUserAction` |
| `setNavigationBehavior(b)` | decision | How the host answers `navigateTo` (log: `getNavigationLog()` / `clearNavigationLog()`, above) |
| `setNotificationBehavior(b)` | decision | How the host answers `pushNotification`; the function form sees `{ text, deeplink, scheduledAt }` (log: `getNotificationLog()` / `clearNotificationLog()`, above) |

`initialState` and `behaviors` apply the same data and decisions before the product's first frame:

```ts
const { testHost } = createTestHostFixture({
  productUrl: "http://localhost:3000",
  initialState: {
    locale: "pt-BR",
    theme: "dark",
    devicePermissionStatuses: { Camera: "Denied" },
    features: { Chain: false },
    supportedChains: [{ identifier: "AssetHub", genesisHash: "0x23e7..." }],
    // Granted without the product asking, as `grantPermission(tag)` would.
    grantedPermissions: ["ChainSubmit"],
    productStorage: { "some-key-getProductStorage-reported": "value" },
  },
  behaviors: {
    userConfirmation: "reject-all",
  },
});
```

Two limitations worth knowing:

- **`seedProductStorage` only replays a key `getProductStorage()` has reported.** The core namespaces product-storage keys per product, so a key is always round-tripped, never hand-constructed — seeding a key the product has never written is not supported. `initialState.productStorage` carries the same restriction.
- **A function-form behavior cannot cross `page.evaluate`.** `setUserConfirmationBehavior` / `setNavigationBehavior` / `setNotificationBehavior` on the fixture, and the `behaviors` boot option, accept only `'approve-all' | 'reject-all'` — the `FixtureBehavior` type. The function form — `(request) => boolean`, the third arm of `Behavior<Req>` — works only in-page, via `window.__TEST_HOST__`.

### Built-in networks

| Network | Export |
|-------|--------|
| Paseo Asset Hub | `PASEO_ASSET_HUB` |
| Previewnet | `PREVIEWNET` |
| Previewnet Asset Hub | `PREVIEWNET_ASSET_HUB` |

### Account switching

`switchAccount` / `setAccounts` re-mint the host's SSO session under the new account and replace the product's core connection underneath it. The **iframe is not reloaded**: its `MessagePort` is transferred exactly once at load and cannot be handed over again, so the product keeps running and is not told. Reload the page yourself if a test needs the product to re-initialise, and wait for `getChainStatus() === 'connected'` before expecting a signature — a switch that leaves it `'disconnected'` means no signature will come back.

## Contributing

Contributions are welcome! Please open an issue first if you want to discuss a larger change.

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 10

### Development

```bash
pnpm install

# Build everything (browser assets + TypeScript + CJS bundles)
pnpm run build

# Unit tests
pnpm run test:unit

# ESM + CJS export verification
pnpm test

# Playwright E2E against a real product in an iframe
pnpm run test:integration

# Typecheck without emitting (two projects: Node side and browser side)
pnpm run typecheck
```

### Project structure

```
src/
├── index.ts                  # Package entry point
├── types.ts                  # Published type definitions
├── server.ts                 # Node HTTP server (serves the page and dist/host/)
├── accounts.ts               # Dev account definitions
├── networks.ts               # Built-in network configs
├── host-page.ts              # HTML shell generation
├── browser/                  # Everything that runs in the page (bundled by esbuild)
│   ├── host-runtime.ts       #   boot: worker, session, iframe, control API
│   ├── host-worker.ts        #   the core's Web Worker entry
│   ├── control-api.ts        #   window.__TEST_HOST__
│   ├── dev-accounts.ts       #   in-page sr25519 derivation
│   ├── product-accounts.ts   #   product subtree + soft index derivation
│   ├── loopback-chain.ts     #   the in-page People statement store
│   ├── callbacks/            #   host callbacks the core calls
│   ├── signing/              #   extrinsic assembly and raw signing
│   └── sso/                  #   the paired-signer half of the SSO session
└── playwright/
    ├── index.ts              # Playwright entry point
    └── fixture.ts            # Playwright test fixture
```

The build produces three kinds of output:

1. **Browser assets** (`dist/host/`) — ESM chunks built with esbuild, plus the two `.wasm` payloads, served by the test host's own HTTP server
2. **ESM modules** (`dist/*.js`) — the Node-side API compiled with `tsc`
3. **CJS bundles** (`dist/index.cjs`, `dist/playwright.cjs`) — the same API for CommonJS consumers

## Migrating from 0.13.0 to 0.13.1

Nothing to change; three things start working that previously could not.

- **`account.getUserId()` answers.** It used to fail with `No primary username for this session` for every product, because the host minted a session with no username and the core only resolves one from Asset Hub. Sessions now carry `"<name>.01"`, overridable per account with `accounts[].username`.
- **`productId` is configurable.** Previously fixed at `test-product.dot`, which meant a product signing under its own dotNS identifier got `PermissionDenied` from every product-account call. Set `productId` to whatever your product signs as.
- **A `chain: 'Bulletin'` or `chain: 'AssetHub'` network now reaches the core.** Those two roles were declared to the core as absent whatever you configured, so `preimage.submit()` could never connect. Configuring such a network now makes the core use its `rpcUrl` — which is real network traffic, where before it failed instantly.

## Migrating from 0.12.x to 0.13.0

0.13 replaces the whole upstream stack. See the [CHANGELOG](./CHANGELOG.md) for the full list; the parts that touch test code are:

- **Your product must be on `@parity/truapi` `0.17` and boot through `@parity/truapi/sandbox`.** There is no `@novasamatech/host-container` protocol any more, so both sides move together.
- **`productAccounts` keys are bare product ids.** `'myapp.dot/0': 'bob'` → `'myapp.dot': 'bob'`, and it now moves every index of that product. A per-index key throws.
- **Product-account addresses moved**, because the core derives them now (a soft junction over the product subtree) rather than asking the host. Root dev accounts — `//Alice` and friends — are unchanged. If a test pins a product-account address, re-read it from the host.
- **Removed controls**: `getSubmittedStatements`, `injectStatement`, `clearStatements`, `setLoginBehavior`, `getIsAuthenticated`, `simulateDisconnect`, `simulateReconnect`, `setPaymentBalance`, `getPaymentLog`, `clearPaymentLog`, `setPaymentTopUpBehavior`, `simulatePaymentStatus`, `setEnforcePermissions`. The removed types are `LoginBehavior`, `PaymentLogEntry`, `PaymentTopUpBehavior` and `StatementSubmissionLogEntry`.
- **`injectChatAction` is now async** and takes the protocol's own action type (`ChatActionInput`); `await` it.
- **Chat needs `executionKind: 'Worker'`.**

## Migrating from 0.1.x to 0.2.x

The env file utilities (`loadChainFromEnv`, `parseEnvFile`, `loadEnvFiles`) have been removed. If you used them, construct a `NetworkConfig` directly:

```diff
-import { createTestHostServer, loadChainFromEnv } from "@parity/host-api-test-sdk";
-const chain = loadChainFromEnv({ envFiles: [".env.local"], ... });
+import { createTestHostServer } from "@parity/host-api-test-sdk";
+import type { NetworkConfig } from "@parity/host-api-test-sdk";
+const network: NetworkConfig = {
+  id: "local-asset-hub",
+  name: "Local Asset Hub",
+  genesisHash: process.env.GENESIS_HASH as `0x${string}`,
+  rpcUrl: "ws://127.0.0.1:9944",
+  tokenSymbol: "WND",
+  tokenDecimals: 12,
+};
```

If you only used built-in networks (`PASEO_ASSET_HUB`, etc.) and `createTestHostFixture` — no changes needed.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit: https://parity.io/bug-bounty

## License

[MIT](./LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
