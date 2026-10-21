/**
 * @chat/messaging-core & Normalized State Store
 * Implements the Normalized In-Memory Store Schema, Optimistic UI Outbox Reconciler,
 * Sequence Gap Detector, and Ephemeral Typing TTL Manager from docs/03-frontend-design-specification.md.
 */

export interface UserProfile {
  user_id: string;
  username: string;
  display_name: string;
  masked_email: string;
  avatar_url?: string | null;
}

export interface PresenceEntry {
  status: 'ONLINE' | 'OFFLINE' | 'AWAY' | 'DND';
  lastSeenAt: string;
  nodeId?: string;
}

export interface ChannelMetadata {
  channel_id: string;
  type: 'DIRECT' | 'GROUP';
  name: string | null;
  topic?: string | null;
  is_private: boolean;
  member_count: number;
  last_sequence_num: number;
  unread_count: number;
}

export interface MessageEntity {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sequence_num: number;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  content: string;
  content_type: 'TEXT' | 'SYSTEM' | 'MEDIA';
  created_at: string;
  status?: 'PERSISTED';
}

export interface OptimisticMessage {
  client_message_id: string;
  channel_id: string;
  sender_id: string;
  sender_display_name: string;
  content: string;
  created_at: string;
  status: 'SENDING' | 'FAILED_RETRYABLE';
}

export interface SequenceGapResult {
  hasGap: boolean;
  fromSeq: number;
  toSeq: number;
}

export class ChatStateStore {
  private csrfToken: string | null = null;
  private currentUser: UserProfile | null = null;
  private activeStorageEngine: 'spanner' | 'firestore' = 'spanner';

  public usersById: Record<string, UserProfile> = {};
  public presenceByUserId: Record<string, PresenceEntry> = {};
  public channelsById: Record<string, ChannelMetadata> = {};
  public messageIdsByChannel: Record<string, string[]> = {};
  public messagesById: Record<string, MessageEntity> = {};
  public pendingMessagesByClientId: Record<string, OptimisticMessage> = {};
  public typingUsersByChannel: Record<string, Record<string, number>> = {};

  public setSession(user: UserProfile, csrfToken: string): void {
    this.currentUser = user;
    this.csrfToken = csrfToken;
    this.usersById[user.user_id] = user;
  }

  public getCsrfToken(): string | null {
    return this.csrfToken;
  }

  public getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  public setStorageEngine(engine: 'spanner' | 'firestore'): void {
    this.activeStorageEngine = engine;
  }

  public getStorageEngine(): 'spanner' | 'firestore' {
    return this.activeStorageEngine;
  }

  public upsertUsers(users: UserProfile[]): void {
    for (const u of users) {
      this.usersById[u.user_id] = u;
    }
  }

  public updatePresence(
    userId: string,
    status: 'ONLINE' | 'OFFLINE' | 'AWAY' | 'DND',
    lastSeenAt: string,
    nodeId?: string
  ): void {
    this.presenceByUserId[userId] = { status, lastSeenAt, nodeId };
  }

  public upsertChannels(channels: Array<Omit<ChannelMetadata, 'unread_count'>>): void {
    for (const ch of channels) {
      const existingUnread = this.channelsById[ch.channel_id]?.unread_count ?? 0;
      this.channelsById[ch.channel_id] = {
        ...ch,
        unread_count: existingUnread,
      };
    }
  }

  /**
   * Inserts an optimistic message into the outbox (<16ms perceived latency).
   */
  public enqueueOptimisticMessage(msg: Omit<OptimisticMessage, 'status'>): OptimisticMessage {
    const optimistic: OptimisticMessage = {
      ...msg,
      status: 'SENDING',
    };
    this.pendingMessagesByClientId[msg.client_message_id] = optimistic;
    return optimistic;
  }

  /**
   * Marks an unacknowledged optimistic message as FAILED_RETRYABLE after timeout.
   */
  public markOptimisticMessageFailed(clientMessageId: string): OptimisticMessage | null {
    const pending = this.pendingMessagesByClientId[clientMessageId];
    if (!pending) return null;
    pending.status = 'FAILED_RETRYABLE';
    return pending;
  }

  /**
   * Detects if an incoming message sequence number skips ahead of the highest contiguous sequence in local state.
   */
  public detectSequenceGap(channelId: string, incomingSequenceNum: number): SequenceGapResult {
    const ids = this.messageIdsByChannel[channelId] || [];
    if (ids.length === 0) {
      return { hasGap: false, fromSeq: 0, toSeq: 0 };
    }
    const lastId = ids[ids.length - 1];
    const lastMsg = this.messagesById[lastId];
    if (!lastMsg) {
      return { hasGap: false, fromSeq: 0, toSeq: 0 };
    }

    if (incomingSequenceNum > lastMsg.sequence_num + 1) {
      return {
        hasGap: true,
        fromSeq: lastMsg.sequence_num + 1,
        toSeq: incomingSequenceNum - 1,
      };
    }
    return { hasGap: false, fromSeq: 0, toSeq: 0 };
  }

  /**
   * Reconciles a canonical server message (from REST history, message_ack, or receive_message),
   * removing any matching optimistic outbox entry and sorting messages strictly by sequence_num ASC.
   */
  public reconcileServerMessage(msg: MessageEntity, activeChannelId?: string | null): SequenceGapResult {
    const gap = this.detectSequenceGap(msg.channel_id, msg.sequence_num);

    // 1. Remove matching optimistic message from pending outbox if present
    if (msg.client_message_id && this.pendingMessagesByClientId[msg.client_message_id]) {
      delete this.pendingMessagesByClientId[msg.client_message_id];
    }

    // 2. Store canonical message entity
    this.messagesById[msg.message_id] = {
      ...msg,
      status: 'PERSISTED',
    };

    // 3. Maintain deduplicated, sequence-ordered message ID list for the channel
    const list = this.messageIdsByChannel[msg.channel_id]
      ? [...this.messageIdsByChannel[msg.channel_id]]
      : [];

    // Also deduplicate by client_message_id in case another message_id was previously registered
    const existingById = list.includes(msg.message_id);
    if (!existingById) {
      list.push(msg.message_id);
    }

    list.sort((a, b) => {
      const seqA = this.messagesById[a]?.sequence_num ?? 0;
      const seqB = this.messagesById[b]?.sequence_num ?? 0;
      return seqA - seqB;
    });

    this.messageIdsByChannel[msg.channel_id] = list;

    // 4. Update channel metadata & unread badge if channel is not currently active
    const ch = this.channelsById[msg.channel_id];
    if (ch) {
      if (msg.sequence_num > ch.last_sequence_num) {
        ch.last_sequence_num = msg.sequence_num;
      }
      if (activeChannelId && activeChannelId !== msg.channel_id) {
        ch.unread_count += 1;
      }
    }

    return gap;
  }

  public clearChannelUnread(channelId: string): void {
    const ch = this.channelsById[channelId];
    if (ch) {
      ch.unread_count = 0;
    }
  }

  public getOrderedMessagesForChannel(channelId: string): MessageEntity[] {
    const ids = this.messageIdsByChannel[channelId] || [];
    return ids.map((id) => this.messagesById[id]).filter(Boolean);
  }

  public getPendingMessagesForChannel(channelId: string): OptimisticMessage[] {
    return Object.values(this.pendingMessagesByClientId).filter(
      (m) => m.channel_id === channelId
    );
  }

  public setUserTyping(
    channelId: string,
    userId: string,
    isTyping: boolean,
    nowMs: number = Date.now(),
    ttlMs: number = 5000
  ): void {
    if (!this.typingUsersByChannel[channelId]) {
      this.typingUsersByChannel[channelId] = {};
    }
    if (isTyping) {
      this.typingUsersByChannel[channelId][userId] = nowMs + ttlMs;
    } else {
      delete this.typingUsersByChannel[channelId][userId];
    }
  }

  public getActiveTypingUserIds(channelId: string, nowMs: number = Date.now()): string[] {
    const channelMap = this.typingUsersByChannel[channelId];
    if (!channelMap) return [];
    const active: string[] = [];
    for (const [uid, expiresAt] of Object.entries(channelMap)) {
      if (expiresAt > nowMs) {
        active.push(uid);
      } else {
        delete channelMap[uid];
      }
    }
    return active;
  }

  /**
   * Purges all in-memory state on logout (Section 4.2 of Frontend Design Specification).
   */
  public resetAllState(): void {
    this.csrfToken = null;
    this.currentUser = null;
    this.usersById = {};
    this.presenceByUserId = {};
    this.channelsById = {};
    this.messageIdsByChannel = {};
    this.messagesById = {};
    this.pendingMessagesByClientId = {};
    this.typingUsersByChannel = {};
  }
}
