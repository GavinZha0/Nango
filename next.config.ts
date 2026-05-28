import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack is default in Next.js 16 — no flag needed

  // Docker builds set NEXT_STANDALONE_OUTPUT=true to produce a self-contained
  // server.js that doesn't need node_modules at runtime.
  output: process.env.NEXT_STANDALONE_OUTPUT === "true" ? "standalone" : undefined,

  experimental: {
    // authInterrupts allows forbidden()/unauthorized() in Server Components
    authInterrupts: true,
  },

  // Keep heavy server-only packages out of the Turbopack bundle.
  // @copilotkit/runtime pulls in openai, langchain, etc. which are not
  // installed as direct deps; letting Node resolve them at runtime avoids
  // "module not found" build errors. The duckdb / pg / vertica entries
  // are native (.node) bindings or have dynamic platform-specific
  // requires that Turbopack cannot statically resolve — they must be
  // loaded by Node at runtime, not bundled.
  serverExternalPackages: [
    "@copilotkit/runtime",
    "openai",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "pg",
    "pg-native",
    "vertica-nodejs",
  ],

  env: {
    NO_HTTPS: process.env.NO_HTTPS,
  },
};

export default nextConfig;
