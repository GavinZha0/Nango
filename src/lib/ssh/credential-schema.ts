/**
 * Zod schemas for the credential payload shapes that an `ssh_server`
 * row can bind to (basic_auth + private_key), plus the normalised
 * shape consumed by the SSH client's connect builder.
 *
 * See docs/ssh.md.
 */

import { z } from "zod";

/** `basic_auth` payload as used by SSH password auth. */
export const SshBasicAuthPayload = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
});

/** `private_key` payload (PEM key + optional passphrase). */
export const SshPrivateKeyPayload = z.object({
  username: z.string().min(1, "username is required"),
  /**
   * OpenSSH PEM-encoded private key (whole file, including the
   * `-----BEGIN OPENSSH PRIVATE KEY-----` / END markers). ssh2 also
   * accepts PKCS#1 / PKCS#8 RSA keys; both pass through.
   */
  privateKey: z.string().min(1, "privateKey is required"),
  /** Optional passphrase if the key is encrypted at rest. */
  passphrase: z.string().optional(),
});

export type SshBasicAuthPayloadT = z.infer<typeof SshBasicAuthPayload>;
export type SshPrivateKeyPayloadT = z.infer<typeof SshPrivateKeyPayload>;

/**
 * Normalised SSH auth surfaced to `client.ts`'s connect builder. We
 * keep `kind` discriminated so the connect-config branch is exhaustive.
 */
export type NormalisedSshAuth =
  | { kind: "password"; username: string; password: string }
  | {
      kind: "privateKey";
      username: string;
      privateKey: string;
      passphrase?: string;
    };
