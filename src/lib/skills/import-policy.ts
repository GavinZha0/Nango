/**
 * Skill-file import policy.
 *
 * The open Agent Skills spec permits any files, but Nango can only execute
 * `.py` / `.sh` scripts and preview images. Everything else is either inert or
 * a storage/security liability, so the import pipeline uses an allowlist.
 *
 * The lists themselves — noise, text, image, blocked — are the shared
 * {@link classifyFolderPath}, because a knowledge import reads exactly the same
 * bytes as text and two copies of a rejection table only get to disagree. What
 * is skills-specific is the consequence: an image is a real asset here (a
 * preview, a script's fixture), and the editor's create/rename rules.
 *
 * Client-safe: the editor's Add/Rename dialogs use the same rules.
 */

import { getExtension } from "@/lib/paths";
import {
  classifyFolderPath,
  type FilePolicyResult,
} from "@/lib/folder-import/manifest";

/**
 * Classify a path entering a skill import.
 *
 * `ignore` entries are noise a directory tree always carries (dotfiles,
 * caches, OS metadata) and are skipped with a report.
 * `block` entries reject the whole import with a reason.
 */
export function classifyImportPath(path: string): FilePolicyResult {
  return classifyFolderPath(path);
}

/** Editor creation is text-only; binary assets must be imported. */
export function classifyEditorCreatePath(path: string): FilePolicyResult {
  const result = classifyImportPath(path);
  if (result.action === "allow-image") {
    return {
      action: "block",
      reason:
        "Images and other binary assets must be added through a folder import.",
    };
  }
  if (result.action === "ignore") {
    return {
      action: "block",
      reason: "This name is reserved for generated or OS noise; choose another file name.",
    };
  }
  return result;
}

/** Renaming may keep text or image files; blocked/noise types are refused. */
export function classifyEditorRenamePath(path: string): FilePolicyResult {
  const result = classifyImportPath(path);
  if (result.action === "ignore") {
    return { action: "block", reason: "That path is generated or OS noise and cannot be used." };
  }
  return result;
}

function ascii(content: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...content.subarray(start, end));
}

/** Verify image magic bytes so a renamed executable cannot slip through. */
export function validateImageBytes(
  path: string,
  content: Uint8Array,
): string | null {
  const ext = getExtension(path);
  if (content.length < 4) {
    return "Image content is too short to be a valid image.";
  }

  if (ext === "png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ok =
      content.length >= signature.length &&
      signature.every((byte, i) => content[i] === byte);
    return ok ? null : "PNG content does not match its extension.";
  }
  if (ext === "jpg" || ext === "jpeg") {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
      ? null
      : "JPEG content does not match its extension.";
  }
  if (ext === "gif") {
    const header = ascii(content, 0, 6);
    return header === "GIF87a" || header === "GIF89a"
      ? null
      : "GIF content does not match its extension.";
  }
  if (ext === "webp") {
    const ok =
      content.length >= 12 &&
      ascii(content, 0, 4) === "RIFF" &&
      ascii(content, 8, 12) === "WEBP";
    return ok ? null : "WEBP content does not match its extension.";
  }
  if (ext === "ico") {
    const ok =
      content[0] === 0x00 &&
      content[1] === 0x00 &&
      content[2] === 0x01 &&
      content[3] === 0x00;
    return ok ? null : "ICO content does not match its extension.";
  }
  return null;
}
