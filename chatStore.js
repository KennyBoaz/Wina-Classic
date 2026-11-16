/**
 * chatStore.js  (CommonJS build)
 *
 * Everything the app writes about a CHAT (as opposed to what Gemini
 * remembers, which lives in memory.js):
 *
 *   recordIncoming()      save a customer's message, update the chat summary
 *   recordOutgoing()      save a message we sent (bot now, staff in Phase 2)
 *   recordStaffEcho()     save a message the shop sent from the WhatsApp
 *                         Business app on the phone (Coexistence), and put the
 *                         chat in human mode
 *   applyStatusUpdate()   sent / delivered / read / failed ticks from Meta
 *   getConversation()     the chat's current mode/status row
 *   markEscalated()       flag a chat as needing a human
 *
 * The dashboard (Phase 2+) reads the same tables.
 */

const db = require("./db.js");

const PREVIEW_LENGTH = 200;
const STATUS_ORDER = ["pending", "sent", "delivered", "read", "failed"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-line, trimmed text for the chat list ("last message" preview). */
function makePreview(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_LENGTH
    ? `${clean.slice(0, PREVIEW_LENGTH - 1)}…`
    : clean;
}

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * WhatsApp sends message times as unix seconds. We store that moment (it is
 * what Meta uses for the 24-hour reply window). Never store a future time.
 */
function fromWhatsAppTimestamp(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  const date = new Date(seconds * 1000);
  return date.getTime() > Date.now() ? new Date() : date;
}

/**
 * Make sure the customer and their conversation rows exist.
 * Safe to call as often as you like.
 */
async function ensureCustomer(phone, whatsappName) {
  await db.run(
    `INSERT INTO customers (phone, whatsapp_name, created_at)
     VALUES (?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE whatsapp_name = COALESCE(VALUES(whatsapp_name), whatsapp_name)`,
    [phone, clip(whatsappName, 150)]
  );
  await db.run(
    `INSERT INTO conversations (phone, created_at)
     VALUES (?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE phone = phone`,
    [phone]
  );
}

async function getConversation(phone) {
  return db.one("SELECT * FROM conversations WHERE phone = ?", [phone]);
}

/**
 * Save a customer's message.
 * Returns { duplicate: true } if we already stored this WhatsApp message id
 * (Meta sometimes delivers the same webhook twice, and this check survives
 * server restarts, unlike the in-memory Set in server.js).
 * Otherwise returns { duplicate: false, conversation, messageId }.
 */
async function recordIncoming({ id, from, name, type, text, timestamp, replyTo }) {
  await ensureCustomer(from, name);

  const createdAt = fromWhatsAppTimestamp(timestamp);
  const body = text || "";

  let insert;
  try {
    insert = await db.run(
      `INSERT INTO messages
         (phone, direction, sender_type, msg_type, body, wa_message_id, reply_to_wa_id, created_at)
       VALUES (?, 'in', 'customer', ?, ?, ?, ?, ?)`,
      [from, clip(type, 20) || "text", body, clip(id, 128), clip(replyTo, 128), createdAt]
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw err;
  }

  await db.run(
    `UPDATE conversations
        SET last_customer_message_at = ?,
            last_message_at = ?,
            last_message_preview = ?,
            unread_count = unread_count + 1
      WHERE phone = ?`,
    [createdAt, createdAt, makePreview(body), from]
  );

  // A customer writing again re-opens a chat that had been marked resolved.
  await db.run(
    `UPDATE conversations
        SET status = 'open', resolved_at = NULL, resolved_by = NULL
      WHERE phone = ? AND status = 'resolved'`,
    [from]
  );

  const conversation = await getConversation(from);
  return { duplicate: false, conversation, messageId: insert.insertId };
}

/**
 * Save a message WE sent to the customer.
 * senderType: 'bot' or 'staff'. status: 'sent' or 'failed'.
 */
async function recordOutgoing({
  phone,
  body,
  senderType = "bot",
  staffId = null,
  waMessageId = null,
  status = "sent",
  error = null,
  replyToWaId = null,
}) {
  await ensureCustomer(phone, null);

  const insert = await db.run(
    `INSERT INTO messages
       (phone, direction, sender_type, staff_id, msg_type, body,
        wa_message_id, delivery_status, error_text, reply_to_wa_id, created_at)
     VALUES (?, 'out', ?, ?, 'text', ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [
      phone,
      senderType,
      staffId,
      body || "",
      clip(waMessageId, 128),
      status,
      clip(error, 500),
      clip(replyToWaId, 128),
    ]
  );

  await db.run(
    `UPDATE conversations
        SET last_message_at = UTC_TIMESTAMP(3), last_message_preview = ?
      WHERE phone = ?`,
    [makePreview(body), phone]
  );

  return insert.insertId;
}

/**
 * A message the shop sent from the WhatsApp Business APP on the phone (a
 * Coexistence "echo"). Saved as a staff message, and the chat switches to
 * human mode so the bot does not talk over the person who just answered.
 * Returns { duplicate: true } if this message id is already stored (for
 * example a message the bot itself sent); nothing is changed in that case.
 */
async function recordStaffEcho({ phone, body, waMessageId, timestamp, msgType = "text" }) {
  await ensureCustomer(phone, null);

  const createdAt = fromWhatsAppTimestamp(timestamp);
  try {
    await db.run(
      `INSERT INTO messages
         (phone, direction, sender_type, msg_type, body, wa_message_id, delivery_status, created_at)
       VALUES (?, 'out', 'staff', ?, ?, ?, 'sent', ?)`,
      [phone, clip(msgType, 20) || "text", body || "", clip(waMessageId, 128), createdAt]
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw err;
  }

  await db.run(
    `UPDATE conversations
        SET last_message_at = ?, last_message_preview = ?
      WHERE phone = ? AND (last_message_at IS NULL OR last_message_at <= ?)`,
    [createdAt, makePreview(body), phone, createdAt]
  );

  await db.run(
    `UPDATE conversations
        SET mode = 'human', human_since = UTC_TIMESTAMP(3)
      WHERE phone = ? AND mode = 'bot'`,
    [phone]
  );

  return { duplicate: false };
}

/**
 * Apply a delivery receipt from Meta (sent / delivered / read / failed).
 * Ticks only move forward (a late "delivered" never overwrites "read").
 * Meta can send the receipt a moment before our own insert finishes, so if
 * we cannot find the message yet we wait briefly and look again.
 */
async function applyStatusUpdate({ id, status, errorText }) {
  if (!id || !STATUS_ORDER.includes(status)) return false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const row = await db.one(
      "SELECT id FROM messages WHERE wa_message_id = ? AND direction = 'out' LIMIT 1",
      [id]
    );

    if (row) {
      await db.run(
        `UPDATE messages
            SET delivery_status = ?, error_text = ?
          WHERE id = ?
            AND (delivery_status IS NULL
                 OR FIELD(delivery_status, 'pending','sent','delivered','read','failed')
                    < FIELD(?, 'pending','sent','delivered','read','failed'))`,
        [status, status === "failed" ? clip(errorText, 500) : null, row.id, status]
      );
      return true;
    }

    await sleep(1000);
  }

  return false;
}

/**
 * Flag a chat as needing a human. If pauseBot is true the bot also stops
 * answering that customer until staff hand the chat back.
 */
async function markEscalated(phone, { pauseBot = false } = {}) {
  await ensureCustomer(phone, null);

  await db.run(
    `UPDATE conversations
        SET status = 'escalated', escalated_at = UTC_TIMESTAMP(3)
      WHERE phone = ? AND status <> 'escalated'`,
    [phone]
  );

  if (pauseBot) {
    await db.run(
      `UPDATE conversations
          SET mode = 'human', human_since = UTC_TIMESTAMP(3)
        WHERE phone = ? AND mode = 'bot'`,
      [phone]
    );
  }
}

/** A customer reacted with an emoji to one of our messages (emoji "" = they removed it). */
async function setCustomerReaction(waMessageId, emoji) {
  if (!waMessageId) return;
  await db.run("UPDATE messages SET customer_reaction = ? WHERE wa_message_id = ?", [
    emoji ? clip(emoji, 16) : null,
    waMessageId,
  ]);
}

module.exports = {
  setCustomerReaction,
  ensureCustomer,
  getConversation,
  recordIncoming,
  recordOutgoing,
  recordStaffEcho,
  applyStatusUpdate,
  markEscalated,
  makePreview,
};