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
const { sendWhatsAppText, sendWhatsAppReaction } = require("./whatsapp.js");
const { HttpError } = require("./apiUtil.js");

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_STAFF_TEXT = 4000;

const MESSAGE_COLUMNS = `m.id, m.phone, m.direction, m.sender_type, m.staff_id,
  su.name AS staff_name, m.msg_type, m.body, m.delivery_status, m.error_text, m.created_at,
  m.wa_message_id, m.reply_to_wa_id, m.starred, m.reaction, m.customer_reaction,
  q.body AS quoted_body, q.direction AS quoted_direction, q.sender_type AS quoted_sender`;

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
       LEFT JOIN messages q ON q.wa_message_id = m.reply_to_wa_id
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
       LEFT JOIN messages q ON q.wa_message_id = m.reply_to_wa_id
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
async function sendStaffMessage({ phone, text, staff, replyTo }) {
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

  // Quote an earlier message of this same chat (replyTo = its id in our database).
  let replyWaId = null;
  if (replyTo) {
    const quoted = await db.one("SELECT wa_message_id FROM messages WHERE id = ? AND phone = ?", [replyTo, phone]);
    replyWaId = (quoted && quoted.wa_message_id) || null;
  }

  let results;
  try {
    results = await sendWhatsAppText(phone, body, { replyTo: replyWaId });
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
        replyToWaId: replyWaId,
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
    results = await sendWhatsAppText(message.phone, message.body, { replyTo: message.reply_to_wa_id || null });
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

// ---------------------------------------------------------------------------
// Phase 4: message and chat menu actions
// ---------------------------------------------------------------------------

const ALLOWED_REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F64F}", "\u{1F60A}", "\u{1F602}", "\u{1F62E}", "\u{1F622}"];

async function requireMessage(messageId) {
  const message = await db.one("SELECT * FROM messages WHERE id = ?", [messageId]);
  if (!message) throw new HttpError(404, "Message not found.", "NOT_FOUND");
  return message;
}

/** Send (or remove, with emoji "") our emoji reaction on a CUSTOMER's message. */
async function reactToMessage({ messageId, emoji }) {
  const message = await requireMessage(messageId);
  if (message.direction !== "in" || !message.wa_message_id) {
    throw new HttpError(400, "You can only react to a customer's message.", "BAD_TARGET");
  }
  if (emoji !== "" && !ALLOWED_REACTIONS.includes(emoji)) {
    throw new HttpError(400, "That reaction is not available.", "BAD_EMOJI");
  }
  const conversation = await requireConversation(message.phone);
  if (!windowInfo(conversation.last_customer_message_at).open) {
    throw new HttpError(409, "The 24-hour WhatsApp reply window has closed.", "WINDOW_CLOSED");
  }

  let result;
  try {
    result = await sendWhatsAppReaction(message.phone, message.wa_message_id, emoji);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  if (!result.ok) {
    throw new HttpError(502, `WhatsApp did not accept the reaction: ${result.error}`, "SEND_FAILED");
  }

  await db.run("UPDATE messages SET reaction = ? WHERE id = ?", [emoji || null, messageId]);
  return (await getMessagesByIds([messageId]))[0];
}

/** Forward a message WE sent (staff or bot) into another customer's chat. */
async function forwardMessage({ messageId, toPhone, staff }) {
  const message = await requireMessage(messageId);
  if (message.direction !== "out") {
    throw new HttpError(403, "Only messages we sent can be forwarded. A customer's messages stay in their own chat.", "FORWARD_NOT_ALLOWED");
  }
  if (toPhone === message.phone) throw new HttpError(400, "Choose a different chat.", "SAME_CHAT");
  return sendStaffMessage({ phone: toPhone, text: message.body, staff });
}

async function setStarred(messageId, starred) {
  await requireMessage(messageId);
  await db.run("UPDATE messages SET starred = ? WHERE id = ?", [starred ? 1 : 0, messageId]);
  return (await getMessagesByIds([messageId]))[0];
}

/** Append a message's text to the customer's private notes. */
async function saveMessageToNotes(messageId) {
  const message = await requireMessage(messageId);
  const customer = await db.one("SELECT notes FROM customers WHERE phone = ?", [message.phone]);
  const line = "- " + String(message.body || "").replace(/\s+/g, " ").slice(0, 400);
  const next = ((customer && customer.notes) ? customer.notes + "\n" : "") + line;
  if (next.length > 5000) throw new HttpError(400, "This customer's notes are full. Tidy them up first.", "NOTES_FULL");
  await db.run("UPDATE customers SET notes = ? WHERE phone = ?", [next, message.phone]);
  return next;
}

async function setPinned(phone, pinned) {
  await requireConversation(phone);
  await db.run("UPDATE conversations SET pinned = ? WHERE phone = ?", [pinned ? 1 : 0, phone]);
}

async function markUnread(phone) {
  await requireConversation(phone);
  await db.run("UPDATE conversations SET unread_count = 1 WHERE phone = ? AND unread_count = 0", [phone]);
}

async function assignChat(phone, staffId) {
  await requireConversation(phone);
  if (staffId !== null) {
    const person = await db.one("SELECT id FROM staff_users WHERE id = ? AND active = 1", [staffId]);
    if (!person) throw new HttpError(400, "That staff member is not available.", "BAD_STAFF");
  }
  await db.run("UPDATE conversations SET assigned_to = ? WHERE phone = ?", [staffId, phone]);
}

/** The bot forgets this customer (it will start the conversation fresh). Records stay. */
async function resetBotMemory(phone) {
  await requireConversation(phone);
  await db.run("DELETE FROM bot_history WHERE phone = ?", [phone]);
}

/** The whole conversation as plain text (for disputes, records). */
async function exportText(phone) {
  await requireConversation(phone);
  const customer = await db.one("SELECT whatsapp_name, display_name FROM customers WHERE phone = ?", [phone]);
  const rows = await db.all(
    `SELECT m.sender_type, m.body, m.created_at, su.name AS staff_name
       FROM messages m LEFT JOIN staff_users su ON su.id = m.staff_id
      WHERE m.phone = ? ORDER BY m.id ASC LIMIT 5000`,
    [phone]
  );
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kampala", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const name = (customer && (customer.display_name || customer.whatsapp_name)) || phone;
  const lines = rows.map((row) => {
    const who = row.sender_type === "customer" ? name : row.sender_type === "staff" ? `${row.staff_name || "Team"} (team)` : "Wina Classic bot";
    return `[${stamp.format(new Date(row.created_at))}] ${who}: ${row.body || ""}`;
  });
  return {
    filename: `chat-${phone}.txt`,
    text: `WhatsApp conversation with ${name} (+${phone})\nExported ${stamp.format(new Date())} (Africa/Kampala)\n\n${lines.join("\n")}\n`,
  };
}

/**
 * Permanently erase a chat (admin only): messages, the bot's memory and the
 * customer's record. With alsoRecords, their orders, appointments and tickets go too.
 */
async function deleteConversation(phone, alsoRecords) {
  await requireConversation(phone);
  await db.run("DELETE FROM bot_history WHERE phone = ?", [phone]);
  if (alsoRecords) {
    await db.run("DELETE FROM orders WHERE phone = ?", [phone]);
    await db.run("DELETE FROM appointments WHERE phone = ?", [phone]);
    await db.run("DELETE FROM issues WHERE phone = ?", [phone]);
  }
  await db.run("DELETE FROM customers WHERE phone = ?", [phone]); // messages + conversation go with it
}

module.exports = {
  ALLOWED_REACTIONS,
  reactToMessage,
  forwardMessage,
  setStarred,
  saveMessageToNotes,
  setPinned,
  markUnread,
  assignChat,
  resetBotMemory,
  exportText,
  deleteConversation,
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