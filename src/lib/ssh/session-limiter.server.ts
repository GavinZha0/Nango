

/**
 * Per-server concurrent SSH session limiter (caps open exec/SFTP channels
 * per `serverId` to stay within OpenSSH `MaxSessions` on shared connections).
 *
 * See docs/ssh.md.
 */

import "server-only";

interface ServerSlots {
  active: number;
  waiters: Array<() => void>;
}

export interface SshSessionSlot{
  ready: Promise<() => void>;
  cancel: () => void;
}

const servers = new Map<string, ServerSlots>();

export function acquireSshSessionSlot(
  serverId: string,
  maxSessions: number
): SshSessionSlot {
  if (!Number.isFinite(maxSessions) || maxSessions <= 0) {
    return { ready: Promise.resolve(() => {}), cancel: () => {} };
  }
  
  let state = servers.get(serverId);
  if (!state) {
    state = { active: 0, waiters: [] };
    servers.set(serverId, state);
  }
  
  const slots = state;
  let granted = false;
  let released = false;
  const release = (): void => {
    if (!granted || released) return;
    released = true;
    slots.active--;
    const next = slots.waiters.shift();
    if (next) {
      next();
    } else if (slots.active === 0) {
      servers.delete(serverId);
    }
  };

  let grant!: () => void;
  const ready = new Promise<() => void>((resolve) => {
    grant = () => {
      granted = true;
      slots.active++;
      resolve(release);
    };
  });


  if (slots.active < maxSessions) {
    grant();
  } else {
    slots.waiters.push(grant);
  }

  return {
    ready,
    cancel: () => {
      // Handle the race where a queued waiter is granted just before abort/timeout.
      if (granted) {
        release();
        return;
      }
      const idx = slots.waiters.indexOf(grant);
      if (idx >= 0) {
        slots.waiters.splice(idx, 1);
      }
      if (slots.active === 0 && slots.waiters.length === 0) {
        servers.delete(serverId);
      }
    }
  };
}

export function __sshSessionSlotStats(serverId: string): { active: number; waiters: number } {
  const state = servers.get(serverId);
  return {
    active: state?.active ?? 0,
    waiters: state?.waiters.length ?? 0
  };
}