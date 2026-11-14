/**
 * apiUtil.js  (CommonJS build)
 *
 * Small helpers shared by the dashboard API:
 *   HttpError   - throw new HttpError(404, "Chat not found.") anywhere in a
 *                 route; the API's error handler turns it into a clean JSON reply.
 *   wrap(fn)    - lets async route handlers throw without crashing the app.
 *   clean*()    - validate / tidy values that come from the browser.
 */

const crypto = require("crypto");

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

/** Wrap an async route handler so thrown errors reach the error handler. */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 190) return null;
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email) ? email : null;
}

function cleanName(value, max = 100) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  return name && name.length <= max ? name : null;
}

/**
 * Optional free text. undefined -> undefined (field not sent),
 * "" / null -> null (clear it), too long -> 400.
 */
function cleanText(value, max) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (text.length > max) {
    throw new HttpError(400, `Text is too long (max ${max} characters).`, "TOO_LONG");
  }
  return text === "" ? null : text;
}

/** WhatsApp numbers are digits only (no +, spaces or dashes). */
function parsePhone(value, status = 404) {
  const text = String(value ?? "");
  if (!/^\d{5,20}$/.test(text)) {
    throw new HttpError(status, "Chat not found.", "NOT_FOUND");
  }
  return text;
}

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Search text for LIKE: drop the wildcard characters so users can't craft patterns. */
function searchTerm(value) {
  return String(value ?? "")
    .replace(/[%_\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Constant-time string comparison (for tokens). */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  HttpError,
  wrap,
  cleanEmail,
  cleanName,
  cleanText,
  parsePhone,
  intParam,
  searchTerm,
  clip,
  sha256,
  safeEqual,
};
