import { describe, it, expect } from "vitest";
import {
  parseToolApprovalMode,
  resolveEffectiveToolApprovalMode,
} from "@/lib/http/chat-headers";
import { useWorkspaceStore } from "@/store/workspace";

describe("tool approval mode header helpers", () => {
  it("parses valid modes case-insensitively and rejects unknown values", () => {
    expect(parseToolApprovalMode("auto")).toBe("auto");
    expect(parseToolApprovalMode("  ALWAYS ")).toBe("always");
    expect(parseToolApprovalMode("Never")).toBe("never");
    expect(parseToolApprovalMode("")).toBeUndefined();
    expect(parseToolApprovalMode("bypass")).toBeUndefined();
    expect(parseToolApprovalMode(null)).toBeUndefined();
    expect(parseToolApprovalMode(undefined)).toBeUndefined();
  });

  it("honors override only when caller has editor/admin privileges", () => {
    expect(
      resolveEffectiveToolApprovalMode({
        configured: "always",
        override: "never",
        canOverride: true,
      }),
    ).toBe("never");

    expect(
      resolveEffectiveToolApprovalMode({
        configured: "always",
        override: "never",
        canOverride: false,
      }),
    ).toBe("always");

    expect(
      resolveEffectiveToolApprovalMode({
        configured: "auto",
        override: undefined,
        canOverride: true,
      }),
    ).toBe("auto");
  });

  it("resets approvalModeOverride in workspace store when switching agents", () => {
    const store = useWorkspaceStore.getState();
    store.setActiveAgent("agent-a", "agent", "builtin");
    store.setApprovalModeOverride("never");
    expect(useWorkspaceStore.getState().approvalModeOverride).toBe("never");

    // Re-selecting the same agent keeps the transient override
    useWorkspaceStore.getState().setActiveAgent("agent-a", "agent", "builtin");
    expect(useWorkspaceStore.getState().approvalModeOverride).toBe("never");

    // Switching to another agent clears the override
    useWorkspaceStore.getState().setActiveAgent("agent-b", "agent", "builtin");
    expect(useWorkspaceStore.getState().approvalModeOverride).toBeNull();

    // Entering Nango clears the override
    useWorkspaceStore.getState().setApprovalModeOverride("always");
    useWorkspaceStore.getState().enterNango({ id: "supervisor-1" });
    expect(useWorkspaceStore.getState().approvalModeOverride).toBeNull();
  });
});
