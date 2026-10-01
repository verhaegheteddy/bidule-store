import { defineConfig } from 'vitest/config'

// The server's tests, in Node (the core's Vitest only takes the extensions' interface tests):
// `npx vitest run --config tests/vitest.config.ts` from the module's folder.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
})
