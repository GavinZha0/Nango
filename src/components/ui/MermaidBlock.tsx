"use client";

/**
 * MermaidBlock — renders a mermaid diagram from a fenced code block.
 */

import { useEffect, useMemo, useRef, useState } from "react";

interface MermaidBlockProps {
  code: string;
}

/** Simple djb2 hash → base-36 string, safe for use as an HTML id. */
function hashCode(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return "mermaid-" + (h >>> 0).toString(36);
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const id = useMemo(() => hashCode(code), [code]);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  // Keep a ref of the id used in the last successful render so mermaid
  // doesn't complain about re-using the same element id.
  const renderedId = useRef<string>("");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "loose",
        });
        // Remove any leftover SVG element from a previous render with the same id
        if (renderedId.current) {
          document.getElementById(renderedId.current)?.remove();
        }
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          renderedId.current = id;
          setSvg(rendered);
          setError("");
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (error) {
    return (
      <pre className="rounded bg-destructive/10 p-3 text-xs text-destructive">
        {`Mermaid error: ${error}`}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <span className="animate-pulse">Rendering diagram…</span>
      </div>
    );
  }

  return (
    <div
      className="my-2 overflow-x-auto rounded border bg-white p-4 dark:bg-zinc-900"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
