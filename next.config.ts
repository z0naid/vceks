import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone: a self-contained server plus a pruned node_modules,
  // which is what keeps the runtime image small. Without it the Dockerfile's
  // `COPY /app/.next/standalone` has nothing to copy.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
