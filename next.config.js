/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Run pdf-parse as a native Node.js module — avoids webpack bundling issues
    serverComponentsExternalPackages: ["pdf-parse"],
  },
};

module.exports = nextConfig;
