import crypto from 'crypto';

export const SESSION_COOKIE_NAME = 'painel_session';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX_ATTEMPTS = 12;

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function sha256Buffer(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

export function timingSafeStringEqual(a, b) {
  const bufA = sha256Buffer(a);
  const bufB = sha256Buffer(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createAuthHelper({
  appPassword = process.env.APP_PASSWORD || '',
  sessionSecret = process.env.SESSION_SECRET || '',
  isVercel = Boolean(process.env.VERCEL),
  allowPublicAccess = String(process.env.ALLOW_PUBLIC_ACCESS || '').toLowerCase() === 'true',
  sessionTtlMs = DEFAULT_SESSION_TTL_MS
} = {}) {
  const cleanPassword = String(appPassword || '').trim();
  const misconfigured = (isVercel && !cleanPassword && !allowPublicAccess)
    ? 'Acesso bloqueado por segurança: defina a variável de ambiente APP_PASSWORD na Vercel para proteger seu painel pessoal.'
    : null;
  const authRequired = Boolean(cleanPassword || misconfigured);

  const hmacKey = crypto
    .createHash('sha256')
    .update(String(sessionSecret || '').trim() || `painel-estudos-session-v1:${cleanPassword}`)
    .digest();

  const failedLoginsByIp = new Map();

  function signToken(payloadObj) {
    const encoded = Buffer.from(JSON.stringify(payloadObj), 'utf-8').toString('base64url');
    const sig = crypto.createHmac('sha256', hmacKey).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
  }

  function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0) return false;
    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    if (!encoded || !sig) return false;

    const expectedSig = crypto.createHmac('sha256', hmacKey).update(encoded).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return false;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
      if (!payload || typeof payload.exp !== 'number') return false;
      return Date.now() < payload.exp;
    } catch {
      return false;
    }
  }

  function isSecureRequest(req) {
    if (isVercel) return true;
    if (req && req.secure) return true;
    const proto = req && req.headers && req.headers['x-forwarded-proto'];
    return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
  }

  function getClientIp(req) {
    const forwarded = req && req.headers && req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    return (req && req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function checkRateLimit(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    const rec = failedLoginsByIp.get(ip);
    if (!rec) return { blocked: false };
    if (now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
      failedLoginsByIp.delete(ip);
      return { blocked: false };
    }
    if (rec.count >= RATE_LIMIT_MAX_ATTEMPTS) {
      const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - rec.windowStart)) / 1000);
      return { blocked: true, retryAfterSec };
    }
    return { blocked: false };
  }

  function recordFailedAttempt(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    const rec = failedLoginsByIp.get(ip);
    if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
      failedLoginsByIp.set(ip, { count: 1, windowStart: now });
    } else {
      rec.count += 1;
    }
  }

  function clearFailedAttempts(req) {
    failedLoginsByIp.delete(getClientIp(req));
  }

  function isAuthenticated(req) {
    if (misconfigured) return false;
    if (!authRequired) return true;
    const cookies = parseCookies(req && req.headers && req.headers.cookie);
    return verifyToken(cookies[SESSION_COOKIE_NAME]);
  }

  function getStatus(req) {
    return {
      authRequired,
      authenticated: isAuthenticated(req),
      ...(misconfigured ? { misconfigured } : {})
    };
  }

  function verifyPassword(candidate) {
    if (!cleanPassword || typeof candidate !== 'string') return false;
    return timingSafeStringEqual(candidate.trim(), cleanPassword);
  }

  function issueSessionCookie(req, res) {
    const token = signToken({ v: 1, exp: Date.now() + sessionTtlMs });
    const maxAgeSec = Math.floor(sessionTtlMs / 1000);
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`
    ];
    if (isSecureRequest(req)) {
      parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(req, res) {
    const parts = [
      `${SESSION_COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0'
    ];
    if (isSecureRequest(req)) {
      parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function requireAuthMiddleware(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next();
    if (misconfigured) {
      return res.status(503).json({
        ok: false,
        authRequired: true,
        misconfigured,
        error: misconfigured
      });
    }
    if (authRequired && !isAuthenticated(req)) {
      return res.status(401).json({
        ok: false,
        authRequired: true,
        error: 'Sessão expirada ou não autenticada. Faça login com sua senha pessoal.'
      });
    }
    return next();
  }

  return {
    authRequired,
    misconfigured,
    getStatus,
    isAuthenticated,
    verifyPassword,
    issueSessionCookie,
    clearSessionCookie,
    checkRateLimit,
    recordFailedAttempt,
    clearFailedAttempts,
    requireAuthMiddleware
  };
}
