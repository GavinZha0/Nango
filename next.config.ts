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

  // pino transports are loaded via worker + dynamic require() — nft
  // can't trace them, so standalone builds miss `pino-pretty` and
  // the server crashes when NANGO_LOG_PRETTY=true with
  // "unable to determine transport target". Promoted from
  // `experimental` to top-level in Next.js 16.
  //
  // NOTE: this only works for direct deps that have a top-level
  // `node_modules/<pkg>` symlink. Transitive packages buried in
  // `.pnpm/<hash>/node_modules/<pkg>` are NOT reachable via these
  // globs — the JS ones are handled by nft's require-tracing, and the
  // one native dlopen sidecar (duckdb's libduckdb.so) is shipped via an
  // explicit COPY in docker/Dockerfile.
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/pino-pretty/**/*"],
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
