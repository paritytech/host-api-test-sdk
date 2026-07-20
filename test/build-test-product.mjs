import { build } from 'esbuild';

const products = [
  { entry: 'test/test-product.ts', outfile: 'test/test-product-bundle.js' },
  { entry: 'test/test-product-truapi.ts', outfile: 'test/test-product-truapi-bundle.js' },
];

await Promise.all(
  products.map(async ({ entry, outfile }) => {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      outfile,
      sourcemap: false,
      conditions: ['browser'],
    });
    console.log(`Test product bundle built: ${outfile}`);
  }),
);
