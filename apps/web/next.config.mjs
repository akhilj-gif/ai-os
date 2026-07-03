/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy browser calls to the kernel API — same origin, no CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://localhost:4000/:path*' }];
  },
};

export default nextConfig;
