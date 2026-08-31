import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    env: {
      EXCALIDRAW_NO_BROWSER_OPEN: '1',
      EXCALIDRAW_NO_AUTOSTART: '1',
    },
  },
});
