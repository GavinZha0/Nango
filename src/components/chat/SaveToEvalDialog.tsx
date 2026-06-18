"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { evalActions } from "@/store/evaluation";
import { evalCaseActions, type CreateCaseInput } from "@/store/evaluation-cases";
import type { EvalTurn } from "@/lib/evaluation/types";

interface AGUIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type AGUIMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content?: string; toolCalls?: AGUIToolCall[] }
  | { id: string; role: "tool"; toolCallId: string; content: string }
  | { id: string; role: "reasoning"; content: string };

interface SaveToEvalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentSource: string;
  threadId: string;
}

export function SaveToEvalDialog({
  open,
  onOpenChange,
  agentId,
  agentSource,
  threadId,
}: SaveToEvalDialogProps): ReactNode {
  const [issue, setIssue] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      // 1. Fetch thread messages
      const res = await fetch(`/api/threads/${threadId}/messages`);
      if (!res.ok) throw new Error("Failed to fetch thread messages");
      const data = (await res.json()) as { messages: AGUIMessage[] };
      const messages = data.messages;

      if (messages.length === 0) {
        toast.error("Thread is empty, nothing to save.");
        setSaving(false);
        return;
      }

      // 2. Parse into EvalTurn[]
      const turns: EvalTurn[] = [];
      let currentTurn: EvalTurn | null = null;
      
      // We also need to map tool call results which come in subsequent 'tool' role messages.
      const toolResultsMap = new Map<string, string>();
      for (const msg of messages) {
        if (msg.role === "tool") {
          toolResultsMap.set(msg.toolCallId, msg.content);
        }
      }

      for (const msg of messages) {
        if (msg.role === "user") {
          // Push previous turn if exists
          if (currentTurn) turns.push(currentTurn);
          currentTurn = { userMessage: msg.content };
        } else if (msg.role === "assistant") {
          if (!currentTurn) {
            // Edge case: assistant message without prior user message
            currentTurn = { userMessage: "" };
          }
          if (msg.content) {
            currentTurn.actualResponse = (currentTurn.actualResponse ? currentTurn.actualResponse + "\n" : "") + msg.content;
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            currentTurn.toolCalls = currentTurn.toolCalls || [];
            for (const tc of msg.toolCalls) {
              currentTurn.toolCalls.push({
                name: tc.function.name,
                args: tc.function.arguments,
                result: toolResultsMap.get(tc.id) ?? "",
              });
            }
          }
        }
      }
      if (currentTurn) turns.push(currentTurn);

      // 3. Ensure Drafts Suite exists
      const suiteId = await evalActions.ensureDraftSuite(agentId, agentSource);
      if (!suiteId) throw new Error("Failed to resolve Drafts suite");

      // 4. Create Eval Case
      // Derive name from first user message or fallback
      const caseName = turns.length > 0 && turns[0].userMessage
        ? turns[0].userMessage.slice(0, 40) + (turns[0].userMessage.length > 40 ? "..." : "")
        : "Draft Case " + new Date().toISOString().slice(0, 10);

      const criteria: Record<string, unknown> = {};
      if (issue.trim()) criteria.issue = issue.trim();
      if (expectedOutcome.trim()) criteria.expected_outcome = expectedOutcome.trim();

      const input: CreateCaseInput = {
        name: caseName,
        turns,
        criteria,
      };

      const newCase = await evalCaseActions.create(suiteId, input);
      if (!newCase) throw new Error("Failed to create evaluation case");

      toast.success("Saved to Evaluation Drafts");
      onOpenChange(false);
      setIssue("");
      setExpectedOutcome("");
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Save to Evaluation Drafts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="issue" className="text-sm font-medium">
              What went wrong? (Issue)
            </label>
            <Textarea
              id="issue"
              placeholder="e.g., Agent hallucinated the price..."
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              className="resize-none h-32"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="outcome" className="text-sm font-medium">
              What is the expected behavior?
            </label>
            <Textarea
              id="outcome"
              placeholder="e.g., Should call the search tool first..."
              value={expectedOutcome}
              onChange={(e) => setExpectedOutcome(e.target.value)}
              className="resize-none h-32"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !threadId}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
