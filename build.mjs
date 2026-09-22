import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_ASSET_DIR = 'dist/host';

// Content-hashed chunks, and esbuild does not clean its outdir: stale chunks
// would otherwise be shipped by `pnpm pack`.
rmSync(HOST_ASSET_DIR, { recursive: true, force: true });
mkdirSync(HOST_ASSET_DIR, { recursive: true });

/** Resolve a published file through its package's `exports` map. */
function resolveExport(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

/**
 * esbuild passes `new Worker(new URL(...))` through verbatim rather than
 * bundling the target, so the worker is its own entry point. Naming the entries
 * with an object pins the output basenames despite the two source roots being
 * far apart, which is what lets `host-worker.ts` name `./worker-runtime.js`
 * relative to its own `import.meta.url`.
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
  conditions: ['browser'],
});

console.log(`Browser bundles built into ${HOST_ASSET_DIR}/`);

/**
 * Copy each wasm payload next to the chunk that asks for it.
 *
 * Both wasm-pack glues resolve their payload with
 * `new URL('<name>_bg.wasm', import.meta.url)`, which esbuild leaves verbatim —
 * so the `.wasm` must sit in the directory the glue chunk lands in. The
 * assertion fails the build if one ever moves, rather than shipping a green
 * build whose page 404s on its wasm at runtime.
 *
 * `pkgEntry` only locates the payload's directory: the `.wasm` is not always in
 * the package's `exports` map, so resolve the glue and take the sibling.
 */
for (const { pkgEntry, glue, wasmName } of [
  {
    pkgEntry: '@parity/truapi-host/wasm/web',
    glue: '/wasm/web/truapi_server.js',
    wasmName: 'truapi_server_bg.wasm',
  },
  {
    pkgEntry: '@parity/truapi-provider',
    glue: '/@parity/truapi-provider/dist/truapi_provider.js',
    wasmName: 'truapi_provider_bg.wasm',
  },
]) {
  const glueChunks = Object.entries(browserResult.metafile.outputs)
    .filter(([, out]) => Object.keys(out.inputs).some((i) => i.endsWith(glue)))
    .map(([file]) => file);

  if (glueChunks.length !== 1 || dirname(glueChunks[0]) !== HOST_ASSET_DIR) {
    throw new Error(
      `expected exactly one ${wasmName} glue chunk directly in ${HOST_ASSET_DIR}/, got: ${glueChunks.join(', ') || '(none)'}`,
    );
  }

  const from = join(dirname(resolveExport(pkgEntry)), wasmName);
  copyFileSync(from, join(HOST_ASSET_DIR, wasmName));
  console.log(`WASM payload copied: ${HOST_ASSET_DIR}/${wasmName} (glue: ${glueChunks[0]})`);
}

// Both bundles live in dist/ so `server.ts`'s `import.meta.url` resolves
// dist/host/ the same way it does from the ESM build's dist/server.js.
const cjsShared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: false,
  external: ['@playwright/test'],
  // `server.ts` locates dist/host/ through `import.meta.url`, which CJS lacks.
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

/**
 * Drift guard for the published wire-schema hash.
 *
 * The core ships as a vendored `.wasm`, so the `@parity/truapi` version in
 * `package.json` says what the JS codecs were built against, not what the
 * binary speaks. Consumers need the latter to answer "can my product talk to
 * this host?", so the value is published — and a bump that changes the core
 * without changing the constant would publish a lie.
 */
{
  const wasm = await import('@parity/truapi-host/wasm/web');
  await wasm.default({
    module_or_path: await readFile(
      new URL('node_modules/@parity/truapi-host/dist/wasm/web/truapi_server_bg.wasm', import.meta.url),
    ),
  });
  const actual = wasm.wireSchemaHash();
  const source = await readFile(new URL('src/types.ts', import.meta.url), 'utf8');
  const declared = /TRUAPI_WIRE_SCHEMA_HASH = '([^']+)'/.exec(source)?.[1];
  if (declared !== actual) {
    throw new Error(
      `TRUAPI_WIRE_SCHEMA_HASH is ${declared ?? 'missing'}, but the bundled core speaks ${actual}. ` +
        'Update the constant in src/types.ts and say so in the CHANGELOG.',
    );
  }
  console.log(`Wire schema hash verified: ${actual}`);
}
