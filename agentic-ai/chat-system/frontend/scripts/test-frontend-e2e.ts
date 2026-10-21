import WebSocket from 'ws';
import crypto from 'crypto';
import { ChatStateStore } from '../src/domain/chat-store';
import { WebSocketStateMachine } from '../src/domain/ws-state-machine';
import {
  maskEmail,
  maskIdentifier,
  sanitizeMessageText,
} from '../src/domain/security-sanitizer';

const FRONTEND_URL =
  process.env.CHAT_FRONTEND_URL ||
  'https://chat-system-frontend-ayf6osu6ka-uc.a.run.app';

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

function extractCspNonce(cspHeader: string): string {
  const match = cspHeader.match(/'nonce-([^']+)'/);
  return match ? match[1] : '';
}

async function authenticateThroughBff(username: string): Promise<{
  store: ChatStateStore;
  cookie: string;
}> {
  const store = new ChatStateStore();

  const csrfRes = await fetch(`${FRONTEND_URL}/v1/auth/csrf`);
  assertCondition(csrfRes.status === 200, `Expected 200 from BFF /v1/auth/csrf, got ${csrfRes.status}`);
  const csrfData = (await csrfRes.json()) as { csrf_token: string };

  const loginRes = await fetch(`${FRONTEND_URL}/v1/auth/demo-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfData.csrf_token,
    },
    body: JSON.stringify({
      username,
    }),
  });
  assertCondition(loginRes.status === 200, `Expected 200 from BFF /v1/auth/demo-login for ${username}`);

  const cookie = extractSessionCookie(loginRes.headers.get('set-cookie'));
  assertCondition(Boolean(cookie), `Expected Set-Cookie from Frontend BFF for ${username}`);

  const body = (await loginRes.json()) as {
    user: {
      user_id: string;
      username: string;
      display_name: string;
      masked_email: string;
      avatar_url: string | null;
    };
    csrf_token: string;
  };

  store.setSession(body.user, body.csrf_token);
  return { store, cookie };
}

async function runFrontendTests(): Promise<void> {
  console.log('====================================================================');
  console.log('Running Frontend UI, State Store & BFF End-to-End Test Suite');
  console.log(`Target Frontend URL: ${FRONTEND_URL}`);
  console.log('====================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Frontend BFF Health & Upstream Target Verification
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 1/6] BFF Health Proxy (/v1/health) & Security Headers...');
  const healthRes = await fetch(`${FRONTEND_URL}/v1/health`);
  assertCondition(healthRes.status === 200, `Expected 200 from BFF /v1/health, got ${healthRes.status}`);
  const healthData = (await healthRes.json()) as {
    status: string;
    service: string;
    diagnostics: {
      project_id: string;
      spanner: { instance: string; database: string; users: number; channels: number; messages: number };
      firestore: { database: string; users: number; channels: number };
    };
  };
  assertCondition(healthData.status === 'HEALTHY', 'Expected Frontend BFF /v1/health status HEALTHY');
  console.log(
    `  ✓ Frontend BFF Proxy -> Backend Health: ${healthData.status} | Spanner (${healthData.diagnostics.spanner.users}u/${healthData.diagnostics.spanner.channels}c/${healthData.diagnostics.spanner.messages}m) | Firestore (${healthData.diagnostics.firestore.users}u/${healthData.diagnostics.firestore.channels}c)\n`
  );

  // -------------------------------------------------------------------------
  // TEST 2: Dedicated Login Page (/login) & Chatting Page (/chat), CSP Nonces & Bundles
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 2/6] Login Page (/login), Chatting Page (/chat), CSP Nonces & Bundles...');
  const [loginPageRes, loginJsRes, chatPageRes1, chatPageRes2, jsRes] = await Promise.all([
    fetch(`${FRONTEND_URL}/login`),
    fetch(`${FRONTEND_URL}/login.js`),
    fetch(`${FRONTEND_URL}/chat`),
    fetch(`${FRONTEND_URL}/`),
    fetch(`${FRONTEND_URL}/app.js`),
  ]);

  assertCondition(loginPageRes.status === 200, 'Expected 200 on GET /login');
  assertCondition(loginJsRes.status === 200, 'Expected 200 on GET /login.js');
  assertCondition(chatPageRes1.status === 200 && chatPageRes2.status === 200, 'Expected 200 on GET /chat and GET /');
  assertCondition(jsRes.status === 200, 'Expected 200 on GET /app.js');

  const loginCsp = loginPageRes.headers.get('content-security-policy') || '';
  const csp1 = chatPageRes1.headers.get('content-security-policy') || '';
  const csp2 = chatPageRes2.headers.get('content-security-policy') || '';
  const loginNonce = extractCspNonce(loginCsp);
  const nonce1 = extractCspNonce(csp1);
  const nonce2 = extractCspNonce(csp2);

  assertCondition(Boolean(loginNonce) && Boolean(nonce1) && Boolean(nonce2), 'Missing cryptographic CSP nonces');
  assertCondition(nonce1 !== nonce2 && loginNonce !== nonce1, 'CSP nonce must rotate on every HTTP request');

  const loginHtml = await loginPageRes.text();
  assertCondition(
    loginHtml.includes(`<style nonce="${loginNonce}">`) &&
      loginHtml.includes(`<script src="/login.js" nonce="${loginNonce}" defer></script>`),
    'Login page <style> and <script> nonces do not match response CSP header nonce'
  );
  const requiredLoginMarkers = [
    'id="signin-form"',
    'id="signup-form"',
    'id="persona-list"',
    'id="current-password"',
    'id="new-password"',
    'id="login-dialog" closedby="any"',
  ];
  for (const marker of requiredLoginMarkers) {
    assertCondition(loginHtml.includes(marker), `Missing required Login Page DOM marker: ${marker}`);
  }

  const html1 = await chatPageRes1.text();
  assertCondition(
    html1.includes(`<style nonce="${nonce1}">`) &&
      html1.includes(`<script src="/app.js" nonce="${nonce1}" defer></script>`),
    'Chat page <style> and <script> nonces do not match response CSP header nonce'
  );

  // Verify all micro-frontend DOM mount points exist in served Chat Page HTML
  const requiredDomIds = [
    'id="user-switcher"',
    'id="channel-roster"',
    'id="presence-roster"',
    'id="message-viewport"',
    'id="typing-indicator-bar"',
    'id="message-composer-form"',
    'id="store-inspector"',
    'id="gcp-diagnostics"',
    'id="trace-log"',
    'id="app-dialog" closedby="any"',
  ];
  for (const marker of requiredDomIds) {
    assertCondition(html1.includes(marker), `Missing required DOM element marker: ${marker}`);
  }

  const loginJsText = await loginJsRes.text();
  const appJsText = await jsRes.text();
  assertCondition(
    loginJsText.includes('performSignIn') &&
      loginJsText.includes('performSignUp') &&
      loginJsText.includes('renderPersonaCards'),
    'Served /login.js is missing expected login functions'
  );
  assertCondition(
    appJsText.includes('bootstrapAuthenticatedSession') &&
      appJsText.includes('initiateWebSocketHandshake') &&
      appJsText.includes('reconcileMessage'),
    'Served /app.js is missing expected client engine functions'
  );
  console.log(
    `  ✓ Verified rotating per-request CSP nonces across /login and /chat (${loginNonce.slice(0, 8)}... != ${nonce1.slice(0, 8)}...)`
  );
  console.log(
    `  ✓ Verified Login Page (/login, /login.js: ${loginJsText.length}B) & Chatting Page (/chat, /app.js: ${appJsText.length}B)\n`
  );

  // -------------------------------------------------------------------------
  // TEST 3: BFF Auth Proxy & Client ChatStateStore Session Hydration
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 3/6] BFF Auth Proxy & Client ChatStateStore Session Hydration...');
  const { store: aliceStore, cookie: aliceCookie } = await authenticateThroughBff('alice');
  const { store: dianaStore, cookie: dianaCookie } = await authenticateThroughBff('diana');

  const aliceUser = aliceStore.getCurrentUser()!;
  const dianaUser = dianaStore.getCurrentUser()!;
  assertCondition(aliceUser.user_id === 'usr_alice', 'Expected usr_alice in Alice store');
  assertCondition(dianaUser.user_id === 'usr_diana', 'Expected usr_diana in Diana store');
  assertCondition(Boolean(aliceStore.getCsrfToken()), 'Expected in-memory CSRF token in Alice store');
  console.log(
    `  ✓ Hydrated Alice store: ${aliceUser.display_name} (${maskIdentifier(aliceUser.user_id)}, ${maskEmail(aliceUser.masked_email)})`
  );
  console.log(
    `  ✓ Hydrated Diana store: ${dianaUser.display_name} (${maskIdentifier(dianaUser.user_id)}, ${maskEmail(dianaUser.masked_email)})\n`
  );

  // -------------------------------------------------------------------------
  // TEST 4: Storage Engine Toggle (Cloud Spanner vs. Cloud Firestore) in Store
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 4/6] Frontend Storage Engine Switcher (Cloud Spanner <-> Cloud Firestore)...');
  for (const engine of ['spanner', 'firestore'] as const) {
    aliceStore.setStorageEngine(engine);
    const chRes = await fetch(`${FRONTEND_URL}/v1/channels?store=${engine}`, {
      headers: { Cookie: aliceCookie },
    });
    assertCondition(chRes.status === 200, `Expected 200 from BFF /v1/channels?store=${engine}`);
    const chData = (await chRes.json()) as {
      source_store: string;
      channels: Array<{
        channel_id: string;
        type: 'DIRECT' | 'GROUP';
        name: string | null;
        is_private: boolean;
        member_count: number;
        last_sequence_num: number;
      }>;
    };
    aliceStore.upsertChannels(chData.channels);

    const msgRes = await fetch(
      `${FRONTEND_URL}/v1/channels/chn_arch_review/messages?limit=50&store=${engine}`,
      { headers: { Cookie: aliceCookie } }
    );
    assertCondition(msgRes.status === 200, `Expected 200 from BFF messages?store=${engine}`);
    const msgData = (await msgRes.json()) as {
      source_store: string;
      messages: Array<{
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
      }>;
    };
    for (const m of msgData.messages) {
      aliceStore.reconcileServerMessage(m, 'chn_arch_review');
    }
    const ordered = aliceStore.getOrderedMessagesForChannel('chn_arch_review');
    console.log(
      `  ✓ Engine [${engine.toUpperCase()}]: hydrated ${Object.keys(aliceStore.channelsById).length} channels & ${ordered.length} ordered messages from ${msgData.source_store}`
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // TEST 5: Optimistic UI Outbox + WebSocket State Machine + BFF WS Relay
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 5/6] Optimistic UI Outbox, WS State Machine & Real-Time BFF Relay...');
  const aliceFsm = new WebSocketStateMachine();
  const dianaFsm = new WebSocketStateMachine();

  assertCondition(aliceFsm.transition('USER_AUTHENTICATED') === 'ACQUIRING_TICKET', 'FSM transition failed');
  dianaFsm.transition('USER_AUTHENTICATED');

  const [aliceTicketRes, dianaTicketRes] = await Promise.all([
    fetch(`${FRONTEND_URL}/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { Cookie: aliceCookie, 'X-CSRF-Token': aliceStore.getCsrfToken()! },
    }),
    fetch(`${FRONTEND_URL}/v1/auth/ws-ticket`, {
      method: 'POST',
      headers: { Cookie: dianaCookie, 'X-CSRF-Token': dianaStore.getCsrfToken()! },
    }),
  ]);
  assertCondition(aliceTicketRes.status === 201 && dianaTicketRes.status === 201, 'WS ticket failed');

  const aliceTicket = (await aliceTicketRes.json()) as { ws_ticket: string; ws_endpoint: string };
  const dianaTicket = (await dianaTicketRes.json()) as { ws_ticket: string; ws_endpoint: string };

  // Verify the Frontend BFF rewrote ws_endpoint to point to the Frontend BFF host!
  const expectedWsHost = new URL(FRONTEND_URL).host;
  assertCondition(
    aliceTicket.ws_endpoint.includes(expectedWsHost),
    `Expected BFF to rewrite ws_endpoint to ${expectedWsHost}, got ${aliceTicket.ws_endpoint}`
  );
  console.log(`  ✓ BFF rewrote ws_endpoint to Frontend BFF gateway: ${aliceTicket.ws_endpoint}`);

  aliceFsm.transition('TICKET_ACQUIRED');
  dianaFsm.transition('TICKET_ACQUIRED');

  // Enqueue Optimistic Message in Alice's store BEFORE sending over WebSocket
  const clientMessageId = `fe_opt_${crypto.randomBytes(6).toString('hex')}`;
  const cleanCheck = sanitizeMessageText(
    'Testing Frontend Optimistic Outbox -> BFF WebSocket Relay -> Spanner & Firestore!'
  );
  assertCondition(cleanCheck.valid, 'Expected sanitized message to be valid');

  const optimisticEntry = aliceStore.enqueueOptimisticMessage({
    client_message_id: clientMessageId,
    channel_id: 'chn_arch_review',
    sender_id: aliceUser.user_id,
    sender_display_name: aliceUser.display_name,
    content: cleanCheck.sanitized,
    created_at: new Date().toISOString(),
  });
  assertCondition(optimisticEntry.status === 'SENDING', 'Expected SENDING status in outbox');
  assertCondition(
    aliceStore.getPendingMessagesForChannel('chn_arch_review').length === 1,
    'Expected 1 message in optimistic outbox before server ack'
  );
  console.log(`  ✓ Enqueued optimistic message ${clientMessageId} in Alice's outbox (status: SENDING)`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Frontend BFF WebSocket relay test timed out after 15s'));
    }, 15000);

    const wsAlice = new WebSocket(aliceTicket.ws_endpoint, [
      'chat.v1',
      `ticket.${aliceTicket.ws_ticket}`,
    ]);
    const wsDiana = new WebSocket(dianaTicket.ws_endpoint, [
      'chat.v1',
      `ticket.${dianaTicket.ws_ticket}`,
    ]);

    let aliceReady = false;
    let dianaReady = false;
    let aliceReconciled = false;
    let dianaReceived = false;

    function checkComplete(): void {
      if (aliceReconciled && dianaReceived) {
        clearTimeout(timer);
        wsAlice.close(1000, 'Test complete');
        wsDiana.close(1000, 'Test complete');
        resolve();
      }
    }

    function onSocketOpen(): void {
      if (!aliceReady || !dianaReady) return;
      wsAlice.send(
        JSON.stringify({
          event_type: 'send_message',
          trace_id: 'trc_fe_e2e_01',
          payload: {
            channel_id: 'chn_arch_review',
            client_message_id: clientMessageId,
            content: cleanCheck.sanitized,
          },
        })
      );
    }

    wsAlice.on('open', () => {
      aliceFsm.transition('WS_OPEN_101');
      aliceFsm.transition('DELTA_SYNC_COMPLETE');
      aliceReady = true;
      onSocketOpen();
    });

    wsDiana.on('open', () => {
      dianaFsm.transition('WS_OPEN_101');
      dianaFsm.transition('DELTA_SYNC_COMPLETE');
      dianaReady = true;
      onSocketOpen();
    });

    wsAlice.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.event_type === 'receive_message' && frame.payload?.client_message_id === clientMessageId) {
        const p = frame.payload;
        aliceStore.reconcileServerMessage(
          {
            message_id: p.message_id,
            client_message_id: p.client_message_id,
            channel_id: p.channel_id,
            sequence_num: p.sequence_num,
            sender_id: p.sender.user_id,
            sender_username: p.sender.username,
            sender_display_name: p.sender.display_name,
            content: p.content,
            content_type: p.content_type,
            created_at: p.created_at,
          },
          'chn_arch_review'
        );

        assertCondition(
          aliceStore.getPendingMessagesForChannel('chn_arch_review').length === 0,
          'Expected optimistic outbox to be empty after reconciliation'
        );
        aliceReconciled = true;
        console.log(
          `  ✓ Alice reconciled optimistic message -> canonical ${p.message_id} (seq #${p.sequence_num}, outbox pending: 0)`
        );
        checkComplete();
      }
    });

    wsDiana.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.event_type === 'receive_message' && frame.payload?.client_message_id === clientMessageId) {
        const p = frame.payload;
        // Diana is viewing a different channel ('chn_sre_loadtest'), so unread_count on 'chn_arch_review' should increment!
        dianaStore.upsertChannels([
          {
            channel_id: 'chn_arch_review',
            type: 'GROUP',
            name: 'architecture-review',
            is_private: false,
            member_count: 4,
            last_sequence_num: p.sequence_num - 1,
          },
        ]);
        dianaStore.reconcileServerMessage(
          {
            message_id: p.message_id,
            client_message_id: p.client_message_id,
            channel_id: p.channel_id,
            sequence_num: p.sequence_num,
            sender_id: p.sender.user_id,
            sender_username: p.sender.username,
            sender_display_name: p.sender.display_name,
            content: p.content,
            content_type: p.content_type,
            created_at: p.created_at,
          },
          'chn_sre_loadtest'
        );

        assertCondition(
          dianaStore.channelsById['chn_arch_review'].unread_count === 1,
          'Expected Diana unread badge count on chn_arch_review to increment to 1'
        );
        dianaReceived = true;
        console.log(
          `  ✓ Diana received message in real time via Frontend BFF WS relay & incremented unread badge (unread: 1)`
        );
        checkComplete();
      }
    });

    wsAlice.on('error', reject);
    wsDiana.on('error', reject);
  });
  console.log('');

  // -------------------------------------------------------------------------
  // TEST 6: Secure Logout Lifecycle & Store Memory Purge
  // -------------------------------------------------------------------------
  console.log('[Frontend Test 6/6] Secure Logout Lifecycle (BFF Revocation + Store Purge)...');
  const logoutRes = await fetch(`${FRONTEND_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: dianaCookie,
      'X-CSRF-Token': dianaStore.getCsrfToken()!,
    },
  });
  assertCondition(logoutRes.status === 200, `Expected 200 on BFF logout, got ${logoutRes.status}`);

  dianaFsm.transition('USER_LOGOUT');
  dianaStore.resetAllState();

  assertCondition(dianaFsm.getState() === 'DISCONNECTED', 'Expected FSM state DISCONNECTED after logout');
  assertCondition(dianaStore.getCsrfToken() === null, 'Expected CSRF token purged from memory');
  assertCondition(dianaStore.getCurrentUser() === null, 'Expected user profile purged from memory');
  console.log('  ✓ Purged all in-memory store entities & revoked session token via Frontend BFF\n');

  console.log('====================================================================');
  console.log('ALL 6 FRONTEND UI, STORE & BFF E2E TESTS PASSED! (100% PASS)');
  console.log('====================================================================');
}

runFrontendTests().catch((err) => {
  console.error('\n[FRONTEND TEST FAILURE]', err);
  process.exit(1);
});
