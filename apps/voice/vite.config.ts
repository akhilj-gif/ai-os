import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';

/** Refuse to lend the API token to anything that is not the UI's own page.
 *
 *  The /api proxy below mints ambient authority: it attaches the admin token to
 *  whatever arrives, so any request reaching it runs fully authenticated. This
 *  guard is an ALLOWLIST on Sec-Fetch-Site (browser-set, unforgeable from JS).
 *  Only 'same-origin' passes; 'same-site', 'cross-site', 'none' and a MISSING
 *  header are all refused. Two of those were proven exploitable against the
 *  previous cross-site-only denylist (2026-08-13, real browser rig): a page on
 *  any OTHER localhost port is same-site (loopback "site" spans every port) and
 *  got 4/4 vectors through with the token; and a request with no header at all
 *  was handed the token, re-opening the "any local process can act as the user"
 *  hole the API token exists to close. Legitimate non-browser callers use :4000
 *  directly with their own AIOS_API_TOKEN, so requiring same-origin costs nothing
 *  — the voice UI's own calls (fetch('/api/…') and the forge EventSource) are all
 *  relative, hence same-origin.
 *
 *  It runs as a MIDDLEWARE rather than inside the proxy's own configure hook,
 *  because rejecting there meant proxyReq.destroy(), which emits an error on the
 *  outbound socket and logged a full stack trace per blocked request — a
 *  remote-triggerable log/disk-growth nuisance. A middleware added in
 *  configureServer's body runs BEFORE Vite's internal proxy middleware, so a
 *  refused request never opens an upstream socket at all. */
/** Is the Host header a loopback name? Mirrors hostIsLoopback in
 *  apps/web/app/api/[...path]/route.ts — duplicated rather than shared because a
 *  vite.config.ts cannot import from a Next app, and adding a workspace package
 *  for six lines is not worth it. Keep the two in step. */
function hostIsLoopback(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : (h.split(':')[0] ?? '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

function apiOriginGuard(): Plugin {
  return {
    name: 'aios-api-origin-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api')) return next();
        // Host must be a loopback NAME (2026-08-13). Without it, DNS rebinding
        // defeats the origin check outright: point evil.example at 127.0.0.1, have
        // the victim load http://evil.example:3001/, and that page's fetch to
        // /api/* is same-origin as far as the browser is concerned — so
        // 'same-origin' arrives and the token is attached. Vite's own allowedHosts
        // blocks this by default, but it is disabled in several common configs, so
        // the proxy does not rely on it. Port-agnostic so changing the port cannot
        // silently break the UI.
        // A duplicated header arrives joined ("cross-site, same-origin") or as an
        // array; neither is === 'same-origin', so both are refused for free.
        if (req.headers['sec-fetch-site'] !== 'same-origin' || !hostIsLoopback(req.headers.host)) {
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'only same-origin requests may use the API proxy' }));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), apiOriginGuard()],
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
          // AIOS_API_TOKEN to this process via ecosystem.config.cjs. Requests
          // that reach here have already passed apiOriginGuard above.
          configure: (proxy) => {
            const token = process.env.AIOS_API_TOKEN;
            if (token) proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('x-aios-token', token));
          },
        },
      },
    },
  };
});
