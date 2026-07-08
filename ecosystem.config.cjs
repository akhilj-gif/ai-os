// pm2 process supervision (M-stabilize / Option 2). Keeps the three long-running
// node services alive and auto-restarts any that crash. Brought up by `pnpm up`
// (which first ensures Docker + Postgres are healthy) and inspected by `pnpm status`.
// Upgrade path to full boot-on-login (Option 1) = a Windows Startup shortcut that
// runs `pnpm up`; nothing here changes.
//
// api + bridge run TypeScript directly via `node --import tsx` (verified working);
// web runs the Next dev server via its resolved bin. Logs → ./logs/*.log.
const { join } = require('node:path');
const root = __dirname;

const common = {
  autorestart: true,
  max_restarts: 10, // within min_uptime; then pm2 backs off (crash-loop guard)
  min_uptime: 10_000, // must stay up 10s to count as a good start
  restart_delay: 3_000,
  kill_timeout: 8_000, // give the process time to close sockets/DB on stop
  time: true, // timestamp log lines
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'ai-os-api',
      script: join(root, 'apps/api/src/server.ts'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: root,
      out_file: join(root, 'logs/api.log'),
      error_file: join(root, 'logs/api.err.log'),
    },
    {
      ...common,
      name: 'ai-os-bridge',
      script: join(root, 'apps/whatsapp-bridge/src/index.ts'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: root,
      out_file: join(root, 'logs/bridge.log'),
      error_file: join(root, 'logs/bridge.err.log'),
    },
    {
      ...common,
      name: 'ai-os-web',
      script: join(root, 'apps/web/node_modules/next/dist/bin/next'),
      args: 'dev -p 3000',
      interpreter: 'node',
      cwd: join(root, 'apps/web'),
      out_file: join(root, 'logs/web.log'),
      error_file: join(root, 'logs/web.err.log'),
    },
  ],
};
