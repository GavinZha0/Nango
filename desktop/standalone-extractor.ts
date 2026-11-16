/**
 * Automated runtime extraction and junction materialization for Nango Desktop.
 *
 * Background:
 * electron-builder and Windows NSIS cannot package or extract complex .pnpm
 * directory symlink farms without admin privileges (Developer Mode) or without
 * electron-builder's createFilter dropping the root node_modules directory.
 *
 * Solution:
 * The standalone runtime is packaged as a single `resources/standalone.tar`
 * archive. On first run (or version update), this module unpacks the archive into
 * `<userData>/runtime/standalone`, materializes all symlinks as Windows Junctions
 * (which require no admin/developer permissions) on Windows or native symlinks on
 * POSIX in a two-pass algorithm, and writes a `.version` marker.
 *
 * Subsequent boots match the marker and start instantly (0ms delay).
 *
 * See docs/desktop-architecture.md.
 */

import fs from "node:fs";
import path from "node:path";
import { Parser, type ReadEntry } from "tar";

export interface ExtractStandaloneOptions {
  userDataDir: string;
  resourcesPath: string;
  appVersion: string;
  onProgress?: (msg: string) => void;
}

/**
 * Ensure the Next.js standalone runtime directory exists, is up-to-date with
 * `appVersion`, and has all dependency symlinks/junctions materialized.
 */
export async function ensureStandaloneExtracted(
  opts: ExtractStandaloneOptions,
): Promise<string> {
  const runtimeDir = path.join(opts.userDataDir, "runtime", "standalone");
  const markerFile = path.join(runtimeDir, ".version");

  // Fast path: if already extracted for this exact version, return immediately.
  if (fs.existsSync(markerFile)) {
    try {
      const recordedVersion = fs.readFileSync(markerFile, "utf8").trim();
      if (recordedVersion === opts.appVersion) {
        return runtimeDir;
      }
    } catch {
      // Re-extract on read error
    }
  }

  const tarPath = path.join(opts.resourcesPath, "standalone.tar");
  // Fallback for unpackaged local development mode if standalone.tar does not exist
  if (!fs.existsSync(tarPath)) {
    const rawStandalone = path.join(opts.resourcesPath, "standalone");
    if (fs.existsSync(rawStandalone)) {
      return rawStandalone;
    }
    throw new Error(
      `Neither ${tarPath} nor ${rawStandalone} exists. Run 'pnpm desktop:build-standalone' first.`,
    );
  }

  opts.onProgress?.(`Extracting standalone runtime (v${opts.appVersion})...`);

  // Clean runtime directory before extraction
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const runtimeRoot = path.resolve(runtimeDir);
  const deferredSymlinks: Array<{ destPath: string; linkpath: string }> = [];
  const fileWrites: Array<Promise<void>> = [];

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(tarPath);
    const parser = new Parser({
      onReadEntry(entry: ReadEntry) {
        const destPath = path.resolve(runtimeRoot, entry.path);
        // SECURITY: Guard against path traversal / zip-slip entries escaping runtimeDir.
        if (
          destPath !== runtimeRoot &&
          !destPath.startsWith(runtimeRoot + path.sep)
        ) {
          entry.resume();
          stream.destroy();
          reject(
            new Error(`Refusing tar entry outside runtimeDir: ${entry.path}`),
          );
          return;
        }
        if (entry.type === "Directory") {
          fs.mkdirSync(destPath, { recursive: true });
          entry.resume();
        } else if (entry.type === "File") {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          const out = fs.createWriteStream(destPath);
          fileWrites.push(
            new Promise<void>((res, rej) => {
              out.on("finish", res);
              out.on("error", rej);
            }),
          );
          entry.pipe(out);
        } else if (entry.type === "SymbolicLink") {
          if (entry.linkpath) {
            deferredSymlinks.push({ destPath, linkpath: entry.linkpath });
          }
          entry.resume();
        } else {
          entry.resume();
        }
      },
    });

    stream.on("error", reject);
    parser.on("error", reject);
    parser.on("finish", () => {
      resolve();
    });

    stream.pipe(parser);
  });

  // Wait for all streamed file writes to finish flush to disk
  await Promise.all(fileWrites);

  // Two-pass symlink materialization: all target files/directories exist now.
  if (process.platform === "win32") {
    let pending = deferredSymlinks;
    while (pending.length > 0) {
      const nextPending: typeof deferredSymlinks = [];
      let progressed = false;

      for (const entry of pending) {
        const { destPath, linkpath } = entry;
        const targetAbs = path.resolve(path.dirname(destPath), linkpath);

        let isFileTarget: boolean;
        try {
          isFileTarget = fs.statSync(targetAbs).isFile();
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            // Target may be a chained symlink not yet materialized, or a dangling
            // symlink (e.g. untraced optional peer dependency). Defer to next pass.
            nextPending.push(entry);
            continue;
          }
          throw err;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try {
          fs.unlinkSync(destPath);
        } catch {
          // Ignored
        }

        // Windows junctions only support directories; copy file targets instead
        // so file symlinks (e.g. `.bin` shims) never abort extraction.
        if (isFileTarget) {
          fs.copyFileSync(targetAbs, destPath);
        } else {
          fs.symlinkSync(targetAbs, destPath, "junction");
        }
        progressed = true;
      }

      if (!progressed) {
        // Remaining entries have genuinely missing targets (dangling symlinks);
        // skip them so untraced optional peer symlinks never block app startup.
        break;
      }
      pending = nextPending;
    }
  } else {
    for (const { destPath, linkpath } of deferredSymlinks) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        fs.unlinkSync(destPath);
      } catch {
        // Ignored
      }
      fs.symlinkSync(linkpath, destPath);
    }
  }

  // Atomically mark completion with version string
  fs.writeFileSync(markerFile, opts.appVersion, "utf8");

  return runtimeDir;
}
