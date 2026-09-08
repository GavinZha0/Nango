import { describe, it, expect } from "vitest";
import { computeRoleSwitchSideEffects } from "@/lib/builtin-agents/role-transitions";
import { DEFAULT_TESTER_SYSTEM_PROMPT } from "@/lib/testing/prompt";
import { DEFAULT_EVALUATOR_SYSTEM_PROMPT } from "@/lib/evaluation/types";
import {
  SUPERVISOR_NAME,
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";

describe("computeRoleSwitchSideEffects", () => {
  const initialForm = {
    name: "My Custom Agent",
    description: "Does custom work",
    prompt: "You are a custom assistant.",
    role: null,
    sharedStateEnabled: false,
  };

  const initialTools = {
    builtinTools: new Set(["rag_search"]),
    mcp: new Set(["github-mcp"]),
  };

  const mockPlaywrightServers = [
    { id: "mcp-playwright-pub", name: "playwright", enabled: true, visibility: "public" },
    { id: "mcp-other", name: "docs-search", enabled: true, visibility: "public" },
  ];

  describe("Switching to 'tester' (SDET) role", () => {
    it("auto-injects generate_html_page and binds best Playwright MCP server", () => {
      const result = computeRoleSwitchSideEffects(
        initialForm,
        initialTools,
        "tester",
        mockPlaywrightServers,
        null,
      );

      expect(result.nextForm.role).toBe("tester");
      expect(result.nextForm.sharedStateEnabled).toBe(true);
      // Preserves existing custom name/description/prompt when non-empty
      expect(result.nextForm.name).toBe("My Custom Agent");
      expect(result.nextForm.description).toBe("Does custom work");
      expect(result.nextForm.prompt).toBe("You are a custom assistant.");

      // Check tool side effects
      expect(result.nextTools).toBeDefined();
      expect(result.nextTools?.builtinTools.has("generate_html_page")).toBe(true);
      expect(result.nextTools?.builtinTools.has("rag_search")).toBe(true);
      expect(result.nextTools?.mcp.has("mcp-playwright-pub")).toBe(true);
      expect(result.nextTools?.mcp.has("github-mcp")).toBe(true);
      expect(result.warning).toBeNull();
    });

    it("populates default SDET presets when name, description, and prompt are empty", () => {
      const blankForm = {
        name: "",
        description: "",
        prompt: "",
        role: null,
        sharedStateEnabled: false,
      };

      const result = computeRoleSwitchSideEffects(
        blankForm,
        initialTools,
        "tester",
        mockPlaywrightServers,
        null,
      );

      expect(result.nextForm.name).toBe("Tester");
      expect(result.nextForm.prompt).toBe(DEFAULT_TESTER_SYSTEM_PROMPT);
      expect(result.nextForm.description).toContain("Autonomous Software Test Engineer (SDET)");
    });

    it("warns user when no Playwright MCP server is available", () => {
      const result = computeRoleSwitchSideEffects(
        initialForm,
        initialTools,
        "tester",
        [{ id: "mcp-other", name: "docs-search", enabled: true }],
        null,
      );

      expect(result.warning).toMatch(/No Playwright MCP server found/);
      expect(result.nextTools?.builtinTools.has("generate_html_page")).toBe(true);
      expect(result.nextTools?.mcp.has("github-mcp")).toBe(true);
      // Did not bind non-playwright server
      expect(result.nextTools?.mcp.has("mcp-other")).toBe(false);
    });
  });

  describe("Switching to and from 'supervisor' role", () => {
    it("captures snapshot and applies locked supervisor constants", () => {
      const result = computeRoleSwitchSideEffects(
        initialForm,
        initialTools,
        "supervisor",
        mockPlaywrightServers,
        null,
      );

      expect(result.nextForm.role).toBe("supervisor");
      expect(result.nextForm.name).toBe(SUPERVISOR_NAME);
      expect(result.nextForm.description).toBe(SUPERVISOR_DESCRIPTION);
      expect(result.nextForm.prompt).toBe(SUPERVISOR_PROMPT);
      expect(result.nextForm.sharedStateEnabled).toBe(true);

      expect(result.nextSnapshot).toEqual({
        name: "My Custom Agent",
        description: "Does custom work",
        prompt: "You are a custom assistant.",
      });
    });

    it("restores snapshot when switching away from supervisor back to specialist", () => {
      const supervisorForm = {
        name: SUPERVISOR_NAME,
        description: SUPERVISOR_DESCRIPTION,
        prompt: SUPERVISOR_PROMPT,
        role: "supervisor" as const,
        sharedStateEnabled: true,
      };

      const snapshot = {
        name: "My Saved Agent",
        description: "My Saved Description",
        prompt: "My Saved Prompt",
      };

      const result = computeRoleSwitchSideEffects(
        supervisorForm,
        initialTools,
        null, // specialist
        mockPlaywrightServers,
        snapshot,
      );

      expect(result.nextForm.role).toBeNull();
      expect(result.nextForm.name).toBe("My Saved Agent");
      expect(result.nextForm.description).toBe("My Saved Description");
      expect(result.nextForm.prompt).toBe("My Saved Prompt");
      expect(result.nextSnapshot).toBeNull();
    });
  });

  describe("Switching to 'evaluator' role", () => {
    it("sets default evaluator name and prompt if blank", () => {
      const blankForm = {
        name: "",
        description: "Evaluation agent",
        prompt: "",
        role: null,
        sharedStateEnabled: false,
      };

      const result = computeRoleSwitchSideEffects(
        blankForm,
        initialTools,
        "evaluator",
        mockPlaywrightServers,
        null,
      );

      expect(result.nextForm.role).toBe("evaluator");
      expect(result.nextForm.name).toBe("Evaluator");
      expect(result.nextForm.prompt).toBe(DEFAULT_EVALUATOR_SYSTEM_PROMPT);
    });
  });
});
