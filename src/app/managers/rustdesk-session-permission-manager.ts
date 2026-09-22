interface RustDeskSessionPermissionLease {
  chatId: number;
  sessionId: string;
  connectionId?: string;
  createdAt: number;
  lastUsedAt: number;
}

const PENDING_LEASE_TTL_MS = 15 * 60 * 1000;

function key(chatId: number, sessionId: string): string {
  return `${chatId}:${sessionId}`;
}

class RustDeskSessionPermissionManager {
  private readonly leases = new Map<string, RustDeskSessionPermissionLease>();

  grant(chatId: number, sessionId: string, connectionId?: string): void {
    const now = Date.now();
    this.leases.set(key(chatId, sessionId), {
      chatId,
      sessionId,
      connectionId,
      createdAt: now,
      lastUsedAt: now,
    });
  }

  canUse(chatId: number, sessionId: string, connectionId?: string, now = Date.now()): boolean {
    const leaseKey = key(chatId, sessionId);
    const lease = this.leases.get(leaseKey);
    if (!lease) return false;

    if (!lease.connectionId && now - lease.createdAt >= PENDING_LEASE_TTL_MS) {
      this.leases.delete(leaseKey);
      return false;
    }

    // Connection-creating actions do not have a connection id. They must always
    // receive a fresh explicit user approval; a session lease only applies after
    // RustDesk has returned a concrete connection id.
    if (!connectionId) return false;
    if (lease.connectionId && lease.connectionId !== connectionId) return false;

    lease.lastUsedAt = now;
    return true;
  }

  bindConnection(chatId: number, sessionId: string, connectionId: string): boolean {
    const lease = this.leases.get(key(chatId, sessionId));
    if (!lease) return false;
    if (lease.connectionId && lease.connectionId !== connectionId) return false;
    lease.connectionId = connectionId;
    lease.lastUsedAt = Date.now();
    return true;
  }

  revoke(chatId: number, sessionId: string, connectionId?: string): boolean {
    const leaseKey = key(chatId, sessionId);
    const lease = this.leases.get(leaseKey);
    if (!lease) return false;
    if (connectionId && lease.connectionId && lease.connectionId !== connectionId) return false;
    return this.leases.delete(leaseKey);
  }

  has(chatId: number, sessionId: string): boolean {
    return this.leases.has(key(chatId, sessionId));
  }

  clearAll(): void {
    this.leases.clear();
  }

  __resetForTests(): void {
    this.clearAll();
  }
}

export const rustDeskSessionPermissionManager = new RustDeskSessionPermissionManager();
