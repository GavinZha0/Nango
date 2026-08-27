import { describe, it, expect, beforeEach } from "vitest";
import { useCopilotStateStore } from "@/store/copilot";
import { defaultSharedState } from "@/lib/copilot/shared-state-schema";
import {
  executeProposePageEdit,
  executeDiscardPageEdit,
} from "@/lib/copilot/tool-handlers";

describe("propose_page_edit & discard_page_edit Tool Handler Full Chain Integration", () => {
  beforeEach(() => {
    useCopilotStateStore.setState({
      state: defaultSharedState,
      activeResourceData: null,
      editors: [],
    });
  });

  it("rejects propose_page_edit when no active editor is open in store", async () => {
    const res = await executeProposePageEdit({
      resourceType: "schedule",
      draftData: { name: "Test Schedule" },
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("No active resource editor is currently open");
  });

  it("rejects propose_page_edit when draft data payload is empty", async () => {
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: null,
      isReadOnly: false,
      getCurrentData: () => ({ name: "Old" }),
      applyDraft: () => ["name"],
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "schedule",
      draftData: {},
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Draft data cannot be empty");
  });

  it("rejects propose_page_edit when editor resourceType does not match target", async () => {
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: null,
      isReadOnly: false,
      getCurrentData: () => ({ name: "Old" }),
      applyDraft: () => ["name"],
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "agent",
      draftData: { name: "New Agent Name" },
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Mismatch: current editor is viewing 'schedule', but draft targets 'agent'");
  });

  it("rejects propose_page_edit on read-only (builtin) resources", async () => {
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-builtin",
      resourceType: "skills",
      resourceId: "builtin-1",
      isReadOnly: true,
      getCurrentData: () => ({ name: "Builtin Skill" }),
      applyDraft: () => [],
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "skills",
      draftData: { name: "Modified Builtin" },
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Permission Denied: This skills is read-only (builtin)");
  });

  it("strictly rejects unknown rogue fields via Zod schema boundary", async () => {
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: null,
      isReadOnly: false,
      getCurrentData: () => ({ name: "Old" }),
      applyDraft: () => ["name"],
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "schedule",
      draftData: {
        name: "Valid Title",
        rogueUnknownProperty: "malicious_input",
      },
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Invalid draft payload for schedule");
  });

  it("strictly rejects constraint violations (e.g. invalid enum)", async () => {
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: null,
      isReadOnly: false,
      getCurrentData: () => ({ name: "Old" }),
      applyDraft: () => ["triggerMode"],
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "schedule",
      draftData: {
        triggerMode: "invalid_trigger_mode",
      },
    });

    expect(res.isError).toBe(true);
    expect(res.message).toContain("Invalid draft payload for schedule");
  });

  it("successfully applies valid draft, updates state, and returns applied fields", async () => {
    const internalForm = { name: "Initial Name", task: "Initial Task" };
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: "sched-123",
      isReadOnly: false,
      getCurrentData: () => internalForm,
      applyDraft: (draft) => {
        const applied: string[] = [];
        if (draft.name && draft.name !== internalForm.name) {
          internalForm.name = draft.name as string;
          applied.push("name");
        }
        if (draft.task && draft.task !== internalForm.task) {
          internalForm.task = draft.task as string;
          applied.push("task");
        }
        return applied;
      },
      discardDraft: () => {},
    });

    const res = await executeProposePageEdit({
      resourceType: "schedule",
      draftData: {
        name: "Updated Backup Name",
        task: "Execute backup immediately",
      },
    });

    expect(res.status).toBe("success");
    expect(res.appliedFields).toEqual(["name", "task"]);
    expect(internalForm.name).toBe("Updated Backup Name");
    expect(internalForm.task).toBe("Execute backup immediately");
  });

  it("handles discard_page_edit and triggers editor discard callback", async () => {
    let discardCalled = false;
    useCopilotStateStore.getState().registerEditor({
      instanceId: "editor-1",
      resourceType: "schedule",
      resourceId: "sched-123",
      isReadOnly: false,
      getCurrentData: () => ({ name: "Current" }),
      applyDraft: () => ["name"],
      discardDraft: () => {
        discardCalled = true;
      },
    });

    const res = await executeDiscardPageEdit({
      resourceType: "schedule",
    });

    expect(res.status).toBe("success");
    expect(discardCalled).toBe(true);
  });
});
