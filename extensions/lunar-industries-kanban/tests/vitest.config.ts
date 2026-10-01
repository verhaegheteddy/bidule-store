import { defineConfig } from 'vitest/config'

// The module's tests, in Node: `npx vitest run --config tests/vitest.config.ts` from the module's folder.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
