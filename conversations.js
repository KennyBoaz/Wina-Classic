/**
 * conversations.js  (CommonJS build)
 *
 * The "business rules" of working a chat from the dashboard. The API routes
 * stay thin and call these functions.
 *
 *   windowInfo()          is the 24-hour WhatsApp reply window still open?
 *   listMessages()        messages of a chat (for the thread view + polling)
 *   sendStaffMessage()    staff reply -> WhatsApp, saved, chat switches to human mode
 *   retryStaffMessage()   try a failed staff message again
 *   takeOver()/handBack() switch between "staff answer" and "bot answers"
 *   resolve()/reopen()    mark a chat as handled / open it again
 *
 * About the 24-hour window: WhatsApp only lets a business send free-form
 * messages within 24 hours of the customer's LAST message. After that only
 * approved "template" messages are allowed (planned for a later phase).
 */

const db = require("./db.js");
const memory = require("./memory.js");
const chatStore = require("./chatStore.js");
const { sendWhatsAppText } = require("./whatsapp.js");
const { HttpError } = require("./apiUtil.js");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_STAFF_TEXT = 4000;

const MESSAGE_COLUMNS = `m.id, m.phone, m.direction, m.sender_type, m.staff_id,
  su.name AS staff_name, m.msg_type, m.body, m.delivery_status, m.error_text, m.created_at`;

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** { open, expires_at, seconds_left } for a customer's last message time. */
function windowInfo(lastCustomerMessageAt, now = new Date()) {
  const last = toDate(lastCustomerMessageAt);
  if (!last) return { open: false, expires_at: null, seconds_left: 0 };

  const expires = new Date(last.getTime() + WINDOW_MS);
  const secondsLeft = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1000));
  return { open: secondsLeft > 0, expires_at: expires.toISOString(), seconds_left: secondsLeft };
}

async function requireConversation(phone) {
  const conversation = await chatStore.getConversation(phone);
  if (!conversation) throw new HttpError(404, "Chat not found.", "NOT_FOUND");
  return conversation;
}

// ---------------------------------------------------------------------------
// Reading messages
// ---------------------------------------------------------------------------

/**
 * Messages of a chat, oldest first.
 *   no options  -> the latest `limit` messages
 *   before: id  -> older messages (scrolling up)
 *   after: id   -> only NEWER messages (the dashboard polls with this)
 */
async function listMessages(phone, { after = null, before = null, limit = 50 } = {}) {
  const where = ["m.phone = ?"];
  const params = [phone];

  if (after) {
    where.push("m.id > ?");
    params.push(after);
  }
  if (before) {
    where.push("m.id < ?");
    params.push(before);
  }
  params.push(limit);

  const rows = await db.all(
    `SELECT ${MESSAGE_COLUMNS}
       FROM messages m
       LEFT JOIN staff_users su ON su.id = m.staff_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.id ${after ? "ASC" : "DESC"}
      LIMIT ?`,
    params
  );

  return after ? rows : rows.reverse();
}

async function getMessagesByIds(ids) {
  if (ids.length === 0) return [];
  return db.all(
    `SELECT ${MESSAGE_COLUMNS}
       FROM messages m
       LEFT JOIN staff_users su ON su.id = m.staff_id
      WHERE m.id IN (?)
      ORDER BY m.id ASC`,
    [ids]
  );
}

async function markRead(phone) {
  await db.run("UPDATE conversations SET unread_count = 0 WHERE phone = ?", [phone]);
}

// ---------------------------------------------------------------------------
// Staff replies
// ---------------------------------------------------------------------------

/**
 * Send a reply to the customer on behalf of a staff member.
 * Returns { delivered, messages, error }. The message is saved even if
 * WhatsApp refuses it (status "failed"), so staff can see it and retry.
 */
async function sendStaffMessage({ phone, text, staff }) {
  const body = String(text ?? "").trim();
  if (!body) throw new HttpError(400, "Type a message first.", "EMPTY");
  if (body.length > MAX_STAFF_TEXT) {
    throw new HttpError(400, `Message is too long (max ${MAX_STAFF_TEXT} characters).`, "TOO_LONG");
  }

  const conversation = await requireConversation(phone);
  if (!windowInfo(conversation.last_customer_message_at).open) {
    throw new HttpError(
      409,
      "The 24-hour WhatsApp reply window has closed. WhatsApp only allows free-form replies within 24 hours of the customer's last message.",
      "WINDOW_CLOSED"
    );
  }

  let results;
  try {
    results = await sendWhatsAppText(phone, body);
  } catch (err) {
    results = [{ text: body, id: null, ok: false, error: err.message }];
  }

  const ids = [];
  for (const result of results) {
    ids.push(
      await chatStore.recordOutgoing({
        phone,
        body: result.text,
        senderType: "staff",
        staffId: staff.id,
        waMessageId: result.id,
        status: result.ok ? "sent" : "failed",
        error: result.error,
      })
    );
  }

  // A staff reply means a human is handling this chat: pause the bot, assign
  // it, clear the unread badge, and re-open it if it had been resolved.
  await db.run(
    "UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3) WHERE phone = ? AND mode = 'bot'",
    [phone]
  );
  await db.run(
    "UPDATE conversations SET assigned_to = ?, unread_count = 0 WHERE phone = ?",
    [staff.id, phone]
  );
  await db.run(
    "UPDATE conversations SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE phone = ? AND status = 'resolved'",
    [phone]
  );

  const delivered = results.length > 0 && results.every((result) => result.ok);
  const failure = results.find((result) => !result.ok);

  return {
    delivered,
    messages: await getMessagesByIds(ids),
    error: delivered ? null : (failure && failure.error) || "WhatsApp did not accept the message.",
  };
}

/** Try again to send a staff message that failed. */
async function retryStaffMessage(messageId) {
  const message = await db.one("SELECT * FROM messages WHERE id = ?", [messageId]);
  if (!message || message.direction !== "out" || message.sender_type !== "staff") {
    throw new HttpError(404, "Message not found.", "NOT_FOUND");
  }
  if (message.delivery_status !== "failed") {
    throw new HttpError(409, "Only failed messages can be retried.", "NOT_FAILED");
  }

  const conversation = await requireConversation(message.phone);
  if (!windowInfo(conversation.last_customer_message_at).open) {
    throw new HttpError(
      409,
      "The 24-hour WhatsApp reply window has closed, so this message can no longer be sent.",
      "WINDOW_CLOSED"
    );
  }

  let results;
  try {
    results = await sendWhatsAppText(message.phone, message.body);
  } catch (err) {
    results = [{ text: message.body, id: null, ok: false, error: err.message }];
  }

  const delivered = results.length > 0 && results.every((result) => result.ok);
  const first = results[0] || {};

  await db.run(
    "UPDATE messages SET wa_message_id = ?, delivery_status = ?, error_text = ? WHERE id = ?",
    [
      first.id || null,
      delivered ? "sent" : "failed",
      delivered ? null : String(first.error || "send failed").slice(0, 500),
      messageId,
    ]
  );

  const [updated] = await getMessagesByIds([messageId]);
  return {
    delivered,
    message: updated,
    error: delivered ? null : first.error || "WhatsApp did not accept the message.",
  };
}

// ---------------------------------------------------------------------------
// Bot <-> human handover
// ---------------------------------------------------------------------------

function historyTurn(role, text) {
  return { role, content: text, parts: [{ text }], timestamp: new Date().toISOString() };
}

/**
 * While a chat is in human mode the bot sees nothing. When control goes back
 * to the bot, give it a short transcript of what was said in the meantime, so
 * it does not repeat the team's answers or contradict them.
 *
 * "In the meantime" = everything after the bot's last message in this chat
 * (the bot is silent while a human is in charge, so that is exactly what it
 * missed). Messages that WhatsApp refused to send are left out.
 */
async function addHandoverNote(phone) {
  const rows = (
    await db.all(
      `SELECT m.sender_type, m.body, su.name AS staff_name
         FROM messages m
         LEFT JOIN staff_users su ON su.id = m.staff_id
        WHERE m.phone = ?
          AND m.id > (SELECT COALESCE(MAX(b.id), 0) FROM messages b
                       WHERE b.phone = ? AND b.sender_type = 'bot')
          AND (m.delivery_status IS NULL OR m.delivery_status <> 'failed')
        ORDER BY m.id DESC
        LIMIT 60`,
      [phone, phone]
    )
  ).reverse();

  const lines = rows
    .filter((row) => row.body)
    .map((row) => {
      const text = String(row.body).replace(/\s+/g, " ").slice(0, 500);
      if (row.sender_type === "customer") return `Customer: ${text}`;
      if (row.sender_type === "staff") return `Team member (${row.staff_name || "staff"}): ${text}`;
      return `Assistant: ${text}`;
    });

  if (lines.length === 0) return false;

  const note = [
    "[Internal note, not from the customer: a human team member handled this chat for a while and the assistant was paused. This is what was said in that time:]",
    ...lines,
    "[End of note. Carry on from here and do not repeat what the team member already told the customer.]",
  ]
    .join("\n")
    .slice(0, 6000);

  const history = await memory.getHistory(phone);
  const last = history[history.length - 1];
  if (last && last.role !== "model") {
    history.push(historyTurn("model", "(no reply was sent)"));
  }
  history.push(historyTurn("user", note));
  history.push(
    historyTurn("model", "Understood. I'll continue from here without repeating what the team already said.")
  );
  await memory.saveHistory(phone, history);
  return true;
}

async function takeOver(phone, staff) {
  const conversation = await requireConversation(phone);
  if (conversation.mode === "bot") {
    await db.run(
      "UPDATE conversations SET mode = 'human', human_since = UTC_TIMESTAMP(3) WHERE phone = ? AND mode = 'bot'",
      [phone]
    );
  }
  await db.run("UPDATE conversations SET assigned_to = ? WHERE phone = ?", [staff.id, phone]);
}

async function handBack(phone) {
  const conversation = await requireConversation(phone);
  if (conversation.mode !== "human") return { changed: false };

  await addHandoverNote(phone);
  await db.run(
    "UPDATE conversations SET mode = 'bot', human_since = NULL WHERE phone = ?",
    [phone]
  );
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Resolve / reopen
// ---------------------------------------------------------------------------

/**
 * Mark a chat as handled: returns control to the bot, closes the chat's
 * human-handoff request(s), and reports anything still open for this customer
 * (orders, appointments, other issues have to be resolved on their own).
 */
async function resolve(phone, staff, note) {
  await requireConversation(phone);
  await handBack(phone);

  await db.run(
    `UPDATE conversations
        SET status = 'resolved', resolved_by = ?, resolved_at = UTC_TIMESTAMP(3), unread_count = 0
      WHERE phone = ?`,
    [staff.id, phone]
  );

  const closed = await db.run(
    `UPDATE issues
        SET status = 'resolved', resolved_by = ?, resolved_at = UTC_TIMESTAMP(3),
            resolution_note = COALESCE(?, resolution_note), updated_at = UTC_TIMESTAMP(3)
      WHERE phone = ? AND type = 'escalation' AND status <> 'resolved'`,
    [staff.id, note || null, phone]
  );

  const open = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE phone = ? AND status IN ('new','in_progress')) AS orders,
       (SELECT COUNT(*) FROM appointments WHERE phone = ? AND status IN ('new','in_progress')) AS appointments,
       (SELECT COUNT(*) FROM issues WHERE phone = ? AND status IN ('new','in_progress')) AS issues`,
    [phone, phone, phone]
  );

  return {
    resolved_escalations: Number(closed.affectedRows) || 0,
    still_open: {
      orders: Number(open.orders) || 0,
      appointments: Number(open.appointments) || 0,
      issues: Number(open.issues) || 0,
    },
  };
}

async function reopen(phone) {
  await requireConversation(phone);
  await db.run(
    "UPDATE conversations SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE phone = ? AND status = 'resolved'",
    [phone]
  );
}

module.exports = {
  WINDOW_MS,
  windowInfo,
  requireConversation,
  listMessages,
  getMessagesByIds,
  markRead,
  sendStaffMessage,
  retryStaffMessage,
  takeOver,
  handBack,
  resolve,
  reopen,
};
