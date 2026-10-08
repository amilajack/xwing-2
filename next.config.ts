import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  // Hosts other than localhost that may load the dev server
  // - for example a tunnel used to test on a phone.
  // Each developer's tunnel is their own, so it comes from
  // their environment (e.g. .env.local) rather than the repo.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export default nextConfig;
