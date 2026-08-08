import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Loopback only (2026-07-09 security audit) — never expose the UI (and
      // through its proxy, the kernel API) to the LAN.
      host: '127.0.0.1',
      port: 3001,
      // Same-origin proxy to the kernel API — the API deliberately sends no
      // CORS headers, so all browser calls go /api/* → 127.0.0.1:4000/*.
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4000',
          changeOrigin: false,
          rewrite: (p: string) => p.replace(/^\/api/, ''),
          // Inject the API auth token server-side so the browser never sees it
          // (the API rejects any request without x-aios-token). PM2 provides
          // AIOS_API_TOKEN to this process via ecosystem.config.cjs.
          configure: (proxy) => {
            const token = process.env.AIOS_API_TOKEN;
            if (token) proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('x-aios-token', token));
          },
        },
      },
    },
  };
});
