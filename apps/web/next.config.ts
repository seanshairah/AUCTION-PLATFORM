import type { NextConfig } from 'next';

/**
 * The browser talks only to this origin: /api/* is forwarded to the API process,
 * so the session cookie stays first-party and no CORS is needed.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default config;
