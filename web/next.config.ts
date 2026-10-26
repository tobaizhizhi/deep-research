import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Web 位于 Python 项目内，将构建范围固定在当前 web 目录。
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  output: "standalone",
};

export default nextConfig;
