/**
 * Next.js boot hook. Converges runtime state on process start.
 */

export async function register(): Promise<void> {
  // Boot-trace: prove the instrumentation hook actually fired. If
  // this line is missing from the dev console the rest of the
  // bootstrap below — config loading, recovery, scheduler, sandbox
  // — never ran. Most common cause is launching `pnpm dev` in a
  // context where Next.js skips instrumentation (edge runtime tests,
  // misconfigured next.config.ts, etc.).
  console.log(
    `[instrumentation] register() called, NEXT_RUNTIME=${process.env.NEXT_RUNTIME ?? "(unset)"}`,
  );
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Lazy import: keeps server-only modules out of the edge-runtime
  // graph that Next builds for things like middleware.

  // CONTRACT: process_boot row MUST be inserted before recoverStrandedRuns.
  const { recordProcessBoot } = await import("@/lib/runner/process-boot");
  let bootStartedAt: Date | undefined;
  try {
    const boot = await recordProcessBoot();
    bootStartedAt = boot.startedAt;
  } catch (err) {
    console.error("[nango] process boot record failed; skipping recovery:", err);
  }

  if (bootStartedAt) {
    const { recoverStrandedRuns } = await import("@/lib/runner/recovery");
    try {
      await recoverStrandedRuns(bootStartedAt);
    } catch (err) {
      // Don't block boot if recovery itself fails — log and move on.
      // The next boot tries again, and the operational tools (Drizzle
      // Studio, psql) can patch up state in the meantime.
      console.error("[nango] runner recovery failed:", err);
    }

    // Same idea, sibling subsystem: flip stranded verification_run rows
    // from `running` to `errored`. See docs/verification.md.
    const { recoverStrandedVerificationRuns } = await import(
      "@/lib/verification/recovery"
    );
    try {
      await recoverStrandedVerificationRuns(bootStartedAt);
    } catch (err) {
      console.error("[nango] verification recovery failed:", err);
    }

    // Evaluation subsystem: same recovery pattern.
    const { recoverStrandedEvalRuns } = await import(
      "@/lib/evaluation/recovery"
    );
    try {
      await recoverStrandedEvalRuns(bootStartedAt);
    } catch (err) {
      console.error("[nango] evaluation recovery failed:", err);
    }
  }

  // Application config: seed defaults (insert-if-absent), then load all
  // rows into the in-memory cache. Must run before any module that reads
  // config values (caches, sandbox, etc.).
  const { seedDefaults, loadAllConfigs, getConfig } = await import(
    "@/lib/config/service"
  );
  try {
    await seedDefaults();
    await loadAllConfigs();
    // Boot-trace: log the resolved value of a known-tricky key
    // (sandbox.subprocess.python_path) so an operator can confirm
    // the DB row actually landed in the in-memory cache for this
    // particular Node worker. The previous "[config] loaded N
    // config(s)" line only proves the SELECT returned rows, not
    // that any specific key is queryable from this worker's
    // module instance — Next.js dev / Turbopack can hold multiple
    // module realms.
    const pyPath = getConfig("sandbox.subprocess.python_path", "");
    console.log(
      `[instrumentation] config probe: sandbox.subprocess.python_path=${JSON.stringify(pyPath)}`,
    );
  } catch (err) {
    console.error("[nango] config bootstrap failed:", err);
  }

  // Dataset cache sweep — see docs/data-sources.md.
  // Best-effort: a failed sweep logs and continues so a permission
  // hiccup can never block boot.
  try {
    const { purgeAllDatasets } = await import("@/lib/data-sources/cache");
    const removed = await purgeAllDatasets();
    if (removed > 0) {
      console.log(
        `[instrumentation] dataset cache swept: removed ${removed} top-level entries`,
      );
    }
  } catch (err) {
    console.error("[nango] dataset cache sweep failed:", err);
  }

  // Built-in skills: seed `dist/builtin-skills.json` into the DB. Cheap on
  // warm starts (per-skill checksum compare), tolerant of a missing bundle
  // (logs and skips, so first-run dev without `pnpm build:skills` still boots).
  // See docs/skills.md.
  const { seedBuiltinSkills } = await import("@/lib/skills/builtin-reconcile");
  try {
    await seedBuiltinSkills();
  } catch (err) {
    console.error("[nango] builtin skills reconcile failed:", err);
  }

  // Supervisor canonicalization — see docs/prompts.md.
  const { canonicalizeSupervisorAgents } = await import(
    "@/lib/builtin-agents/canonicalize-supervisor"
  );
  try {
    await canonicalizeSupervisorAgents();
  } catch (err) {
    console.error("[nango] supervisor canonicalize failed:", err);
  }

  // Schedules: register one Croner job per enabled row. Independent
  // of recovery — a scheduler boot failure shouldn't prevent the app
  // from serving requests; the next restart tries again.
  const { bootstrapScheduler, shutdownScheduler } = await import("@/lib/runner/scheduler");
  try {
    await bootstrapScheduler();
  } catch (err) {
    console.error("[nango] scheduler bootstrap failed:", err);
  }

  // Graceful shutdown: clear all scheduler timers so the process can
  // exit without waiting for pending setTimeout callbacks.
  // Guard against HMR double-registration in dev mode.
  // NOTE: `nodeProcess` indirection avoids Turbopack's static
  // `process.on` → Edge-incompatible warning (false positive —
  // register() is guarded by NEXT_RUNTIME === "nodejs" above).
  const g = globalThis as Record<string, unknown>;
  if (!g.__nango_shutdown_registered) {
    g.__nango_shutdown_registered = true;
    const nodeProcess: NodeJS.Process = globalThis.process;
    const onShutdown = (): void => { shutdownScheduler(); };
    nodeProcess.on("SIGTERM", onShutdown);
    nodeProcess.on("SIGINT", onShutdown);
  }

  // Sandbox: resolve the active adapter eagerly so a misconfigured
  // SANDBOX_MODE (e.g. SANDBOX_MODE=docker but Docker is down) fails
  // at boot instead of on the first user invocation. Also pins the
  // selection in the per-process cache and emits a single line
  // operators can grep for.
  const { getActiveAdapter } = await import("@/lib/sandbox/registry.server");
  const { SandboxDisabledError } = await import("@/lib/sandbox/errors");
  try {
    const active = await getActiveAdapter();
    console.log(
      `[nango] sandbox active backend: ${active.backend}`,
    );
  } catch (err) {
    if (err instanceof SandboxDisabledError) {
      // Expected fail-closed state (fresh install / no isolation opted in):
      // code execution is intentionally OFF, not misconfigured.
      console.warn(
        "[nango] code execution is disabled — no sandbox configured. " +
          "Set sandbox.mode=local-docker (recommended) or " +
          "sandbox.allow_insecure=true to enable run_code_in_sandbox / skill scripts.",
      );
    } else {
      console.error("[nango] sandbox bootstrap failed:", err);
    }
  }
}
