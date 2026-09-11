/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This project sits inside a parent directory that also has a lockfile;
  // pin the trace root so Next does not walk up and pick the wrong one.
  outputFileTracingRoot: process.cwd(),
  // Dataset binaries are content-addressed by version in their path, so they are
  // safe to cache immutably. See docs/ARCHITECTURE.md ("Binary delivery").
  async headers() {
    return [
      {
        source: '/datasets/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
