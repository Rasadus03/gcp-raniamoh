import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  JwtClaims,
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  parseCookies,
  rateLimitMiddleware,
  securityHeadersMiddleware,
  signJwt,
  validatePasswordStrength,
  verifyJwt,
  verifyPassword,
} from './config/security';
import { ephemeralStore } from './repositories/ephemeral-store';
import { dbRepo, MessageEntity } from './repositories/database.repository';

declare global {
  namespace Express {
    interface Request {
      authUser?: JwtClaims;
    }
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(securityHeadersMiddleware);
app.use(rateLimitMiddleware(300));
app.use(express.json({ limit: '64kb' }));

/**
 * Authentication Middleware: verifies hardened __Host-chat_session / chat_session cookie.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies['__Host-chat_session'] || cookies['chat_session'];
  if (!rawToken) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const claims = verifyJwt(rawToken, (jti) => ephemeralStore.isJtiRevoked(jti));
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired session token.' });
    return;
  }

  req.authUser = claims;
  next();
}

/**
 * Synchronizer CSRF Protection Middleware for all state-changing endpoints.
 */
function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const csrfHeader = req.headers['x-csrf-token'];
  if (typeof csrfHeader !== 'string' || !csrfHeader) {
    res.status(403).json({ error: 'CSRF token missing.' });
    return;
  }

  if (req.authUser) {
    if (req.authUser.csrf !== csrfHeader) {
      res.status(403).json({ error: 'CSRF token mismatch.' });
      return;
    }
    next();
    return;
  }

  if (!ephemeralStore.verifyPreAuthCsrfToken(csrfHeader)) {
    res.status(403).json({ error: 'Invalid or expired pre-auth CSRF token.' });
    return;
  }
  next();
}

// ============================================================================
// 1. HEALTH & SYSTEM DIAGNOSTICS ENDPOINTS
// ============================================================================
app.get('/v1/health', async (_req: Request, res: Response) => {
  try {
    const diagnostics = await dbRepo.getDatabaseDiagnostics();
    res.status(200).json({
      status: 'HEALTHY',
      service: 'chat-system-microservices',
      timestamp: new Date().toISOString(),
      diagnostics,
    });
  } catch {
    res.status(500).json({ status: 'DEGRADED', error: 'Database health check failed.' });
  }
});

// ============================================================================
// 2. AUTH & IDENTITY SERVICE ENDPOINTS (/v1/auth/*)
// ============================================================================
app.get('/v1/auth/csrf', (_req: Request, res: Response) => {
  const csrfToken = ephemeralStore.issuePreAuthCsrfToken();
  res.status(200).json({ csrf_token: csrfToken });
});

app.post('/v1/auth/login', requireCsrf, async (req: Request, res: Response) => {
  try {
    const { identifier, email, password } = req.body ?? {};
    const lookupKey = typeof identifier === 'string' ? identifier : typeof email === 'string' ? email : '';

    if (!lookupKey || typeof password !== 'string') {
      res.status(400).json({ error: 'Identifier/email and password are required.' });
      return;
    }

    const user = await dbRepo.findUserByIdentifier(lookupKey);
    if (!user || !verifyPassword(password, user.password_hash)) {
      // Generic error message; never log credentials on failed login
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const { token, claims } = signJwt(
      {
        sub: user.user_id,
        username: user.username,
        displayName: user.display_name,
      },
      3600
    );

    res.setHeader('Set-Cookie', buildSessionCookieHeader(req, token, 3600));
    res.status(200).json({
      user: {
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        masked_email: user.masked_email,
        avatar_url: user.avatar_url,
      },
      csrf_token: claims.csrf,
      expires_in_seconds: 3600,
    });
  } catch {
    res.status(500).json({ error: 'Authentication service unavailable.' });
  }
});

const DEMO_PERSONA_USERNAMES = new Set(['alice', 'bob', 'charlie', 'diana']);

app.post('/v1/auth/demo-login', requireCsrf, async (req: Request, res: Response) => {
  try {
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (!DEMO_PERSONA_USERNAMES.has(rawUsername)) {
      res.status(400).json({ error: 'Invalid demo persona username.' });
      return;
    }

    const user = await dbRepo.findUserByIdentifier(rawUsername);
    if (!user) {
      res.status(404).json({ error: 'Demo persona not found.' });
      return;
    }

    const { token, claims } = signJwt(
      {
        sub: user.user_id,
        username: user.username,
        displayName: user.display_name,
      },
      3600
    );

    res.setHeader('Set-Cookie', buildSessionCookieHeader(req, token, 3600));
    res.status(200).json({
      user: {
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        masked_email: user.masked_email,
        avatar_url: user.avatar_url,
      },
      csrf_token: claims.csrf,
      expires_in_seconds: 3600,
    });
  } catch {
    res.status(500).json({ error: 'Demo authentication service unavailable.' });
  }
});

app.post('/v1/auth/register', requireCsrf, async (req: Request, res: Response) => {
  try {
    const { username, email, password, display_name } = req.body ?? {};
    if (
      typeof username !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,32}$/.test(username) ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      typeof display_name !== 'string' ||
      display_name.trim().length < 2
    ) {
      res.status(400).json({ error: 'Invalid username, email, or display_name format.' });
      return;
    }

    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid) {
      res.status(400).json({ error: pwCheck.reason });
      return;
    }

    const existing = await dbRepo.findUserByIdentifier(username);
    if (existing) {
      res.status(409).json({ error: 'Username or email already exists.' });
      return;
    }

    const created = await dbRepo.createUser({
      username,
      email,
      password,
      display_name,
    });

    const { token, claims } = signJwt(
      {
        sub: created.user_id,
        username: created.username,
        displayName: created.display_name,
      },
      3600
    );

    res.setHeader('Set-Cookie', buildSessionCookieHeader(req, token, 3600));
    res.status(201).json({
      user: {
        user_id: created.user_id,
        username: created.username,
        display_name: created.display_name,
        masked_email: created.masked_email,
      },
      csrf_token: claims.csrf,
      expires_in_seconds: 3600,
    });
  } catch {
    res.status(500).json({ error: 'Unable to register account.' });
  }
});

app.get('/v1/auth/me', requireAuth, async (req: Request, res: Response) => {
  const claims = req.authUser!;
  const user = await dbRepo.getUserById(claims.sub);
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  res.status(200).json({
    user: {
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      masked_email: user.masked_email,
      avatar_url: user.avatar_url,
    },
    csrf_token: claims.csrf,
  });
});

app.post('/v1/auth/ws-ticket', requireAuth, requireCsrf, (req: Request, res: Response) => {
  const claims = req.authUser!;
  const { ticket, expiresAt } = ephemeralStore.issueWsTicket({
    user_id: claims.sub,
    username: claims.username,
    display_name: claims.displayName,
    jti: claims.jti,
  });

  const proto =
    req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const host = req.headers.host || '127.0.0.1:8080';

  res.status(201).json({
    ws_ticket: ticket,
    ws_endpoint: `${proto}://${host}/v1/stream`,
    expires_at: expiresAt,
  });
});

app.post('/v1/auth/logout', requireAuth, requireCsrf, (req: Request, res: Response) => {
  const claims = req.authUser!;
  ephemeralStore.revokeJti(claims.jti);
  disconnectUserSockets(claims.sub);
  res.setHeader('Set-Cookie', buildClearSessionCookieHeader(req));
  res.status(200).json({ status: 'LOGGED_OUT' });
});

// ============================================================================
// 3. USERS & PRESENCE SERVICE ENDPOINTS (/v1/users, /v1/presence/*)
// ============================================================================
app.get('/v1/users', requireAuth, async (_req: Request, res: Response) => {
  try {
    const users = await dbRepo.listAllUsers();
    const presenceList = ephemeralStore.getPresenceBatch(users.map((u) => u.user_id));
    const presenceByUid = new Map(presenceList.map((p) => [p.user_id, p]));

    res.status(200).json({
      users: users.map((u) => ({
        ...u,
        presence: presenceByUid.get(u.user_id)?.status ?? 'OFFLINE',
        last_seen_at: presenceByUid.get(u.user_id)?.last_seen_at ?? u.created_at,
      })),
    });
  } catch {
    res.status(500).json({ error: 'Failed to list users.' });
  }
});

app.post('/v1/presence/query', requireAuth, requireCsrf, (req: Request, res: Response) => {
  const userIds = Array.isArray(req.body?.user_ids)
    ? (req.body.user_ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 100)
    : [];
  const statuses = ephemeralStore.getPresenceBatch(userIds);
  res.status(200).json({ statuses });
});

// ============================================================================
// 4. CHANNEL & MEMBERSHIP SERVICE ENDPOINTS (/v1/channels/*)
// ============================================================================
app.get('/v1/channels', requireAuth, async (req: Request, res: Response) => {
  try {
    const store = req.query.store === 'firestore' ? 'firestore' : 'spanner';
    const channels = await dbRepo.listChannelsForUser(req.authUser!.sub, store);
    res.status(200).json({
      source_store: store,
      channels,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch channels.' });
  }
});

app.post('/v1/channels', requireAuth, requireCsrf, async (req: Request, res: Response) => {
  try {
    const { type, name, topic, is_private, member_user_ids } = req.body ?? {};
    const channelType = type === 'DIRECT' ? 'DIRECT' : 'GROUP';
    if (channelType === 'GROUP' && (typeof name !== 'string' || name.trim().length < 2)) {
      res.status(400).json({ error: 'Group channel name (min 2 chars) is required.' });
      return;
    }

    const memberIds = Array.isArray(member_user_ids)
      ? (member_user_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    const channel = await dbRepo.createChannel({
      type: channelType,
      name: typeof name === 'string' ? name.trim() : null,
      topic: typeof topic === 'string' ? topic.trim() : null,
      is_private: Boolean(is_private ?? true),
      created_by: req.authUser!.sub,
      member_user_ids: memberIds,
    });

    res.status(201).json(channel);
  } catch {
    res.status(500).json({ error: 'Failed to create channel.' });
  }
});

// ============================================================================
// 5. MESSAGE INGESTION & HISTORY SERVICE ENDPOINTS (/v1/channels/:id/messages)
// ============================================================================
app.get('/v1/channels/:channelId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const isMember = await dbRepo.isChannelMember(channelId, req.authUser!.sub);
    if (!isMember) {
      res.status(403).json({ error: 'Access denied: you are not a member of this channel.' });
      return;
    }

    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const beforeSeq = req.query.before_seq ? Number(req.query.before_seq) : undefined;
    const store = req.query.store === 'firestore' ? 'firestore' : 'spanner';

    const result = await dbRepo.getChannelMessages({
      channelId,
      beforeSequenceNum: beforeSeq,
      limit,
      store,
    });

    res.status(200).json({
      channel_id: channelId,
      source_store: result.sourceStore,
      messages: result.messages,
      pagination: {
        next_before_seq: result.nextBeforeSeq,
        has_more: result.hasMore,
      },
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch channel messages.' });
  }
});

app.post(
  '/v1/channels/:channelId/messages',
  requireAuth,
  requireCsrf,
  async (req: Request, res: Response) => {
    try {
      const { channelId } = req.params;
      const isMember = await dbRepo.isChannelMember(channelId, req.authUser!.sub);
      if (!isMember) {
        res.status(403).json({ error: 'Access denied: you are not a member of this channel.' });
        return;
      }

      const { content, client_message_id, reply_to_message_id } = req.body ?? {};
      if (typeof content !== 'string' || content.trim().length === 0 || content.length > 4096) {
        res.status(400).json({ error: 'Message content must be between 1 and 4096 characters.' });
        return;
      }

      const clientMsgId =
        typeof client_message_id === 'string' && client_message_id.length >= 8
          ? client_message_id
          : crypto.randomUUID();

      const msg = await dbRepo.createMessage({
        channel_id: channelId,
        sender_id: req.authUser!.sub,
        client_message_id: clientMsgId,
        content: content.trim(),
        content_type: 'TEXT',
        reply_to_message_id: typeof reply_to_message_id === 'string' ? reply_to_message_id : null,
      });

      await broadcastMessageToChannelMembers(msg);
      res.status(201).json(msg);
    } catch {
      res.status(500).json({ error: 'Failed to persist message.' });
    }
  }
);

// ============================================================================
// 6. STATEFUL WEBSOCKET GATEWAY TIER (/v1/stream)
// ============================================================================
interface AuthenticatedSocket extends WebSocket {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
}

const localSocketsByUser = new Map<string, Set<AuthenticatedSocket>>();

function registerLocalSocket(ws: AuthenticatedSocket): void {
  let set = localSocketsByUser.get(ws.userId);
  if (!set) {
    set = new Set();
    localSocketsByUser.set(ws.userId, set);
  }
  set.add(ws);
}

function unregisterLocalSocket(ws: AuthenticatedSocket): void {
  const set = localSocketsByUser.get(ws.userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      localSocketsByUser.delete(ws.userId);
    }
  }
}

function disconnectUserSockets(userId: string): void {
  const set = localSocketsByUser.get(userId);
  if (!set) return;
  for (const ws of set) {
    ws.close(1000, 'Session logged out');
  }
  localSocketsByUser.delete(userId);
}

async function broadcastMessageToChannelMembers(msg: MessageEntity): Promise<void> {
  const memberIds = await dbRepo.getChannelMemberIds(msg.channel_id);
  const frame = JSON.stringify({
    event_type: 'receive_message',
    trace_id: `trc_${crypto.randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    payload: {
      message_id: msg.message_id,
      client_message_id: msg.client_message_id,
      channel_id: msg.channel_id,
      sender: {
        user_id: msg.sender_id,
        username: msg.sender_username ?? msg.sender_id,
        display_name: msg.sender_display_name ?? msg.sender_id,
      },
      content: msg.content,
      content_type: msg.content_type,
      reply_to_message_id: msg.reply_to_message_id,
      sequence_num: msg.sequence_num,
      created_at: msg.created_at,
    },
  });

  for (const uid of memberIds) {
    const sockets = localSocketsByUser.get(uid);
    if (!sockets) continue;
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(frame);
      }
    }
  }
}

function broadcastToAllOnlineClients(eventPayload: unknown): void {
  const raw = JSON.stringify(eventPayload);
  for (const sockets of localSocketsByUser.values()) {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(raw);
      }
    }
  }
}

// ============================================================================
// 7. FRONTEND STATIC SERVING WITH NONCE CSP INJECTION
// ============================================================================
app.get('/app.js', (_req: Request, res: Response) => {
  const jsPath = path.join(__dirname, 'public', 'app.js');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(jsPath);
});

app.get('/login.js', (_req: Request, res: Response) => {
  const jsPath = path.join(__dirname, 'public', 'login.js');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(jsPath);
});

app.get('/login', (_req: Request, res: Response) => {
  const htmlPath = path.join(__dirname, 'public', 'login.html');
  const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
  const nonce = String(res.locals.cspNonce || '');
  const rendered = rawHtml.replace(/\{\{CSP_NONCE\}\}/g, nonce);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(rendered);
});

app.get(['/chat', '/', '*'], (_req: Request, res: Response) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
  const nonce = String(res.locals.cspNonce || '');
  const rendered = rawHtml.replace(/\{\{CSP_NONCE\}\}/g, nonce);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(rendered);
});

// ============================================================================
// 8. HTTP + WEBSOCKET SERVER INITIALIZATION
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  try {
    const urlObj = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (urlObj.pathname !== '/v1/stream') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Extract single-use ws_ticket from Sec-WebSocket-Protocol header ("chat.v1, ticket.wst_...")
    const protoHeader = request.headers['sec-websocket-protocol'] || '';
    const protocols = protoHeader.split(',').map((p) => p.trim());
    const ticketProto = protocols.find((p) => p.startsWith('ticket.'));
    const rawTicket = ticketProto ? ticketProto.slice('ticket.'.length) : undefined;

    const ticketRecord = ephemeralStore.redeemWsTicket(rawTicket);
    if (!ticketRecord) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const authWs = ws as AuthenticatedSocket;
      authWs.userId = ticketRecord.user_id;
      authWs.username = ticketRecord.username;
      authWs.displayName = ticketRecord.display_name;
      authWs.sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
      wss.emit('connection', authWs, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws: AuthenticatedSocket) => {
  registerLocalSocket(ws);

  const presence = ephemeralStore.registerOrRefreshSession(
    {
      user_id: ws.userId,
      username: ws.username,
      display_name: ws.displayName,
    },
    ws.sessionId
  );

  // Broadcast ONLINE presence_update to connected peers
  broadcastToAllOnlineClients({
    event_type: 'presence_update',
    trace_id: `trc_${crypto.randomBytes(6).toString('hex')}`,
    timestamp: new Date().toISOString(),
    payload: {
      user_id: presence.user_id,
      username: presence.username,
      display_name: presence.display_name,
      status: presence.status,
      custom_status: presence.custom_status,
      node_id: presence.node_id,
      last_seen_at: presence.last_seen_at,
    },
  });

  ws.on('message', async (rawData) => {
    try {
      const event = JSON.parse(rawData.toString('utf-8'));
      const eventType = event?.event_type;
      const traceId = event?.trace_id || `trc_${crypto.randomBytes(6).toString('hex')}`;
      const payload = event?.payload ?? {};

      if (eventType === 'heartbeat_ping') {
        ephemeralStore.registerOrRefreshSession(
          {
            user_id: ws.userId,
            username: ws.username,
            display_name: ws.displayName,
          },
          ws.sessionId
        );
        ws.send(
          JSON.stringify({
            event_type: 'heartbeat_pong',
            trace_id: traceId,
            timestamp: new Date().toISOString(),
            payload: {
              server_time: Date.now(),
              node_id: ephemeralStore.nodeId,
            },
          })
        );
        return;
      }

      if (eventType === 'typing_indicator') {
        const channelId = String(payload.channel_id || '');
        const isTyping = Boolean(payload.is_typing);
        if (!channelId) return;
        const allowed = await dbRepo.isChannelMember(channelId, ws.userId);
        if (!allowed) return;

        ephemeralStore.setTyping(channelId, ws.userId, ws.username, isTyping);
        const members = await dbRepo.getChannelMemberIds(channelId);
        const typingFrame = JSON.stringify({
          event_type: 'typing_indicator',
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          payload: {
            channel_id: channelId,
            user_id: ws.userId,
            username: ws.username,
            display_name: ws.displayName,
            is_typing: isTyping,
            ttl_seconds: 5,
          },
        });
        for (const uid of members) {
          if (uid === ws.userId) continue;
          const peerSockets = localSocketsByUser.get(uid);
          if (!peerSockets) continue;
          for (const s of peerSockets) {
            if (s.readyState === WebSocket.OPEN) s.send(typingFrame);
          }
        }
        return;
      }

      if (eventType === 'send_message') {
        const channelId = String(payload.channel_id || '');
        const content = String(payload.content || '').trim();
        const clientMessageId = String(payload.client_message_id || crypto.randomUUID());

        if (!channelId || !content || content.length > 4096) {
          ws.send(
            JSON.stringify({
              event_type: 'error',
              trace_id: traceId,
              timestamp: new Date().toISOString(),
              payload: { message: 'Invalid channel_id or message content length.' },
            })
          );
          return;
        }

        const isMember = await dbRepo.isChannelMember(channelId, ws.userId);
        if (!isMember) {
          ws.send(
            JSON.stringify({
              event_type: 'error',
              trace_id: traceId,
              timestamp: new Date().toISOString(),
              payload: { message: 'Forbidden: not a member of this channel.' },
            })
          );
          return;
        }

        const persisted = await dbRepo.createMessage({
          channel_id: channelId,
          sender_id: ws.userId,
          client_message_id: clientMessageId,
          content,
          content_type: 'TEXT',
          reply_to_message_id: payload.reply_to_message_id ?? null,
        });

        // 1. Send immediate message_ack to sender
        ws.send(
          JSON.stringify({
            event_type: 'message_ack',
            trace_id: traceId,
            timestamp: new Date().toISOString(),
            payload: {
              client_message_id: persisted.client_message_id,
              message_id: persisted.message_id,
              channel_id: persisted.channel_id,
              sequence_num: persisted.sequence_num,
              status: 'PERSISTED',
              server_created_at: persisted.created_at,
            },
          })
        );

        // 2. Push receive_message to all online channel members
        await broadcastMessageToChannelMembers(persisted);
        return;
      }

      if (eventType === 'read_receipt') {
        const channelId = String(payload.channel_id || '');
        const lastMsgId = String(payload.last_read_message_id || '');
        const lastSeq = Number(payload.last_read_sequence_num || 0);
        if (channelId && lastMsgId && lastSeq > 0) {
          await dbRepo.updateReadReceipt({
            channelId,
            userId: ws.userId,
            lastReadMessageId: lastMsgId,
            lastReadSequenceNum: lastSeq,
          });
        }
      }
    } catch {
      // Ignore malformed frame safely
    }
  });

  ws.on('close', () => {
    unregisterLocalSocket(ws);
    const updated = ephemeralStore.unregisterSession(ws.userId, ws.sessionId);
    if (updated) {
      broadcastToAllOnlineClients({
        event_type: 'presence_update',
        trace_id: `trc_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: new Date().toISOString(),
        payload: {
          user_id: updated.user_id,
          username: updated.username,
          display_name: updated.display_name,
          status: updated.status,
          custom_status: updated.custom_status,
          node_id: updated.node_id,
          last_seen_at: updated.last_seen_at,
        },
      });
    }
  });
});

const PORT = Number(process.env.PORT || 8080);
// Bind strictly to 127.0.0.1 during local testing (and Cloud Run ingress when K_SERVICE is set)
const HOST = process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(
    `[Chat Microservices Backend] Listening on http://${HOST}:${PORT} (Node: ${ephemeralStore.nodeId})`
  );
});
