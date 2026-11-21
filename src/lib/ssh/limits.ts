/**
 * System-level resource bounds for the SSH execution path.
 *
 * See docs/ssh.md.
 */

import "server-only";

import { getConfigMs, getConfigNumber } from "@/lib/config";

const DEFAULT_EXEC_TIMEOUT_S = 60;
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream
const DEFAULT_MAX_COMMAND_CHARS = 20_000;
const DEFAULT_SFTP_MAX_BYTES = 104_857_600; // 100 MiB per SFTP transfer
const DEFAULT_POOL_IDLE_TIMEOUT_S = 180; // 3 min idle eviction

export interface SshLimits {
  /** Wall-clock cap on a single command execution. */
  execTimeoutMs: number;
  /** TCP + handshake budget before connect() rejects. */
  connectTimeoutMs: number;
  /** Per-stream (stdout / stderr) byte cap. */
  maxOutputBytes: number;
  /** Max assembled SSH wire command length in characters. */
  maxCommandChars: number;
  /** Max single-file size in bytes for SFTP upload/download. */
  sftpMaxBytes: number;
  /** Idle TTL before an unused pooled SSH connection is disposed. */
  poolIdleTimeoutMs: number;
}

export function getSshLimits(): SshLimits {
  return {
    execTimeoutMs: getConfigMs("ssh.exec_timeout", DEFAULT_EXEC_TIMEOUT_S),
    connectTimeoutMs: getConfigMs("ssh.connect_timeout", DEFAULT_CONNECT_TIMEOUT_S),
    maxOutputBytes: getConfigNumber("ssh.max_output_bytes", DEFAULT_MAX_OUTPUT_BYTES),
    maxCommandChars: getConfigNumber("ssh.max_command_chars", DEFAULT_MAX_COMMAND_CHARS),
    sftpMaxBytes: getConfigNumber("ssh.sftp_max_bytes", DEFAULT_SFTP_MAX_BYTES),
    poolIdleTimeoutMs: getConfigMs("ssh.pool_idle_timeout", DEFAULT_POOL_IDLE_TIMEOUT_S),
  };
}

/** Test seam: no-op now (config service handles caching). */
export function __resetSshLimitsCache(): void {
  // Kept for backward compat with existing tests.
}
