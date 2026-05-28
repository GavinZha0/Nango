"use client";

/**
 * EmojiPicker — full-catalog emoji selector for agent / resource icons.
 *
 * Wraps `emoji-picker-react` in NATIVE mode behind the project's
 * `DropdownMenu` so the trigger and popover behaviour match every
 * other floating panel in the app. NATIVE mode means the picker
 * renders glyphs with the OS native emoji font instead of downloading
 * Apple/Google/Twitter emoji images, which:
 *
 *   - Keeps the project usable on enterprise networks (no jsdelivr
 *     fetches; everything ships with the bundle).
 *   - Eliminates any HTTP traffic for emoji rendering.
 *   - Matches the storage choice: we persist the raw Unicode glyph
 *     (e.g. "🤖") in DB and render it with `<span>{value}</span>` in
 *     list views, so the picker should use the same glyph rendering
 *     pipeline for visual consistency.
 *
 * The library's own data set drives categories (Smileys & People,
 * Animals & Nature, Food & Drink, Travel, Activities, Objects,
 * Symbols, Flags) and search — we don't curate the list ourselves.
 */

import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { type ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// `emoji-picker-react` reads `document` / `window` at import time, so
// it has to render client-only. Dynamic-importing with ssr:false keeps
// it out of the server bundle and prevents hydration warnings; the
// loading state shows a tiny inline placeholder while the chunk loads.
//
// Only the type `EmojiClickData` is imported (`import type`) so it's
// erased at build time. EmojiStyle / Theme are string enums, but
// importing their *values* would pull the library into the server
// bundle just to access "native" / "dark" / "light" — so we pass those
// as string literals with a narrow `as` cast instead. The library
// happily accepts the underlying string at runtime.
import type {
  Categories,
  EmojiClickData,
  EmojiStyle,
  Theme,
} from "emoji-picker-react";

const Picker = dynamic(() => import("emoji-picker-react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[320px] w-[300px] items-center justify-center text-xs text-muted-foreground">
      Loading emojis…
    </div>
  ),
});

interface EmojiPickerProps {
  /** Current emoji character, or null/undefined for "no icon". */
  value?: string | null;
  /** Called with the picked emoji character (raw Unicode glyph). */
  onChange: (next: string) => void;
  /**
   * Called when the user wants to clear the selection. If omitted,
   * the clear control is hidden — useful for required-icon fields.
   */
  onClear?: () => void;
  /** Glyph shown in the trigger when value is empty. Default "+". */
  placeholderGlyph?: string;
  /** Disable the trigger (read-only contexts). */
  disabled?: boolean;
  /** Trigger button size in px. Default 32. */
  size?: number;
  /** Extra classes on the trigger button. */
  className?: string;
  /** Accessibility label for the trigger. */
  ariaLabel?: string;
  /**
   * Where the popover sits relative to the trigger:
   *   - `"end"`   (default) — right edge of popover aligns with right
   *     edge of trigger, so the panel grows to the LEFT. Best when the
   *     picker sits at the right end of a row (the common case in the
   *     agent editor's Name field).
   *   - `"start"` — left edge aligns with trigger's left edge; panel
   *     grows to the RIGHT. Use when the picker is the leading control.
   *   - `"center"` — popover is centered under the trigger.
   */
  align?: "start" | "end" | "center";
}

/**
 * Emoji font fallback chain — matches list-view renderers so the same
 * glyph is drawn identically inside the picker and in agent rows.
 */
const EMOJI_FONT_STACK: string =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif';

/**
 * Category list passed to `emoji-picker-react`. The library shows
 * categories in this order; omitting `SUGGESTED` (= "Frequently Used")
 * hides that section entirely, which is what we want — agent icons
 * don't benefit from a "your recent picks" lane.
 *
 * String literal values match the `Categories` string-enum from the
 * library. We use `as Categories` casts instead of importing the enum
 * values so the enum's runtime code never enters the server bundle.
 */
const PICKER_CATEGORIES: Array<{ category: Categories; name: string }> = [
  { category: "smileys_people" as Categories, name: "Smileys & People" },
  { category: "animals_nature" as Categories, name: "Animals & Nature" },
  { category: "food_drink" as Categories, name: "Food & Drink" },
  { category: "travel_places" as Categories, name: "Travel & Places" },
  { category: "activities" as Categories, name: "Activities" },
  { category: "objects" as Categories, name: "Objects" },
  { category: "symbols" as Categories, name: "Symbols" },
  { category: "flags" as Categories, name: "Flags" },
];

export function EmojiPicker({
  value,
  onChange,
  onClear,
  placeholderGlyph = "+",
  disabled = false,
  size = 32,
  className,
  ariaLabel = "Pick an icon",
  align = "end",
}: EmojiPickerProps): ReactNode {
  const { resolvedTheme } = useTheme();
  const display: string = value && value.length > 0 ? value : placeholderGlyph;

  function handlePick(data: EmojiClickData): void {
    // `data.emoji` is the raw Unicode glyph — exactly what we store.
    onChange(data.emoji);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md border border-input bg-background transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Emoji glyphs render visually smaller than Latin characters
          // at the same px size, so we bump the trigger font to text-xl
          // (20px) on the default 32px square. The container size stays
          // unchanged — only the inner glyph grows.
          "text-xl leading-none",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <span aria-hidden style={{ fontFamily: EMOJI_FONT_STACK }}>
          {display}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        // Strip default padding / max-width so the picker's own chrome
        // (search bar, category strip, scrollable grid) controls its
        // layout end-to-end. Otherwise the inner Picker fights the
        // DropdownMenu's max-w-(--radix-…)/padding.
        className="w-auto max-w-none border-none bg-transparent p-0 shadow-none"
      >
        <div className="flex flex-col gap-1.5">
          {/* `emojiStyle="native"` is the critical bit: render with
              system fonts, never fetch image assets. The library still
              bundles its own emoji metadata (codepoint + name +
              category) so search and grouping work without network. */}
          <Picker
            onEmojiClick={handlePick}
            emojiStyle={"native" as EmojiStyle}
            theme={(resolvedTheme === "dark" ? "dark" : "light") as Theme}
            lazyLoadEmojis
            // Compact dimensions so it fits well inside a sidebar /
            // popover. The library's defaults are ~350×450 which is
            // huge for our use case.
            height={360}
            width={300}
            // Skin-tone picker not useful for "agent icons" and adds
            // clutter — hide it.
            skinTonesDisabled
            // Hide the bottom preview row (large hovered glyph + name +
            // codepoints). The grid already renders the glyphs at a
            // comfortable size, so the preview is redundant noise and
            // it also takes ~50 px of vertical space that's better
            // given to the grid itself.
            previewConfig={{ showPreview: false }}
            // Explicit category list — drops the default "Frequently
            // Used" (SUGGESTED) section. Agent icons are picked once
            // per agent and rarely re-picked, so a recents lane adds
            // clutter without value. The rest of the categories keep
            // their natural order.
            categories={PICKER_CATEGORIES}
          />
          {onClear && value && value.length > 0 && (
            <div className="flex justify-end rounded-md border bg-popover px-2 py-1.5">
              <button
                type="button"
                onClick={onClear}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Clear icon
              </button>
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Default emoji used when an agent / resource hasn't picked one.
 * Centralised so list views, chat headers, etc. agree on the fallback.
 */
export const DEFAULT_AGENT_ICON: string = "🤖";

/**
 * Resolve an optional icon value to a guaranteed glyph for rendering.
 * Use this on the read side so list views render uniformly while the
 * write side preserves null in the DB ("not chosen").
 */
export function resolveAgentIcon(value?: string | null): string {
  return value && value.length > 0 ? value : DEFAULT_AGENT_ICON;
}
