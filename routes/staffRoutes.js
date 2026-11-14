/**
 * routes/staffRoutes.js
 *
 * ONE-TIME SETUP (public, but only works while there are NO staff accounts
 * and SETUP_TOKEN is set in .env):
 *   GET  /api/setup/status     { needed, enabled }
 *   POST /api/setup            { token, name, email, password }  -> creates the first admin
 *
 * STAFF MANAGEMENT (admin only):
 *   GET   /api/staff
 *   POST  /api/staff           { name, email, password, role }
 *   PATCH /api/staff/:id       { name?, role?, active?, password? }
 */

const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const {
  HttpError,
  wrap,
  cleanEmail,
  cleanName,
  safeEqual,
} = require("../apiUtil.js");

// ---------------------------------------------------------------------------
// First-time setup
// ---------------------------------------------------------------------------

const setupRouter = express.Router();

async function staffCount() {
  const row = await db.one("SELECT COUNT(*) AS n FROM staff_users");
  return Number(row.n) || 0;
}

setupRouter.get(
  "/status",
  wrap(async (_req, res) => {
    res.json({
      needed: (await staffCount()) === 0,
      enabled: Boolean(process.env.SETUP_TOKEN),
    });
  })
);

setupRouter.post(
  "/",
  wrap(async (req, res) => {
    if (!auth.allowAttempt(`setup:${auth.clientIp(req)}`, 10, 15 * 60 * 1000)) {
      throw new HttpError(429, "Too many attempts. Please wait a few minutes.", "RATE_LIMITED");
    }
    if (!process.env.SETUP_TOKEN) {
      throw new HttpError(404, "Setup is not enabled. Add SETUP_TOKEN to .env first.", "SETUP_DISABLED");
    }
    if ((await staffCount()) > 0) {
      throw new HttpError(403, "Setup has already been completed.", "SETUP_DONE");
    }

    const body = req.body || {};
    if (!safeEqual(body.token, process.env.SETUP_TOKEN)) {
      throw new HttpError(403, "The setup token is not correct.", "BAD_TOKEN");
    }

    const name = cleanName(body.name);
    const email = cleanEmail(body.email);
    if (!name) throw new HttpError(400, "Enter a name.", "BAD_NAME");
    if (!email) throw new HttpError(400, "Enter a valid email address.", "BAD_EMAIL");
    const problem = auth.checkPasswordRules(body.password, email);
    if (problem) throw new HttpError(400, problem, "WEAK_PASSWORD");

    await db.run(
      `INSERT INTO staff_users (name, email, password_hash, role, active, created_at)
       VALUES (?, ?, ?, 'admin', 1, UTC_TIMESTAMP(3))`,
      [name, email, await auth.hashPassword(body.password)]
    );

    res.status(201).json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Staff management (admin only)
// ---------------------------------------------------------------------------

const staffRouter = express.Router();
staffRouter.use(auth.requireAdmin);

const STAFF_COLUMNS = "id, name, email, role, active, last_login_at, created_at";

staffRouter.get(
  "/",
  wrap(async (_req, res) => {
    const staff = await db.all(`SELECT ${STAFF_COLUMNS} FROM staff_users ORDER BY name`);
    res.json({ staff: staff.map((row) => ({ ...row, active: Boolean(row.active) })) });
  })
);

staffRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = req.body || {};
    const name = cleanName(body.name);
    const email = cleanEmail(body.email);
    const role = body.role === "admin" ? "admin" : "staff";

    if (!name) throw new HttpError(400, "Enter a name.", "BAD_NAME");
    if (!email) throw new HttpError(400, "Enter a valid email address.", "BAD_EMAIL");
    const problem = auth.checkPasswordRules(body.password, email);
    if (problem) throw new HttpError(400, problem, "WEAK_PASSWORD");

    let insert;
    try {
      insert = await db.run(
        `INSERT INTO staff_users (name, email, password_hash, role, active, created_at)
         VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP(3))`,
        [name, email, await auth.hashPassword(body.password), role]
      );
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        throw new HttpError(409, "A staff member with that email already exists.", "EMAIL_TAKEN");
      }
      throw err;
    }

    const created = await db.one(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE id = ?`, [
      insert.insertId,
    ]);
    res.status(201).json({ staff: { ...created, active: Boolean(created.active) } });
  })
);

staffRouter.patch(
  "/:id",
  wrap(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const target = Number.isFinite(id)
      ? await db.one(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE id = ?`, [id])
      : null;
    if (!target) throw new HttpError(404, "Staff member not found.", "NOT_FOUND");

    const body = req.body || {};
    const isSelf = target.id === req.staff.id;
    const sets = [];
    const params = [];

    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, "Enter a name.", "BAD_NAME");
      sets.push("name = ?");
      params.push(name);
    }

    if (body.role !== undefined) {
      if (!["admin", "staff"].includes(body.role)) {
        throw new HttpError(400, "Role must be admin or staff.", "BAD_ROLE");
      }
      if (isSelf && body.role !== target.role) {
        throw new HttpError(400, "You can't change your own role.", "SELF_CHANGE");
      }
      sets.push("role = ?");
      params.push(body.role);
    }

    let endSessions = false;

    if (body.active !== undefined) {
      const active = Boolean(body.active);
      if (isSelf && !active) {
        throw new HttpError(400, "You can't deactivate your own account.", "SELF_CHANGE");
      }
      sets.push("active = ?");
      params.push(active ? 1 : 0);
      if (!active) endSessions = true;
    }

    if (body.password !== undefined) {
      const problem = auth.checkPasswordRules(body.password, target.email);
      if (problem) throw new HttpError(400, problem, "WEAK_PASSWORD");
      sets.push("password_hash = ?", "failed_logins = 0", "locked_until = NULL");
      params.push(await auth.hashPassword(body.password));
      endSessions = true;
    }

    if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

    params.push(target.id);
    await db.run(`UPDATE staff_users SET ${sets.join(", ")} WHERE id = ?`, params);

    // Disabled accounts and reset passwords are signed out immediately.
    if (endSessions) await auth.destroyAllSessions(target.id);

    const updated = await db.one(`SELECT ${STAFF_COLUMNS} FROM staff_users WHERE id = ?`, [target.id]);
    res.json({ staff: { ...updated, active: Boolean(updated.active) } });
  })
);

module.exports = { setupRouter, staffRouter };
