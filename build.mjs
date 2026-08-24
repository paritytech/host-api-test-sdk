import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/browser/host-runtime.ts'],
  bundle: true,
  format: 'iife',
  globalName: '__testHostRuntime',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/host-bundle.js',
  minify: true,
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // polkadot WASM crypto needs this
  conditions: ['browser'],
});

console.log('Browser bundle built: dist/host-bundle.js');

// CJS bundles for CommonJS compatibility (e.g. Playwright's default CJS loader).
// Both bundles live in dist/ so __dirname resolves host-bundle.js correctly.
const cjsShared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: false,
  // Ring-proof imports stay external: verifiablejs loads its wasm relative to
  // its own module path, and polkadot-api is far too heavy to inline.
  external: [
    '@novasamatech/host-api',
    '@playwright/test',
    'verifiablejs',
    'verifiablejs/*',
    'polkadot-api',
    'polkadot-api/*',
    '@polkadot/util-crypto',
    '@noble/hashes',
    '@noble/hashes/*',
  ],
  // Polyfill import.meta.url for CJS (used by host-page.ts to locate host-bundle.js)
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
