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
            proxy.on('proxyReq', (proxyReq, req, res) => {
              // Never lend the token to a CROSS-SITE request (2026-08-13 audit,
              // same fix as apps/web/app/api/[...path]/route.ts — this proxy
              // mints the identical ambient authority). Sec-Fetch-Site is
              // browser-set and unforgeable from JS; a MISSING value means a
              // non-browser client, which stays token-gated as before.
              if (req.headers['sec-fetch-site'] === 'cross-site') {
                proxyReq.destroy();
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'cross-site requests are not allowed' }));
                return;
              }
              if (token) proxyReq.setHeader('x-aios-token', token);
            });
          },
        },
      },
    },
  };
});
