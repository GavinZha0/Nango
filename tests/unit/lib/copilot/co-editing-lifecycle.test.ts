import { describe, it, expect, beforeEach } from "vitest";
import { useCopilotStateStore, type EditorRegistration } from "@/store/copilot";
import { defaultSharedState } from "@/lib/copilot/shared-state-schema";
import { DRAFT_SCHEMAS } from "@/lib/copilot/resource-registry";

describe("Co-Editing & Shared State Lifecycle Integration Suite", () => {
  beforeEach(() => {
    // Reset store before each test
    useCopilotStateStore.setState({
      state: defaultSharedState,
      activeResourceData: null,
      editors: [],
      activeEditor: null,
    });
  });

  describe("Scenario 1: Self-Pollution & Single Writer Regression (#4)", () => {
    it("handles rapid page switching without context pollution or fake mismatches", () => {
      // 1. User starts on Agent page
      let agentFormData = { name: "DevOps Agent", model: "gpt-4o" };
      const agentEditor: EditorRegistration = {
        instanceId: "editor-agent-1",
        resourceType: "agent",
        resourceId: "agent-uuid-1",
        isReadOnly: false,
        applyDraft: (draft) => {
          agentFormData = { ...agentFormData, ...draft };
          return Object.keys(draft);
        },
        getCurrentData: () => agentFormData,
        discardDraft: () => {},
      };
      useCopilotStateStore.getState().registerEditor(agentEditor);

      // Simulate context sync effect setting URL context to /agent
      useCopilotStateStore.getState().setState({
        context: {
          activeUrl: "/agent/agent-uuid-1",
          activeView: "agent",
          activeResourceId: "agent-uuid-1",
          activeResourceData: agentFormData,
        },
      });

      // 2. User navigates to Schedule page
      useCopilotStateStore.getState().unregisterEditor("editor-agent-1");

      let scheduleFormData = { name: "Daily Report", task: "Run check" };
      const scheduleEditor: EditorRegistration = {
        instanceId: "editor-sched-1",
        resourceType: "schedule",
        resourceId: "sched-uuid-1",
        isReadOnly: false,
        applyDraft: (draft) => {
          scheduleFormData = { ...scheduleFormData, ...draft };
          return Object.keys(draft);
        },
        getCurrentData: () => scheduleFormData,
        discardDraft: () => {},
      };
      useCopilotStateStore.getState().registerEditor(scheduleEditor);

      // Context sync updates to /schedule
      useCopilotStateStore.getState().setState({
        context: {
          activeUrl: "/schedule/sched-uuid-1",
          activeView: "schedules",
          activeResourceId: "sched-uuid-1",
          activeResourceData: scheduleFormData,
        },
      });

      // 3. Supervisor proposes edit to schedule (1st call)
      const editor1 = useCopilotStateStore.getState().activeEditor;
      expect(editor1).not.toBeNull();
      expect(editor1?.resourceType).toBe("schedule");

      const modifiedFields1 = editor1?.applyDraft({ task: "Updated check task" });
      expect(modifiedFields1).toEqual(["task"]);
      expect(scheduleFormData.task).toBe("Updated check task");

      // 4. Supervisor proposes second edit to schedule (2nd call)
      const editor2 = useCopilotStateStore.getState().activeEditor;
      expect(editor2?.resourceType).toBe("schedule");
      const modifiedFields2 = editor2?.applyDraft({ name: "Renamed Report" });
      expect(modifiedFields2).toEqual(["name"]);
      expect(scheduleFormData.name).toBe("Renamed Report");

      // Verify global context was NOT polluted back to agent
      const currentContext = useCopilotStateStore.getState().state.context;
      expect(currentContext.activeView).toBe("schedules");
      expect(currentContext.activeResourceId).toBe("sched-uuid-1");
    });
  });

  describe("Scenario 2: Read-Only Builtin Barrier (#1)", () => {
    it("rejects draft applications on builtin / immutable resources", () => {
      let skillData = { name: "python-runner", source: "builtin", skillMd: "original code" };
      const builtinSkillEditor: EditorRegistration = {
        instanceId: "editor-builtin-skill",
        resourceType: "skills",
        resourceId: "builtin-1",
        isReadOnly: true, // Locked builtin resource
        applyDraft: (draft) => {
          if (builtinSkillEditor.isReadOnly) return [];
          skillData = { ...skillData, ...draft };
          return Object.keys(draft);
        },
        getCurrentData: () => skillData,
        discardDraft: () => {},
      };

      useCopilotStateStore.getState().registerEditor(builtinSkillEditor);

      const activeEditor = useCopilotStateStore.getState().activeEditor;
      expect(activeEditor?.isReadOnly).toBe(true);

      // Attempting to apply draft should be rejected
      const applied = activeEditor?.applyDraft({ skillMd: "malicious replacement" });
      expect(applied).toEqual([]);
      expect(skillData.skillMd).toBe("original code");
    });
  });

  describe("Scenario 3: Empty Draft Defense (#6)", () => {
    it("detects and rejects empty draft objects without state corruption", () => {
      let scheduleData = { name: "Audit Job", task: "Audit" };
      const scheduleEditor: EditorRegistration = {
        instanceId: "editor-sched-2",
        resourceType: "schedule",
        resourceId: "sched-2",
        isReadOnly: false,
        applyDraft: (draft) => {
          if (!draft || Object.keys(draft).length === 0) return [];
          scheduleData = { ...scheduleData, ...draft };
          return Object.keys(draft);
        },
        getCurrentData: () => scheduleData,
        discardDraft: () => {},
      };

      useCopilotStateStore.getState().registerEditor(scheduleEditor);

      const activeEditor = useCopilotStateStore.getState().activeEditor;
      const applied = activeEditor?.applyDraft({});
      expect(applied).toEqual([]);
      expect(scheduleData).toEqual({ name: "Audit Job", task: "Audit" });
    });
  });

  describe("Scenario 4: Rollback & Undo Snapshot (#7)", () => {
    it("records preDraft snapshot and restores exact state on discard", () => {
      let formData = { name: "Original Host", port: 22, host: "192.168.1.1" };
      let undoSnapshot: typeof formData | null = null;
      let isDraftApplied = false;

      const sshEditor: EditorRegistration = {
        instanceId: "editor-ssh-1",
        resourceType: "ssh-server",
        resourceId: "ssh-1",
        isReadOnly: false,
        applyDraft: (draft) => {
          if (!undoSnapshot) {
            undoSnapshot = { ...formData }; // Take snapshot on first apply
          }
          formData = { ...formData, ...draft };
          isDraftApplied = true;
          return Object.keys(draft);
        },
        getCurrentData: () => formData,
        discardDraft: () => {
          if (undoSnapshot) {
            formData = { ...undoSnapshot };
            undoSnapshot = null;
            isDraftApplied = false;
          }
        },
      };

      useCopilotStateStore.getState().registerEditor(sshEditor);

      const editor = useCopilotStateStore.getState().activeEditor!;
      expect(editor.getCurrentData().port).toBe(22);

      // 1. Agent modifies port to 2222
      const modifiedFields = editor.applyDraft({ port: 2222 });
      expect(modifiedFields).toEqual(["port"]);
      expect(formData.port).toBe(2222);
      expect(isDraftApplied).toBe(true);

      // 2. Discard changes
      editor.discardDraft();
      expect(formData.port).toBe(22);
      expect(isDraftApplied).toBe(false);
    });
  });

  describe("Scenario 5: Multi-Editor Lifecycle & Stack Unregistration (Parent/Child Inspector)", () => {
    it("handles parent suite and child case inspector lifecycle with automatic stack fallback", () => {
      const suiteEditor: EditorRegistration = {
        instanceId: "inst-suite",
        resourceType: "verification",
        resourceId: "suite-1",
        isReadOnly: false,
        applyDraft: () => [],
        getCurrentData: () => ({ name: "Suite 1" }),
        discardDraft: () => {},
      };

      const caseInspector: EditorRegistration = {
        instanceId: "inst-case",
        resourceType: "verification",
        resourceId: "case-101",
        isReadOnly: false,
        applyDraft: () => [],
        getCurrentData: () => ({ name: "Case 101" }),
        discardDraft: () => {},
      };

      // 1. Mount Suite Editor
      useCopilotStateStore.getState().registerEditor(suiteEditor);
      expect(useCopilotStateStore.getState().activeEditor?.instanceId).toBe("inst-suite");

      // 2. Open Case Inspector (child pushes onto stack)
      useCopilotStateStore.getState().registerEditor(caseInspector);
      expect(useCopilotStateStore.getState().activeEditor?.instanceId).toBe("inst-case");

      // 3. Close Case Inspector (child unmounts) -> MUST automatically fall back to parent Suite Editor!
      useCopilotStateStore.getState().unregisterEditor("inst-case");
      expect(useCopilotStateStore.getState().activeEditor?.instanceId).toBe("inst-suite");

      // 4. Suite Editor unmounts -> activeEditor becomes null
      useCopilotStateStore.getState().unregisterEditor("inst-suite");
      expect(useCopilotStateStore.getState().activeEditor).toBeNull();
    });
  });

  describe("Scenario 6: Fast Sequential Invocations & Baseline Snapshot Stability", () => {
    it("maintains original baseline snapshot across multiple consecutive draft updates", () => {
      const initialForm = {
        name: "Initial Agent",
        model: "claude-3-5-sonnet",
        temperature: 0.7,
      };

      let currentForm = { ...initialForm };
      let preDraftSnapshot: typeof initialForm | null = null;
      let isDraftApplied = false;

      const sequentialEditor: EditorRegistration = {
        instanceId: "editor-sequential",
        resourceType: "agent",
        resourceId: "agent-seq-1",
        isReadOnly: false,
        applyDraft: (draft) => {
          if (!preDraftSnapshot) {
            preDraftSnapshot = { ...currentForm }; // Snapshot ONLY on first edit
          }
          currentForm = { ...currentForm, ...draft };
          isDraftApplied = true;
          return Object.keys(draft);
        },
        getCurrentData: () => currentForm,
        discardDraft: () => {
          if (preDraftSnapshot) {
            currentForm = { ...preDraftSnapshot };
            preDraftSnapshot = null;
            isDraftApplied = false;
          }
        },
      };

      useCopilotStateStore.getState().registerEditor(sequentialEditor);
      const editor = useCopilotStateStore.getState().activeEditor!;

      // 1. First draft arrives: changes name
      editor.applyDraft({ name: "First Iteration Agent" });
      expect(currentForm.name).toBe("First Iteration Agent");
      expect(currentForm.model).toBe("claude-3-5-sonnet");

      // 2. Second draft arrives rapidly: changes temperature
      editor.applyDraft({ temperature: 0.2 });
      expect(currentForm.temperature).toBe(0.2);

      // 3. Third draft arrives: changes model
      editor.applyDraft({ model: "gpt-4o" });
      expect(currentForm.model).toBe("gpt-4o");

      // Current form has accumulated all 3 edits
      expect(currentForm).toEqual({
        name: "First Iteration Agent",
        model: "gpt-4o",
        temperature: 0.2,
      });
      expect(isDraftApplied).toBe(true);

      // 4. Discard draft -> MUST restore all the way back to initialForm (A, not B or C)
      editor.discardDraft();
      expect(currentForm).toEqual(initialForm);
      expect(isDraftApplied).toBe(false);
    });
  });

  describe("Scenario 7: Malformed & Rogue Draft Data Graceful Handling", () => {
    it("safely ignores malformed types and unknown fields without crashing or corrupting form", () => {
      const scheduleForm = {
        name: "Backup Database",
        task: "pg_dump -Fc",
        intervalValue: 1,
        cronExpr: "0 0 * * *",
      };

      const resilientEditor: EditorRegistration = {
        instanceId: "editor-resilient",
        resourceType: "schedule",
        resourceId: "sched-resilient",
        isReadOnly: false,
        applyDraft: (draft: Record<string, unknown>) => {
          const applied: string[] = [];

          // String field defense
          if (typeof draft.name === "string" && draft.name.trim()) {
            scheduleForm.name = draft.name.trim();
            applied.push("name");
          }
          if (typeof draft.task === "string") {
            scheduleForm.task = draft.task;
            applied.push("task");
          }

          // Number field defense: ignore strings like "NaN", objects, etc.
          if (typeof draft.intervalValue === "number" && !Number.isNaN(draft.intervalValue)) {
            scheduleForm.intervalValue = draft.intervalValue;
            applied.push("intervalValue");
          }

          // Return recognized and successfully applied fields
          return applied;
        },
        getCurrentData: () => scheduleForm,
        discardDraft: () => {},
      };

      useCopilotStateStore.getState().registerEditor(resilientEditor);
      const editor = useCopilotStateStore.getState().activeEditor!;

      // 1. Pass malformed types and rogue fields:
      const appliedFields = editor.applyDraft({
        name: { unexpected: "object" },
        task: "pg_dump -Fc --clean",
        intervalValue: "twenty",
        rogueField: ["malicious", "array"],
      });

      // 2. Assert only the valid task field was accepted
      expect(appliedFields).toEqual(["task"]);
      expect(scheduleForm.task).toBe("pg_dump -Fc --clean");

      // 3. Assert name and intervalValue retained original valid values without crash
      expect(scheduleForm.name).toBe("Backup Database");
      expect(scheduleForm.intervalValue).toBe(1);
    });
  });

  describe("Scenario 8: Zod Boundary Validation & Unknown Field Rejection", () => {
    it("strictly validates draft payloads against Zod schemas and rejects unknown fields", () => {
      const scheduleSchema = DRAFT_SCHEMAS["schedule"];

      // 1. Valid payload parses cleanly
      const valid = scheduleSchema.safeParse({
        name: "Nightly Backup",
        task: "Run backup job",
        triggerMode: "cron",
        cronExpr: "0 2 * * *",
      });
      expect(valid.success).toBe(true);

      // 2. Unknown/rogue fields are rejected by .strict() validation
      const withBogus = scheduleSchema.safeParse({
        name: "Valid Name",
        task: "Valid Task",
        unknownRogueField: "malicious_injection",
      });
      expect(withBogus.success).toBe(false);

      // 3. Invalid enum value is rejected
      const invalidEnum = scheduleSchema.safeParse({
        triggerMode: "not_a_valid_mode",
      });
      expect(invalidEnum.success).toBe(false);

      // 4. Constraint violation: max string length exceeded
      const overlongName = scheduleSchema.safeParse({
        name: "A".repeat(121), // max is 120
      });
      expect(overlongName.success).toBe(false);
    });

    it("enforces boundary constraints across resource schemas (datasource & agent)", () => {
      // DataSource: invalid provider & port constraint
      const dsSchema = DRAFT_SCHEMAS["datasource"];
      expect(dsSchema.safeParse({ provider: "unsupported_db" }).success).toBe(false);
      expect(dsSchema.safeParse({ port: 70000 }).success).toBe(false); // port max 65535
      expect(dsSchema.safeParse({ provider: "postgres", port: 5432 }).success).toBe(true);

      // Agent: temperature range & maxSteps
      const agentSchema = DRAFT_SCHEMAS["agent"];
      expect(agentSchema.safeParse({ temperature: 1.5 }).success).toBe(false); // max 1.0
      expect(agentSchema.safeParse({ maxSteps: 100 }).success).toBe(false); // max 50
      expect(agentSchema.safeParse({ temperature: 0.7, maxSteps: 10 }).success).toBe(true);
    });
  });
});

