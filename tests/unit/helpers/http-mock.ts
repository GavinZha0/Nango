/**
 * Shared HTTP mock utilities for Next.js API route testing.
 */

import { NextRequest } from "next/server";

export interface MockRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  searchParams?: Record<string, string | number | boolean | undefined | null>;
}

/**
 * Builds a NextRequest with sensible defaults for JSON APIs.
 * Automatically resolves relative paths against http://localhost:9300.
 */
export function createMockRequest(url: string, options: MockRequestOptions = {}): NextRequest {
  const fullUrl = url.startsWith("http://") || url.startsWith("https://")
    ? url
    : `http://localhost:9300${url.startsWith("/") ? "" : "/"}${url}`;

  const target = new URL(fullUrl);
  if (options.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      if (value !== undefined && value !== null) {
        target.searchParams.set(key, String(value));
      }
    }
  }

  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const headers = new Headers(options.headers);

  let body: string | undefined = undefined;
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof options.body === "string") {
      body = options.body;
    } else {
      body = JSON.stringify(options.body);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }
  }

  return new NextRequest(target.toString(), {
    method,
    headers,
    body,
  });
}
