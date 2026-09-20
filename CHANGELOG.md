# Changelog

## 0.14.0

Three parts of the host were declared to the core as absent and could not be
configured otherwise, so three product-facing features were dead on arrival in
0.13.0. Each is now wired, and each has a test that fails without it.

### Fixed

- **`account.getUserId()` failed for every product** with `Unknown: No primary username for this session`. The host minted its SSO session with both username fields empty, on the assumption that the core resolves them itself. It does — but only from the dotNS contracts on Asset Hub, and it gives up at once when the host declares no Asset Hub, which this one did. The session now carries a username: `"<name>.01"` for the active account (`alice.01`, `bob.01`), following `switchAccount`.
- **A `chain: 'Bulletin'` network never reached the core**, so `preimage.submit()` could not work at all: the core asked the host to connect to the all-zero genesis and got `bulletin chain unavailable: … no chain configured for genesis 0x0000…`. The core routes its own Bulletin and Asset Hub traffic by the genesis hashes it was handed at boot, not by anything `supportedChains()` reports, and the host was hard-coding both to all-zero. They now come from whichever configured network declares that `chain` role. Preimage *lookup* was unaffected and still is.
- **The product's dotNS identifier was fixed at `test-product.dot`.** The core refuses any call acting as a product account whose `dotNsIdentifier` is not the id the host declared the product under — `signRaw`, `signPayload` and `createTransaction` with `PermissionDenied`, `statementStore.createProofAuthorized` with `UnknownAccount`. A real product signing under its own name therefore got a blanket `PermissionDenied` with nothing in any log to explain it, and no option existed to change the id. See `productId` below.

### Added

- **`productId` on `createTestHostServer` and the Playwright fixture** (default `'test-product.dot'`). The dotNS identifier the host declares the product under: the id product-account calls must name, the key `productAccounts` is looked up by, and the namespace the core scopes product storage and permissions to.
- **`accounts[].username`** on the custom-account form, overriding the derived `"<name>.01"`. This is what `account.getUserId()` reports while that account is the active identity.

### Changed

- **Configuring a network with `chain: 'AssetHub'` now has an effect on the core**, where before it was declared absent. The core reads dotNS from it — product manifests, and the `trustedProducts` grants that carry cross-product access — so a grant that used to be refused instantly now costs a real round trip to that network's `rpcUrl`. Unchanged for a network with no `chain` role, and unchanged for every other kind of test: signing is still the in-page People loopback, with no network at all.

### Downstream

- `../host-playground` pinned `0.12.1`. 0.13.0's migration notes apply first; this release adds `productId`, which that suite needs if its product signs under anything but `test-product.dot`.

## 0.13.0

A rewrite of everything below the public API: the host no longer speaks the
`@novasamatech/host-container` protocol, it **runs the TrUAPI core itself** —
`truapi-server` compiled to WebAssembly, in a Web Worker. Both sides of the
wire move together, so a product must be on `@parity/truapi` 0.17 and boot
through `@parity/truapi/sandbox`.

### Breaking changes

- **Upstream stack replaced.** Every `@novasamatech/*` dependency is gone: `host-api`, `host-container` and `host-api-wrapper` are no longer installed, imported or bundled. In their place: `@parity/truapi` `0.17.0` (a real runtime dependency, because the published type declarations name its chat types), plus `@parity/truapi-host` `0.17.0` and `@parity/truapi-provider` `0.2.0`. A product on the old protocol, or on an earlier truapi minor, will not connect at all.
- **Signing is an SSO round trip, not a synchronous host callback.** The core never signs. It encrypts each signing request to its paired signer and publishes it as a statement on the People chain; the host answers as that peer. To keep "no network" true, the People chain is an **in-page loopback statement store** — no node, no Docker, no RPC — and the host mints both halves of the session at boot. Tests that awaited a signature already work; tests that read `getSigningLog()` immediately after triggering an action must now await the product's own promise first.
- **Product-account addresses moved, and `productAccounts` is keyed by the bare product id.** The core stopped asking the host for an indexed product account. It asks once for the product's hard subtree (`ProductSubtreeRequest`) and derives every account from it itself, as one soft junction — `derive_product_public_key(subtree, index_bytes(n))` (`truapi-server/src/host_logic/product_account.rs`). The host's only remaining lever is which keypair the subtree is, so:
  - `productAccounts: { 'myapp.dot/0': 'bob' }` → `productAccounts: { 'myapp.dot': 'bob' }`. A per-index key is now **rejected with an error** naming the replacement, rather than silently ignored.
  - An entry moves every indexed account of that product together, `Raw` selectors included.
  - Unmapped, the subtree is still `//Selected//dotnsId`, but index `n` under it is now the soft child at `index_bytes(n)` rather than the hard junction `//Selected//dotnsId/n`. **Any test pinning a product-account address must re-read it.** Root dev accounts are untouched: `//Alice` is still `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`.
- **Removed controls.** Each of these is gone from `TestHostAPI`, `window.__TEST_HOST__` and the Playwright fixture — grep your tests for them:
  - statement store: `getSubmittedStatements`, `injectStatement`, `clearStatements`
  - login: `setLoginBehavior`, `getIsAuthenticated`, `simulateDisconnect`, `simulateReconnect`
  - payments: `setPaymentBalance`, `getPaymentLog`, `clearPaymentLog`, `setPaymentTopUpBehavior`, `simulatePaymentStatus`
  - permissions: `setEnforcePermissions`
- **Removed types.** `LoginBehavior`, `PaymentLogEntry`, `PaymentTopUpBehavior`, `StatementSubmissionLogEntry` are no longer exported from the package root.
- **`injectChatAction` is async and typed by the protocol.** It takes `ChatActionInput` (the core's own `HostChatActionSubscribeItem`) instead of `{ roomId, peer, payload }`, and returns a promise that rejects if the action cannot be delivered. `await` it.
- **`accounts[].uri` accepts only hard junctions.** Keys are derived in-page with `@scure/sr25519`; there is no keyring. The string is split on `//` and each segment becomes one hard-junction *label*, verbatim: `'//Alice'` and `'//Alice//custom'` work, and `'//Alice//custom/0'` treats `custom/0` as one label rather than a polkadot-js soft junction. A mnemonic or a hex seed is not read as a seed either — it becomes a label, and a label is capped at 31 bytes, so a real mnemonic or a `0x`-prefixed 32-byte seed throws on that cap. A *short* hex string does not throw; it silently derives a real but unintended account.
- **`accounts` is a roster with exactly one active identity — and it is now honoured.** The first entry is the active signing identity (the SSO session carries one, and only one); the rest are switch targets. What changed: `switchAccount` / `setAccounts` now resolve a name against the configured roster, case-insensitively, instead of always synthesising `//Name` from it. Grep your tests for two assumptions that were never true — passing several accounts never made more than the first one signable, and `getLegacyAccounts()` returns `[]` whatever the roster holds, because the core never enumerates legacy accounts and refuses a legacy request naming anything but the active identity.
- **The browser bundle is no longer one inlined IIFE.** The host page is a shell that loads `dist/host/host-runtime.js`, `dist/host/worker-runtime.js` and two `.wasm` payloads from the same server. `dist/host-bundle.js` no longer exists. Nothing in a consumer's test code refers to these, but a fork that copied the page generation will need updating.
- **`clearChatState` renamed to `clearChat`.** Same behaviour (wipe rooms, bots and the message log; live subscribers are pushed the empty list) — just a shorter name, in line with the new `seedChatRoom` / `seedChatBot` pair.

### Added

- **`executionKind` option on `createTestHostServer` and the Playwright fixture** (`'App' | 'Widget' | 'Worker'`, default `'App'`). The core gates every Chat entry point on the connection's execution kind — `chat_platform_for` denies anything but `Worker` (`truapi-server/src/runtime/chat.rs`) — so a test that drives `chatCreateRoom`, `chatRegisterBot`, `chatPostMessage`, the room subscription or `injectChatAction` must declare `executionKind: 'Worker'`. The default stays `'App'` because that is what an iframe-embedded product genuinely is; declaring every product headless to unlock one modality would misreport what the host runs. `ProductExecutionKind` is exported from the package root.
- **`getChainStatus()`** alongside `getConnectionStatus()`: the host's own session (`'connecting'` → `'connected'`, or `'disconnected'` after a failed account switch) as distinct from the product's connection. Signing travels over the session, so a switch that leaves it `'disconnected'` means no signature will come back.
- **`NetworkConfig.chain`** — a network's protocol role (`'Relay' | 'AssetHub' | 'People' | 'Bulletin'`), reported to products through `supportedChains()`. A network that omits it is left out of that report rather than labelled by guesswork. `ChainIdentifier` is exported from the package root.
- **`ChatActionInput` and `ChatActionPayload`** exported, for building an `injectChatAction` argument.
- **Override the host's ambient data and decisions from a test**, live or at boot. Two families, named consistently: `get<Thing>` / `set<Thing>` / `seed<Thing>` / `clear<Thing>` for ambient data, and `set<Thing>Behavior` (`'approve-all' | 'reject-all'` or, in-page only, a function) plus `get<Thing>Log` / `clear<Thing>Log` for decisions. New members: `setDevicePermissionStatus`, `getDevicePermissionStatuses`, `seedChatRoom`, `seedChatBot`, `getLocale`, `setLocale`, `setUserConfirmationBehavior`, `getUserConfirmationLog`, `clearUserConfirmationLog`, `setNavigationBehavior`, `setNotificationBehavior`, `setFeatureSupport`, `getFeatureSupport`, `setSupportedChains`, `getSupportedChains`, `seedProductStorage`, `getProductStorage`, `clearProductStorage`. The per-key overrides take `undefined` to restore what the host would otherwise report: `setFeatureSupport(feature, undefined)`, `setDevicePermissionStatus(type, undefined)`, `setSupportedChains(undefined)`. New `CreateTestHostOptions` / `TestHostFixtureOptions` members `initialState` (`theme`, `locale`, `features`, `supportedChains`, `devicePermissionStatuses`, `grantedPermissions`, `productStorage`) and `behaviors` apply the same data and decisions before the product's first frame; an unknown status or behaviour mode in either throws at boot, naming the value. New exported types: `Behavior`, `UserConfirmationBehavior`, `UserConfirmationLogEntry`, `NavigationBehavior`, `NotificationBehavior`, `ChainEntry`, `DevicePermissionStatus`, `HostDevicePermissionRequest`, `InitialState`, `InitialBehaviors`; `@parity/host-api-test-sdk/playwright` also exports `FixtureBehavior` — the `'approve-all' | 'reject-all'` narrowing every fixture setter takes — alongside the types its own signatures name. See the README's [Overriding host conditions](./README.md#overriding-host-conditions) for the full table and the two limitations (product-storage keys must be replayed as reported; the function form of a behavior only works in-page, not through the Playwright fixture).

### Fixed

- **`featureSupported` denied the one chain the host always serves.** `supportedChains()` unconditionally advertises the in-page People loopback, but `featureSupported({ tag: 'Chain', ... })` matched only against the configured `networks` — which never contain the People genesis, precisely because that chain is served in-page. A product probing the chain every signature travels over was told `false`. Both answers now come off the same routing truth: the People loopback plus every configured network (a network with no declared `chain` role is still routable and still reported supported; it is only left out of `supportedChains()`).
- **Switching to a custom account signed with the wrong key.** For `accounts: ['alice', { name: 'Derived', uri: '//Alice//custom' }]`, `switchAccount('Derived')` synthesised `//Derived` from the display name and re-minted the session under *that*, silently ignoring the configured URI — so the documented custom-URI account could never actually be switched to. Names now resolve against the roster first, and fall back to the bare dev derivation (`'charlie'` → `//Charlie`) only when the roster does not carry them.
- **An indexed product account was reported under one key and signed for under another.** The core reported `soft(subtree, index_bytes(n))` while the host signed with the hard derivation `//Selected//dotnsId/n`, so a product's own signature did not verify against its own address — and no `productAccounts` entry could reconcile them. The host now derives the signer with the same soft junction the core uses (`@scure/sr25519`'s `HDKD.secretSoft` over the subtree keypair, chain code `index_bytes(n)`; `Raw` selectors pass through unchanged, as `derivation_index_bytes` does). Verified against schnorrkel's own pinned vector, not just against itself: the core's `wire_index_derivation_matches_the_mobile_vector` value is reproduced byte-for-byte in `dev-accounts.spec.ts`. The four `Product account derivation` integration tests now run, and one of them signs and verifies against the address the core reported.
- **`statement_submit` was rejected by the core, which blocked ALL signing.** The in-page loopback statement store replied with the bare JSON string `"new"`. The core reads a *field*: `result.get("status")` must be `"new"` or `"known"` (`truapi-server/src/runtime/statement_store_rpc.rs`), and `.get()` on a JSON string is `None`, so every SSO request died with `statement_submit not accepted: "new"` and no signing request ever reached the responder. The store now replies `{ "status": "new" }`.
- **Statement subscription items were delivered in the wrong envelope.** The store pushed the SCALE statement as a bare hex `result`; the core decodes every item with `parse_new_statements_result`, which requires `{ "event": "newStatements", "data": { "statements": [...], "remaining": n } }` and otherwise fails with `malformed statement-store frame: result is not a newStatements event`. The store now sends that envelope, under the notification method name Substrate uses for this subscription.
- **Topic filters were parsed under the wrong key spelling.** `parseFilter` matched `MatchAll` / `MatchAny`, but the core emits lower-camel `matchAll` / `matchAny`. A real filter therefore parsed as `MatchAll` with an *empty* topic list — which matches every statement — and a `matchAny` filter was silently narrowed to `matchAll`. Both spellings are now honoured, `matchAny` is probed first so it can never be narrowed, and an unreadable filter still subscribes to everything rather than to nothing.
- **The AutoSigning capability was refused as an invalid subtree secret.** schnorrkel has two 64-byte secret encodings, and `@scure/sr25519` hands out the cofactor-multiplied (ed25519-shifted) one, which `SecretKey::from_bytes` rejects on its canonicity check. `validate_auto_signing_key` (`truapi-server/src/runtime/pairing_host.rs`) and `derive_product_keypair_from_subtree_secret` accept only the canonical form — unlike `Sr25519Signer::from_secret_bytes`, which falls back. Every raw secret this host hands the core (the AutoSigning `productRootPrivateKey` and both allowance `slotAccountKey`s) is now converted with the new `canonicalSecretKey`. Both encodings name the same scalar, so no key and no signature moves.

### Internal

- **CI runs the unit suite.** `pnpm run test:unit` was in the README's contributor workflow but in no workflow file, so every unit test sat outside every gate — including the drift guards this migration's design names as its main mitigation (the 456-byte session-blob length pin, the non-circular 24-variant wire-index test, the schnorrkel cross-implementation vector) and the loopback envelope/filter regressions. It now runs first in `build-and-test`, ahead of the build, because it needs neither a build nor a browser.
- **The People chain route now owns its response stream.** It hands out one iterator per connection instead of minting a fresh one per `responses()` call over shared buffers — two loops would have raced each other for frames — and it unsubscribes from the loopback store when the consumer stops pulling, not only on an explicit `close()`. The configured-network route already did both.
- **A reply that will not encode can no longer hang the core.** The SSO responder encoded its replies *after* publishing the transport ack and outside every `try`, and the loopback store swallowed the resulting throw with its submit-listener isolation: a mis-shaped success payload dropped the reply entirely, leaving the core waiting forever with nothing on the console. Encoding is part of building a reply now, and a payload that will not encode degrades to a failure reply. The store also logs a throwing submit listener or subscriber instead of swallowing it silently.
- Dead code and stale comments cleared: a third, unreferenced copy of the dev-account URI table; a `productAccounts` field comment still describing the `"dotnsId/index"` keys the code now rejects with an error; a Playwright fixture comment claiming an iframe reload that deliberately never happens, together with the tautological wait beside it; and the planning-document references that had leaked into shipped source comments.
- `THIRD_PARTY_NOTICES.md` rewritten against what `pnpm pack` actually ships. Note the licence change it records: `truapi_provider_bg.wasm` links `smoldot` / `smoldot-light`, **GPL-3.0-or-later WITH Classpath-exception-2.0**, so the shipped tree is no longer free of copyleft as earlier releases claimed. Everything else remains MIT or Apache-2.0.
- Unit coverage grew from 114 to 137 tests; the integration suite runs 49 with none skipped.

### Downstream

- **`../host-playground` pins `@parity/host-api-test-sdk` at `0.12.1`** and uses the old product bootstrap. It needs its own update against 0.13.0 — at minimum the truapi 0.17 sandbox bootstrap, the `productAccounts` key change, and any assertion that pins a product-account address.

## 0.12.1

### Fixed

- **All three built-in network genesis hashes refreshed after chain resets.** `PASEO_ASSET_HUB`, `PREVIEWNET`, and `PREVIEWNET_ASSET_HUB` all pinned genesis values from earlier deployments of those chains. Each was verified dead against live RPC via `chain_getBlockHash(0)`:

  | Constant | Was | Now |
  |---|---|---|
  | `PASEO_ASSET_HUB` | `0xbf0488…ef19f` | `0x23e730eb1c6fecae09c917439a5038cb6122d0d48980e8b9bbf0ff56f94a2ca6` |
  | `PREVIEWNET` | `0x477dd8…12525` | `0x8c27ddf678c2ae9bef0efebfc485a9309f3d735c6d3fbb8d947afc3ace0e80f4` |
  | `PREVIEWNET_ASSET_HUB` | `0x860d75…c7867c` | `0x4d11c803cc6921429e3876638977ad006ea1bba8cd3976a0bca2f164e7026210` |

### Internal

- The chain-feature integration test now reads the expected genesis from `PASEO_ASSET_HUB.genesisHash` instead of repeating the literal, so the next reset is a one-line change in `src/networks.ts`.

## 0.12.0

### Breaking changes

- **Upstream `@novasamatech/*` → `^0.9.1`; the wire is incompatible with `0.8.x`.** A product on `@novasamatech/host-api-wrapper@^0.8.x` will no longer talk to this test host, and vice versa. Upgrade both sides in lockstep, the same way 0.9.0 required. The break is RFC-0022: `DerivationIndex` — the selector identifying an account inside a product's subtree — changed from a bare `u32` to `Enum{Index(u32), Raw([u8; 32])}`, one extra tag byte on every request carrying a product account.
- **`ProductAccount` no longer carries `name`.** `handleAccountGet` used to return `{ publicKey, name }`, but the protocol struct only has `publicKey`, so the encoder dropped the name and it was never on the wire. The field is gone from the response; `productAccounts: { "myapp.dot/0": { name, uri } }` still accepts `name`, it just documents the mapping rather than reaching the product.
- **`handleAccountGetAlias` now rejects with `GetAliasErr`, not `RequestCredentialsErr`.** Upstream split the alias errors out into their own enum, with `RingNotFound` / `NotMember` / `Rejected` / `Unknown`. An unsigned host (`accounts: []`) now answers unmapped alias requests with `GetAliasErr.Unknown`.

### Changed

- **`@parity/truapi` → `^0.6.0`** for the truapi-product integration coverage, matching what [product-sdk 0.20.0](https://github.com/paritytech/product-sdk/pull/271) ships. truapi 0.6 encodes the selector tag as `Left`/`Right` where `@novasamatech/host-api` decodes it as `Index`/`Raw` — different names, identical SCALE wire, so both connect to the same container.
- **Product-account resolution accepts either selector form.** `Index(n)` resolves exactly as the plain `n` did before, so `productAccounts` keys (`"myapp.dot/0"`) and derived addresses (`//Bob//myapp.dot/0`) are **unchanged** — no test that asserts an address needs updating. `Raw(bytes)`, previously inexpressible, is keyed and derived by its hex. Products calling through `host-api-wrapper` need no code change either: it takes the ergonomic `AccountSelector` (`number | Uint8Array`) and normalises internally. Only code that builds protocol requests by hand has to wrap its index in `derivationIndexOf()`.
- **`handleAccountGetAlias` request shape.** Now `[ProductProofContext, RingLocation]` instead of a bare `ProductAccountId`. The context is `[productId, suffix]` — structurally the same as a product account id, and the identity mapping on it — so the account a request resolves to is unchanged. `RingLocation` also changed (`{ genesisHash, ringRootHash, hints }` → `{ chainId, junctions }`); this host ignores it.
- **`handleAccountCreateProof` response shape.** Now `{ proof, contextualAlias: { context, alias }, ringIndex, ringRevision }` instead of bare proof bytes. It remains a deterministic stand-in — an sr25519 signature over the message rather than a real ring VRF, as before — with `contextualAlias` matching what `handleAccountGetAlias` returns for the same account, and `ringIndex` / `ringRevision` fixed at `0`.
- **`AllocatableResource.SmartContractAllowance` carries a selector**, so `requestResourceAllocation([{ tag: 'SmartContractAllowance', value: 0 }])` becomes `value: { tag: 'Index', value: 0 }`.

## 0.11.0

### Added

- **`@parity/truapi` 0.4 product support (MessagePort handoff).** Products built on `@parity/truapi` ≥ 0.4 boot through `@parity/truapi/sandbox`: the iframe posts `{ type: "truapi-ready" }` to the parent window and waits (20s) for a `{ type: "truapi-init" }` answer carrying a transferred `MessagePort`, then runs all protocol traffic over that port — it never listens on direct window postMessage. The host page now answers that handshake with a fresh port pair on every product page load and routes wire frames to whichever channel the product opened. Products on the 0.3 bootstrap (`@novasamatech/host-api-wrapper`) continue to use the direct window postMessage channel; both kinds connect to the same container, and `waitForConnection()` and all handlers work unchanged. Wire frames are identical on both channels, so no codec changes were needed.

### Internal

- `src/browser/truapi-port-handoff.ts`: `createDualChannelIframeProvider({ iframe, url })` builds on the container's `createIframeProvider`, answering `truapi-ready` and swapping the port pair per page load (device-permission and deep-link reloads each re-handshake).
- `test/truapi-product.spec.ts` + `test/test-product-truapi.ts`: integration coverage with a real `@parity/truapi@0.4` product bundle — asserts `getConnectionStatus()` turns `connected` and serves a localStorage roundtrip and product-account fetch over the port. `@parity/truapi` added as a devDependency.

## 0.10.0

### Breaking changes

- **The `chain` host option is replaced by `networks`, an array.** `createTestHostServer` / `createTestHostFixture` now take `networks: NetworkConfig[]` instead of `chain: ChainConfig`. The host routes each connection request to the matching network by genesis hash, and the first entry is the default. Migration: wrap your existing value — `chain: PASEO_ASSET_HUB` → `networks: [PASEO_ASSET_HUB]`. The option is optional and still defaults to `[PASEO_ASSET_HUB]`.
- **`ChainConfig` renamed to `NetworkConfig`.** The shape is unchanged (`id`, `name`, `genesisHash`, `rpcUrl`, `tokenSymbol`, `tokenDecimals`); only the type name changed. Update type imports accordingly.

### Added

- **Multi-network routing.** The host can now be configured with several networks at once and serves a per-genesis WebSocket provider on demand, so a product that switches genesis mid-session connects to the right RPC instead of being rejected. Unknown genesis hashes are reported as `Unsupported chain requested` against the full routable list.

### Internal

- Renamed `src/chains.ts` to `src/networks.ts` and updated all imports/exports.
- Removed decorative section-separator comment banners from `host-runtime.ts` and `types.ts`.

## 0.9.2

### Changed

- **Upstream `@novasamatech/*` → `^0.8.8`**. Tracks 0.8.7 ([triangle-js-sdks release/0.8.7](https://github.com/paritytech/triangle-js-sdks/pull/216)) and 0.8.8 ([release/0.8.8](https://github.com/paritytech/triangle-js-sdks/pull/219)). The diff against 0.8.6 in `host-api`, `host-container`, and `host-api-wrapper` is LICENSE files and version bumps only — no source changes. The 0.8.7 statement-store rework (priority epoch, expiry retries, AccountFull handling) and the 0.8.8 legacy sign requests both live in `host-papp` (the SSO peer / authorising-device path), which this SDK does not simulate. No handler surface changes; no test changes beyond re-running the suite.

## 0.9.1

### Changed

- **Upstream `@novasamatech/*` → `^0.8.6`**. Pulls in RFC-0021 coin top-ups ([triangle-js-sdks#194](https://github.com/paritytech/triangle-js-sdks/pull/194)), the `PaymentTopUpSource` codec fix ([#198](https://github.com/paritytech/triangle-js-sdks/pull/198) — `PrivateKey`/`Coins` keys are now 64-byte sr25519 secrets, not 32-byte ed25519), the `deriveProductEntropyFromSource` export for RFC-0007 Option 1 hosts ([#205](https://github.com/paritytech/triangle-js-sdks/pull/205)), and host-chat / host-papp internals. All existing handlers (theme, payments, signing, statement-store) continue to work without code changes.

### Added

- **`PaymentTopUpSource.Coins(Vector<Sr25519SecretKey>)` flows through to `paymentLog.source`.** `handlePaymentTopUp` already forwarded `params.source` as-is, so the new variant lands in the log entry as `{ tag: 'Coins', value: Uint8Array[] }`. Each key in the vector is 64 bytes after the upstream codec fix.
- **`setPaymentTopUpBehavior(behavior)` test control** for driving products through the RFC-0021 `PartialPayment` error path. Behavior is `'ok'` (default), `{ type: 'partial', credited }` (credit `credited` and reject with `PaymentTopUpErr.PartialPayment({ credited })`, mirroring how a real host reports that only some coins could be claimed), or `{ type: 'reject', reason: 'InvalidSource' | 'InsufficientFunds' }`. The `paymentLog` entry always records the attempted `amount` and `source` regardless of outcome.
- **`PaymentTopUpBehavior` type exported** from the package root so tests can type the argument.

### Internal

- Integration tests for the coins round-trip and the partial-payment behavior. The partial-payment test asserts both the rejected promise's `payload.credited` and that the balance was bumped by exactly that amount.
- Test product gained `paymentTopUpCoins(amount, keysHex[])` helper.

## 0.9.0

### Changed

- **Upstream `@novasamatech/*` → `^0.8.0`** ([triangle-js-sdks#179](https://github.com/paritytech/triangle-js-sdks/pull/179)). v0.8 is **wire-incompatible** with v0.7 — a test host built on this release will only talk to products on `@novasamatech/host-api@^0.8.0`. Upgrade your product side in lockstep. Most products don't need code changes if they use `createPapiProvider` for chain access and `@novasamatech/product-react-renderer` for custom chat. The product-side breaking points are documented in [the v0.8 migration guide](https://github.com/paritytech/triangle-js-sdks/blob/release/0.8/docs/migration/v0.8.md): theme subscription struct, `OptionBool` encoding fix (signing + custom renderer), and a handful of variant renames.

### Breaking changes

- **Theme subscription** delivers the new `{ name, variant }` struct instead of a flat `'light' | 'dark'`. `setTheme('light' | 'dark')` keeps working as a shorthand (mapped to `{ name: { tag: 'Default', value: undefined }, variant: 'Light' | 'Dark' }`) and now also accepts the full struct so tests can drive custom-named themes (e.g. `setTheme({ name: { tag: 'Custom', value: 'midnight' }, variant: 'Dark' })`). `getTheme()` returns the struct — read `theme.variant` for the previous light/dark value.
- **`AllocatableResource` variant rename**: `BulletInAllowance` → `BulletinAllowance`. Affects tests that hand-build resource-allocation requests.

### Added

- **`PaymentLogEntry.purse`** records the optional purse selector from RFC-0017 — `into` on top-ups, `from` on payment requests. Undefined means the product targeted the main purse.
- **`Theme` and `ThemeInput` types** exported from the package root so tests can type their theme assertions.

### Internal

- New integration coverage: default + custom-theme struct round-trip, and a purse-selector assertion on the payment log.
- Test product (`test/test-product.ts`) updated for the new theme payload shape and gained a `paymentSmokeWithPurse` helper.

## 0.8.6

### Fixed

- **`PASEO_ASSET_HUB.genesisHash` refreshed after the Paseo Asset Hub chain reset** ([#153](https://github.com/paritytech/product-sdk/pull/153)). The `paseo-asset-hub-next` chain was reset, changing its genesis from `0x173cea…` to `0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f`. The stale literal caused the host's chain-feature handshake to reject product-sdk descriptors regenerated against the new chain, surfacing as the product app stuck `disconnected` in E2E (`expect byod-status: "connected"`, received `"disconnected"`). Verified the new value against the live chain via `chain_getBlockHash(0)`.

## 0.8.5

### Fixed

- **`handleAccountGet` and `handleAccountGetAlias` no longer throw on unsigned hosts** ([#31](https://github.com/paritytech/host-api-test-sdk/pull/31), reported and initial fix by [@BigTava](https://github.com/BigTava)). When `accounts: []` (no signed-in user), both handlers indexed `pairs[0]` without a guard, surfacing a synchronous `TypeError` instead of a protocol-level response. They now return `err(new RequestCredentialsErr.NotConnected(undefined))`, matching how `polkadot-desktop` reports `getProductAccount` / `getProductAccountAlias` calls made before login. The `productAccounts` override branch still wins for explicitly mapped identities, so tests that pre-map accounts continue to work with `accounts: []`.

## 0.8.4

### Fixed

- **`getIsAuthenticated()` now reflects login state correctly** ([#25](https://github.com/paritytech/host-api-test-sdk/issues/25)). Previously it defaulted to `true` on page load, which meant `setLoginBehavior('reject')` was silently ignored — the host short-circuited login with `'alreadyConnected'` before consulting the behavior. The flag is now `false` until a successful login (or `simulateReconnect()`), and is explicitly reset to `false` on a rejected login. Tests asserting on the post-reject UX can now use `getIsAuthenticated()` as a reliable oracle.

### Added

- **README — "What `permissionLog` records (and what it doesn't)"** section ([#24](https://github.com/paritytech/host-api-test-sdk/issues/24)). Documents that signing is not gated behind ChainSubmit at the test-sdk level (deliberate 0.7.1 design), `permissionLog` only records explicit `hostApi.permission(...)` calls, and container-side `transaction_broadcast` denials aren't currently observable from the test-sdk.

## 0.8.3

### Changed

- **Upstream `@novasamatech/*` → `^0.7.9` (final)**. Caret is safe again now that upstream is on a stable point release. The package previously named `@novasamatech/product-sdk` is now `@novasamatech/host-api-wrapper` — no compat re-export under the old name. Our test-product's import is updated; consumers writing their own test-product need to do the same when they bump their own copy.
- **Push notifications**: protocol gained `scheduledAt: bigint | undefined` on the request and now returns a `NotificationId` (u32). `NotificationLogEntry` adds `id`, `scheduledAt`, and `cancelled`. The test host accepts and records both; no existing assertion in our integration suite (or any pinned `^0.8.2` consumer surveyed) breaks.

### Added

- **`handlePushNotificationCancel`**: new container handler in upstream `0.7.9`. The test host marks the matching log entry's `cancelled = true` and returns `ok(undefined)`; unknown id returns `GenericError`.
- **Integration test** covering `scheduledAt` + the cancel round-trip.

### Notes

`host_create_transaction`'s on-the-wire shape is unchanged from `0.8.x` — the v4 signed extrinsic produced by `0.8.2` is still valid. The only protocol-shape changes in upstream `0.7.9` are around notifications.

## 0.8.2

### Fixed

- **`handleCreateTransaction` now prepends the SCALE-compact length prefix** to the returned bytes. `0.8.1` returned the bare `[0x84][signer][sig][extras][callData]` frame, which is the *inner* extrinsic body — RPC and polkadot-api decoders expect the outer wire form `[compact len][0x84]…`, so a length-prefixed decoder reads byte 0 as part of the length and fails. The handler now produces the wire form directly.
- Integration test #45 was updated to strip the compact prefix before asserting on the v4 frame, so the test would have caught the missing prefix.

## 0.8.1

### Fixed

- **`handleCreateTransaction` and `handleCreateTransactionWithLegacyAccount` now return a properly signed v4 extrinsic.** In `0.8.0` they returned `params.callData` as-is — fine for tests that only assert `result.ok === true`, but unusable for tests that submit the bytes to a chain (polkadot-api's extrinsic codec rejects them, since `callData[0]` is the pallet index, not a valid v4/v5 prefix byte).

  The handler now:
  1. Resolves the keypair (product account flow → `getPairForProductAccount`; legacy flow → new `getPairByPublicKey` matching against the raw 32-byte sr25519 public key in `params.signer`).
  2. Concatenates the per-extension `extra` and `additionalSigned` blobs in order.
  3. Signs `callData || extras || additionalSigned` with sr25519 — using `blake2_256(payload)` instead when the payload exceeds 256 bytes, matching Substrate convention.
  4. Returns the v4 signed-extrinsic body (no outer compact length): `[0x84][MultiAddress::Id + AccountId32][MultiSignature::Sr25519 + sig][extras][callData]`.

  v5 general extrinsics aren't emitted yet — paseo-asset-hub-next currently advertises `extrinsic.version: [4]` only, and the `AsPgas` / `AsRingAlias` / `EthSetOrigin` / etc. extensions ride as additional signed-extensions on v4. v5 support is a follow-up if/when a runtime negotiates it.

### Notes

- `0.8.0` is deprecated on npm; consumers should upgrade. The protocol-shape changes from `0.8.0` are still in effect — only the handler return value changed.

## 0.8.0

### Breaking changes

- **`handleCreateTransaction` request shape** — upstream `0.7.9-x` rewrote `host_create_transaction`. The request is now a flat `ProductAccountTransaction` object instead of a `[ProductAccountId, VersionedPublicTxPayload]` tuple, with no versioned envelope around the inner payload:

  ```ts
  // 0.7.6 (old)
  container.handleCreateTransaction(([[dotnsId, idx], payload], { ok }) => ok(payload.callData));

  // 0.8.0 (new)
  container.handleCreateTransaction((params, { ok }) => ok(params.callData));
  // params: { signer: [dotnsId, idx], genesisHash: Uint8Array, callData: Uint8Array,
  //          extensions: { id, extra: Uint8Array, additionalSigned: Uint8Array }[], txExtVersion }
  ```

  The `context` field (`metadata`, `tokenSymbol`, `tokenDecimals`, `bestBlockHeight`) is gone — `genesisHash` replaces it as the only top-level chain hint. All hex fields are now `Uint8Array`.

- **`handleCreateTransactionWithLegacyAccount` request shape** — same flattening. `params.signer` is now `Uint8Array` (a 32-byte AccountId) instead of an SS58 string.

- **Removed exports** — upstream removed `VersionedPublicTxPayload` / `TxPayloadV1Public`. New types: `LegacyTransaction`, `ProductAccountTransaction`.

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → `0.7.9-4` (pinned, not caret, because `^0.7.9-4` would float through subsequent prereleases). Upstream did not publish a `CHANGELOG.md` entry for any `0.7.9-N`; this entry was reconstructed from the commit log.

### Other upstream changes (no SDK-facing impact)

- `feat: Remove attestation service and simplify auth flow` — SSO auth simplification on the paired-app side.
- `fix: backward-compatibility flag in product-sdk accounts provider`.
- `Rename product-sdk to host-api-wrapper (#169)` — internal package rename. `@novasamatech/product-sdk@0.7.9-4` still ships under the old name; `0.7.9-5` is the last prerelease and switches to `@novasamatech/host-api-wrapper`.

## 0.7.6

### Fixed

- **`PASEO_ASSET_HUB`** — `genesisHash` and `rpcUrl` updated to Paseo Asset Hub v2. The previous values pointed at Paseo Next v1, deprecated 2026-05-20.
- **`PREVIEWNET`** and **`PREVIEWNET_ASSET_HUB`** — `genesisHash` refreshed against live RPC. The previous values were stale from prior redeployments and no longer matched what the chains return.

All three values verified live via `chain_getBlockHash[0]`. The downstream `paritytech/product-sdk` e2e suite went from 9 failures (`chain-client-demo`, `contracts-demo`, `tx-demo`) to all green after the bump.

## 0.7.5

### Added

- **`handleCreateTransaction`** — creates transactions for product accounts. Returns the call data for test assertions.
- **`handleAccountCreateProof`** — creates Ring VRF proofs for product accounts. Signs the message with sr25519 for test purposes.
- **Integration tests** — 12 new tests covering theme subscribe, entropy derivation, login/getUserId, resource allocation, feature check, local storage, statement store proof, create transaction, and account create proof. Total: 46 integration tests (up from 34).

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → ^0.7.8 (identity fixes, bulletin package).

## 0.7.4

### Added

- **`handleRequestResourceAllocation`** (RFC-0010) — products can request resource allowances (StatementStoreAllowance, BulletInAllowance, SmartContractAllowance, AutoSigning). The test host auto-allocates all requested resources.
- **`handleStatementStoreCreateProofAuthorized`** — creates statement proofs using the host-internal allowance account (no product account required). Uses the first configured account.

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → ^0.7.7. Upstream changes include RFC-0010 resource allocation, authorized statement proofs, SSO signer fixes, and reconnect improvements.

## 0.7.3

### Breaking changes

- **`handleAccountGetRoot` replaced by `handleGetUserId`** — upstream 0.7.4 renamed this method (RFC-0014: Get User Primary DotNS Name). Returns `{ primaryUsername: string }` instead of `{ publicKey, name }`. Error type changed from `RequestCredentialsErr` to `GetUserIdErr`.

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → ^0.7.4. Upstream changes include the `host_get_user_id` method (RFC-0014), sign method ABI ordering fix, and transport message parsing optimization.
- **CI runners** — `parity-default` with `corepack enable`.

## 0.7.2

### Fixed

- **Permission handler uses single `RemotePermission`** — upstream 0.7.2 refined the spec to use a single `RemotePermission` per request (not batched array). The test host now matches.

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → ^0.7.2. Upstream changes include ABI-stable method ordering, notification permission gate, and restored deprecated JSON-RPC methods for backward compatibility.

## 0.7.1

### Fixed

- **Signing no longer gated behind `ChainSubmit` permission** — in v0.7.0 the test host incorrectly required `ChainSubmit` before signing. Real Spektr hosts don't do this — `ChainSubmit` is enforced by the container at the `transaction_broadcast` level, not at signing. Signing now works without any prior permission request, matching production behavior.

### Changed

- **CI runners** — switched to `parity-default`, added `corepack enable` for pnpm.

## 0.7.0

### Breaking changes

- **Permission renames** — `TransactionSubmit` → `ChainSubmit`, `ExternalRequest` → `Remote`. Signing enforcement now checks `ChainSubmit`. `handlePermission` receives `RemotePermission[]` (batched) instead of a single permission.
- **Signing uses `ProductAccountId`** — `handleSignPayload` and `handleSignRaw` receive `{ account: [dotnsId, derivationIndex], payload }` instead of `{ address, data }`.
- **Legacy account rename** — `handleGetNonProductAccounts` → `handleGetLegacyAccounts`. New handlers: `handleSignPayloadWithLegacyAccount`, `handleSignRawWithLegacyAccount`, `handleCreateTransactionWithLegacyAccount`.
- **Statement store subscribe** — takes `TopicFilter` (`{ tag: 'MatchAll' | 'MatchAny', value: Topic[] }`) instead of `Topic[]`. Delivers `SignedStatementsPage` (`{ statements, isComplete }`) instead of raw arrays.
- **Device permissions expanded** — 9 variants: Camera, Microphone, Location, Bluetooth, Notifications, NFC, Clipboard, OpenUrl, Biometrics.
- **polkadot-api v2** — `polkadot-api/ws-provider` import changed to `polkadot-api/ws`.

### Migration from 0.6.x

Permission names:
```diff
-await testHost.grantPermission('TransactionSubmit');
+await testHost.grantPermission('ChainSubmit');
```

Permission log assertions:
```diff
-expect(log.some(e => e.tag === 'TransactionSubmit')).toBe(true);
+expect(log.some(e => e.tag === 'ChainSubmit')).toBe(true);
```

### Added

#### Theme (RFC-0007)
- `handleThemeSubscribe` — products subscribe to host theme changes (`'light'` / `'dark'`).
- `getTheme()` / `setTheme(theme)` — test controls.

#### Entropy derivation (RFC-0007)
- `handleDeriveEntropy` — deterministic 32-byte entropy from a caller key, using the three-layer BLAKE2b-256 scheme via `deriveProductEntropy` from `@novasamatech/host-container`.

#### Root account access (RFC-0010)
- `handleAccountGetRoot` — returns the first configured account as the root DotNS-linked account.

#### Login flow (RFC-0009)
- `handleRequestLogin` — products trigger the host login flow. Simulates auth state.
- `setLoginBehavior(behavior)` — `'success'` / `'reject'` / custom function.
- `getIsAuthenticated()` / `simulateDisconnect()` / `simulateReconnect()` — test controls.

#### Payment API (RFC-0006)
- `handlePaymentBalanceSubscribe`, `handlePaymentTopUp`, `handlePaymentRequest`, `handlePaymentStatusSubscribe` — in-memory payment state.
- `setPaymentBalance(amount)` / `getPaymentLog()` / `clearPaymentLog()` / `simulatePaymentStatus(id, status)` — test controls.

#### Types
- **New exported types**: `LoginBehavior`, `PaymentLogEntry`

### Changed

- **Dependencies** — `@novasamatech/host-api`, `host-container`, `product-sdk` → 0.7.0; `polkadot-api` → ^2.0.0.
- **Integration tests updated** — all 36 tests pass against the v0.7 protocol.

## 0.6.0

### Added

#### Navigation, notifications, account alias
- **Navigation handler** — `handleNavigateTo` records `hostApi.navigateTo(url)` calls in a log without actually navigating. Inspect via `getNavigationLog()` / `clearNavigationLog()`.
- **Push notification handler** — `handlePushNotification` records `hostApi.pushNotification({ text, deeplink })` calls. Inspect via `getNotificationLog()` / `clearNotificationLog()`.
- **Account alias handler** — `handleAccountGetAlias` returns a deterministic `(context, alias)` pair derived from the account public key via BLAKE2b-256. Stable across runs for a given account.

#### Chat
- **Chat handlers** — `handleChatCreateRoom`, `handleChatBotRegistration`, `handleChatListSubscribe`, `handleChatPostMessage`, `handleChatActionSubscribe`. In-memory rooms/bots/messages. Inspect via `getChatRooms()`, `getChatBots()`, `getChatMessageLog()`.
- `injectChatAction({ roomId, peer, payload })` — simulate an incoming message from a peer.
- `clearChatState()` — wipe all chat state.

#### Preimage store
- **Preimage handlers** — `handlePreimageSubmit` stores the value and returns its BLAKE2b-256 key. `handlePreimageLookupSubscribe` delivers the value (or `null`) when queried, and notifies subscribers when a new preimage matching their key is submitted.
- `seedPreimage(value)` — pre-populate the store from tests; returns the computed key.
- `getPreimages()` / `clearPreimages()` — inspect or reset the store.

#### Statement store
- **Statement store handlers** — `handleStatementStoreSubscribe`, `handleStatementStoreCreateProof`, `handleStatementStoreSubmit`. In-memory statement storage with topic-based subscription filtering. Product accounts sign via sr25519 for `createProof`.
- `getSubmittedStatements()` — log of what the product has submitted.
- `injectStatement(statement)` — deliver a statement to matching subscribers without going through submit.
- `clearStatements()` — reset all statement state.

#### Types
- **New exported types**: `NavigationLogEntry`, `NotificationLogEntry`, `ChatRoom`, `ChatBot`, `ChatMessageLogEntry`, `PreimageEntry`, `StatementSubmissionLogEntry`

### Changed

- **Per-session state reset** — permission grants, navigation log, notification log, chat state, preimages, and statement store are now cleared on container recreation (e.g. `setAccounts`), matching real host session behavior.

## 0.5.0

### Breaking changes

- **Signing now requires `TransactionSubmit` permission** — matching real host behavior (polkadot-desktop, dot.li). Products must call `hostApi.permission({ tag: 'TransactionSubmit' })` before signing, otherwise the signing request will fail with a clear error. This catches products that skip the permission step — tests that passed before may now fail if the product wasn't requesting permission correctly.
- **Device permissions now handled** — `handleDevicePermission` responds to Camera, Microphone, Location, and Bluetooth requests. When granted, the iframe `allow` attribute is updated with the corresponding Permissions Policy directive (matching dot.li). Products that don't request device permissions before using browser APIs will be blocked by the browser itself.

### Migration from 0.4.x

If your product already requests `TransactionSubmit` permission before signing, no changes needed.

If your tests break, you have two options:

**Option A** — fix the product (recommended): ensure your product calls `hostApi.permission({ tag: 'TransactionSubmit' })` before signing. This is what real hosts require.

**Option B** — opt out of enforcement temporarily:
```ts
// In Playwright fixture
await testHost.setEnforcePermissions(false);

// Or via page.evaluate
await page.evaluate(() => window.__TEST_HOST__.setEnforcePermissions(false));
```

### Added

- `grantPermission(tag)` / `revokePermission(tag)` — pre-grant or revoke permissions from tests without the product requesting them
- `getGrantedPermissions()` — inspect currently granted permissions
- `setEnforcePermissions(enforce)` — enable/disable permission enforcement on signing

## 0.4.0

### Added

- **`productAccounts` option** — maps product account requests (`"dotnsId/index"`) to specific accounts. Lets you point derived product accounts at funded dev accounts without changing the derivation logic. Unmapped identities fall back to production-style derivation (`//Bob//dotnsId/index`).
  ```ts
  productAccounts: {
    'myapp.dot/0': 'bob',
    'myapp.dot/2': { name: 'Custom', uri: '//My//Path' },
  }
  ```
- **Custom accounts everywhere** — `accounts` (root) and `productAccounts` now accept `{ name, uri }` objects in addition to dev account names, so you can use arbitrary Substrate URIs (derivation paths, mnemonics, hex seeds).
  ```ts
  accounts: ['bob', { name: 'From mnemonic', uri: 'word1 word2 ... word12' }]
  ```
- **Playwright integration tests** — verifies product account derivation and `productAccounts` mapping end-to-end with a real product in an iframe.

## 0.3.0

### Added

- **Permission handling** — the test host now handles `remote_permission` requests from the product. By default all permissions are auto-approved, matching the existing auto-sign behavior. Products can control this with:
  - `setPermissionBehavior('approve-all' | 'reject-all' | fn)` — configure approve/reject/custom logic
  - `getPermissionLog()` — inspect permission requests and their outcomes
  - `clearPermissionLog()` — reset the log between tests
- **New exported types**: `PermissionBehavior`, `PermissionLogEntry`

### Changed

- **Updated `@novasamatech/host-api` and `@novasamatech/host-container`** from `0.6.6-1` to `0.6.15`

## 0.2.0

### Breaking changes

- **Removed `loadChainFromEnv`, `parseEnvFile`, `loadEnvFiles`** — env file utilities have been removed. Construct a `ChainConfig` object directly using your project's own env loading (`process.env`, Vite, dotenv, etc.). See the [Custom chain config](./README.md#custom-chain-config) section in the README.
- **`HexString` is now re-exported from `@novasamatech/host-api`** — structurally identical (`0x${string}`), no code changes needed.
- **`@novasamatech/host-api` moved to `dependencies`** — installed automatically, no action required.

### Added

- **`TestHostAPI` type** — exported from both `.` and `./playwright` entry points. Describes the `window.__TEST_HOST__` control API shape.

### Fixed

- `chainStatus` now correctly starts as `'idle'` and transitions to `'connected'` when the chain handler is actually called (was incorrectly set to `'connected'` immediately on provider creation).

### Migration from 0.1.x

If you used env utilities, replace them with your own env loading:

```diff
-import { createTestHostServer, loadChainFromEnv } from "@parity/host-api-test-sdk";
-const chain = loadChainFromEnv({ envFiles: [".env.local"], ... });
+import { createTestHostServer } from "@parity/host-api-test-sdk";
+import type { ChainConfig } from "@parity/host-api-test-sdk";
+const chain: ChainConfig = {
+  id: "local-asset-hub",
+  name: "Local Asset Hub",
+  genesisHash: process.env.GENESIS_HASH as `0x${string}`,
+  rpcUrl: "ws://127.0.0.1:9944",
+  tokenSymbol: "WND",
+  tokenDecimals: 12,
+};
```

If you only used built-in chains (`PASEO_ASSET_HUB`, etc.) and `createTestHostFixture` — no changes needed.

## 0.1.0

Initial release.
