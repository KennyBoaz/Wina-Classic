/**
 * auth.js  (CommonJS build)
 *
 * Staff login for the dashboard. No extra npm packages are needed:
 *
 *  - Passwords are hashed with scrypt (built into Node, memory-hard, the same
 *    family of algorithm as bcrypt/argon2). Only the hash is stored.
 *  - Logging in creates a random session token. The browser keeps it in an
 *    HttpOnly cookie (JavaScript on the page can't read it); the database
 *    keeps only its SHA-256 hash.
 *  - Every request that CHANGES something must also carry the session's CSRF
 *    token in an X-CSRF-Token header and be JSON. That stops other websites
 *    from making a logged-in staff member's browser do things.
 *  - Disabling a staff member or resetting a password ends their sessions at once.
 *
 * .env:
 *   COOKIE_SECURE   "true" (default) = cookie only sent over https.
 *                   Set "false" only if you test over plain http.
 */

const crypto = require("crypto");
const db = require("./db.js");
const { HttpError, wrap, clip, sha256, safeEqual } = require("./apiUtil.js");

const COOKIE_NAME = "wc_session";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // logged out after 12h of no use
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000; // and always after 7 days
const TOUCH_AFTER_MS = 5 * 60 * 1000; // extend the session at most every 5 min

const LOGIN_MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// scrypt cost settings (stored inside every hash, so they can be raised later)
const SCRYPT = { N: 16384, r: 8, p: 5 };
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function scryptAsync(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt, KEY_LENGTH, {
    ...SCRYPT,
    maxmem: MAX_MEM,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(
    String(password),
    Buffer.from(saltB64, "base64"),
    expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: MAX_MEM }
  );
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Used so "unknown email" takes as long as "wrong password" (no user guessing).
let dummyHashPromise = null;
async function burnTime(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("not-a-real-password");
  await verifyPassword(password, await dummyHashPromise);
}

/** Returns an error message, or null if the password is acceptable. */
function checkPasswordRules(password, email) {
  const text = String(password ?? "");
  if (text.length < 10) return "Password must be at least 10 characters.";
  if (text.length > 200) return "Password is too long.";
  if (email && text.toLowerCase() === String(email).toLowerCase()) {
    return "Password can't be the same as the email address.";
  }
  if (/^(.)\1+$/.test(text)) return "Choose a less repetitive password.";
  return null;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieSecure() {
  return String(process.env.COOKIE_SECURE ?? "true").toLowerCase() !== "false";
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookieSecure()) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  setSessionCookie(res, "", 0);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

async function createSession(staffId, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_IDLE_MS);

  await db.run(
    `INSERT INTO staff_sessions
       (token_hash, staff_id, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sha256(token),
      staffId,
      csrf,
      clip(clientIp(req), 64),
      clip(req.headers["user-agent"], 255),
      now,
      now,
      expires,
    ]
  );

  // Tidy up sessions that expired a while ago.
  await db.run("DELETE FROM staff_sessions WHERE expires_at < ?", [now]);

  return { token, csrf, maxAgeSeconds: Math.floor(SESSION_IDLE_MS / 1000) };
}

async function destroySession(sessionId) {
  await db.run("DELETE FROM staff_sessions WHERE id = ?", [sessionId]);
}

/** End every session of a staff member (optionally keeping one). */
async function destroyAllSessions(staffId, exceptSessionId = null) {
  if (exceptSessionId) {
    await db.run("DELETE FROM staff_sessions WHERE staff_id = ? AND id <> ?", [
      staffId,
      exceptSessionId,
    ]);
  } else {
    await db.run("DELETE FROM staff_sessions WHERE staff_id = ?", [staffId]);
  }
}

/**
 * Look up the logged-in staff member from the request's cookie.
 * Returns { staff, csrf, sessionId } or null.
 */
async function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;

  const now = new Date();
  const row = await db.one(
    `SELECT s.id AS session_id, s.staff_id, s.csrf_token, s.created_at, s.last_seen_at,
            u.name, u.email, u.role, u.active
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.staff_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), now]
  );

  if (!row || !row.active) return null;

  if (now.getTime() - new Date(row.created_at).getTime() > SESSION_MAX_MS) {
    await destroySession(row.session_id);
    return null;
  }

  if (now.getTime() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    await db.run(
      "UPDATE staff_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
      [now, new Date(now.getTime() + SESSION_IDLE_MS), row.session_id]
    );
  }

  return {
    staff: { id: row.staff_id, name: row.name, email: row.email, role: row.role },
    csrf: row.csrf_token,
    sessionId: row.session_id,
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Must be logged in. For changing requests, also checks CSRF token + JSON. */
const requireAuth = wrap(async (req, res, next) => {
  const auth = await loadSession(req);
  if (!auth) {
    throw new HttpError(401, "Please log in.", "UNAUTHENTICATED");
  }

  req.staff = auth.staff;
  req.csrf = auth.csrf;
  req.sessionId = auth.sessionId;

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!safeEqual(req.headers["x-csrf-token"], auth.csrf)) {
      throw new HttpError(
        403,
        "Security token missing or expired. Refresh the page and try again.",
        "CSRF"
      );
    }
    if (!/^application\/json/i.test(String(req.headers["content-type"] || ""))) {
      throw new HttpError(415, "Requests must be sent as JSON.", "BAD_CONTENT_TYPE");
    }
  }

  next();
});

function requireAdmin(req, res, next) {
  if (!req.staff || req.staff.role !== "admin") {
    return next(new HttpError(403, "Only an admin can do that.", "FORBIDDEN"));
  }
  next();
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per key, e.g. per IP address)
// ---------------------------------------------------------------------------

const rateBuckets = new Map();

/** Returns true if this attempt is allowed. */
function allowAttempt(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;

  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
  }

  return bucket.count <= max;
}

module.exports = {
  COOKIE_NAME,
  LOGIN_MAX_FAILS,
  LOCK_MS,
  hashPassword,
  verifyPassword,
  burnTime,
  checkPasswordRules,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  clientIp,
  createSession,
  destroySession,
  destroyAllSessions,
  loadSession,
  requireAuth,
  requireAdmin,
  allowAttempt,
};
