# Third-party notices

`@parity/host-api-test-sdk` is distributed under the [MIT License](./LICENSE) and bundles, links to, or depends on a number of open-source components. This file lists what an install of this package actually ships, plus the runtime and peer dependencies.

Audited on 2026-09-17 against `pnpm pack` for `0.13.0`. Re-run the audit after any dependency bump.

## What the package ships

`package.json` declares `"files": ["dist"]`, so the tarball contains:

| Path | What it is |
|---|---|
| `dist/host/host-runtime.js` + `dist/host/chunk-*.js` | The in-page host runtime, bundled by esbuild. Third-party JS is inlined here. |
| `dist/host/worker-runtime.js`, `dist/host/truapi_server-*.js`, `dist/host/truapi_server_bg.wasm` | The TrUAPI core, compiled from Rust to WebAssembly, and its wasm-bindgen glue. Runs in a Web Worker. |
| `dist/host/truapi_provider-*.js`, `dist/host/truapi_provider_bg.wasm` | The TrUAPI chain provider, likewise compiled from Rust. |
| `dist/*.js`, `dist/*.d.ts`, `dist/playwright/*` | The Node-side API, compiled by `tsc`. No third-party code is inlined. |
| `dist/index.cjs`, `dist/playwright.cjs` | The same Node-side API bundled for CommonJS. Also free of third-party code — everything it needs is its own source, and `@playwright/test` stays external. |

There is no `dist/host-bundle.js`; the single inlined IIFE was replaced in 0.13.0 by the separately served `dist/host/` assets.

## Inlined into the browser runtime (`dist/host/`)

These packages are bundled by esbuild and ship with every install. The list is taken from esbuild's metafile, so it includes transitive packages the source does not import directly.

| Package | License | Upstream |
|---|---|---|
| @noble/ciphers | MIT | https://github.com/paulmillr/noble-ciphers |
| @noble/curves | MIT | https://github.com/paulmillr/noble-curves |
| @noble/hashes | MIT | https://github.com/paulmillr/noble-hashes |
| @parity/truapi | MIT | https://github.com/paritytech/truapi |
| @parity/truapi-host | MIT | https://github.com/paritytech/host-rust-core |
| @parity/truapi-provider | MIT AND Apache-2.0 | https://github.com/paritytech/host-rust-core |
| @polkadot-labs/hdkd-helpers | MIT | https://github.com/polkadot-labs/hdkd |
| @polkadot/networks | Apache-2.0 | https://github.com/polkadot-js/common |
| @polkadot/types, @polkadot/types-codec, @polkadot/types-create | Apache-2.0 | https://github.com/polkadot-js/api |
| @polkadot/util, @polkadot/util-crypto | Apache-2.0 | https://github.com/polkadot-js/common |
| @polkadot/wasm-bridge, @polkadot/wasm-crypto, @polkadot/wasm-crypto-init, @polkadot/wasm-crypto-wasm, @polkadot/wasm-util | Apache-2.0 | https://github.com/polkadot-js/wasm |
| @polkadot/x-bigint, @polkadot/x-global, @polkadot/x-randomvalues, @polkadot/x-textdecoder, @polkadot/x-textencoder | Apache-2.0 | https://github.com/polkadot-js/common |
| @scure/base | MIT | https://github.com/paulmillr/scure-base |
| @scure/sr25519 | MIT | https://github.com/paulmillr/scure-sr25519 |
| @substrate/ss58-registry | Apache-2.0 | https://github.com/paritytech/ss58-registry |
| bn.js | MIT | https://github.com/indutny/bn.js |
| neverthrow | MIT | https://github.com/supermacro/neverthrow |
| scale-ts | MIT | https://github.com/unstoppablejs/unstoppablejs |

`@polkadot/util-crypto` and the `@polkadot/wasm-*` packages are pulled in transitively by `@polkadot/types`, which this host uses for one thing only: assembling a `SignerPayload` from its named signed extensions. They are not direct dependencies, and no code here calls them.

## Compiled Rust in the shipped `.wasm` payloads

`truapi_server_bg.wasm` and `truapi_provider_bg.wasm` are binaries; their sources are the `truapi-server` and `truapi-provider` crates in https://github.com/paritytech/host-rust-core, published as the npm packages listed above. `@parity/truapi-provider` carries a `NOTICE` file, reproduced here as upstream requires:

> This package ships the `truapi-provider` Rust crate compiled to WebAssembly. It is licensed MIT (see LICENSE) except for the vendored browser light-client platform, which is licensed Apache-2.0 (see LICENSE-APACHE).
>
> Vendored components (compiled into `truapi_provider_bg.wasm`): the crate's `src/light_platform_web/{platform,helpers,socket}.rs`, Copyright 2019-2026 Parity Technologies (UK) Ltd., vendored from subxt-lightclient 0.50.1 (github.com/paritytech/subxt, `crates/lightclient`), which is dual-licensed Apache-2.0 OR GPL-3.0; used here under Apache-2.0. The `onmessage` handler in `socket.rs` was modified to ignore non-ArrayBuffer frames instead of panicking; otherwise the copy is faithful.
>
> The embedded light client itself (the `smoldot` / `smoldot-light` crates, GPL-3.0-or-later WITH Classpath-exception-2.0) is an ordinary Cargo dependency, linked under the Classpath exception; its source is not vendored here.

**Copyleft:** unlike every earlier release, the shipped tree is no longer free of copyleft. `truapi_provider_bg.wasm` links `smoldot` / `smoldot-light`, which are **GPL-3.0-or-later WITH Classpath-exception-2.0**. The Classpath exception is what permits linking it into an otherwise-permissive binary; the exception's conditions travel with any redistribution of that `.wasm`. Every other component listed on this page is MIT or Apache-2.0.

## Runtime dependency

- **@parity/truapi** — MIT — declared in `package.json` as a real `dependency`. It is required for the published type declarations to resolve: `dist/types.d.ts` names `HostChatActionSubscribeItem` and `ChatActionPayload` from it. No emitted JavaScript imports it.

## Peer dependency

- **@playwright/test** — Apache-2.0 — https://github.com/microsoft/playwright (optional; only required when using the `/playwright` entry point, and left external in the CJS bundles).

## Apache-2.0 attribution

Copies of the Apache License 2.0 are available from each upstream repository linked above, and in `@parity/truapi-provider`'s own `LICENSE-APACHE`. The only NOTICE file in the bundled tree is the one reproduced above; if another upstream adds one, it belongs here on the next dependency bump.

## Regenerating

The bundled list is whatever esbuild actually inlines, so read it off the build rather than off `package.json`:

```bash
pnpm run build           # writes dist/host/
npx --yes license-checker-rseidelsohn --json
```

Re-run after any dependency bump and update the tables above if licences change or new bundled packages appear.
