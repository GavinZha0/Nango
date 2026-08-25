/**
 * ServiceSandboxAdapter — External HTTP REST API Sandbox Backend.
 *
 * Connects to external sandbox services (default: dify-sandbox) via HTTP REST API.
 * See docs/sandbox.md.
 */

import "server-only";

import type {
  ISandboxAdapter,
  SandboxBackend,
  SandboxInput,
  SandboxOutput,
} from "../../types";
import { SANDBOX_PARAMS_ENV_KEY } from "../../types";
import { processStderr, processStdout } from "../../output";
import { buildMapping } from "../../path-mapper";
import { getConfigMs } from "@/lib/config";
import { getEnabledInfrastructureCredentialByProvider } from "@/lib/credentials/lookup";

const DEFAULT_SERVICE_URL = "http://sandbox:8194";
const DEFAULT_API_KEY = "dify-sandbox";
const DEFAULT_TIMEOUT_MS = 30000;

export class ServiceSandboxAdapter implements ISandboxAdapter {
  readonly backend: SandboxBackend = "service";
  readonly displayName = "Service Sandbox (dify)";

  /**
   * Probe whether the external sandbox service is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const cred = await getEnabledInfrastructureCredentialByProvider("dify-sandbox");
      const baseUrl = (cred?.host ?? DEFAULT_SERVICE_URL).replace(/\/+$/, "");
      const res = await fetch(`${baseUrl}/v1/sandbox/run`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      // Any HTTP response (even 404/405 from Gin root) proves the service is listening
      return res !== null;
    } catch {
      return false;
    }
  }

  async run(input: SandboxInput): Promise<SandboxOutput> {
    const startedAt = Date.now();
    const tmpHostDir = "/tmp/nango-service-sandbox";
    const mapping = buildMapping(tmpHostDir, input.datasets ?? []);

    const cred = await getEnabledInfrastructureCredentialByProvider("dify-sandbox");
    const baseUrl = (cred?.host ?? DEFAULT_SERVICE_URL).replace(/\/+$/, "");
    const apiKey = cred?.apiKey ?? DEFAULT_API_KEY;
    const timeoutMs = input.timeoutMs ?? getConfigMs("sandbox.timeout", DEFAULT_TIMEOUT_MS);

    // Determine language and main script payload (prefer explicit input.language)
    const language = input.language ?? this.determineLanguage(input.command);
    let code = input.stdin ?? "";

    // If no code passed in stdin, check inputFiles
    if (!code && input.inputFiles) {
      for (const [filename, buf] of Object.entries(input.inputFiles)) {
        if (filename.endsWith(".py") || filename.endsWith(".js")) {
          code = buf.toString("utf-8");
          break;
        }
      }
    }

    if (!code) {
      code = "# Empty execution script\n";
    }

    if (language === "python3") {
      let preamble =
        `import os as __nango_os, sys as __nango_sys\n` +
        `__nango_data_root = '/tmp/data'\n` +
        `DATA_DIR = __nango_data_root\n`;

      if (input.env?.[SANDBOX_PARAMS_ENV_KEY]) {
        const rawParams = input.env[SANDBOX_PARAMS_ENV_KEY];
        preamble += `__nango_os.environ['${SANDBOX_PARAMS_ENV_KEY}'] = ${JSON.stringify(rawParams)}\n`;
      }
      code = preamble + code;
    } else if (language === "javascript") {
      if (input.env?.[SANDBOX_PARAMS_ENV_KEY]) {
        const rawParams = input.env[SANDBOX_PARAMS_ENV_KEY];
        const preamble = `process.env[${JSON.stringify(SANDBOX_PARAMS_ENV_KEY)}] = ${JSON.stringify(rawParams)};\n`;
        code = preamble + code;
      }
    }

    const endpoint = `${baseUrl}/v1/sandbox/run`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({
          language,
          code,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Sandbox service returned HTTP ${response.status}: ${errText}`);
      }

      const json = (await response.json()) as {
        code: number;
        message: string;
        data?: {
          stdout?: string;
          stderr?: string;
          error?: string | number;
        };
      };

      if (json.code !== 0) {
        return {
          stdout: "",
          stderr: processStderr(json.message || "Sandbox service error", mapping),
          exitCode: json.code < 0 ? 503 : 1,
          durationMs: Date.now() - startedAt,
        };
      }

      const rawStdout = json.data?.stdout ?? "";
      const rawStderr =
        json.data?.stderr ??
        (typeof json.data?.error === "string" ? json.data.error : "");

      const exitCode =
        typeof json.data?.error === "number"
          ? json.data.error
          : json.data?.error &&
            typeof json.data.error === "string" &&
            json.data.error !== "" &&
            !rawStdout.trim()
          ? 1
          : 0;

      return {
        stdout: processStdout(rawStdout, mapping),
        stderr: processStderr(rawStderr, mapping),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return {
          stdout: "",
          stderr: processStderr("Execution timed out", mapping),
          exitCode: 124,
          durationMs: Date.now() - startedAt,
          termination: "timeout",
        };
      }
      throw err;
    }
  }

  private determineLanguage(command: string[]): "python3" | "javascript" {
    if (command.length > 0) {
      const cmd = command[0].toLowerCase();
      if (cmd.includes("node") || cmd.includes("js")) return "javascript";
    }
    return "python3";
  }
}
