/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_STANDALONE === 'true' || process.platform !== 'win32' ? 'standalone' : undefined,
  // The site uses no next/image (its only image is an inline data URL in the OG image), so the optimizer stays off and
  // allows no remote host: /_next/image fetches nothing (#1616). A page that needs next/image later lists its exact
  // hosts.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
