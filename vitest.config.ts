import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // `contracts/` is an isolated Foundry project (Solidity, forge test) —
    // its vendored libs (OpenZeppelin, forge-std) ship their own *.test.js
    // fixtures that must never be picked up by the root Vitest run.
    exclude: ['**/node_modules/**', '**/contracts/**'],
  },
});
