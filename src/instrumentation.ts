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
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
  // Lazy import: keeps server-only modules out of the edge-runtime
  // graph that Next builds for things like middleware.

  // Phase 1: Parallel boot tasks.
  // - `process_boot` MUST be recorded before stranded-run recovery.
  // - Config bootstrap (`seedDefaults` + `loadAllConfigs`) MUST finish before
  //   `bootstrapScheduler()`, before serving requests, and before importing any
  //   module whose top-level singleton evaluates `getConfig*` (e.g. `lookup`,
  //   `agentPool`).
  // - CONTRACT: Any module imported before `configReady` settles MUST NOT read
  //   `getConfig*` at module evaluation time, or it will pin code defaults into
  //   `globalThis` singletons for the lifetime of the process.
  // - `seedBuiltinInfrastructure` runs in Phase 1 so background sandbox probing
  //   sees any newly seeded `NANGO_SEED_SANDBOX_URL` credentials.
  let bootStartedAt: Date | undefined;

  const configReady = (async () => {
    try {
      const { seedDefaults, loadAllConfigs } = await import(
        "@/lib/config/service"
      );
      await seedDefaults();
      await loadAllConfigs();
    } catch (err) {
      console.error("[nango] config bootstrap failed:", err);
    }
  })();

  await Promise.all([
    (async () => {
      try {
        const { recordProcessBoot } = await import("@/lib/runner/process-boot");
        const boot = await recordProcessBoot();
        bootStartedAt = boot.startedAt;
      } catch (err) {
        console.error(
          "[nango] process boot record failed; skipping recovery:",
          err,
        );
      }
    })(),
    configReady,
    (async () => {
      await configReady;
      try {
        const { seedBuiltinInfrastructure } = await import(
          "@/lib/credentials/seed-infra"
        );
        await seedBuiltinInfrastructure();
      } catch (err) {
        console.error("[nango] builtin infrastructure seed failed:", err);
      }
    })(),
    (async () => {
      await configReady;
      try {
        const { canonicalizeSupervisorAgents } = await import(
          "@/lib/builtin-agents/canonicalize-supervisor"
        );
        await canonicalizeSupervisorAgents();
      } catch (err) {
        console.error("[nango] supervisor canonicalize failed:", err);
      }
    })(),
  ]);

  // Phase 2: Parallel boot-epoch recovery across independent subsystems.
  // Runs before `bootstrapScheduler()` so stranded rows are flipped before
  // scheduled jobs dispatch.
  if (bootStartedAt) {
    const startedAt = bootStartedAt;
    await Promise.all([
      (async () => {
        try {
          const { recoverStrandedRuns } = await import("@/lib/runner/recovery");
          await recoverStrandedRuns(startedAt);
        } catch (err) {
          // Don't block boot if recovery itself fails — log and move on.
          console.error("[nango] runner recovery failed:", err);
        }
      })(),
      (async () => {
        try {
          const { recoverStrandedVerificationRuns } = await import(
            "@/lib/verification/recovery"
          );
          await recoverStrandedVerificationRuns(startedAt);
        } catch (err) {
          console.error("[nango] verification recovery failed:", err);
        }
      })(),
      (async () => {
        try {
          const { recoverStrandedEvalRuns } = await import(
            "@/lib/evaluation/recovery"
          );
          await recoverStrandedEvalRuns(startedAt);
        } catch (err) {
          console.error("[nango] evaluation recovery failed:", err);
        }
      })(),
      (async () => {
        try {
          const { recoverStrandedWebAutoRuns } = await import(
            "@/lib/web-auto/recovery"
          );
          await recoverStrandedWebAutoRuns(startedAt);
        } catch (err) {
          console.error("[nango] web-auto recovery failed:", err);
        }
      })(),
    ]);
  }

  // Phase 3: Schedules & graceful shutdown registration.
  const { bootstrapScheduler, shutdownScheduler } = await import(
    "@/lib/runner/scheduler"
  );
  const { mcpProviderPool } = await import("@/lib/mcp");
  try {
    await bootstrapScheduler();
  } catch (err) {
    console.error("[nango] scheduler bootstrap failed:", err);
  }

  // Graceful shutdown: clear all scheduler timers and close pooled MCP
  // providers (including stdio child process trees) so the process can
  // exit cleanly without stranding orphan child processes.
  // Guard against HMR double-registration in dev mode.
  // NOTE: `nodeProcess` indirection avoids Turbopack's static
  // `process.on` → Edge-incompatible warning (false positive —
  // register() is guarded by NEXT_RUNTIME === "nodejs" above).
  const g = globalThis as Record<string, unknown>;
  if (!g.__nango_shutdown_registered) {
    g.__nango_shutdown_registered = true;
    const nodeProcess: NodeJS.Process = globalThis.process;
    let shuttingDown = false;
    const runShutdown = (exitAfter: boolean): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      shutdownScheduler();
      const done = mcpProviderPool.shutdown();
      if (exitAfter) {
        void done.finally(() => {
          nodeProcess.exit(0);
        });
      }
    };
    const onShutdown = (): void => runShutdown(false);
    nodeProcess.on("SIGTERM", onShutdown);
    nodeProcess.on("SIGINT", onShutdown);
    nodeProcess.on("beforeExit", onShutdown);

    // CONTRACT: On Windows, `child.kill("SIGTERM")` terminates immediately via
    // `TerminateProcess`, bypassing signal handlers. Desktop's `ServerManager`
    // writes `__NANGO_SHUTDOWN__\n` over piped stdin for graceful cleanup.
    if (nodeProcess.stdin && !nodeProcess.stdin.isTTY) {
      let stdinBuf = "";
      nodeProcess.stdin.setEncoding("utf8");
      nodeProcess.stdin.on("data", (chunk: string) => {
        stdinBuf += chunk;
        if (stdinBuf.includes("__NANGO_SHUTDOWN__")) {
          runShutdown(true);
        } else if (stdinBuf.length > 256) {
          stdinBuf = stdinBuf.slice(-64);
        }
      });
    }
  }

  // Non-blocking background warmup/housekeeping: never delay HTTP server
  // readiness (`/api/health`) on filesystem sweeps or external sandbox probes.
  void (async () => {
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
  })();

  void (async () => {
    try {
      const { getActiveAdapter } = await import("@/lib/sandbox/registry.server");
      const active = await getActiveAdapter();
      console.log(`[nango] sandbox active backend: ${active.backend}`);
    } catch (err) {
      console.error("[nango] sandbox bootstrap failed:", err);
    }
  })();
}
