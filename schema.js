/**
 * schema.js  (CommonJS build)
 *
 * Keeps the database up to date by itself. When the app starts it checks that every
 * table and column the newest code needs exists, and adds the missing ones. This means a
 * forgotten (or half-finished) phpMyAdmin upgrade can no longer break the dashboard.
 *
 * It only ADDS things (never deletes or changes data), and the names below are fixed in
 * the code. It needs the database user to be allowed to ALTER tables (the cPanel
 * "Database Wizard" with ALL PRIVILEGES does).
 */

const db = require("./db.js");

// Tables added in later phases (CREATE ... IF NOT EXISTS is harmless if they already exist).
const TABLES = [
  `CREATE TABLE IF NOT EXISTS staff_sessions (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
     token_hash    CHAR(64) NOT NULL,
     staff_id      INT UNSIGNED NOT NULL,
     csrf_token    VARCHAR(64) NOT NULL,
     ip            VARCHAR(64) NULL,
     user_agent    VARCHAR(255) NULL,
     created_at    DATETIME(3) NOT NULL,
     last_seen_at  DATETIME(3) NOT NULL,
     expires_at    DATETIME(3) NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_sess_token (token_hash),
     KEY idx_sess_staff (staff_id),
     CONSTRAINT fk_sess_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS products (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
     name        VARCHAR(190) NOT NULL,
     brand       VARCHAR(100) NULL,
     category    VARCHAR(60) NULL,
     price_ugx   BIGINT UNSIGNED NULL,
     stock       ENUM('in_stock','low','out') NOT NULL DEFAULT 'in_stock',
     details     VARCHAR(500) NULL,
     active      TINYINT(1) NOT NULL DEFAULT 1,
     created_at  DATETIME(3) NOT NULL,
     updated_at  DATETIME(3) NOT NULL,
     PRIMARY KEY (id),
     KEY idx_prod_active (active, category),
     KEY idx_prod_name (name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // The shop's real WhatsApp number, connected through Embedded Signup
  // (Coexistence). One row only (id = 1). Holds the access token.
  `CREATE TABLE IF NOT EXISTS whatsapp_connection (
     id               TINYINT UNSIGNED NOT NULL,
     waba_id          VARCHAR(40) NOT NULL,
     phone_number_id  VARCHAR(40) NOT NULL,
     display_phone    VARCHAR(40) NULL,
     verified_name    VARCHAR(190) NULL,
     access_token     TEXT NOT NULL,
     token_expires_at DATETIME(3) NULL,
     mode             VARCHAR(20) NOT NULL DEFAULT 'coexistence',
     connected_by     INT UNSIGNED NULL,
     connected_at     DATETIME(3) NOT NULL,
     updated_at       DATETIME(3) NOT NULL,
     PRIMARY KEY (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Raw coexistence webhook payloads (chat history, contacts, staff replies
  // from the phone). History arrives only once, so it is stored untouched
  // first and imported into the chat tables afterwards.
  `CREATE TABLE IF NOT EXISTS wa_raw_events (
     id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     field        VARCHAR(40) NOT NULL,
     payload      MEDIUMTEXT NOT NULL,
     received_at  DATETIME(3) NOT NULL,
     processed_at DATETIME(3) NULL,
     PRIMARY KEY (id),
     KEY idx_raw_field (field, processed_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Columns added in later phases: [table, column, definition]
const COLUMNS = [
  ["messages", "reply_to_wa_id", "VARCHAR(128) NULL"],
  ["messages", "starred", "TINYINT(1) NOT NULL DEFAULT 0"],
  ["messages", "reaction", "VARCHAR(16) NULL"],
  ["messages", "customer_reaction", "VARCHAR(16) NULL"],
  ["conversations", "pinned", "TINYINT(1) NOT NULL DEFAULT 0"],
];

/** Returns the list of things it had to add, e.g. ["conversations.pinned"]. */
async function ensureSchema() {
  const added = [];

  for (const sql of TABLES) await db.run(sql);

  for (const [table, column, definition] of COLUMNS) {
    const found = await db.all(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (found.length === 0) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      added.push(`${table}.${column}`);
    }
  }
  return added;
}

module.exports = { ensureSchema };