import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const pkg = (n: string) => resolve(import.meta.dirname, `packages/${n}/src/index.ts`);
const alias = {
  '@arena/shared': pkg('shared'), '@arena/data': pkg('data'), '@arena/core': pkg('core'),
  '@arena/venue': pkg('venue'), '@arena/api': pkg('api'), '@arena/ops': pkg('ops'),
};

const base = { alias, globals: false, restoreMocks: true, clearMocks: true } as const;

export default defineConfig({
  test: {
    projects: [
      { test: { ...base, name: 'unit', include: ['packages/*/src/**/*.test.ts', 'tests/scaffold.test.ts'], testTimeout: 30_000 } },
      { test: { ...base, name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, fileParallelism: false } },
      { test: { ...base, name: 'fault', include: ['tests/fault/**/*.test.ts'], testTimeout: 60_000, fileParallelism: false } },
      {
        plugins: [react()],
        test: {
          ...base, name: 'web', environment: 'jsdom',
          include: ['apps/web/__tests__/**/*.test.{ts,tsx}'], testTimeout: 300_000,
          fileParallelism: false,
        },
      },
      { test: { ...base, name: 'live', include: ['tests/live/**/*.test.ts'], testTimeout: 120_000, fileParallelism: false } },
    ],
  },
});
