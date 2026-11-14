/**
 * routes/authRoutes.js
 *
 *   POST /api/auth/login            { email, password }
 *   GET  /api/auth/me               who am I (and the CSRF token to send back)
 *   POST /api/auth/logout
 *   POST /api/auth/change-password  { currentPassword, newPassword }
 */

const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const { HttpError, wrap, cleanEmail } = require("../apiUtil.js");

const router = express.Router();

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

router.post(
  "/login",
  wrap(async (req, res) => {
    if (!auth.allowAttempt(`login:${auth.clientIp(req)}`, 30, 15 * 60 * 1000)) {
      throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", "RATE_LIMITED");
    }

    const email = cleanEmail(req.body && req.body.email);
    const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) {
      throw new HttpError(400, "Enter your email and password.", "BAD_REQUEST");
    }

    const user = await db.one(
      `SELECT id, name, email, password_hash, role, active, failed_logins, locked_until
         FROM staff_users WHERE email = ?`,
      [email]
    );

    const now = new Date();
    if (user && user.locked_until && new Date(user.locked_until) > now) {
      throw new HttpError(
        429,
        "Too many failed attempts. This account is locked for a few minutes.",
        "LOCKED"
      );
    }

    let valid = false;
    if (user && user.active) {
      valid = await auth.verifyPassword(password, user.password_hash);
    } else {
      await auth.burnTime(password);
    }

    if (!valid) {
      if (user) {
        const fails = (Number(user.failed_logins) || 0) + 1;
        const lock = fails >= auth.LOGIN_MAX_FAILS;
        await db.run(
          "UPDATE staff_users SET failed_logins = ?, locked_until = ? WHERE id = ?",
          [lock ? 0 : fails, lock ? new Date(now.getTime() + auth.LOCK_MS) : null, user.id]
        );
      }
      throw new HttpError(401, "Invalid email or password.", "BAD_LOGIN");
    }

    await db.run(
      "UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
      [now, user.id]
    );

    const session = await auth.createSession(user.id, req);
    auth.setSessionCookie(res, session.token, session.maxAgeSeconds);
    res.json({ user: publicUser(user), csrfToken: session.csrf });
  })
);

router.get(
  "/me",
  wrap(async (req, res) => {
    const session = await auth.loadSession(req);
    if (!session) throw new HttpError(401, "Please log in.", "UNAUTHENTICATED");
    res.json({ user: session.staff, csrfToken: session.csrf });
  })
);

router.post(
  "/logout",
  auth.requireAuth,
  wrap(async (req, res) => {
    await auth.destroySession(req.sessionId);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  })
);

router.post(
  "/change-password",
  auth.requireAuth,
  wrap(async (req, res) => {
    const current = req.body && typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const next = req.body && typeof req.body.newPassword === "string" ? req.body.newPassword : "";

    const user = await db.one("SELECT id, email, password_hash FROM staff_users WHERE id = ?", [
      req.staff.id,
    ]);
    if (!user || !(await auth.verifyPassword(current, user.password_hash))) {
      throw new HttpError(400, "Your current password is not correct.", "BAD_PASSWORD");
    }

    const problem = auth.checkPasswordRules(next, user.email);
    if (problem) throw new HttpError(400, problem, "WEAK_PASSWORD");

    await db.run("UPDATE staff_users SET password_hash = ? WHERE id = ?", [
      await auth.hashPassword(next),
      user.id,
    ]);
    // Sign out everywhere else; keep this browser logged in.
    await auth.destroyAllSessions(user.id, req.sessionId);
    res.json({ ok: true });
  })
);

module.exports = router;
