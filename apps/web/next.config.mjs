/** @type {import('next').NextConfig} */
const nextConfig = {
  // Browser calls to /api/* are proxied by app/api/[...path]/route.ts, which
  // injects the API auth token server-side. (The old rewrite couldn't add a
  // request header, so it would 401 against the now-authenticated API.)
};

export default nextConfig;
