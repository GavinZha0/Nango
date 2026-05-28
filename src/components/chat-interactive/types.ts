/**
 * Shared types for HITL (Human-in-the-Loop) interactive render components.
 *
 * `useHumanInTheLoop` from CopilotKit v2 delivers render props as a
 * discriminated union keyed on `status`. `result` is a **top-level**
 * field (type `string` when complete), NOT inside `args`.
 *
 * The generic `HitlRenderProps<T>` below is a local alias — CopilotKit
 * does not export a named type for this shape.
 */

/** Render-prop union passed to every HITL render component. */
export type HitlRenderProps<T> =
  | {
      name: string;
      args: Partial<T>;
      status: "inProgress";
      result: undefined;
      respond: undefined;
    }
  | {
      name: string;
      args: T;
      status: "executing";
      result: undefined;
      respond: (value: unknown) => Promise<void>;
    }
  | {
      name: string;
      args: T;
      status: "complete";
      result: string;
      respond: undefined;
    };
