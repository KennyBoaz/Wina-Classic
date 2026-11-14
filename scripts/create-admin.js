/**
 * scripts/create-admin.js
 *
 * Creates an admin account, or resets the password of an existing one.
 * Use it if you cannot (or no longer can) use the browser setup page.
 *
 *   node scripts/create-admin.js "Full Name" you@example.com "a-long-password"
 *
 * On cPanel without a terminal: temporarily add these lines to .env, then run
 * the "create-admin" script from the Node.js App page ("Run JS script"), then
 * DELETE the ADMIN_PASSWORD line again:
 *   ADMIN_NAME=Full Name
 *   ADMIN_EMAIL=you@example.com
 *   ADMIN_PASSWORD="a-long-password"
 */

require("dotenv").config();
const db = require("../db.js");
const { hashPassword, checkPasswordRules } = require("../auth.js");
const { cleanEmail, cleanName } = require("../apiUtil.js");

async function main() {
  const [, , argName, argEmail, argPassword] = process.argv;
  const name = cleanName(argName || process.env.ADMIN_NAME);
  const email = cleanEmail(argEmail || process.env.ADMIN_EMAIL);
  const password = argPassword || process.env.ADMIN_PASSWORD;

  if (!name || !email || !password) {
    console.error('Usage: node scripts/create-admin.js "Full Name" email password');
    console.error("(or set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD in .env)");
    process.exitCode = 1;
    return;
  }

  const problem = checkPasswordRules(password, email);
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  const existing = await db.one("SELECT id FROM staff_users WHERE email = ?", [email]);

  if (existing) {
    await db.run(
      `UPDATE staff_users
          SET name = ?, password_hash = ?, role = 'admin', active = 1,
              failed_logins = 0, locked_until = NULL
        WHERE id = ?`,
      [name, hash, existing.id]
    );
    await db.run("DELETE FROM staff_sessions WHERE staff_id = ?", [existing.id]);
    console.log(`Updated existing account ${email}: password reset, role admin, active.`);
  } else {
    await db.run(
      `INSERT INTO staff_users (name, email, password_hash, role, active, created_at)
       VALUES (?, ?, ?, 'admin', 1, UTC_TIMESTAMP(3))`,
      [name, email, hash]
    );
    console.log(`Created admin account ${email}.`);
  }
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.getPool().end();
    } catch {
      // ignore
    }
  });
