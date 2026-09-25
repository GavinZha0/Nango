import { describe, it, expect } from "vitest";
import {
  normalizeBentoDoc,
  assembleBentoHtml,
} from "@/lib/bento/template";

describe("bento template & normalization", () => {
  describe("normalizeBentoDoc", () => {
    it("defensively populates missing top-level metadata (theme, size, version, format)", () => {
      const bareDoc = {
        slides: [
          {
            elements: [{ type: "text", text: "Hello" }],
          },
        ],
      };

      const normalized = normalizeBentoDoc(bareDoc) as {
        format: string;
        version: number;
        size: { width: number; height: number };
        theme: {
          background: string;
          color: string;
          accent: string;
          palette: Record<string, unknown>;
        };
      };

      expect(normalized.format).toBe("bento/slides");
      expect(normalized.version).toBe(1);
      expect(normalized.size).toEqual({ width: 1280, height: 720 });
      expect(normalized.theme).toBeDefined();
      expect(normalized.theme.background).toBeDefined();
      expect(normalized.theme.color).toBeDefined();
      expect(normalized.theme.accent).toBeDefined();
      expect(normalized.theme.palette).toBeDefined();
    });

    it("preserves custom theme and size properties", () => {
      const customDoc = {
        format: "bento/slides",
        size: { width: 1920, height: 1080 },
        theme: {
          background: "#111111",
          color: "#FAFAFA",
          accent: "#E11D48",
          fontFamily: "CustomFont",
        },
        slides: [{ id: "s1" }],
      };

      const normalized = normalizeBentoDoc(customDoc) as {
        size: { width: number; height: number };
        theme: {
          background: string;
          color: string;
          accent: string;
          fontFamily: string;
          palette: Record<string, unknown>;
        };
      };

      expect(normalized.size).toEqual({ width: 1920, height: 1080 });
      expect(normalized.theme.background).toBe("#111111");
      expect(normalized.theme.color).toBe("#FAFAFA");
      expect(normalized.theme.accent).toBe("#E11D48");
      expect(normalized.theme.fontFamily).toBe("CustomFont");
      expect(normalized.theme.palette).toEqual({});
    });

    it("normalizes text element text property to html", () => {
      const doc = {
        slides: [
          {
            elements: [
              {
                id: "t1",
                type: "text",
                text: "Hello World",
              },
            ],
          },
        ],
      };

      const normalized = normalizeBentoDoc(doc) as {
        slides: Array<{
          elements: Array<{
            type: string;
            html: string;
            lineHeight: number;
            align: string;
          }>;
        }>;
      };
      const el = normalized.slides[0]!.elements[0]!;

      expect(el.type).toBe("text");
      expect(el.html).toBe("Hello World");
      expect(el.lineHeight).toBe(1.2);
      expect(el.align).toBe("left");
    });

    it("normalizes shorthand shape types and ensures strokeWidth is a number", () => {
      const doc = {
        slides: [
          {
            elements: [
              {
                id: "r1",
                type: "rect",
                color: "#10B981",
                borderRadius: 4,
              },
            ],
          },
        ],
      };

      const normalized = normalizeBentoDoc(doc) as {
        slides: Array<{
          elements: Array<{
            type: string;
            shape: string;
            fill: string;
            strokeWidth: number;
            stroke: string;
            radius: number;
            rotation: number;
            opacity: number;
          }>;
        }>;
      };
      const el = normalized.slides[0]!.elements[0]!;

      expect(el.type).toBe("shape");
      expect(el.shape).toBe("rect");
      expect(el.fill).toBe("#10B981");
      expect(el.strokeWidth).toBe(0);
      expect(el.stroke).toBe("transparent");
      expect(el.radius).toBe(4);
      expect(el.rotation).toBe(0);
      expect(el.opacity).toBe(1);
    });
  });

  describe("assembleBentoHtml", () => {
    it("assembles valid HTML with normalized JSON in #bento-doc", () => {
      const doc = {
        slides: [
          {
            id: "slide-1",
            elements: [
              {
                id: "title",
                type: "text",
                html: "Bento Presentation",
              },
            ],
          },
        ],
      };

      const html = assembleBentoHtml(doc);

      expect(html).toContain('id="bento-doc"');
      expect(html).toContain("Bento Presentation");
      expect(html).toContain('"format":"bento/slides"');
      expect(html).toContain('"theme":{');
      expect(html).toContain('"palette":{');
    });

    it("escapes '<' inside JSON as '\\u003c'", () => {
      const doc = {
        slides: [
          {
            elements: [
              {
                type: "text",
                html: "<b>Bold text</b> & <script>alert(1)</script>",
              },
            ],
          },
        ],
      };

      const html = assembleBentoHtml(doc);

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("\\u003cscript>alert(1)\\u003c/script>");
    });

    it("populates doc.title from fallbackTitle when missing", () => {
      const doc = {
        slides: [{ elements: [{ type: "text", html: "Slide" }] }],
      };

      const html = assembleBentoHtml(doc, "My Custom Presentation Title");

      expect(html).toContain('"title":"My Custom Presentation Title"');
    });

    it("preserves explicit doc.title over fallbackTitle", () => {
      const doc = {
        title: "Explicit Title",
        slides: [{ elements: [{ type: "text", html: "Slide" }] }],
      };

      const html = assembleBentoHtml(doc, "Fallback Title");

      expect(html).toContain('"title":"Explicit Title"');
      expect(html).not.toContain('"title":"Fallback Title"');
    });

    it("injects preview CSS and disables stage pointer events when mode is 'preview'", () => {
      const doc = {
        slides: [{ id: "slide-1", elements: [] }],
      };

      const html = assembleBentoHtml(doc, { mode: "preview" });

      expect(html).toContain('id="nango-bento-preview"');
      expect(html).toContain(".ed-topbar, .ed-props, .ed-main > .ed-resizer:last-of-type { display: none !important; }");
      expect(html).toContain(".ed-stage { pointer-events: none !important; }");
      expect(html).toContain('id="nango-bento-bridge"');
    });

    it("defaults to mode 'preview' when options is a string or omitted", () => {
      const doc = {
        slides: [{ id: "slide-1", elements: [] }],
      };

      const htmlDefault = assembleBentoHtml(doc);
      expect(htmlDefault).toContain('id="nango-bento-preview"');

      const htmlWithTitle = assembleBentoHtml(doc, "Deck Title");
      expect(htmlWithTitle).toContain('id="nango-bento-preview"');
      expect(htmlWithTitle).toContain('"title":"Deck Title"');
    });

    it("injects edit CSS to hide broken sandboxed buttons in mode 'edit'", () => {
      const doc = {
        slides: [{ id: "slide-1", elements: [] }],
      };

      const html = assembleBentoHtml(doc, {
        fallbackTitle: "Editable Deck",
        mode: "edit",
      });

      expect(html).not.toContain('id="nango-bento-preview"');
      expect(html).toContain('id="nango-bento-edit"');
      expect(html).toContain(".ed-group-right { display: none !important; }");
      expect(html).toContain('id="nango-bento-bridge"');
      expect(html).toContain("nango:get-doc");
      expect(html).toContain('"title":"Editable Deck"');
    });

    it("does not inject any override styles in mode 'standalone'", () => {
      const doc = {
        slides: [{ id: "slide-1", elements: [] }],
      };

      const html = assembleBentoHtml(doc, {
        fallbackTitle: "Exported Deck",
        mode: "standalone",
      });

      expect(html).not.toContain('id="nango-bento-preview"');
      expect(html).not.toContain('id="nango-bento-edit"');
      expect(html).toContain('id="nango-bento-bridge"');
      expect(html).toContain('"title":"Exported Deck"');
    });
  });
});
