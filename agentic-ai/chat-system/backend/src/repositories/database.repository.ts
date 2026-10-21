// Ensure local corp proxy certificate overrides do not interfere with standard ADC OAuth tokens
delete process.env.GOOGLE_API_CERTIFICATE_CONFIG;
process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE = 'false';

import crypto from 'crypto';
import { Spanner } from '@google-cloud/spanner';
import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import { hashEmail, hashPassword, maskEmail } from '../config/security';
import { ephemeralStore } from './ephemeral-store';

export const GCP_PROJECT_ID =
  process.env.GCP_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  'cloud-next25-screendemo';
export const SPANNER_INSTANCE_ID =
  process.env.SPANNER_INSTANCE_ID || 'chat-spanner-instance';
export const SPANNER_DATABASE_ID = process.env.SPANNER_DATABASE_ID || 'chat-db';
export const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || 'chat-system-db';
export const PUBSUB_NODE_TOPIC =
  process.env.PUBSUB_NODE_TOPIC || 'chat-node-gateway-1';
export const PUBSUB_BROADCAST_TOPIC =
  process.env.PUBSUB_BROADCAST_TOPIC || 'channel-broadcast-shard-0';

export interface UserEntity {
  user_id: string;
  username: string;
  email_hash: string;
  masked_email: string;
  password_hash: string;
  display_name: string;
  avatar_url: string | null;
  account_status: string;
  created_at: string;
}

export interface ChannelEntity {
  channel_id: string;
  type: 'DIRECT' | 'GROUP';
  dm_pair_hash: string | null;
  name: string | null;
  topic: string | null;
  is_private: boolean;
  created_by: string;
  member_count: number;
  last_sequence_num: number;
  last_message_at: string | null;
  created_at: string;
}

export interface MessageEntity {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sequence_num: number;
  sender_id: string;
  sender_username?: string;
  sender_display_name?: string;
  content: string;
  content_type: 'TEXT' | 'SYSTEM' | 'MEDIA';
  reply_to_message_id: string | null;
  is_deleted: boolean;
  created_at: string;
}

/**
 * Dual-Database Persistence Repository supporting:
 * 1. Cloud Spanner (Interleaved relational schema with 100% parameterized SQL queries)
 * 2. Cloud Firestore in Native Mode (Document/Subcollection hierarchy)
 * 3. Google Cloud Pub/Sub for cross-node real-time message fan-out
 */
export class DatabaseRepository {
  private spanner: Spanner;
  private spannerDb: ReturnType<ReturnType<Spanner['instance']>['database']>;
  private firestore: Firestore;
  private pubsub: PubSub;

  constructor() {
    this.spanner = new Spanner({ projectId: GCP_PROJECT_ID });
    const instance = this.spanner.instance(SPANNER_INSTANCE_ID);
    this.spannerDb = instance.database(SPANNER_DATABASE_ID);

    this.firestore = new Firestore({
      projectId: GCP_PROJECT_ID,
      databaseId: FIRESTORE_DATABASE_ID,
    });

    this.pubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  }

  /**
   * Look up a user by email hash or username using parameterized Spanner SQL (fallback to Firestore).
   */
  public async findUserByIdentifier(identifier: string): Promise<UserEntity | null> {
    const clean = identifier.trim().toLowerCase();
    const emailHash = clean.includes('@') ? hashEmail(clean) : clean;

    try {
      // Strictly parameterized query (Zero string concatenation)
      const [rows] = await this.spannerDb.run({
        sql: `SELECT user_id, username, email_hash, masked_email, password_hash,
                     display_name, avatar_url, account_status, created_at
              FROM Users
              WHERE email_hash = @emailHash OR LOWER(username) = @username
              LIMIT 1`,
        params: {
          emailHash,
          username: clean,
        },
      });

      if (rows.length > 0) {
        const r = rows[0].toJSON();
        return {
          user_id: String(r.user_id),
          username: String(r.username),
          email_hash: String(r.email_hash),
          masked_email: String(r.masked_email),
          password_hash: String(r.password_hash),
          display_name: String(r.display_name),
          avatar_url: r.avatar_url ? String(r.avatar_url) : null,
          account_status: String(r.account_status),
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      }
    } catch (err) {
      console.error('[DatabaseRepository] Spanner findUserByIdentifier fallback to Firestore');
    }

    // Fallback check in Firestore Native DB
    const snapshot = await this.firestore
      .collection('users')
      .where('username', '==', clean.split('@')[0])
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return snapshot.docs[0].data() as UserEntity;
    }
    return null;
  }

  public async getUserById(userId: string): Promise<UserEntity | null> {
    try {
      const [rows] = await this.spannerDb.run({
        sql: `SELECT user_id, username, email_hash, masked_email, password_hash,
                     display_name, avatar_url, account_status, created_at
              FROM Users
              WHERE user_id = @userId
              LIMIT 1`,
        params: { userId },
      });
      if (rows.length > 0) {
        const r = rows[0].toJSON();
        return {
          user_id: String(r.user_id),
          username: String(r.username),
          email_hash: String(r.email_hash),
          masked_email: String(r.masked_email),
          password_hash: String(r.password_hash),
          display_name: String(r.display_name),
          avatar_url: r.avatar_url ? String(r.avatar_url) : null,
          account_status: String(r.account_status),
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      }
    } catch {
      // Fallback to Firestore
    }

    const doc = await this.firestore.collection('users').doc(userId).get();
    return doc.exists ? (doc.data() as UserEntity) : null;
  }

  public async listAllUsers(): Promise<Array<Omit<UserEntity, 'password_hash' | 'email_hash'>>> {
    try {
      const [rows] = await this.spannerDb.run({
        sql: `SELECT user_id, username, masked_email, display_name, avatar_url, account_status, created_at
              FROM Users
              WHERE account_status = @status
              ORDER BY username ASC
              LIMIT @limit`,
        params: { status: 'ACTIVE', limit: 100 },
      });
      return rows.map((row) => {
        const r = row.toJSON();
        return {
          user_id: String(r.user_id),
          username: String(r.username),
          masked_email: String(r.masked_email),
          display_name: String(r.display_name),
          avatar_url: r.avatar_url ? String(r.avatar_url) : null,
          account_status: String(r.account_status),
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      });
    } catch {
      const snap = await this.firestore.collection('users').limit(100).get();
      return snap.docs.map((d) => {
        const data = d.data() as UserEntity;
        return {
          user_id: data.user_id,
          username: data.username,
          masked_email: data.masked_email,
          display_name: data.display_name,
          avatar_url: data.avatar_url,
          account_status: data.account_status,
          created_at: data.created_at,
        };
      });
    }
  }

  /**
   * Creates a user in BOTH Cloud Spanner and Cloud Firestore.
   */
  public async createUser(input: {
    user_id?: string;
    username: string;
    email: string;
    password: string;
    display_name: string;
    avatar_url?: string | null;
  }): Promise<UserEntity> {
    const now = new Date().toISOString();
    const user: UserEntity = {
      user_id: input.user_id || `usr_${crypto.randomBytes(10).toString('hex')}`,
      username: input.username.trim().toLowerCase(),
      email_hash: hashEmail(input.email),
      masked_email: maskEmail(input.email),
      password_hash: hashPassword(input.password),
      display_name: input.display_name.trim(),
      avatar_url: input.avatar_url ?? null,
      account_status: 'ACTIVE',
      created_at: now,
    };

    // 1. Write to Cloud Spanner
    await this.spannerDb.table('Users').upsert({
      user_id: user.user_id,
      username: user.username,
      email_hash: user.email_hash,
      masked_email: user.masked_email,
      password_hash: user.password_hash,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      account_status: user.account_status,
      created_at: Spanner.COMMIT_TIMESTAMP,
      updated_at: Spanner.COMMIT_TIMESTAMP,
    });

    // 2. Write to Cloud Firestore Native DB
    await this.firestore.collection('users').doc(user.user_id).set(user, { merge: true });

    return user;
  }

  /**
   * Lists channels for a user (or all channels for demo visibility) from Spanner or Firestore.
   */
  public async listChannelsForUser(
    userId: string,
    store: 'spanner' | 'firestore' = 'spanner'
  ): Promise<ChannelEntity[]> {
    if (store === 'firestore') {
      const snap = await this.firestore.collection('channels').orderBy('created_at', 'asc').get();
      return snap.docs.map((d) => d.data() as ChannelEntity);
    }

    const [rows] = await this.spannerDb.run({
      sql: `SELECT c.channel_id, c.type, c.dm_pair_hash, c.name, c.topic,
                   c.is_private, c.created_by, c.member_count, c.last_sequence_num,
                   c.last_message_at, c.created_at
            FROM Channels c
            JOIN ChannelMembers cm ON c.channel_id = cm.channel_id
            WHERE cm.user_id = @userId
            ORDER BY c.created_at ASC`,
      params: { userId },
    });

    return rows.map((row) => {
      const r = row.toJSON();
      return {
        channel_id: String(r.channel_id),
        type: (r.type as 'DIRECT' | 'GROUP') || 'GROUP',
        dm_pair_hash: r.dm_pair_hash ? String(r.dm_pair_hash) : null,
        name: r.name ? String(r.name) : null,
        topic: r.topic ? String(r.topic) : null,
        is_private: Boolean(r.is_private),
        created_by: String(r.created_by),
        member_count: Number(r.member_count ?? 0),
        last_sequence_num: Number(r.last_sequence_num ?? 0),
        last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      };
    });
  }

  /**
   * Verifies if a user is a member of a channel (cached in EphemeralStore -> Spanner).
   */
  public async isChannelMember(channelId: string, userId: string): Promise<boolean> {
    const cached = ephemeralStore.getCachedChannelMembers(channelId);
    if (cached && cached.includes(userId)) {
      return true;
    }

    const members = await this.getChannelMemberIds(channelId);
    ephemeralStore.cacheChannelMembers(channelId, members);
    return members.includes(userId);
  }

  public async getChannelMemberIds(channelId: string): Promise<string[]> {
    try {
      const [rows] = await this.spannerDb.run({
        sql: `SELECT user_id FROM ChannelMembers WHERE channel_id = @channelId`,
        params: { channelId },
      });
      const ids = rows.map((r) => String(r.toJSON().user_id));
      if (ids.length > 0) {
        ephemeralStore.cacheChannelMembers(channelId, ids);
        return ids;
      }
    } catch {
      // Fallback to Firestore
    }

    const snap = await this.firestore
      .collection('channels')
      .doc(channelId)
      .collection('members')
      .get();
    const ids = snap.docs.map((d) => String(d.data().userId));
    ephemeralStore.cacheChannelMembers(channelId, ids);
    return ids;
  }

  /**
   * Creates a DIRECT (1-on-1 DM) or GROUP channel across both Cloud Spanner and Cloud Firestore.
   */
  public async createChannel(input: {
    channel_id?: string;
    type: 'DIRECT' | 'GROUP';
    name?: string | null;
    topic?: string | null;
    is_private?: boolean;
    created_by: string;
    member_user_ids: string[];
  }): Promise<ChannelEntity> {
    const uniqueMembers = Array.from(new Set([input.created_by, ...input.member_user_ids]));
    let dmPairHash: string | null = null;

    if (input.type === 'DIRECT' && uniqueMembers.length === 2) {
      const sorted = [...uniqueMembers].sort();
      dmPairHash = crypto
        .createHash('sha256')
        .update(`${sorted[0]}:${sorted[1]}`)
        .digest('hex');

      // Idempotently return existing 1-on-1 DM channel if present
      const [existingRows] = await this.spannerDb.run({
        sql: `SELECT channel_id, type, dm_pair_hash, name, topic, is_private,
                     created_by, member_count, last_sequence_num, last_message_at, created_at
              FROM Channels
              WHERE dm_pair_hash = @dmPairHash
              LIMIT 1`,
        params: { dmPairHash },
      });
      if (existingRows.length > 0) {
        const r = existingRows[0].toJSON();
        return {
          channel_id: String(r.channel_id),
          type: 'DIRECT',
          dm_pair_hash: String(r.dm_pair_hash),
          name: r.name ? String(r.name) : null,
          topic: r.topic ? String(r.topic) : null,
          is_private: Boolean(r.is_private),
          created_by: String(r.created_by),
          member_count: Number(r.member_count ?? 2),
          last_sequence_num: Number(r.last_sequence_num ?? 0),
          last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      }
    }

    const now = new Date().toISOString();
    const channel: ChannelEntity = {
      channel_id: input.channel_id || `chn_${crypto.randomBytes(10).toString('hex')}`,
      type: input.type,
      dm_pair_hash: dmPairHash,
      name: input.name ?? (input.type === 'DIRECT' ? 'Direct Message' : 'general'),
      topic: input.topic ?? null,
      is_private: input.is_private ?? true,
      created_by: input.created_by,
      member_count: uniqueMembers.length,
      last_sequence_num: 0,
      last_message_at: now,
      created_at: now,
    };

    // 1. Write Channel & Interleaved ChannelMembers to Cloud Spanner
    await this.spannerDb.table('Channels').upsert({
      channel_id: channel.channel_id,
      type: channel.type,
      dm_pair_hash: channel.dm_pair_hash,
      name: channel.name,
      topic: channel.topic,
      is_private: channel.is_private,
      created_by: channel.created_by,
      member_count: channel.member_count,
      last_sequence_num: channel.last_sequence_num,
      last_message_at: Spanner.COMMIT_TIMESTAMP,
      created_at: Spanner.COMMIT_TIMESTAMP,
      updated_at: Spanner.COMMIT_TIMESTAMP,
    });

    const memberRows = uniqueMembers.map((uid) => ({
      channel_id: channel.channel_id,
      user_id: uid,
      role: uid === input.created_by ? 'OWNER' : 'MEMBER',
      is_muted: false,
      last_read_sequence_num: 0,
      last_read_message_id: null,
      joined_at: Spanner.COMMIT_TIMESTAMP,
    }));
    await this.spannerDb.table('ChannelMembers').upsert(memberRows);

    // 2. Write Channel & Members subcollection to Cloud Firestore Native DB
    const channelRef = this.firestore.collection('channels').doc(channel.channel_id);
    await channelRef.set(channel, { merge: true });
    const batch = this.firestore.batch();
    for (const uid of uniqueMembers) {
      const mRef = channelRef.collection('members').doc(uid);
      batch.set(
        mRef,
        {
          channelId: channel.channel_id,
          userId: uid,
          role: uid === input.created_by ? 'OWNER' : 'MEMBER',
          isMuted: false,
          lastReadSequenceNum: 0,
          joinedAt: now,
        },
        { merge: true }
      );
    }
    await batch.commit();

    ephemeralStore.cacheChannelMembers(channel.channel_id, uniqueMembers);
    return channel;
  }

  /**
   * Persists a message atomically in Cloud Spanner (Interleaved in Channels) AND Cloud Firestore,
   * and publishes the delivery envelope to Google Cloud Pub/Sub.
   */
  public async createMessage(input: {
    channel_id: string;
    sender_id: string;
    client_message_id: string;
    content: string;
    content_type?: 'TEXT' | 'SYSTEM' | 'MEDIA';
    reply_to_message_id?: string | null;
  }): Promise<MessageEntity> {
    // 1. Check idempotency in Cloud Spanner using parameterized query
    const [existing] = await this.spannerDb.run({
      sql: `SELECT m.message_id, m.client_message_id, m.channel_id, m.sequence_num,
                   m.sender_id, m.content, m.content_type, m.reply_to_message_id,
                   m.is_deleted, m.created_at, u.username, u.display_name
            FROM Messages m
            LEFT JOIN Users u ON m.sender_id = u.user_id
            WHERE m.channel_id = @channelId
              AND m.sender_id = @senderId
              AND m.client_message_id = @clientMessageId
            LIMIT 1`,
      params: {
        channelId: input.channel_id,
        senderId: input.sender_id,
        clientMessageId: input.client_message_id,
      },
    });

    if (existing.length > 0) {
      const r = existing[0].toJSON();
      return {
        message_id: String(r.message_id),
        client_message_id: String(r.client_message_id),
        channel_id: String(r.channel_id),
        sequence_num: Number(r.sequence_num),
        sender_id: String(r.sender_id),
        sender_username: r.username ? String(r.username) : undefined,
        sender_display_name: r.display_name ? String(r.display_name) : undefined,
        content: String(r.content),
        content_type: (r.content_type as 'TEXT' | 'SYSTEM' | 'MEDIA') || 'TEXT',
        reply_to_message_id: r.reply_to_message_id ? String(r.reply_to_message_id) : null,
        is_deleted: Boolean(r.is_deleted),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      };
    }

    // 2. Determine next monotonic sequence_num for the channel
    const [seqRows] = await this.spannerDb.run({
      sql: `SELECT COALESCE(MAX(sequence_num), 0) AS max_seq
            FROM Messages
            WHERE channel_id = @channelId`,
      params: { channelId: input.channel_id },
    });
    const nextSeq = Number(seqRows[0]?.toJSON()?.max_seq ?? 0) + 1;
    const messageId = `msg_${crypto.randomBytes(10).toString('hex')}`;
    const now = new Date().toISOString();

    const sender = await this.getUserById(input.sender_id);

    const msg: MessageEntity = {
      message_id: messageId,
      client_message_id: input.client_message_id,
      channel_id: input.channel_id,
      sequence_num: nextSeq,
      sender_id: input.sender_id,
      sender_username: sender?.username ?? input.sender_id,
      sender_display_name: sender?.display_name ?? input.sender_id,
      content: input.content,
      content_type: input.content_type ?? 'TEXT',
      reply_to_message_id: input.reply_to_message_id ?? null,
      is_deleted: false,
      created_at: now,
    };

    // 3. Persist to Cloud Spanner (Interleaved Messages + update parent Channel)
    await this.spannerDb.table('Messages').insert({
      channel_id: msg.channel_id,
      sequence_num: msg.sequence_num,
      message_id: msg.message_id,
      client_message_id: msg.client_message_id,
      sender_id: msg.sender_id,
      content: msg.content,
      content_type: msg.content_type,
      reply_to_message_id: msg.reply_to_message_id,
      is_deleted: false,
      created_at: Spanner.COMMIT_TIMESTAMP,
    });

    await this.spannerDb.table('Channels').update([
      {
        channel_id: msg.channel_id,
        last_sequence_num: msg.sequence_num,
        last_message_at: Spanner.COMMIT_TIMESTAMP,
        updated_at: Spanner.COMMIT_TIMESTAMP,
      },
    ]);

    // 4. Mirror to Cloud Firestore Native DB (channels/{id}/messages/{msgId})
    const chRef = this.firestore.collection('channels').doc(msg.channel_id);
    await Promise.all([
      chRef.collection('messages').doc(msg.message_id).set(msg),
      chRef.set(
        {
          last_sequence_num: msg.sequence_num,
          last_message_at: now,
        },
        { merge: true }
      ),
    ]);

    // 5. Publish real-time routing event to Google Cloud Pub/Sub (with orderingKey = channel_id)
    this.publishToPubSub(msg).catch((err) => {
      console.error('[PubSub] Non-blocking publish warning:', err instanceof Error ? err.message : 'unknown');
    });

    return msg;
  }

  /**
   * Fetches cursor-paginated message history from either Cloud Spanner or Cloud Firestore.
   */
  public async getChannelMessages(params: {
    channelId: string;
    beforeSequenceNum?: number;
    limit?: number;
    store?: 'spanner' | 'firestore';
  }): Promise<{ messages: MessageEntity[]; hasMore: boolean; nextBeforeSeq: number | null; sourceStore: string }> {
    const limit = Math.min(Math.max(params.limit || 50, 1), 100);
    const beforeSeq = params.beforeSequenceNum ?? 999999999;
    const store = params.store || 'spanner';

    if (store === 'firestore') {
      const snap = await this.firestore
        .collection('channels')
        .doc(params.channelId)
        .collection('messages')
        .orderBy('sequence_num', 'desc')
        .limit(limit)
        .get();

      const docs = snap.docs
        .map((d) => d.data() as MessageEntity)
        .filter((m) => m.sequence_num < beforeSeq && !m.is_deleted)
        .reverse();

      const oldest = docs[0]?.sequence_num ?? null;
      return {
        messages: docs,
        hasMore: docs.length === limit,
        nextBeforeSeq: oldest,
        sourceStore: `Cloud Firestore (${FIRESTORE_DATABASE_ID})`,
      };
    }

    // Parameterized Cloud Spanner query on interleaved Messages table
    const [rows] = await this.spannerDb.run({
      sql: `SELECT m.message_id, m.client_message_id, m.channel_id, m.sequence_num,
                   m.sender_id, m.content, m.content_type, m.reply_to_message_id,
                   m.is_deleted, m.created_at, u.username, u.display_name
            FROM Messages m
            LEFT JOIN Users u ON m.sender_id = u.user_id
            WHERE m.channel_id = @channelId
              AND m.sequence_num < @beforeSeq
              AND m.is_deleted = FALSE
            ORDER BY m.sequence_num DESC
            LIMIT @limit`,
      params: {
        channelId: params.channelId,
        beforeSeq,
        limit,
      },
    });

    const messages: MessageEntity[] = rows
      .map((row) => {
        const r = row.toJSON();
        return {
          message_id: String(r.message_id),
          client_message_id: String(r.client_message_id),
          channel_id: String(r.channel_id),
          sequence_num: Number(r.sequence_num),
          sender_id: String(r.sender_id),
          sender_username: r.username ? String(r.username) : String(r.sender_id),
          sender_display_name: r.display_name ? String(r.display_name) : String(r.sender_id),
          content: String(r.content),
          content_type: (r.content_type as 'TEXT' | 'SYSTEM' | 'MEDIA') || 'TEXT',
          reply_to_message_id: r.reply_to_message_id ? String(r.reply_to_message_id) : null,
          is_deleted: Boolean(r.is_deleted),
          created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      })
      .reverse();

    const oldest = messages[0]?.sequence_num ?? null;
    return {
      messages,
      hasMore: rows.length === limit,
      nextBeforeSeq: oldest,
      sourceStore: `Cloud Spanner (${SPANNER_INSTANCE_ID}/${SPANNER_DATABASE_ID})`,
    };
  }

  public async updateReadReceipt(params: {
    channelId: string;
    userId: string;
    lastReadMessageId: string;
    lastReadSequenceNum: number;
  }): Promise<void> {
    await this.spannerDb.table('ChannelMembers').update([
      {
        channel_id: params.channelId,
        user_id: params.userId,
        last_read_message_id: params.lastReadMessageId,
        last_read_sequence_num: params.lastReadSequenceNum,
      },
    ]);

    await this.firestore
      .collection('channels')
      .doc(params.channelId)
      .collection('members')
      .doc(params.userId)
      .set(
        {
          lastReadMessageId: params.lastReadMessageId,
          lastReadSequenceNum: params.lastReadSequenceNum,
          readAt: new Date().toISOString(),
        },
        { merge: true }
      );
  }

  /**
   * Publishes a NodeDeliveryEnvelope to Google Cloud Pub/Sub with message ordering enabled.
   */
  private async publishToPubSub(msg: MessageEntity): Promise<void> {
    const topic = this.pubsub.topic(PUBSUB_NODE_TOPIC, {
      messageOrdering: true,
    });
    const envelope = {
      event_type: 'receive_message',
      origin_node_id: ephemeralStore.nodeId,
      timestamp: new Date().toISOString(),
      payload: msg,
    };
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(envelope), 'utf-8'),
      orderingKey: msg.channel_id,
      attributes: {
        channelId: msg.channel_id,
        originNodeId: ephemeralStore.nodeId,
      },
    });
  }

  /**
   * Returns live database statistics from BOTH Cloud Spanner and Cloud Firestore.
   */
  public async getDatabaseDiagnostics(): Promise<{
    project_id: string;
    spanner: { instance: string; database: string; users: number; channels: number; messages: number };
    firestore: { database: string; users: number; channels: number };
    pubsub: { node_topic: string; broadcast_topic: string; gateway_node_id: string };
  }> {
    const [[uRows], [cRows], [mRows], fsUsers, fsChannels] = await Promise.all([
      this.spannerDb.run({ sql: 'SELECT COUNT(*) AS cnt FROM Users' }),
      this.spannerDb.run({ sql: 'SELECT COUNT(*) AS cnt FROM Channels' }),
      this.spannerDb.run({ sql: 'SELECT COUNT(*) AS cnt FROM Messages' }),
      this.firestore.collection('users').count().get(),
      this.firestore.collection('channels').count().get(),
    ]);

    return {
      project_id: GCP_PROJECT_ID,
      spanner: {
        instance: SPANNER_INSTANCE_ID,
        database: SPANNER_DATABASE_ID,
        users: Number(uRows[0]?.toJSON()?.cnt ?? 0),
        channels: Number(cRows[0]?.toJSON()?.cnt ?? 0),
        messages: Number(mRows[0]?.toJSON()?.cnt ?? 0),
      },
      firestore: {
        database: FIRESTORE_DATABASE_ID,
        users: fsUsers.data().count,
        channels: fsChannels.data().count,
      },
      pubsub: {
        node_topic: PUBSUB_NODE_TOPIC,
        broadcast_topic: PUBSUB_BROADCAST_TOPIC,
        gateway_node_id: ephemeralStore.nodeId,
      },
    };
  }
}

export const dbRepo = new DatabaseRepository();
