import { beforeEach, describe, expect, it } from "vitest";
import { useOutcomeStore, type SlideBlock } from "@/store/outcome-store";

describe("outcome-store: upsertSlideOutcome", () => {
  beforeEach(() => {
    useOutcomeStore.getState().clearForThreadSwitch();
  });

  it("handles normal sequential append (base first, then append)", () => {
    const store = useOutcomeStore.getState();

    // 1. Initial base card
    store.upsertSlideOutcome({
      outcomeId: "deck-1",
      title: "Quarterly Review",
      doc: { format: "bento/slides", slides: [{ id: "slide-1" }] },
      append: false,
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    let outcomes = useOutcomeStore.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.title).toBe("Quarterly Review");
    let block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(1);
    expect(block.appliedToolCallIds).toEqual(["call-1"]);

    // 2. Append card
    useOutcomeStore.getState().upsertSlideOutcome({
      outcomeId: "deck-1",
      title: "Batch 2",
      doc: { format: "bento/slides", slides: [{ id: "slide-2" }] },
      append: true,
      toolCallId: "call-2",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    outcomes = useOutcomeStore.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.title).toBe("Quarterly Review"); // Preserves base title
    block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(2);
    expect(block.appliedToolCallIds).toEqual(["call-1", "call-2"]);
  });

  it("handles out-of-order arrival (append card mounts first, base card arrives later)", () => {
    const store = useOutcomeStore.getState();

    // 1. Append card arrives FIRST (out-of-order)
    store.upsertSlideOutcome({
      outcomeId: "deck-ooo",
      title: "Batch 2 Subtitle",
      doc: { format: "bento/slides", slides: [{ id: "slide-2" }] },
      append: true,
      toolCallId: "call-2",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    let outcomes = useOutcomeStore.getState().outcomes;
    // Surfaced immediately so Outcomes panel is never blank
    expect(outcomes).toHaveLength(1);
    let block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(1);
    expect(block.appliedToolCallIds).toEqual(["call-2"]);

    // 2. Base card arrives LATER
    useOutcomeStore.getState().upsertSlideOutcome({
      outcomeId: "deck-ooo",
      title: "Main Presentation Title",
      doc: { format: "bento/slides", slides: [{ id: "slide-1" }] },
      append: false,
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    outcomes = useOutcomeStore.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.title).toBe("Main Presentation Title"); // Accurately resolves to Base title
    block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.title).toBe("Main Presentation Title");
    const slides = block.doc.slides as Array<{ id: string }>;
    expect(slides).toHaveLength(2);
    // Base slide is prepended at index 0, append slide follows at index 1
    expect(slides[0]?.id).toBe("slide-1");
    expect(slides[1]?.id).toBe("slide-2");
    expect(block.appliedToolCallIds).toEqual(["call-1", "call-2"]);
  });

  it("is strictly idempotent on duplicate toolCallId calls (remounts & StrictMode)", () => {
    const store = useOutcomeStore.getState();

    // 1. Initial
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck",
      doc: { slides: [{ id: "s-1" }] },
      append: false,
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 2. Append
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck",
      doc: { slides: [{ id: "s-2" }] },
      append: true,
      toolCallId: "call-2",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 3. Duplicate invoke of call-2 (e.g. component remount)
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck",
      doc: { slides: [{ id: "s-2" }] },
      append: true,
      toolCallId: "call-2",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 4. Duplicate invoke of call-1
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck",
      doc: { slides: [{ id: "s-1" }] },
      append: false,
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    const outcomes = useOutcomeStore.getState().outcomes;
    const block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(2); // Still 2, no duplicates!
    expect(block.appliedToolCallIds).toEqual(["call-1", "call-2"]);
  });

  it("cleans up completely on clearForThreadSwitch", () => {
    const store = useOutcomeStore.getState();

    store.upsertSlideOutcome({
      outcomeId: "deck-switch",
      title: "Deck",
      doc: { slides: [{ id: "s-1" }] },
      append: false,
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-A",
      runId: null,
    });

    expect(useOutcomeStore.getState().outcomes).toHaveLength(1);

    store.clearForThreadSwitch();
    expect(useOutcomeStore.getState().outcomes).toHaveLength(0);
  });
});
