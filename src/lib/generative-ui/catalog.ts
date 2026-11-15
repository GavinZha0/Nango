/**
 * Isomorphic Generative UI (A2UI) component catalog constants & helpers.
 *
 * Kept free of `@copilotkit/*` and React imports so server routes,
 * `config/defaults.ts`, and client components can share the exact same
 * component names and parsing logic without pulling CopilotKit CSS.
 */

export const GENERATIVE_UI_CONFIG_KEY = "generative_ui.enabled_components";

/** All 68 components exposed by `@copilotkit/react-core/v2/generative-ui` `standardUI`. */
export const STANDARD_UI_COMPONENT_NAMES = [
  "Box",
  "Column",
  "Row",
  "Grid",
  "GridItem",
  "Card",
  "Flow",
  "FlowItem",
  "Carousel",
  "CarouselItem",
  "CarouselMediaItem",
  "Spacer",
  "Divider",
  "Tabs",
  "Title",
  "Text",
  "Caption",
  "Label",
  "Bold",
  "Italic",
  "Underline",
  "Strikethrough",
  "Badge",
  "Blockquote",
  "Code",
  "Markdown",
  "Math",
  "ShimmerText",
  "Link",
  "Button",
  "Pressable",
  "Form",
  "TextField",
  "TextArea",
  "Select",
  "CheckBox",
  "Radio",
  "RadioGroup",
  "Slider",
  "SegmentedControl",
  "ChoicePicker",
  "DateTimeInput",
  "PulseIndicator",
  "FlashcardFlip",
  "Popover",
  "PopoverTrigger",
  "PopoverContent",
  "Modal",
  "Table",
  "TableSection",
  "TableRow",
  "TableCell",
  "List",
  "ListItem",
  "Chart",
  "Map",
  "Image",
  "Icon",
  "Favicon",
  "Svg",
  "Video",
  "AudioPlayer",
  "HtmlView",
  "LinkCard",
  "Citation",
  "FollowUp",
  "EntityCard",
  "ImageGrid",
] as const;

export type StandardUiComponentName = (typeof STANDARD_UI_COMPONENT_NAMES)[number];

const VALID_COMPONENT_SET: ReadonlySet<string> = new Set(STANDARD_UI_COMPONENT_NAMES);

/** Default 15 commonly used layout, typography, table, and chart components. */
export const DEFAULT_GENERATIVE_UI_COMPONENTS: readonly StandardUiComponentName[] = [
  "Card",
  "Grid",
  "GridItem",
  "Column",
  "Row",
  "Tabs",
  "Table",
  "TableSection",
  "TableRow",
  "TableCell",
  "Chart",
  "Markdown",
  "Title",
  "Text",
  "Badge",
];

/** Parse a comma-separated component list from `config` into valid component names. */
export function parseGenerativeUiComponents(
  raw: string | null | undefined,
): StandardUiComponentName[] {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<StandardUiComponentName>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (VALID_COMPONENT_SET.has(trimmed)) {
      seen.add(trimmed as StandardUiComponentName);
    }
  }
  return [...seen];
}

/** Serialize selected component names in canonical catalog order. */
export function serializeGenerativeUiComponents(
  names: readonly string[],
): string {
  const selected = new Set(names);
  return STANDARD_UI_COMPONENT_NAMES.filter((n) => selected.has(n)).join(",");
}
