import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything the page loads at runtime: the entry chunks, the shared chunks, the wasm. */
const HOST_ASSET_DIR = 'dist/host';

// The chunks are content-hashed and esbuild does not clean its outdir, so a
// rebuild after a dependency bump would otherwise leave the previous chunks
// behind for `pnpm pack` to ship.
rmSync(HOST_ASSET_DIR, { recursive: true, force: true });
mkdirSync(HOST_ASSET_DIR, { recursive: true });

/** Resolve a published file through its package's `exports` map. */
function resolveExport(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/**
 * The core runs as Rust/WASM in a Web Worker, so the worker is its own entry
 * point rather than something the main chunk can inline: esbuild passes
 * `new Worker(new URL(...))` through verbatim, it does not bundle the target.
 * Naming the entries with an object pins the output basenames — `host-runtime.js`
 * and `worker-runtime.js` — regardless of how far apart the two source roots are
 * (one is in `src/`, the other in `node_modules/`), which is what lets
 * `src/browser/host-worker.ts` name `./worker-runtime.js` relative to its own
 * `import.meta.url`.
 */
const browserResult = await build({
  entryPoints: {
    'host-runtime': 'src/browser/host-runtime.ts',
    'worker-runtime': resolveExport('@parity/truapi-host/worker-runtime'),
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  outdir: HOST_ASSET_DIR,
  minify: true,
  sourcemap: false,
  metafile: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // polkadot WASM crypto needs this
  conditions: ['browser'],
});

console.log(`Browser bundles built into ${HOST_ASSET_DIR}/`);

/**
 * Copy the wasm payloads next to the chunk that asks for them.
 *
 * wasm-pack's glue resolves its payload with
 * `new URL('truapi_server_bg.wasm', import.meta.url)`, and esbuild passes that
 * through verbatim — the `.wasm` is never emitted, and the URL is resolved at
 * runtime against the URL of whichever chunk the glue ended up in. `splitting`
 * puts shared and dynamically imported chunks in the outdir root, so that is
 * `dist/host/`; the assertion below fails the build if a future esbuild (or a
 * `chunkNames` setting) ever moves it somewhere else.
 */
const glueChunks = Object.entries(browserResult.metafile.outputs)
  .filter(([, out]) => Object.keys(out.inputs).some((i) => i.endsWith('/wasm/web/truapi_server.js')))
  .map(([file]) => file);

if (glueChunks.length !== 1 || dirname(glueChunks[0]) !== HOST_ASSET_DIR) {
  throw new Error(
    `expected exactly one wasm-glue chunk directly in ${HOST_ASSET_DIR}/, got: ${glueChunks.join(', ') || '(none)'}`,
  );
}

for (const [pkgEntry, wasmName] of [
  ['@parity/truapi-host/wasm/web', 'truapi_server_bg.wasm'],
  // Not imported yet: the chain route moves onto @parity/truapi-provider next,
  // and its glue resolves the payload the same way, from beside itself.
  ['@parity/truapi-provider', 'truapi_provider_bg.wasm'],
]) {
  // The wasm itself is not always in the package's `exports` map, so resolve the
  // glue module it sits beside and take the sibling.
  const from = join(dirname(resolveExport(pkgEntry)), wasmName);
  copyFileSync(from, join(HOST_ASSET_DIR, wasmName));
  console.log(`WASM payload copied: ${HOST_ASSET_DIR}/${wasmName}`);
}

// CJS bundles for CommonJS compatibility (e.g. Playwright's default CJS loader).
// Both bundles live in dist/ so `src/server.ts`'s `import.meta.url` resolves
// dist/host/ the same way it does from the ESM build's dist/server.js.
const cjsShared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: false,
  external: ['@playwright/test'],
  // Polyfill import.meta.url for CJS (used by server.ts to locate dist/host/)
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__import_meta_url',
  },
};

await Promise.all([
  build({
    ...cjsShared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.cjs',
  }),
  build({
    ...cjsShared,
    entryPoints: ['src/playwright/index.ts'],
    outfile: 'dist/playwright.cjs',
  }),
]);

console.log('CJS bundles built: dist/index.cjs, dist/playwright.cjs');
