import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Cloud Run image.
  output: 'standalone',
  // Trace deps from the monorepo root so the standalone bundle includes the
  // @brayz/* workspace packages.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Workspace packages are TS source; let Next transpile them.
  transpilePackages: ['@brayz/shared'],
};

export default nextConfig;
