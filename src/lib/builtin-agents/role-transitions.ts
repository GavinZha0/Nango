import { DEFAULT_TESTER_SYSTEM_PROMPT } from "@/lib/testing/prompt";
import { DEFAULT_EVALUATOR_SYSTEM_PROMPT } from "@/lib/evaluation/types";
import {
  SUPERVISOR_NAME,
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_PROMPT,
} from "@/lib/constants/supervisor";
import {
  findBestPlaywrightMcpServer,
  type PlaywrightServerCandidate,
} from "@/lib/web-auto/matching";

export type AgentRole = "supervisor" | "secretary" | "evaluator" | "tester" | null;

export interface RoleSwitchSnapshot {
  name: string;
  description: string;
  prompt: string;
}

export interface RoleSwitchFormInput {
  name: string;
  description: string;
  prompt: string;
  role: AgentRole;
  sharedStateEnabled: boolean;
}

export interface RoleSwitchToolsInput {
  builtinTools: Set<string>;
  mcp: Set<string>;
}

export interface RoleSwitchResult {
  nextForm: RoleSwitchFormInput;
  nextTools?: RoleSwitchToolsInput;
  nextSnapshot: RoleSwitchSnapshot | null;
  warning?: string | null;
}

/**
 * Computes form and tool side effects when switching an agent's role in the editor.
 * Encapsulates role presets, supervisor snapshots, and SDET (tester) tool auto-binding.
 */
export function computeRoleSwitchSideEffects(
  prevForm: RoleSwitchFormInput,
  prevTools: RoleSwitchToolsInput,
  newRole: AgentRole,
  mcpServers: readonly PlaywrightServerCandidate[],
  snapshot: RoleSwitchSnapshot | null,
): RoleSwitchResult {
  if (newRole === "supervisor") {
    return {
      nextForm: {
        ...prevForm,
        role: "supervisor",
        sharedStateEnabled: true,
        name: SUPERVISOR_NAME,
        description: SUPERVISOR_DESCRIPTION,
        prompt: SUPERVISOR_PROMPT,
      },
      nextSnapshot: {
        name: prevForm.name,
        description: prevForm.description,
        prompt: prevForm.prompt,
      },
      warning: null,
    };
  }

  // Restore fields if transitioning away from supervisor
  const restored = prevForm.role === "supervisor" && snapshot ? snapshot : {};
  const nextName = (prevForm.role === "supervisor" ? snapshot?.name : undefined) ?? prevForm.name;
  const nextPrompt = (prevForm.role === "supervisor" ? snapshot?.prompt : undefined) ?? prevForm.prompt;
  const nextDescription = (prevForm.role === "supervisor" ? snapshot?.description : undefined) ?? prevForm.description;

  const nextForm: RoleSwitchFormInput = {
    ...prevForm,
    role: newRole,
    ...restored,
    ...(newRole === "tester" ? { sharedStateEnabled: true } : {}),
    ...(newRole === "evaluator" && nextPrompt.trim() === "" ? { prompt: DEFAULT_EVALUATOR_SYSTEM_PROMPT } : {}),
    ...(newRole === "evaluator" && nextName.trim() === "" ? { name: "Evaluator" } : {}),
    ...(newRole === "tester" && nextPrompt.trim() === "" ? { prompt: DEFAULT_TESTER_SYSTEM_PROMPT } : {}),
    ...(newRole === "tester" && nextName.trim() === "" ? { name: "Tester" } : {}),
    ...(newRole === "tester" && (!nextDescription || nextDescription.trim() === "")
      ? { description: "Autonomous Software Test Engineer (SDET) responsible for full test lifecycle management." }
      : {}),
  };

  let nextTools: RoleSwitchToolsInput | undefined;
  let warning: string | null = null;

  if (newRole === "tester") {
    const builtinTools = new Set(prevTools.builtinTools);
    builtinTools.add("generate_html_page");

    const mcp = new Set(prevTools.mcp);
    const playwright = findBestPlaywrightMcpServer(mcpServers);
    if (playwright) {
      mcp.add(playwright.id);
    } else {
      warning =
        "No Playwright MCP server found. Bind it manually in the MCP tools tab — Web Auto exploration and execution depend on it.";
    }

    nextTools = { builtinTools, mcp };
  }

  return {
    nextForm,
    nextTools,
    nextSnapshot: prevForm.role === "supervisor" ? null : snapshot,
    warning,
  };
}
