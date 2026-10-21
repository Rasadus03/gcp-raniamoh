import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  maskEmail,
  maskPhoneNumber,
  maskIdentifier,
  sanitizeMessageText,
  validateAttachmentMetadata,
} from '../src/domain/security-sanitizer';
import { ChatStateStore } from '../src/domain/chat-store';
import {
  WebSocketStateMachine,
  calculateBackoffWithFullJitter,
} from '../src/domain/ws-state-machine';

describe('Frontend Unit Test Suite — @chat/security-sanitizer', () => {
  it('masks email addresses to prevent PII exposure in UI labels', () => {
    assert.equal(maskEmail('alice.rivera@example.com'), 'a***@example.com');
    assert.equal(maskEmail('bob@google.com'), 'b***@google.com');
    assert.equal(maskEmail('invalid-email'), '***@***');
    assert.equal(maskEmail(''), '***@***');
  });

  it('masks phone numbers leaving only the last 4 digits visible', () => {
    assert.equal(maskPhoneNumber('+1 (415) 555-0199'), '***-***-0199');
    assert.equal(maskPhoneNumber('12'), '***-***-****');
  });

  it('masks internal user and session identifiers safely', () => {
    assert.equal(maskIdentifier('usr_alice_98765'), 'usr_***765');
    assert.equal(maskIdentifier('short'), '***');
  });

  it('sanitizes message text and enforces 1..4096 character bounds', () => {
    const emptyRes = sanitizeMessageText('   \n\t  ');
    assert.equal(emptyRes.valid, false);

    const controlCharRes = sanitizeMessageText('Hello\x00\x07 World!');
    assert.equal(controlCharRes.valid, true);
    assert.equal(controlCharRes.sanitized, 'Hello World!');

    const oversized = sanitizeMessageText('a'.repeat(5000));
    assert.equal(oversized.valid, false);
    assert.equal(oversized.sanitized.length, 4096);
  });

  it('validates media attachments against size limits, MIME allow-list, path traversal, and double extensions', () => {
    const validPng = validateAttachmentMetadata({
      filename: 'architecture-diagram.png',
      mimeType: 'image/png',
      sizeBytes: 250 * 1024,
    });
    assert.equal(validPng.valid, true);

    const traversalAttempt = validateAttachmentMetadata({
      filename: '../../etc/passwd.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    assert.equal(traversalAttempt.valid, false);
    assert.match(traversalAttempt.reason || '', /path traversal/i);

    const doubleExtAttempt = validateAttachmentMetadata({
      filename: 'malware.exe.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    assert.equal(doubleExtAttempt.valid, false);
    assert.match(doubleExtAttempt.reason || '', /double file extension/i);

    const oversizedAttempt = validateAttachmentMetadata({
      filename: 'large-report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 15 * 1024 * 1024, // 15 MB (> 10 MB limit)
    });
    assert.equal(oversizedAttempt.valid, false);
    assert.match(oversizedAttempt.reason || '', /exceeds maximum limit/i);
  });
});

describe('Frontend Unit Test Suite — @chat/messaging-core (ChatStateStore)', () => {
  it('stores CSRF token and user session strictly in memory and purges on resetAllState()', () => {
    const store = new ChatStateStore();
    store.setSession(
      {
        user_id: 'usr_alice',
        username: 'alice',
        display_name: 'Alice Rivera',
        masked_email: 'a***@example.com',
      },
      'csrf_secret_token_123'
    );

    assert.equal(store.getCsrfToken(), 'csrf_secret_token_123');
    assert.equal(store.getCurrentUser()?.username, 'alice');

    store.resetAllState();
    assert.equal(store.getCsrfToken(), null);
    assert.equal(store.getCurrentUser(), null);
    assert.deepEqual(store.usersById, {});
  });

  it('enqueues optimistic messages and reconciles them upon server ack without duplication', () => {
    const store = new ChatStateStore();
    const pending = store.enqueueOptimisticMessage({
      client_message_id: 'cmsg_opt_001',
      channel_id: 'chn_arch_review',
      sender_id: 'usr_alice',
      sender_display_name: 'Alice Rivera',
      content: 'Testing optimistic UI reconciliation',
      created_at: '2026-10-21T10:00:00.000Z',
    });

    assert.equal(pending.status, 'SENDING');
    assert.equal(store.getPendingMessagesForChannel('chn_arch_review').length, 1);

    // Reconcile canonical message from server
    store.reconcileServerMessage({
      message_id: 'msg_server_101',
      client_message_id: 'cmsg_opt_001',
      channel_id: 'chn_arch_review',
      sequence_num: 1,
      sender_id: 'usr_alice',
      sender_username: 'alice',
      sender_display_name: 'Alice Rivera',
      content: 'Testing optimistic UI reconciliation',
      content_type: 'TEXT',
      created_at: '2026-10-21T10:00:00.120Z',
    });

    // Pending outbox should now be empty and canonical message stored
    assert.equal(store.getPendingMessagesForChannel('chn_arch_review').length, 0);
    const ordered = store.getOrderedMessagesForChannel('chn_arch_review');
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0].message_id, 'msg_server_101');
    assert.equal(ordered[0].status, 'PERSISTED');

    // Duplicate delivery of the same message_id must be idempotent
    store.reconcileServerMessage({
      message_id: 'msg_server_101',
      client_message_id: 'cmsg_opt_001',
      channel_id: 'chn_arch_review',
      sequence_num: 1,
      sender_id: 'usr_alice',
      sender_username: 'alice',
      sender_display_name: 'Alice Rivera',
      content: 'Testing optimistic UI reconciliation',
      content_type: 'TEXT',
      created_at: '2026-10-21T10:00:00.120Z',
    });
    assert.equal(store.getOrderedMessagesForChannel('chn_arch_review').length, 1);
  });

  it('detects sequence number gaps when out-of-order frames arrive and sorts by sequence_num ASC', () => {
    const store = new ChatStateStore();
    store.reconcileServerMessage({
      message_id: 'msg_1',
      client_message_id: 'cmsg_1',
      channel_id: 'chn_sre_loadtest',
      sequence_num: 1,
      sender_id: 'usr_bob',
      sender_username: 'bob',
      sender_display_name: 'Bob Chen',
      content: 'Message 1',
      content_type: 'TEXT',
      created_at: '2026-10-21T10:00:01.000Z',
    });

    // Incoming message jumps from sequence_num 1 -> 5 (missing 2..4)
    const gap = store.reconcileServerMessage({
      message_id: 'msg_5',
      client_message_id: 'cmsg_5',
      channel_id: 'chn_sre_loadtest',
      sequence_num: 5,
      sender_id: 'usr_bob',
      sender_username: 'bob',
      sender_display_name: 'Bob Chen',
      content: 'Message 5',
      content_type: 'TEXT',
      created_at: '2026-10-21T10:00:05.000Z',
    });

    assert.equal(gap.hasGap, true);
    assert.equal(gap.fromSeq, 2);
    assert.equal(gap.toSeq, 4);

    // Backfill message #3 and verify list remains sorted [1, 3, 5]
    store.reconcileServerMessage({
      message_id: 'msg_3',
      client_message_id: 'cmsg_3',
      channel_id: 'chn_sre_loadtest',
      sequence_num: 3,
      sender_id: 'usr_alice',
      sender_username: 'alice',
      sender_display_name: 'Alice Rivera',
      content: 'Message 3 (backfilled)',
      content_type: 'TEXT',
      created_at: '2026-10-21T10:00:03.000Z',
    });

    const seqs = store
      .getOrderedMessagesForChannel('chn_sre_loadtest')
      .map((m) => m.sequence_num);
    assert.deepEqual(seqs, [1, 3, 5]);
  });

  it('manages ephemeral typing indicators with TTL expiration', () => {
    const store = new ChatStateStore();
    const baseTime = 1_700_000_000_000;
    store.setUserTyping('chn_arch_review', 'usr_bob', true, baseTime, 5000);

    assert.deepEqual(store.getActiveTypingUserIds('chn_arch_review', baseTime + 2000), [
      'usr_bob',
    ]);
    assert.deepEqual(store.getActiveTypingUserIds('chn_arch_review', baseTime + 6000), []);
  });
});

describe('Frontend Unit Test Suite — @chat/ws-state-machine', () => {
  it('follows deterministic state transitions across the connection lifecycle', () => {
    const fsm = new WebSocketStateMachine();
    assert.equal(fsm.getState(), 'DISCONNECTED');

    assert.equal(fsm.transition('USER_AUTHENTICATED'), 'ACQUIRING_TICKET');
    assert.equal(fsm.transition('TICKET_ACQUIRED'), 'CONNECTING_WSS');
    assert.equal(fsm.transition('WS_OPEN_101'), 'DELTA_SYNCING');
    assert.equal(fsm.transition('DELTA_SYNC_COMPLETE'), 'SYNCED_READY');
    assert.equal(fsm.getReconnectAttempts(), 0);

    // Simulate unexpected socket drop -> RECONNECT_BACKOFF
    assert.equal(fsm.transition('WS_ERROR_OR_CLOSE'), 'RECONNECT_BACKOFF');
    assert.equal(fsm.getReconnectAttempts(), 1);

    // Backoff timer fires -> re-acquires fresh single-use ticket
    assert.equal(fsm.transition('BACKOFF_TIMER_FIRED'), 'ACQUIRING_TICKET');

    // User logs out -> returns to DISCONNECTED and resets attempts
    assert.equal(fsm.transition('USER_LOGOUT'), 'DISCONNECTED');
    assert.equal(fsm.getReconnectAttempts(), 0);
  });

  it('calculates exponential backoff with full jitter within [0, 30000ms]', () => {
    assert.equal(calculateBackoffWithFullJitter(0, () => 0.5), 250);
    assert.equal(calculateBackoffWithFullJitter(1, () => 0.5), 500);
    assert.equal(calculateBackoffWithFullJitter(10, () => 0.9999), 29997);
    assert.equal(calculateBackoffWithFullJitter(0, () => 0), 0);
  });

  it('detects zombie sockets when heartbeat_pong does not arrive within 10s', () => {
    const fsm = new WebSocketStateMachine();
    const t0 = 1_000_000;
    fsm.recordPingSent(t0);

    assert.equal(fsm.isHeartbeatTimedOut(t0 + 5000, 10000), false);
    assert.equal(fsm.isHeartbeatTimedOut(t0 + 10000, 10000), true);

    fsm.recordPongReceived(t0 + 10500);
    assert.equal(fsm.isHeartbeatTimedOut(t0 + 12000, 10000), false);
  });
});

describe('Frontend Unit Test Suite — Static Security & Modern Web Compliance', () => {
  it('verifies both Login Page (/login) and Chatting Page (/chat) HTML and JS contain zero unsafe DOM sinks, zero web storage tokens, and use modern <dialog closedby="any">', () => {
    const chatHtmlPath = path.resolve(__dirname, '../../src/public/index.html');
    const chatJsPath = path.resolve(__dirname, '../../src/public/app.js');
    const loginHtmlPath = path.resolve(__dirname, '../../src/public/login.html');
    const loginJsPath = path.resolve(__dirname, '../../src/public/login.js');

    const chatHtmlContent = fs.readFileSync(chatHtmlPath, 'utf-8');
    const chatJsContent = fs.readFileSync(chatJsPath, 'utf-8');
    const loginHtmlContent = fs.readFileSync(loginHtmlPath, 'utf-8');
    const loginJsContent = fs.readFileSync(loginJsPath, 'utf-8');

    // Verify CSP nonces and <dialog closedby="any"> on both pages
    assert.match(chatHtmlContent, /nonce="\{\{CSP_NONCE\}\}"/);
    assert.match(chatHtmlContent, /<dialog[^>]+closedby="any"/);
    assert.match(loginHtmlContent, /nonce="\{\{CSP_NONCE\}\}"/);
    assert.match(loginHtmlContent, /<dialog[^>]+closedby="any"/);

    // Verify modern-web-guidance autofill attributes on /login page
    assert.match(loginHtmlContent, /autocomplete="username"/);
    assert.match(loginHtmlContent, /id="current-password"/);
    assert.match(loginHtmlContent, /autocomplete="current-password"/);
    assert.match(loginHtmlContent, /id="new-password"/);
    assert.match(loginHtmlContent, /autocomplete="new-password"/);

    // Verify zero unsafe DOM manipulation sinks or blocking dialogs in both app.js and login.js
    const forbiddenPatterns = [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML\b/,
      /document\.write\b/,
      /localStorage\b/,
      /sessionStorage\b/,
      /\balert\s*\(/,
      /\bconfirm\s*\(/,
      /\bprompt\s*\(/,
    ];

    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(chatJsContent),
        false,
        `Forbidden pattern ${pattern} found in frontend/src/public/app.js`
      );
      assert.equal(
        pattern.test(loginJsContent),
        false,
        `Forbidden pattern ${pattern} found in frontend/src/public/login.js`
      );
    }
  });
});
