import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: ['./test/globalSetup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
});
