/**
 * Pure relative-path primitives shared by every subsystem that stores a path
 * string (skill helper files, knowledge pages).
 *
 * No server-only imports: this module is safe in the client bundle.
 */

export function getBaseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function getParentPath(path: string): string {
  const slash: number = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Lower-cased trailing extension, or "" for dot-files and extension-less names. */
export function getExtension(name: string): string {
  const base: string = getBaseName(name);
  const dot: number = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * A stored path as a URL segment: every segment encoded, separators kept
 * literal so the server's catch-all splits them back the same way.
 *
 * QUIRK: `encodeURI` is not enough — `#` and `?` are legal in a page or file
 * name and would truncate the request at the server instead of naming it.
 */
export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
