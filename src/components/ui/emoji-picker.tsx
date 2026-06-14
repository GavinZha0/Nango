"use client";

/**
 * EmojiPicker — full-catalog selector for agent / resource icons.
 * Wraps `emoji-picker-react` in NATIVE mode (OS emoji font, no CDN
 * fetches, matches how list views render the persisted glyph)
 * behind the project's `DropdownMenu`.
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

// `emoji-picker-react` reads `document` at import time → client-only
// via dynamic + ssr:false. Enum values are kept out of the server
// bundle by importing types only and using `as` casts at the call
// site (the library reads the underlying string at runtime).
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
  /** Popover alignment vs. trigger. `"end"` (default) grows the panel
   *  leftward — best when the trigger sits at the right end of a row. */
  align?: "start" | "end" | "center";
}

/**
 * Emoji font fallback chain — matches list-view renderers so the same
 * glyph is drawn identically inside the picker and in agent rows.
 */
const EMOJI_FONT_STACK: string =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif';

/** Category list (in display order). Omits `SUGGESTED` — agent
 *  icons are picked rarely, so a "Frequently Used" lane is noise. */
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
          // Emoji glyphs render small vs Latin at the same px size.
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
        // Strip default padding / max-width so the picker's chrome
        // controls its own layout.
        className="w-auto max-w-none border-none bg-transparent p-0 shadow-none"
      >
        <div className="flex flex-col gap-1.5">
          {/* `emojiStyle="native"` keeps glyph rendering offline. */}
          <Picker
            onEmojiClick={handlePick}
            emojiStyle={"native" as EmojiStyle}
            theme={(resolvedTheme === "dark" ? "dark" : "light") as Theme}
            lazyLoadEmojis
            // Library defaults are ~350×450 — too big for a popover.
            height={360}
            width={300}
            skinTonesDisabled
            searchDisabled
            // The hovered-glyph preview row eats ~50px without value.
            previewConfig={{ showPreview: false }}
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
