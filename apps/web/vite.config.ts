/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverUrl = env.VITE_SERVER_URL || 'http://127.0.0.1:1234';

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Same-origin in development: the browser talks to Vite, which forwards the token
      // endpoint and the WebSocket upgrade to the sync server.
      proxy: {
        '/api': { target: serverUrl, changeOrigin: true },
        '/healthz': { target: serverUrl, changeOrigin: true },
        '/rooms': { target: serverUrl, ws: true, changeOrigin: true },
      },
    },
    build: {
      sourcemap: true,
      target: 'es2022',
      rollupOptions: {
        onwarn(warning, warn) {
          // zod ships `@__PURE__` comments in positions Rollup cannot use; harmless noise.
          if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
          warn(warning);
        },
      },
    },
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      css: { modules: { classNameStrategy: 'non-scoped' } },
    },
  };
});
