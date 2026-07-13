import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 65,
      },
    },
  },
});
