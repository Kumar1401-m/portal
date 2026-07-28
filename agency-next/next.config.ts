import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Multiple lockfiles exist above this folder; pin the workspace root so
  // Turbopack resolves modules from agency-next/.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
