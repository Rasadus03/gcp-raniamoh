import crypto from 'crypto';
import fs from 'fs';
import { Request, Response, NextFunction } from 'express';

/**
 * Multi-tiered secret resolution following mandatory secure coding rules:
 * 1. Environment variable (process.env.JWT_SECRET_KEY)
 * 2. Local secret file (./jwt_secret.txt) for sandbox/local testing
 * 3. Cryptographically strong ephemeral secret + severe horizontal scaling warning
 * NEVER uses a hardcoded literal fallback.
 */
function resolveJwtSecret(): Buffer {
  if (process.env.JWT_SECRET_KEY && process.env.JWT_SECRET_KEY.trim().length >= 32) {
    return Buffer.from(process.env.JWT_SECRET_KEY.trim(), 'utf-8');
  }
  if (fs.existsSync('./jwt_secret.txt')) {
    const fileSecret = fs.readFileSync('./jwt_secret.txt', 'utf-8').trim();
    if (fileSecret.length >= 32) {
      return Buffer.from(fileSecret, 'utf-8');
    }
  }
  console.warn(
    '[SECURITY WARNING] Generating ephemeral cryptographic JWT secret. Instance-isolated! Configure KMS/Secret Manager in production.'
  );
  return crypto.randomBytes(32);
}

const JWT_SECRET_KEY: Buffer = resolveJwtSecret();
const EXPECTED_JWT_ALGORITHM = 'HS256';

export interface JwtClaims {
  sub: string;       // user_id
  username: string;
  displayName: string;
  jti: string;       // unique session/token ID for revocation
  csrf: string;      // bound synchronizer CSRF token
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  return Buffer.from(padded, 'base64');
}

/**
 * Signs a JWT using hardcoded HS256 algorithm and required 'exp' claim.
 */
export function signJwt(
  payload: Omit<JwtClaims, 'iat' | 'exp' | 'jti' | 'csrf'>,
  ttlSeconds = 3600
): { token: string; claims: JwtClaims } {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    ...payload,
    jti: `jti_${crypto.randomBytes(16).toString('hex')}`,
    csrf: `csrf_${crypto.randomBytes(24).toString('hex')}`,
    iat: now,
    exp: now + ttlSeconds,
  };

  const header = { alg: EXPECTED_JWT_ALGORITHM, typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', JWT_SECRET_KEY)
    .update(signingInput)
    .digest();

  return {
    token: `${signingInput}.${base64UrlEncode(signature)}`,
    claims,
  };
}

/**
 * Verifies a JWT:
 * - Explicitly rejects 'none' algorithm
 * - Hardcodes expected algorithm ('HS256'), never deriving algorithm from unverified header
 * - Validates 'exp' claim and checks token revocation
 */
export function verifyJwt(
  token: string,
  isRevokedFn: (jti: string) => boolean
): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const headerJson = JSON.parse(base64UrlDecode(encodedHeader).toString('utf-8'));

    // Reject 'none' algorithm or any mismatch with hardcoded expected algorithm
    if (
      !headerJson ||
      typeof headerJson.alg !== 'string' ||
      headerJson.alg.toLowerCase() === 'none' ||
      headerJson.alg !== EXPECTED_JWT_ALGORITHM
    ) {
      return null;
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET_KEY)
      .update(signingInput)
      .digest();
    const actualSig = base64UrlDecode(encodedSignature);

    if (
      expectedSig.length !== actualSig.length ||
      !crypto.timingSafeEqual(expectedSig, actualSig)
    ) {
      return null;
    }

    const claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf-8')) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.exp || typeof claims.exp !== 'number' || claims.exp <= now) {
      return null;
    }

    if (!claims.jti || isRevokedFn(claims.jti)) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}

/**
 * Memory-hard password hashing using scrypt (N=16384, r=8, p=1) with unique 16-byte per-user salt.
 * TODO(security): Consider integrating OAuth 2.0 / OIDC identity providers.
 * TODO(security): Consider adding WebAuthn / TOTP Multi-Factor Authentication (MFA).
 * TODO(security): Consider hardening password validation with HaveIBeenPwned leaked password detection.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return `scrypt$16384$8$1$${salt}$${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const salt = parts[4];
    const expectedHex = parts[5];
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return (
      expectedBuf.length === actualBuf.length &&
      crypto.timingSafeEqual(expectedBuf, actualBuf)
    );
  } catch {
    return false;
  }
}

/**
 * Validates password strength:
 * - Minimum 8 characters (12+ recommended)
 * - Maximum 128 characters
 * - Allows all characters including special characters
 */
export function validatePasswordStrength(password: unknown): {
  valid: boolean;
  reason?: string;
} {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Password must be a string.' };
  }
  if (password.length < 8) {
    return {
      valid: false,
      reason: 'Password must be at least 8 characters long (12+ recommended).',
    };
  }
  if (password.length > 128) {
    return {
      valid: false,
      reason: 'Password must not exceed 128 characters.',
    };
  }
  return { valid: true };
}

/**
 * PII Masking helper for emails (e.g. "alice@example.com" -> "a***e@example.com").
 */
export function maskEmail(email: string): string {
  const parts = email.trim().split('@');
  if (parts.length !== 2) return '***@***';
  const [local, domain] = parts;
  if (local.length <= 2) {
    return `${local[0] ?? '*'}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

export function hashEmail(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

/**
 * Parses cookies from the Cookie request header safely.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

/**
 * Builds hardened Set-Cookie header string using __Host- prefix on HTTPS
 * (or chat_session on local 127.0.0.1 HTTP test runner so browser testing works).
 */
export function buildSessionCookieHeader(
  req: Request,
  token: string,
  maxAgeSeconds = 3600
): string {
  const isSecure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';

  const cookieName = isSecure ? '__Host-chat_session' : 'chat_session';
  const attributes = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

export function buildClearSessionCookieHeader(req: Request): string {
  return buildSessionCookieHeader(req, '', 0);
}

/**
 * Sliding-window in-memory rate limiter per IP / user.
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(maxRequestsPerMinute = 240) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const key = `${clientIp}:${req.path.startsWith('/v1/auth') ? 'auth' : 'api'}`;
    const limit = req.path.startsWith('/v1/auth') ? 60 : maxRequestsPerMinute;
    const now = Date.now();

    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.status(429).json({
        error: 'Too many requests. Please retry after a short delay.',
      });
      return;
    }
    next();
  };
}

/**
 * Enforces HTTP Method Allow-List, Strict CSP with Nonce, Clickjacking Guards,
 * Permissions-Policy, Cache-Control: no-store, and strict CORS.
 */
export function securityHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const allowedMethods = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);
  if (!allowedMethods.has(req.method.toUpperCase())) {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: https:",
      "connect-src 'self' wss: ws: https:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  // Strict CORS allow-list (never wildcard *)
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && (origin === `https://${host}` || origin === `http://${host}`)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
