/**
 * Public entry point for the local shell subsystem.
 */

export {
  LOCAL_SHELL_KINDS,
  runLocalCommandArgsSchema,
  readLocalCommandOutputArgsSchema,
  stopLocalCommandArgsSchema,
  type LocalShellKind,
  type RunLocalCommandArgs,
  type ReadLocalCommandOutputArgs,
  type StopLocalCommandArgs,
  type LocalShellErrorCode,
  type LocalShellErr,
  type RunLocalCommandSyncResult,
  type RunLocalCommandBackgroundResult,
  type RunLocalCommandEnvelope,
  type ReadLocalCommandOutputOk,
  type ReadLocalCommandOutputEnvelope,
  type StopLocalCommandOk,
  type StopLocalCommandEnvelope,
} from "./schema";
