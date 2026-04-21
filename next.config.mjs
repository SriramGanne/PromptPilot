import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Pin Turbopack's workspace root to this project directory. Without this,
// Turbopack walks up the filesystem looking for a lockfile and can latch onto
// a stray lockfile in a parent folder, which then breaks module resolution
// for `tailwindcss`, `react`, etc. Pinning explicitly makes the dev server
// deterministic regardless of surrounding directories.
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: __dirname },
};

export default nextConfig;
