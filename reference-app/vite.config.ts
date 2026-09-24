import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { defineConfig as defineVitest, mergeConfig } from 'vitest/config';

const viteConfig = defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
});

const vitestConfig = defineVitest({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/client/test-setup.ts'],
    exclude: ['**/node_modules/**', 'tests/**'],
  },
});

export default mergeConfig(viteConfig, vitestConfig);
