import { beforeEach, describe, expect, it } from "vitest";
import { useOutcomeStore, type SlideBlock } from "@/store/outcome-store";

describe("outcome-store: upsertSlideOutcome", () => {
  beforeEach(() => {
    useOutcomeStore.getState().clearForThreadSwitch();
  });

  it("initializes a new deck and overwrites on subsequent generate call with same outcomeId", () => {
    const store = useOutcomeStore.getState();

    // 1. Initial deck
    store.upsertSlideOutcome({
      outcomeId: "deck-1",
      title: "Quarterly Review",
      doc: { format: "bento/slides", slides: [{ id: "slide-1" }] },
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

    // 2. Re-generating same outcomeId overwrites entire deck
    useOutcomeStore.getState().upsertSlideOutcome({
      outcomeId: "deck-1",
      title: "Quarterly Review v2",
      doc: { format: "bento/slides", slides: [{ id: "new-slide-1" }, { id: "new-slide-2" }] },
      toolCallId: "call-2",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    outcomes = useOutcomeStore.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.title).toBe("Quarterly Review v2");
    block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(2);
    expect(block.appliedToolCallIds).toEqual(["call-2"]);
  });

  it("is strictly idempotent on duplicate toolCallId calls (remounts & StrictMode)", () => {
    const store = useOutcomeStore.getState();

    // 1. Initial
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck",
      doc: { slides: [{ id: "s-1" }] },
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 2. Duplicate invoke of call-1
    store.upsertSlideOutcome({
      outcomeId: "deck-dup",
      title: "Deck Overwritten?",
      doc: { slides: [{ id: "s-1-different" }] },
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    const outcomes = useOutcomeStore.getState().outcomes;
    const block = outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toEqual([{ id: "s-1" }]); // Short-circuits, preserves original
    expect(block.appliedToolCallIds).toEqual(["call-1"]);
  });

  it("cleans up completely on clearForThreadSwitch", () => {
    const store = useOutcomeStore.getState();

    store.upsertSlideOutcome({
      outcomeId: "deck-switch",
      title: "Deck",
      doc: { slides: [{ id: "s-1" }] },
      toolCallId: "call-1",
      agentId: "agent-1",
      threadId: "thread-A",
      runId: null,
    });

    store.clearForThreadSwitch();
    expect(useOutcomeStore.getState().outcomes).toHaveLength(0);
  });
});

describe("outcome-store: applySlideEditOutcome", () => {
  beforeEach(() => {
    useOutcomeStore.getState().clearForThreadSwitch();
  });

  it("applies delete, replace, and insert with idempotency guard", () => {
    const store = useOutcomeStore.getState();

    // 1. Initial deck
    store.upsertSlideOutcome({
      outcomeId: "deck-edit",
      title: "Interactive Presentation",
      doc: {
        format: "bento/slides",
        slides: [
          { id: "s1", title: "Slide 1" },
          { id: "s2", title: "Slide 2" },
          { id: "s3", title: "Slide 3" },
        ],
      },
      toolCallId: "init-call",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 2. Delete slide s2
    store.applySlideEditOutcome({
      outcomeId: "deck-edit",
      action: "delete",
      target_slide_ids: ["s2"],
      toolCallId: "del-call",
    });

    let outcomes = useOutcomeStore.getState().outcomes;
    let block = outcomes[0]?.blocks[0] as SlideBlock;
    let slides = block.doc.slides as Array<{ id: string }>;
    expect(slides.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(block.appliedToolCallIds).toContain("del-call");

    // 3. Duplicate delete call (idempotent)
    store.applySlideEditOutcome({
      outcomeId: "deck-edit",
      action: "delete",
      target_slide_ids: ["s2"],
      toolCallId: "del-call",
    });
    outcomes = useOutcomeStore.getState().outcomes;
    block = outcomes[0]?.blocks[0] as SlideBlock;
    slides = block.doc.slides as Array<{ id: string }>;
    expect(slides.map((s) => s.id)).toEqual(["s1", "s3"]);

    // 4. Replace slide s1
    store.applySlideEditOutcome({
      outcomeId: "deck-edit",
      action: "replace",
      target_slide_ids: ["s1"],
      slides: [{ title: "Updated Slide 1" }],
      toolCallId: "rep-call",
    });
    outcomes = useOutcomeStore.getState().outcomes;
    block = outcomes[0]?.blocks[0] as SlideBlock;
    const replacedSlides = block.doc.slides as Array<{ id: string; title?: string }>;
    expect(replacedSlides[0]?.id).toBe("s1");
    expect(replacedSlides[0]?.title).toBe("Updated Slide 1");

    // 5. Insert slide after s1
    store.applySlideEditOutcome({
      outcomeId: "deck-edit",
      action: "insert",
      target_slide_ids: ["s1"],
      slides: [{ id: "s1-sub", title: "Slide 1 Sub" }],
      toolCallId: "ins-call",
    });
    outcomes = useOutcomeStore.getState().outcomes;
    block = outcomes[0]?.blocks[0] as SlideBlock;
    slides = block.doc.slides as Array<{ id: string }>;
    expect(slides.map((s) => s.id)).toEqual(["s1", "s1-sub", "s3"]);
    expect(block.appliedToolCallIds).toEqual([
      "init-call",
      "del-call",
      "rep-call",
      "ins-call",
    ]);
  });

  it("buffers out-of-order edits before deck creation and flushes them when generate arrives", () => {
    const store = useOutcomeStore.getState();

    // 1. Edit arrives BEFORE deck is generated!
    store.applySlideEditOutcome({
      outcomeId: "deck-ooo",
      action: "insert",
      slides: [{ id: "s-late", title: "Late-Arriving Slide" }],
      toolCallId: "call-edit-early",
    });

    // Outcomes is still empty, edit is buffered in pendingSlideEdits
    expect(useOutcomeStore.getState().outcomes).toHaveLength(0);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-ooo"]).toHaveLength(1);

    // 2. Base deck arrives now
    store.upsertSlideOutcome({
      outcomeId: "deck-ooo",
      title: "Main Presentation",
      doc: {
        format: "bento/slides",
        slides: [{ id: "s-base", title: "Base Slide" }],
      },
      toolCallId: "call-base",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // Deck is initialized and pending edit is flushed automatically!
    const outcomes = useOutcomeStore.getState().outcomes;
    expect(outcomes).toHaveLength(1);
    const block = outcomes[0]?.blocks[0] as SlideBlock;
    const slides = block.doc.slides as Array<{ id: string }>;
    expect(slides.map((s) => s.id)).toEqual(["s-base", "s-late"]);
    expect(block.appliedToolCallIds).toEqual(["call-base", "call-edit-early"]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-ooo"]).toBeUndefined();
  });

  it("buffers dependent edits and resolves them with multi-pass flush", () => {
    const store = useOutcomeStore.getState();

    // 1. Create base deck with s1
    store.upsertSlideOutcome({
      outcomeId: "deck-chain",
      title: "Chain Deck",
      doc: {
        format: "bento/slides",
        slides: [{ id: "s1", title: "Slide 1" }],
      },
      toolCallId: "call-init",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 2. Edit B arrives first: replaces s2 (which does not exist yet!)
    store.applySlideEditOutcome({
      outcomeId: "deck-chain",
      action: "replace",
      target_slide_ids: ["s2"],
      slides: [{ title: "Slide 2 Replaced" }],
      toolCallId: "call-edit-b",
    });

    // Should be buffered because s2 was not found
    let block = useOutcomeStore.getState().outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(1); // s1 only
    expect(block.appliedToolCallIds).toEqual(["call-init"]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-chain"]).toHaveLength(1);

    // 3. Edit A arrives: inserts s2
    store.applySlideEditOutcome({
      outcomeId: "deck-chain",
      action: "insert",
      slides: [{ id: "s2", title: "Slide 2 Original" }],
      toolCallId: "call-edit-a",
    });

    // Now Edit A succeeded, triggering flush of Edit B which then replaces s2!
    block = useOutcomeStore.getState().outcomes[0]?.blocks[0] as SlideBlock;
    const slides = block.doc.slides as Array<{ id: string; title?: string }>;
    expect(slides).toHaveLength(2);
    expect(slides[0]?.id).toBe("s1");
    expect(slides[1]?.id).toBe("s2");
    expect(slides[1]?.title).toBe("Slide 2 Replaced"); // Successfully replaced via multi-pass flush!
    expect(block.appliedToolCallIds).toEqual(["call-init", "call-edit-a", "call-edit-b"]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-chain"]).toBeUndefined();
  });

  it("buffers multiple edits before deck creation and flushes them in sequence on base arrival", () => {
    const store = useOutcomeStore.getState();

    // 1. Delete s2 arrives before deck creation
    store.applySlideEditOutcome({
      outcomeId: "deck-multi-ooo",
      action: "delete",
      target_slide_ids: ["s2"],
      toolCallId: "call-del-s2",
    });

    // 2. Replace s1 arrives before deck creation
    store.applySlideEditOutcome({
      outcomeId: "deck-multi-ooo",
      action: "replace",
      target_slide_ids: ["s1"],
      slides: [{ title: "Slide 1 Replaced Ahead of Time" }],
      toolCallId: "call-rep-s1",
    });

    expect(useOutcomeStore.getState().pendingSlideEdits["deck-multi-ooo"]).toHaveLength(2);

    // 3. Base deck arrives with [s1, s2, s3]
    store.upsertSlideOutcome({
      outcomeId: "deck-multi-ooo",
      title: "Deck Title",
      doc: {
        format: "bento/slides",
        slides: [
          { id: "s1", title: "Slide 1" },
          { id: "s2", title: "Slide 2" },
          { id: "s3", title: "Slide 3" },
        ],
      },
      toolCallId: "call-base-deck",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    const block = useOutcomeStore.getState().outcomes[0]?.blocks[0] as SlideBlock;
    const slides = block.doc.slides as Array<{ id: string; title?: string }>;
    // s2 was deleted, s1 was replaced, s3 remains
    expect(slides).toHaveLength(2);
    expect(slides[0]?.id).toBe("s1");
    expect(slides[0]?.title).toBe("Slide 1 Replaced Ahead of Time");
    expect(slides[1]?.id).toBe("s3");
    expect(block.appliedToolCallIds).toEqual([
      "call-base-deck",
      "call-del-s2",
      "call-rep-s1",
    ]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-multi-ooo"]).toBeUndefined();
  });

  it("retains unmatched edit in pending buffer without stamping appliedToolCallIds", () => {
    const store = useOutcomeStore.getState();

    // 1. Base deck with s1
    store.upsertSlideOutcome({
      outcomeId: "deck-unmatched",
      title: "Deck",
      doc: {
        format: "bento/slides",
        slides: [{ id: "s1", title: "Slide 1" }],
      },
      toolCallId: "call-base",
      agentId: "agent-1",
      threadId: "thread-1",
      runId: null,
    });

    // 2. Delete non-existent s-ghost
    store.applySlideEditOutcome({
      outcomeId: "deck-unmatched",
      action: "delete",
      target_slide_ids: ["s-ghost"],
      toolCallId: "call-del-ghost",
    });

    let block = useOutcomeStore.getState().outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(1);
    expect(block.appliedToolCallIds).toEqual(["call-base"]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-unmatched"]).toHaveLength(1);

    // 3. Valid insert of s2 arrives
    store.applySlideEditOutcome({
      outcomeId: "deck-unmatched",
      action: "insert",
      slides: [{ id: "s2", title: "Slide 2" }],
      toolCallId: "call-ins-s2",
    });

    block = useOutcomeStore.getState().outcomes[0]?.blocks[0] as SlideBlock;
    expect(block.doc.slides).toHaveLength(2);
    // call-ins-s2 is applied, but call-del-ghost is still unmatched and not stamped
    expect(block.appliedToolCallIds).toEqual(["call-base", "call-ins-s2"]);
    expect(useOutcomeStore.getState().pendingSlideEdits["deck-unmatched"]).toHaveLength(1);
  });
});

