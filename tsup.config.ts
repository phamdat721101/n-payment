import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@x402/core', '@x402/evm', '@x402/fetch', 'mppx', 'express'],
});
