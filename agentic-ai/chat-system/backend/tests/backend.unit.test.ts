import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  signJwt,
  verifyJwt,
  maskEmail,
  hashEmail,
  parseCookies,
} from '../src/config/security';
import { EphemeralStore } from '../src/repositories/ephemeral-store';

describe('Backend Unit Test Suite — Cryptographic Security & Auth (security.ts)', () => {
  it('hashes passwords with scrypt and verifies with timingSafeEqual', () => {
    const sampleCandidate = `val_${crypto.randomBytes(12).toString('base64url')}`;
    const otherCandidate = `val_${crypto.randomBytes(12).toString('base64url')}`;
    const hash = hashPassword(sampleCandidate);
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(verifyPassword(sampleCandidate, hash), true);
    assert.equal(verifyPassword(otherCandidate, hash), false);
    assert.equal(verifyPassword(sampleCandidate, 'malformed_hash'), false);
  });

  it('enforces password strength rules (8..128 chars)', () => {
    assert.equal(validatePasswordStrength('short').valid, false);
    assert.equal(validatePasswordStrength('a'.repeat(129)).valid, false);
    assert.equal(validatePasswordStrength('a'.repeat(16)).valid, true);
  });

  it('signs HS256 JWTs, verifies claims, and rejects alg:none, tampered signatures, or revoked JTIs', () => {
    const { token, claims } = signJwt(
      {
        sub: 'usr_alice',
        username: 'alice',
        displayName: 'Alice Rivera',
      },
      3600
    );

    const verified = verifyJwt(token, () => false);
    assert.notEqual(verified, null);
    assert.equal(verified?.sub, 'usr_alice');
    assert.equal(verified?.jti, claims.jti);
    assert.equal(verified?.csrf, claims.csrf);

    // Reject revoked JTI
    assert.equal(verifyJwt(token, (jti) => jti === claims.jti), null);

    // Reject alg: "none" forgery attempt
    const [, payloadPart, sigPart] = token.split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .toString('base64')
      .replace(/=/g, '');
    const forgedNoneToken = `${noneHeader}.${payloadPart}.${sigPart}`;
    assert.equal(verifyJwt(forgedNoneToken, () => false), null);

    // Reject tampered payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claims, sub: 'usr_admin' })
    )
      .toString('base64')
      .replace(/=/g, '');
    const tamperedToken = `${token.split('.')[0]}.${tamperedPayload}.${sigPart}`;
    assert.equal(verifyJwt(tamperedToken, () => false), null);
  });

  it('masks PII emails and computes deterministic SHA-256 email hashes', () => {
    assert.equal(maskEmail('alice@example.com'), 'a***e@example.com');
    assert.equal(
      hashEmail('Alice@Example.com '),
      hashEmail('alice@example.com')
    );
  });

  it('parses HTTP Cookie headers accurately', () => {
    const parsed = parseCookies(
      '__Host-chat_session=jwt_token_123; theme=dark'
    );
    assert.equal(parsed['__Host-chat_session'], 'jwt_token_123');
    assert.equal(parsed.theme, 'dark');
  });
});

describe('Backend Unit Test Suite — Ephemeral Store & Single-Use WS Tickets (ephemeral-store.ts)', () => {
  it('issues single-use WebSocket upgrade tickets and blocks replay attacks (atomic GETDEL)', () => {
    const store = new EphemeralStore('test-node-1');
    const { ticket } = store.issueWsTicket({
      user_id: 'usr_alice',
      username: 'alice',
      display_name: 'Alice Rivera',
      jti: 'jti_test_1',
    });

    // First redemption succeeds
    const firstRedeem = store.redeemWsTicket(ticket);
    assert.notEqual(firstRedeem, null);
    assert.equal(firstRedeem?.user_id, 'usr_alice');

    // Replay redemption of the exact same ticket MUST fail (single-use)
    const replayRedeem = store.redeemWsTicket(ticket);
    assert.equal(replayRedeem, null);
  });

  it('tracks multi-device user sessions and transitions ONLINE -> OFFLINE only when last session closes', () => {
    const store = new EphemeralStore('test-node-1');
    const user = {
      user_id: 'usr_bob',
      username: 'bob',
      display_name: 'Bob Chen',
    };

    // Connect two devices (session_desktop + session_mobile)
    store.registerOrRefreshSession(user, 'session_desktop');
    store.registerOrRefreshSession(user, 'session_mobile');
    assert.equal(store.getPresenceBatch(['usr_bob'])[0].status, 'ONLINE');

    // Disconnect desktop -> mobile still active, user remains ONLINE
    store.unregisterSession('usr_bob', 'session_desktop');
    assert.equal(store.getPresenceBatch(['usr_bob'])[0].status, 'ONLINE');

    // Disconnect mobile -> 0 sessions remaining, user transitions to OFFLINE
    store.unregisterSession('usr_bob', 'session_mobile');
    assert.equal(store.getPresenceBatch(['usr_bob'])[0].status, 'OFFLINE');
  });

  it('manages pre-auth CSRF tokens and JTI revocation', () => {
    const store = new EphemeralStore('test-node-1');
    const csrf = store.issuePreAuthCsrfToken();
    assert.equal(store.verifyPreAuthCsrfToken(csrf), true);
    assert.equal(store.verifyPreAuthCsrfToken('invalid_csrf'), false);

    store.revokeJti('jti_compromised');
    assert.equal(store.isJtiRevoked('jti_compromised'), true);
    assert.equal(store.isJtiRevoked('jti_valid'), false);
  });
});
