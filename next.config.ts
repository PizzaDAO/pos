import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this project. A stray lockfile in a parent
  // directory can otherwise cause Next to infer the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
