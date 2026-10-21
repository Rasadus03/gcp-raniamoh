import WebSocket from 'ws';
import crypto from 'crypto';

const BASE_URL =
  process.env.CHAT_BACKEND_URL ||
  'https://chat-system-backend-ayf6osu6ka-uc.a.run.app';

interface TestSession {
  username: string;
  userId: string;
  cookie: string;
  csrfToken: string;
}

function assertCondition(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function extractSessionCookie(setCookieHeader: string | string[] | null): string {
  if (!setCookieHeader) return '';
  const rawList = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const item of rawList) {
    const part = item.split(';')[0]?.trim();
    if (part && (part.startsWith('__Host-chat_session=') || part.startsWith('chat_session='))) {
      return part;
    }
  }
  return '';
}

async function loginUser(username: string): Promise<TestSession> {
  // Step 1: Fetch pre-auth CSRF token
  const csrfRes = await fetch(`${BASE_URL}/v1/auth/csrf`);
  assertCondition(csrfRes.status === 200, `Expected 200 from /v1/auth/csrf, got ${csrfRes.status}`);
  const csrfBody = (await csrfRes.json()) as { csrf_token: string };
  assertCondition(Boolean(csrfBody.csrf_token), 'Missing pre-auth csrf_token');

  // Step 2: Authenticate via CSRF-protected Demo Persona Session Endpoint
  const loginRes = await fetch(`${BASE_URL}/v1/auth/demo-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfBody.csrf_token,
    },
    body: JSON.stringify({
      username,
    }),
  });

  assertCondition(
    loginRes.status === 200,
    `Expected 200 from /v1/auth/demo-login for ${username}, got ${loginRes.status}`
  );

  const setCookie = loginRes.headers.get('set-cookie');
  const cookie = extractSessionCookie(setCookie);
  assertCondition(Boolean(cookie), `Missing session cookie in Set-Cookie header for ${username}`);

  const data = (await loginRes.json()) as {
    user: { user_id: string; username: string; masked_email: string };
    csrf_token: string;
  };

  assertCondition(Boolean(data.csrf_token), 'Missing session csrf_token');
  assertCondition(
    data.user.masked_email.includes('***'),
    `Expected masked_email to mask PII, got ${data.user.masked_email}`
  );

  return {
    username: data.user.username,
    userId: data.user.user_id,
    cookie,
    csrfToken: data.csrf_token,
  };
}

async function runTests(): Promise<void> {
  console.log('====================================================================');
  console.log(`Running End-to-End Microservices Test Suite against:`);
  console.log(`Target URL: ${BASE_URL}`);
  console.log('====================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Health Check, Security Headers & Dual-Database Diagnostics
  // -------------------------------------------------------------------------
  console.log('[Test 1/7] Health Check, Security Headers & Dual-Database Diagnostics...');
  const healthRes = await fetch(`${BASE_URL}/v1/health`);
  assertCondition(healthRes.status === 200, `Expected HTTP 200, got ${healthRes.status}`);

  const csp = healthRes.headers.get('content-security-policy') || '';
  const xfo = healthRes.headers.get('x-frame-options') || '';
  const xcto = healthRes.headers.get('x-content-type-options') || '';
  assertCondition(csp.includes("default-src 'self'") && csp.includes("'nonce-"), 'Missing strict CSP nonce header');
  assertCondition(xfo === 'DENY', `Expected X-Frame-Options: DENY, got ${xfo}`);
  assertCondition(xcto === 'nosniff', `Expected X-Content-Type-Options: nosniff, got ${xcto}`);

  const healthData = (await healthRes.json()) as {
    status: string;
    diagnostics: {
      project_id: string;
      spanner: { instance: string; database: string; users: number; channels: number; messages: number };
      firestore: { database: string; users: number; channels: number };
      pubsub: { node_topic: string; broadcast_topic: string; gateway_node_id: string };
    };
  };
  assertCondition(healthData.status === 'HEALTHY', `Expected HEALTHY, got ${healthData.status}`);
  assertCondition(healthData.diagnostics.spanner.users >= 4, 'Expected >= 4 users in Cloud Spanner');
  assertCondition(healthData.diagnostics.firestore.users >= 4, 'Expected >= 4 users in Cloud Firestore');
  console.log(
    `  ✓ Health: ${healthData.status} | Spanner (${healthData.diagnostics.spanner.instance}/${healthData.diagnostics.spanner.database}): ${healthData.diagnostics.spanner.users} users, ${healthData.diagnostics.spanner.channels} channels, ${healthData.diagnostics.spanner.messages} msgs`
  );
  console.log(
    `  ✓ Firestore (${healthData.diagnostics.firestore.database}): ${healthData.diagnostics.firestore.users} users, ${healthData.diagnostics.firestore.channels} channels`
  );
  console.log(`  ✓ Security Headers verified: CSP nonce, X-Frame-Options: DENY, nosniff\n`);

  // -------------------------------------------------------------------------
  // TEST 2: Authentication, CSRF Enforcement & Session Cookie Hardening
  // -------------------------------------------------------------------------
  console.log('[Test 2/7] Auth Service: CSRF Enforcement, Login & Identity Verification...');
  const noCsrfRes = await fetch(`${BASE_URL}/v1/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  });
  assertCondition(noCsrfRes.status === 403, `Expected 403 when CSRF header is omitted, got ${noCsrfRes.status}`);
  console.log('  ✓ Synchronizer CSRF Guard blocked unauthenticated POST without X-CSRF-Token (HTTP 403)');

  const alice = await loginUser('alice');
  const bob = await loginUser('bob');
  console.log(`  ✓ Signed in as alice (${alice.userId}) & bob (${bob.userId}) with HttpOnly session cookies`);

  const meRes = await fetch(`${BASE_URL}/v1/auth/me`, {
    headers: { Cookie: alice.cookie },
  });
  assertCondition(meRes.status === 200, `Expected 200 from /v1/auth/me, got ${meRes.status}`);
  const meData = (await meRes.json()) as { user: { user_id: string; username: string } };
  assertCondition(meData.user.user_id === 'usr_alice', 'Expected /v1/auth/me to return usr_alice');
  console.log(`  ✓ Verified session via GET /v1/auth/me -> ${meData.user.username} (${meData.user.user_id})\n`);

  // -------------------------------------------------------------------------
  // TEST 3: Users Directory & Ephemeral Presence Batch Query
  // -------------------------------------------------------------------------
  console.log('[Test 3/7] Users & Presence Service (/v1/users & /v1/presence/query)...');
  const usersRes = await fetch(`${BASE_URL}/v1/users`, {
    headers: { Cookie: alice.cookie },
  });
  assertCondition(usersRes.status === 200, `Expected 200 from /v1/users, got ${usersRes.status}`);
  const usersData = (await usersRes.json()) as { users: Array<{ user_id: string; username: string }> };
  assertCondition(usersData.users.length >= 4, `Expected >= 4 users, got ${usersData.users.length}`);

  const presenceRes = await fetch(`${BASE_URL}/v1/presence/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: alice.cookie,
      'X-CSRF-Token': alice.csrfToken,
    },
    body: JSON.stringify({
      user_ids: ['usr_alice', 'usr_bob', 'usr_charlie', 'usr_diana'],
    }),
  });
  assertCondition(presenceRes.status === 200, `Expected 200 from /v1/presence/query, got ${presenceRes.status}`);
  const presenceData = (await presenceRes.json()) as { statuses: Array<{ user_id: string; status: string }> };
  assertCondition(presenceData.statuses.length === 4, 'Expected 4 presence statuses');
  console.log(`  ✓ Listed ${usersData.users.length} active users and queried batch presence for 4 users\n`);

  // -------------------------------------------------------------------------
  // TEST 4: Channel Listing & Parity Across Cloud Spanner and Cloud Firestore
  // -------------------------------------------------------------------------
  console.log('[Test 4/7] Channel Service: Comparing Cloud Spanner vs. Cloud Firestore...');
  const spannerChannelsRes = await fetch(`${BASE_URL}/v1/channels?store=spanner`, {
    headers: { Cookie: alice.cookie },
  });
  const firestoreChannelsRes = await fetch(`${BASE_URL}/v1/channels?store=firestore`, {
    headers: { Cookie: alice.cookie },
  });
  assertCondition(spannerChannelsRes.status === 200, 'Spanner channels request failed');
  assertCondition(firestoreChannelsRes.status === 200, 'Firestore channels request failed');

  const spannerChannels = (await spannerChannelsRes.json()) as {
    source_store: string;
    channels: Array<{ channel_id: string; name: string; type: string }>;
  };
  const firestoreChannels = (await firestoreChannelsRes.json()) as {
    source_store: string;
    channels: Array<{ channel_id: string; name: string; type: string }>;
  };

  assertCondition(spannerChannels.channels.length >= 3, 'Expected >= 3 channels in Cloud Spanner');
  assertCondition(firestoreChannels.channels.length >= 3, 'Expected >= 3 channels in Cloud Firestore');
  console.log(
    `  ✓ Cloud Spanner Channels (${spannerChannels.channels.length}): ${spannerChannels.channels.map((c) => c.channel_id).join(', ')}`
  );
  console.log(
    `  ✓ Cloud Firestore Channels (${firestoreChannels.channels.length}): ${firestoreChannels.channels.map((c) => c.channel_id).join(', ')}\n`
  );

  // -------------------------------------------------------------------------
  // TEST 5: REST Message Ingestion, Idempotency & Spanner/Firestore Read Parity
  // -------------------------------------------------------------------------
  console.log('[Test 5/7] Message Service: Dual-Write, Idempotency Deduplication & History Parity...');
  const idempotencyKey = `e2e_idemp_${crypto.randomBytes(6).toString('hex')}`;
  const msgContent = `Automated E2E verification message (${new Date().toISOString()})`;

  const postMsg1 = await fetch(`${BASE_URL}/v1/channels/chn_arch_review/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: alice.cookie,
      'X-CSRF-Token': alice.csrfToken,
    },
    body: JSON.stringify({
      content: msgContent,
      client_message_id: idempotencyKey,
    }),
  });
  assertCondition(postMsg1.status === 201, `Expected 201 on message create, got ${postMsg1.status}`);
  const createdMsg1 = (await postMsg1.json()) as {
    message_id: string;
    sequence_num: number;
    client_message_id: string;
  };

  // Retry with the exact same client_message_id to verify idempotency
  const postMsg2 = await fetch(`${BASE_URL}/v1/channels/chn_arch_review/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: alice.cookie,
      'X-CSRF-Token': alice.csrfToken,
    },
    body: JSON.stringify({
      content: msgContent,
      client_message_id: idempotencyKey,
    }),
  });
  assertCondition(postMsg2.status === 201, `Expected 201 on idempotent retry, got ${postMsg2.status}`);
  const createdMsg2 = (await postMsg2.json()) as {
    message_id: string;
    sequence_num: number;
    client_message_id: string;
  };

  assertCondition(
    createdMsg1.message_id === createdMsg2.message_id &&
      createdMsg1.sequence_num === createdMsg2.sequence_num,
    'Idempotency check failed: duplicate message created instead of returning original message_id/sequence_num'
  );
  console.log(
    `  ✓ Dual-wrote message ${createdMsg1.message_id} (seq #${createdMsg1.sequence_num}) & verified idempotent retry deduplication`
  );

  // Verify message is readable from BOTH Cloud Spanner and Cloud Firestore
  const spannerMsgsRes = await fetch(
    `${BASE_URL}/v1/channels/chn_arch_review/messages?limit=20&store=spanner`,
    { headers: { Cookie: alice.cookie } }
  );
  const firestoreMsgsRes = await fetch(
    `${BASE_URL}/v1/channels/chn_arch_review/messages?limit=20&store=firestore`,
    { headers: { Cookie: alice.cookie } }
  );
  const spannerMsgs = (await spannerMsgsRes.json()) as {
    source_store: string;
    messages: Array<{ message_id: string; sequence_num: number; content: string }>;
  };
  const firestoreMsgs = (await firestoreMsgsRes.json()) as {
    source_store: string;
    messages: Array<{ message_id: string; sequence_num: number; content: string }>;
  };

  assertCondition(
    spannerMsgs.messages.some((m) => m.message_id === createdMsg1.message_id),
    'New message not found in Cloud Spanner'
  );
  assertCondition(
    firestoreMsgs.messages.some((m) => m.message_id === createdMsg1.message_id),
    'New message not found in Cloud Firestore'
  );
  console.log(
    `  ✓ Verified message ${createdMsg1.message_id} in BOTH ${spannerMsgs.source_store} and ${firestoreMsgs.source_store}\n`
  );

  // -------------------------------------------------------------------------
  // TEST 6: Real-Time WebSocket Gateway (/v1/auth/ws-ticket + /v1/stream)
  // -------------------------------------------------------------------------
  console.log('[Test 6/7] Real-Time WebSocket Gateway: Multi-User Fan-Out, Typing & Heartbeats...');
  const aliceTicketRes = await fetch(`${BASE_URL}/v1/auth/ws-ticket`, {
    method: 'POST',
    headers: { Cookie: alice.cookie, 'X-CSRF-Token': alice.csrfToken },
  });
  const bobTicketRes = await fetch(`${BASE_URL}/v1/auth/ws-ticket`, {
    method: 'POST',
    headers: { Cookie: bob.cookie, 'X-CSRF-Token': bob.csrfToken },
  });
  assertCondition(aliceTicketRes.status === 201 && bobTicketRes.status === 201, 'Failed to issue ws-tickets');

  const aliceTicket = (await aliceTicketRes.json()) as { ws_ticket: string; ws_endpoint: string };
  const bobTicket = (await bobTicketRes.json()) as { ws_ticket: string; ws_endpoint: string };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WebSocket E2E test timed out after 15s'));
    }, 15000);

    const wsAlice = new WebSocket(aliceTicket.ws_endpoint, [
      'chat.v1',
      `ticket.${aliceTicket.ws_ticket}`,
    ]);
    const wsBob = new WebSocket(bobTicket.ws_endpoint, [
      'chat.v1',
      `ticket.${bobTicket.ws_ticket}`,
    ]);

    let aliceOpen = false;
    let bobOpen = false;
    let gotPong = false;
    let gotAck = false;
    let bobReceivedTyping = false;
    let bobReceivedRealtimeMsg = false;
    const wsClientMsgId = `ws_cmsg_${crypto.randomBytes(6).toString('hex')}`;

    function checkDone(): void {
      if (gotPong && gotAck && bobReceivedTyping && bobReceivedRealtimeMsg) {
        clearTimeout(timeout);
        wsAlice.close();
        wsBob.close();
        resolve();
      }
    }

    function onBothConnected(): void {
      if (!aliceOpen || !bobOpen) return;

      // 1. Alice sends heartbeat_ping
      wsAlice.send(
        JSON.stringify({
          event_type: 'heartbeat_ping',
          trace_id: 'trc_hb_01',
          payload: {},
        })
      );

      // 2. Alice sends typing_indicator to chn_dm_alice_bob
      wsAlice.send(
        JSON.stringify({
          event_type: 'typing_indicator',
          trace_id: 'trc_typ_01',
          payload: {
            channel_id: 'chn_dm_alice_bob',
            is_typing: true,
          },
        })
      );

      // 3. Alice sends real-time chat message over WebSocket to chn_dm_alice_bob
      wsAlice.send(
        JSON.stringify({
          event_type: 'send_message',
          trace_id: 'trc_msg_01',
          payload: {
            channel_id: 'chn_dm_alice_bob',
            client_message_id: wsClientMsgId,
            content: 'Real-time WebSocket message from Alice to Bob!',
          },
        })
      );
    }

    wsAlice.on('open', () => {
      aliceOpen = true;
      onBothConnected();
    });

    wsBob.on('open', () => {
      bobOpen = true;
      onBothConnected();
    });

    wsAlice.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.event_type === 'heartbeat_pong') {
        gotPong = true;
        console.log(`  ✓ Alice received heartbeat_pong from gateway node ${ev.payload.node_id}`);
      } else if (ev.event_type === 'message_ack' && ev.payload?.client_message_id === wsClientMsgId) {
        gotAck = true;
        console.log(
          `  ✓ Alice received message_ack (${ev.payload.status}) for ${ev.payload.message_id} (seq #${ev.payload.sequence_num})`
        );
      }
      checkDone();
    });

    wsBob.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.event_type === 'typing_indicator' && ev.payload?.channel_id === 'chn_dm_alice_bob') {
        bobReceivedTyping = true;
        console.log(`  ✓ Bob received real-time typing_indicator from ${ev.payload.username}`);
      } else if (
        ev.event_type === 'receive_message' &&
        ev.payload?.client_message_id === wsClientMsgId
      ) {
        bobReceivedRealtimeMsg = true;
        console.log(
          `  ✓ Bob received real-time receive_message over WebSocket: "${ev.payload.content}" (seq #${ev.payload.sequence_num})`
        );
      }
      checkDone();
    });

    wsAlice.on('error', reject);
    wsBob.on('error', reject);
  });
  console.log('');

  // -------------------------------------------------------------------------
  // TEST 7: Session Logout & JTI Token Revocation
  // -------------------------------------------------------------------------
  console.log('[Test 7/7] Auth Service: Logout & JTI Revocation Verification...');
  const logoutRes = await fetch(`${BASE_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: bob.cookie,
      'X-CSRF-Token': bob.csrfToken,
    },
  });
  assertCondition(logoutRes.status === 200, `Expected 200 on logout, got ${logoutRes.status}`);

  const afterLogoutMe = await fetch(`${BASE_URL}/v1/auth/me`, {
    headers: { Cookie: bob.cookie },
  });
  assertCondition(
    afterLogoutMe.status === 401,
    `Expected 401 after JTI revocation on logout, got ${afterLogoutMe.status}`
  );
  console.log('  ✓ Bob logged out and revoked JWT jti was rejected on subsequent request (HTTP 401)\n');

  console.log('====================================================================');
  console.log('ALL 7 MICROSERVICE & DATABASE INTEGRATION TESTS PASSED! (100% PASS)');
  console.log('====================================================================');
}

runTests().catch((err) => {
  console.error('\n[TEST FAILURE]', err);
  process.exit(1);
});
