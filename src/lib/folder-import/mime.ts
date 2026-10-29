/**
 * Extension → content-type for the files a folder import plausibly carries.
 *
 * Shared because both a skill helper file and a knowledge page store a MIME
 * hint derived from the same author-supplied name.
 *
 * No server-only imports: the editor previews use this too.
 */

import { getExtension } from "@/lib/paths";

/**
 * SECURITY: deliberately no `text/html` and no `image/svg+xml`. The editor
 * builds a `data:` URL from this value and offers it both as an `<img src>`
 * and as a download `href`; an author-controlled folder could otherwise
 * smuggle a markup document into a link the UI invites the user to click.
 * Unknown extensions fall through to null, which renders as an inert
 * binary card rather than a guessed type.
 */
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  ipynb: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  xml: "text/xml",
  sql: "text/plain",
  py: "text/x-python",
  pyi: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Guess a stored content-type from the file extension; null when the extension
 * is absent or unknown.
 *
 * CONTRACT: advisory only. The text-vs-binary decision is made by a NUL-byte
 * scan of the actual content, never by this value, so a wrong guess can only
 * mislabel a file — it cannot make binary bytes render as text.
 */
export function guessContentType(path: string): string | null {
  const ext: string = getExtension(path);
  return ext.length === 0 ? null : (CONTENT_TYPES[ext] ?? null);
}
