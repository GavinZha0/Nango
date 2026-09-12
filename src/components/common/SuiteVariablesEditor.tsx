"use client";

import { useState, forwardRef, useImperativeHandle, useCallback, useRef, useEffect } from "react";
import useSWR from "swr";
import { Trash2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  SuiteVariableDefinition,
  SuiteVariablesMap,
} from "@/lib/testing/types";

export interface SuiteVariablesEditorRef {
  addVariable: () => void;
}

export interface SuiteVariablesEditorProps {
  variables: SuiteVariablesMap;
  onChange: (updated: SuiteVariablesMap) => void;
  allowCredentials?: boolean;
  disabled?: boolean;
}

interface CredentialSelectorItem {
  id: string;
  name: string;
  provider: string;
  type: string;
  fields: string[];
}

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Failed to load credentials");
    return res.json() as Promise<CredentialSelectorItem[]>;
  });

const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface VariableRowModel {
  id: string;
  originalKey: string;
  key: string;
  type: "literal" | "credential";
  literalValue: string;
  credentialId: string;
  field: string;
  description: string;
}

function normalizeVariablesToRows(variables: SuiteVariablesMap): VariableRowModel[] {
  return Object.entries(variables).map(([key, def], idx) => {
    const id = `var_${key || "empty"}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
    if (def && typeof def === "object" && "type" in def) {
      const typed = def as SuiteVariableDefinition;
      if (typed.type === "credential") {
        return {
          id,
          originalKey: key,
          key,
          type: "credential",
          literalValue: "",
          credentialId: typed.credentialId,
          field: typed.field,
          description: typed.description ?? "",
        };
      }
      return {
        id,
        originalKey: key,
        key,
        type: "literal",
        literalValue: String(typed.value ?? ""),
        credentialId: "",
        field: "",
        description: typed.description ?? "",
      };
    }

    // Backward compatibility for legacy flat values (e.g. { baseUrl: "https://..." })
    return {
      id,
      originalKey: key,
      key,
      type: "literal",
      literalValue: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? String(def) : JSON.stringify(def ?? ""),
      credentialId: "",
      field: "",
      description: "",
    };
  });
}

export const SuiteVariablesEditor = forwardRef<
  SuiteVariablesEditorRef,
  SuiteVariablesEditorProps
>(function SuiteVariablesEditor(
  {
    variables,
    onChange,
    allowCredentials = false,
    disabled = false,
  },
  ref,
) {
  const { data: credentials = [] } = useSWR<CredentialSelectorItem[]>(
    allowCredentials ? "/api/credentials?purpose=suite-variable" : null,
    fetcher,
  );

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [rows, setRows] = useState<VariableRowModel[]>(() => normalizeVariablesToRows(variables));
  const lastEmittedRef = useRef<SuiteVariablesMap | null>(null);

  // Synchronize rows when variables prop changes externally (e.g. dialog opened or suite switched)
  useEffect(() => {
    if (variables !== lastEmittedRef.current) {
      setRows(normalizeVariablesToRows(variables));
    }
  }, [variables]);

  const emitRows = useCallback(
    (newRows: VariableRowModel[]) => {
      setRows(newRows);

      const nextMap: SuiteVariablesMap = {};
      for (const r of newRows) {
        const trimmedKey = r.key.trim();
        // Skip empty keys when emitting to parent (saving draft state without polluting parent map)
        if (!trimmedKey) continue;

        if (r.type === "credential") {
          nextMap[trimmedKey] = {
            type: "credential",
            credentialId: r.credentialId,
            field: r.field,
            description: r.description.trim() || undefined,
          };
        } else {
          nextMap[trimmedKey] = {
            type: "literal",
            value: r.literalValue,
            description: r.description.trim() || undefined,
          };
        }
      }
      lastEmittedRef.current = nextMap;
      onChange(nextMap);
    },
    [onChange],
  );

  const handleAdd = useCallback(() => {
    const base = "new_var";
    let count = 1;
    while (rows.some((r) => r.key === (count === 1 ? base : `${base}_${count}`))) {
      count++;
    }
    const defaultKey = count === 1 ? base : `${base}_${count}`;

    const newRow: VariableRowModel = {
      id: `var_${defaultKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      originalKey: "",
      key: defaultKey,
      type: "literal",
      literalValue: "",
      credentialId: "",
      field: "",
      description: "",
    };
    emitRows([...rows, newRow]);
  }, [rows, emitRows]);

  useImperativeHandle(
    ref,
    () => ({
      addVariable: handleAdd,
    }),
    [handleAdd],
  );

  const handleRemove = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    emitRows(next);
  };

  const handleKeyChange = (index: number, newKey: string) => {
    const next = [...rows];
    next[index] = { ...next[index], key: newKey };
    emitRows(next);
  };

  const handleTypeChange = (index: number, newType: "literal" | "credential") => {
    const next = [...rows];
    const cur = next[index];
    if (newType === "credential") {
      const defaultCred = credentials[0];
      const defaultField = defaultCred?.fields?.[0] ?? "";
      next[index] = {
        ...cur,
        type: "credential",
        credentialId: defaultCred?.id ?? "",
        field: defaultField,
      };
    } else {
      next[index] = {
        ...cur,
        type: "literal",
        literalValue: "",
        credentialId: "",
        field: "",
      };
    }
    emitRows(next);
  };

  const handleLiteralValueChange = (index: number, val: string) => {
    const next = [...rows];
    next[index] = { ...next[index], literalValue: val };
    emitRows(next);
  };

  const handleCredentialChange = (index: number, credentialId: string) => {
    const next = [...rows];
    const cred = credentials.find((c) => c.id === credentialId);
    const defaultField = cred?.fields?.[0] ?? "";
    next[index] = {
      ...next[index],
      credentialId,
      field: defaultField,
    };
    emitRows(next);
  };

  const handleFieldChange = (index: number, field: string) => {
    const next = [...rows];
    next[index] = {
      ...next[index],
      field,
    };
    emitRows(next);
  };

  const handleCopy = (key: string) => {
    const template = allowCredentials ? `variables.${key}` : `{{variables.${key}}}`;
    void navigator.clipboard.writeText(template);
    setCopiedKey(key);
    toast.success(`Copied ${template} to clipboard`);
    setTimeout(() => {
      setCopiedKey((cur) => (cur === key ? null : cur));
    }, 2000);
  };

  return (
    <div className="flex flex-col gap-2.5 py-1">
      {allowCredentials ? (
        <p className="text-[11px] text-muted-foreground pb-0.5">
          In scripts, use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
            variables.KEY
          </code>
          ; in assertions, use{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
            {"{{variables.KEY}}"}
          </code>
          .
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground pb-0.5">
          Define reusable parameters accessible across test cases via{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
            {"{{variables.KEY}}"}
          </code>
          .
        </p>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/80 py-12 text-center text-xs text-muted-foreground">
          No suite variables configured.
        </div>
      ) : (
        <div className="rounded-md border divide-y divide-border bg-card">
          {rows.map((row, idx) => {
            const trimmedKey = row.key.trim();
            const isKeyValid = KEY_REGEX.test(trimmedKey);
            const isDuplicate = Boolean(trimmedKey) && rows.filter((r) => r.key.trim() === trimmedKey).length > 1;
            const hasKeyError = !isKeyValid || isDuplicate;

            const selectedCred = credentials.find((c) => c.id === row.credentialId);
            const availableFields = selectedCred?.fields ?? [];

            return (
              <div
                key={row.id}
                className="flex flex-col gap-2 p-2.5 transition-colors hover:bg-muted/20 text-xs"
                data-testid={`suite-variable-row-${idx}`}
              >
                <div className="flex items-center gap-2">
                  {/* Variable Key */}
                  <div className="flex-1 min-w-[130px]">
                    <Input
                      value={row.key}
                      onChange={(e) => handleKeyChange(idx, e.target.value)}
                      placeholder="variable_name"
                      disabled={disabled}
                      className={`h-7 font-mono text-xs ${
                        hasKeyError
                          ? "border-destructive focus-visible:ring-destructive"
                          : ""
                      }`}
                      data-testid={`variable-key-input-${idx}`}
                    />
                  </div>

                  {/* Type Selector (Only if allowCredentials is true) */}
                  {allowCredentials ? (
                    <div className="w-[110px] shrink-0">
                      <Select
                        value={row.type}
                        onValueChange={(val) =>
                          handleTypeChange(idx, val as "literal" | "credential")
                        }
                        disabled={disabled}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="literal">Literal</SelectItem>
                          <SelectItem value="credential">Credential</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <span className="shrink-0 rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      literal
                    </span>
                  )}

                  {/* Value / Binding */}
                  {row.type === "literal" ? (
                    <div className="flex-[1.5] min-w-[150px]">
                      <Input
                        value={row.literalValue}
                        onChange={(e) => handleLiteralValueChange(idx, e.target.value)}
                        placeholder="Literal value..."
                        disabled={disabled}
                        className="h-7 text-xs"
                        data-testid={`variable-value-input-${idx}`}
                      />
                    </div>
                  ) : (
                    <div className="flex-[1.5] flex items-center gap-1.5 min-w-[180px]">
                      {/* Credential Picker */}
                      <Select
                        value={row.credentialId}
                        onValueChange={(val) => handleCredentialChange(idx, val ?? "")}
                        disabled={disabled}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue placeholder="Select credential">
                            {selectedCred?.name || "Select credential"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {credentials.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Field Picker */}
                      <Select
                        value={row.field}
                        onValueChange={(val) => handleFieldChange(idx, val ?? "")}
                        disabled={disabled || !selectedCred}
                      >
                        <SelectTrigger className="h-7 text-xs w-[130px] shrink-0">
                          <SelectValue placeholder="Field" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableFields.map((f) => (
                            <SelectItem key={f} value={f}>
                              {f}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Actions: Copy & Delete */}
                  <div className="flex items-center gap-1 shrink-0">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => handleCopy(row.key)}
                          disabled={!isKeyValid}
                        >
                          {copiedKey === row.key ? (
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[11px]">
                          {allowCredentials
                            ? `Copy variables.${row.key}`
                            : `Copy {{variables.${row.key}}}`}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleRemove(idx)}
                      disabled={disabled}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
