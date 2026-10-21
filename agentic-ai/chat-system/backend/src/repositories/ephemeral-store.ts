import crypto from 'crypto';

export interface PresenceRecord {
  user_id: string;
  username: string;
  display_name: string;
  status: 'ONLINE' | 'OFFLINE' | 'AWAY' | 'DND';
  custom_status: string | null;
  node_id: string;
  last_seen_at: string;
  expires_at: number;
}

export interface WsTicketRecord {
  user_id: string;
  username: string;
  display_name: string;
  jti: string;
  expires_at: number;
}

/**
 * Ephemeral State & Routing Store (Redis Cluster equivalent in-memory engine).
 * Manages:
 * - user:sessions:{user_id} -> Map<session_id, node_id> (90s TTL)
 * - presence:{user_id} -> PresenceRecord (90s TTL)
 * - typing:{channel_id} -> Map<user_id, { username, expires_at }> (5s TTL)
 * - ws:ticket:{sha256} -> Single-use 30s TTL WebSocket upgrade ticket (atomic GETDEL)
 * - revoked_jti:{jti} -> Revoked session JWT IDs
 * - pre_auth_csrf:{token} -> Pre-login synchronizer CSRF tokens (15m TTL)
 */
export class EphemeralStore {
  public readonly nodeId: string;
  private userSessions = new Map<string, Map<string, { nodeId: string; expiresAt: number }>>();
  private presenceMap = new Map<string, PresenceRecord>();
  private typingMap = new Map<string, Map<string, { username: string; expiresAt: number }>>();
  private wsTickets = new Map<string, WsTicketRecord>();
  private revokedJtis = new Map<string, number>();
  private preAuthCsrfTokens = new Map<string, number>();
  private channelMembersCache = new Map<string, { members: Set<string>; expiresAt: number }>();

  constructor(nodeId?: string) {
    this.nodeId = nodeId || `chat-node-${crypto.randomBytes(3).toString('hex')}`;
    // Periodic TTL reaper every 5 seconds
    setInterval(() => this.reapExpired(), 5000).unref();
  }

  public issuePreAuthCsrfToken(): string {
    const token = `csrf_pre_${crypto.randomBytes(20).toString('hex')}`;
    this.preAuthCsrfTokens.set(token, Date.now() + 15 * 60 * 1000);
    return token;
  }

  public verifyPreAuthCsrfToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.preAuthCsrfTokens.get(token);
    if (!exp || exp <= Date.now()) {
      this.preAuthCsrfTokens.delete(token);
      return false;
    }
    return true;
  }

  public revokeJti(jti: string, ttlMs = 3600_000): void {
    this.revokedJtis.set(jti, Date.now() + ttlMs);
  }

  public isJtiRevoked(jti: string): boolean {
    const exp = this.revokedJtis.get(jti);
    if (!exp) return false;
    if (exp <= Date.now()) {
      this.revokedJtis.delete(jti);
      return false;
    }
    return true;
  }

  /**
   * Issues a 30-second single-use WebSocket handshake ticket stored by SHA-256 hash.
   */
  public issueWsTicket(user: {
    user_id: string;
    username: string;
    display_name: string;
    jti: string;
  }): { ticket: string; expiresAt: string } {
    const rawTicket = `wst_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(rawTicket).digest('hex');
    const expiresAt = Date.now() + 30_000;
    this.wsTickets.set(hash, {
      ...user,
      expires_at: expiresAt,
    });
    return {
      ticket: rawTicket,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Atomic single-use GETDEL verification for WebSocket upgrade ticket.
   */
  public redeemWsTicket(rawTicket: string | undefined): WsTicketRecord | null {
    if (!rawTicket) return null;
    const hash = crypto.createHash('sha256').update(rawTicket).digest('hex');
    const record = this.wsTickets.get(hash);
    // Always delete immediately (atomic single-use GETDEL)
    this.wsTickets.delete(hash);
    if (!record || record.expires_at <= Date.now()) {
      return null;
    }
    if (this.isJtiRevoked(record.jti)) {
      return null;
    }
    return record;
  }

  /**
   * Registers or refreshes a WebSocket session in user:sessions:{user_id} and presence:{user_id} (90s TTL).
   */
  public registerOrRefreshSession(
    user: { user_id: string; username: string; display_name: string },
    sessionId: string,
    customStatus: string | null = 'Available'
  ): PresenceRecord {
    const now = Date.now();
    const expiresAt = now + 90_000;

    let sessions = this.userSessions.get(user.user_id);
    if (!sessions) {
      sessions = new Map();
      this.userSessions.set(user.user_id, sessions);
    }
    sessions.set(sessionId, { nodeId: this.nodeId, expiresAt });

    const existing = this.presenceMap.get(user.user_id);
    const record: PresenceRecord = {
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      status: 'ONLINE',
      custom_status: customStatus ?? existing?.custom_status ?? 'Available',
      node_id: this.nodeId,
      last_seen_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    };
    this.presenceMap.set(user.user_id, record);
    return record;
  }

  /**
   * Unregisters a WebSocket session on disconnect; transitions user to OFFLINE if 0 sessions remain.
   */
  public unregisterSession(userId: string, sessionId: string): PresenceRecord | null {
    const sessions = this.userSessions.get(userId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.userSessions.delete(userId);
      }
    }

    const remaining = this.userSessions.get(userId)?.size ?? 0;
    const existing = this.presenceMap.get(userId);
    if (existing && remaining === 0) {
      existing.status = 'OFFLINE';
      existing.last_seen_at = new Date().toISOString();
      this.presenceMap.set(userId, existing);
      return existing;
    }
    return existing ?? null;
  }

  public getPresenceBatch(userIds: string[]): PresenceRecord[] {
    const now = Date.now();
    return userIds.map((uid) => {
      const rec = this.presenceMap.get(uid);
      if (!rec) {
        return {
          user_id: uid,
          username: uid,
          display_name: uid,
          status: 'OFFLINE',
          custom_status: null,
          node_id: this.nodeId,
          last_seen_at: new Date(now).toISOString(),
          expires_at: 0,
        };
      }
      if (rec.status === 'ONLINE' && rec.expires_at <= now) {
        rec.status = 'OFFLINE';
      }
      return rec;
    });
  }

  public getAllPresence(): PresenceRecord[] {
    const now = Date.now();
    const list: PresenceRecord[] = [];
    for (const rec of this.presenceMap.values()) {
      if (rec.status === 'ONLINE' && rec.expires_at <= now) {
        rec.status = 'OFFLINE';
      }
      list.push(rec);
    }
    return list;
  }

  public setTyping(
    channelId: string,
    userId: string,
    username: string,
    isTyping: boolean
  ): void {
    let chMap = this.typingMap.get(channelId);
    if (!chMap) {
      chMap = new Map();
      this.typingMap.set(channelId, chMap);
    }
    if (isTyping) {
      chMap.set(userId, { username, expiresAt: Date.now() + 5000 });
    } else {
      chMap.delete(userId);
    }
  }

  public getTypingUsers(channelId: string): Array<{ user_id: string; username: string }> {
    const chMap = this.typingMap.get(channelId);
    if (!chMap) return [];
    const now = Date.now();
    const active: Array<{ user_id: string; username: string }> = [];
    for (const [uid, data] of chMap.entries()) {
      if (data.expiresAt > now) {
        active.push({ user_id: uid, username: data.username });
      } else {
        chMap.delete(uid);
      }
    }
    return active;
  }

  public cacheChannelMembers(channelId: string, memberIds: string[]): void {
    this.channelMembersCache.set(channelId, {
      members: new Set(memberIds),
      expiresAt: Date.now() + 300_000,
    });
  }

  public getCachedChannelMembers(channelId: string): string[] | null {
    const entry = this.channelMembersCache.get(channelId);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.channelMembersCache.delete(channelId);
      return null;
    }
    return Array.from(entry.members);
  }

  private reapExpired(): void {
    const now = Date.now();
    for (const [hash, ticket] of this.wsTickets.entries()) {
      if (ticket.expires_at <= now) {
        this.wsTickets.delete(hash);
      }
    }
    for (const [token, exp] of this.preAuthCsrfTokens.entries()) {
      if (exp <= now) {
        this.preAuthCsrfTokens.delete(token);
      }
    }
    for (const [uid, sessions] of this.userSessions.entries()) {
      for (const [sid, data] of sessions.entries()) {
        if (data.expiresAt <= now) {
          sessions.delete(sid);
        }
      }
      if (sessions.size === 0) {
        this.userSessions.delete(uid);
        const pres = this.presenceMap.get(uid);
        if (pres && pres.status === 'ONLINE') {
          pres.status = 'OFFLINE';
        }
      }
    }
  }
}

export const ephemeralStore = new EphemeralStore();
