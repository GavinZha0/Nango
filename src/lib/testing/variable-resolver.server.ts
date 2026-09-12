import "server-only";

import { getCredentialFieldsById } from "@/lib/credentials/lookup";
import type { SuiteVariableDefinition } from "./types";

export interface ResolveSuiteVariablesOptions {
  /**
   * Whether credential variables are permitted in the current module.
   * True only for Web-Auto test suites; false (default) for Verification and Evaluation.
   */
  allowCredentials?: boolean;
}

export interface ResolvedSuiteVariablesResult {
  /**
   * Complete resolved variable dictionary (literal + credential values).
   * Used for Web-Auto Playwright script sandbox execution.
   */
  resolved: Record<string, unknown>;

  /**
   * Plain literal-only variables dictionary.
   * Passed to assertion evaluation (evaluateAssertions) to keep assertion context credential-free.
   */
  literalVariables: Record<string, unknown>;

  /**
   * Collected sensitive plaintext values (length >= 4) from credential variables for post-execution redaction.
   * Literal variables are excluded to prevent false-positive masking of public identifiers.
   */
  sensitiveValues: Set<string>;

  /**
   * Structured configuration error.
   * Never throws — invalid permissions or missing credentials surface here.
   */
  error: { source: "config"; message: string } | null;
}

const MIN_SENSITIVE_LENGTH = 4;

/**
 * Resolve suite-level variables with backwards compatibility and strict security boundary enforcement.
 *
 * CONTRACT:
 * - Literal values are unpacked directly into `resolved` and `literalVariables`.
 * - Credential references require `options.allowCredentials === true`.
 * - Credentials must be enabled and registered under `serviceType === "integration"` and `provider === "testing"`.
 * - All credential values are gathered into `sensitiveValues` for earliest post-execution redaction.
 * - Legacy flat records (e.g. { baseUrl: "https://..." }) are unpacked as literals.
 * - Never throws — catches any unexpected exception and returns structured config error.
 */
export async function resolveSuiteVariables(
  rawVariables?: unknown,
  options: ResolveSuiteVariablesOptions = {},
): Promise<ResolvedSuiteVariablesResult> {
  const resolved: Record<string, unknown> = {};
  const literalVariables: Record<string, unknown> = {};
  const sensitiveValues = new Set<string>();

  if (!rawVariables || typeof rawVariables !== "object") {
    return { resolved, literalVariables, sensitiveValues, error: null };
  }

  try {
    for (const [key, varDef] of Object.entries(rawVariables)) {
      // 1. Structured variable definition
      if (varDef && typeof varDef === "object" && "type" in (varDef as Record<string, unknown>)) {
        const def = varDef as SuiteVariableDefinition;

        if (def.type === "literal") {
          resolved[key] = def.value;
          literalVariables[key] = def.value;
        } else if (def.type === "credential") {
          // Backend hard gate: reject credential references if module doesn't allow them
          if (!options.allowCredentials) {
            return {
              resolved,
              literalVariables,
              sensitiveValues,
              error: {
                source: "config",
                message: `Credential variables are not permitted in this suite type (key: '${key}').`,
              },
            };
          }

          const cred = await getCredentialFieldsById(def.credentialId);

          // Boundary check: only integration service credentials with provider 'testing' may be referenced
          if (!cred || cred.serviceType !== "integration" || cred.provider !== "testing") {
            return {
              resolved,
              literalVariables,
              sensitiveValues,
              error: {
                source: "config",
                message: `Credential '${def.credentialId}' not found or not registered under 'integration' service with 'testing' provider (key: '${key}').`,
              },
            };
          }

          const fieldName = def.field ?? "";
          if (fieldName && !(fieldName in cred.fields)) {
            return {
              resolved,
              literalVariables,
              sensitiveValues,
              error: {
                source: "config",
                message: `Field '${fieldName}' not found in credential '${def.credentialId}' (key: '${key}').`,
              },
            };
          }
          const value = fieldName ? cred.fields[fieldName] : cred.fields;
          resolved[key] = value;

          // All credential variables are treated as sensitive (passwords, tokens, keys, etc.)
          const strVal =
            typeof value === "string"
              ? value
              : typeof value === "number"
                ? String(value)
                : null;

          if (strVal && strVal.length >= MIN_SENSITIVE_LENGTH) {
            sensitiveValues.add(strVal);
          }
        }
      } else {
        // 2. Backwards compatibility: flat key-value pairs (e.g. { baseUrl: "https://..." })
        resolved[key] = varDef;
        literalVariables[key] = varDef;
      }
    }

    return { resolved, literalVariables, sensitiveValues, error: null };
  } catch (err) {
    return {
      resolved,
      literalVariables,
      sensitiveValues,
      error: {
        source: "config",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
