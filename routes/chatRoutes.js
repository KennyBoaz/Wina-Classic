/**
 * routes/chatRoutes.js   (all require a logged-in staff member)
 *
 *   GET   /api/summary                          counts + latest ids (for badges / polling)
 *   GET   /api/conversations                    ?filter=&search=&limit=&offset=
 *   GET   /api/conversations/:phone             chat details + that customer's orders/appointments/issues
 *   GET   /api/conversations/:phone/messages    ?after=ID | ?before=ID & limit=
 *   POST  /api/conversations/:phone/messages    { text }  reply as staff
 *   POST  /api/messages/:id/retry               resend a failed staff message
 *   POST  /api/conversations/:phone/read        clear the unread badge
 *   POST  /api/conversations/:phone/takeover    stop the bot, staff answer
 *   POST  /api/conversations/:phone/handback    bot answers again
 *   POST  /api/conversations/:phone/resolve     { note? } mark the chat handled
 *   POST  /api/conversations/:phone/reopen
 *   PATCH /api/conversations/:phone/customer    { display_name?, notes? }
 *
 * filter = active (default: everything not resolved) | unread | human |
 *          escalated | window_open | open_issue | resolved | all
 */

const express = require("express");
const db = require("../db.js");
const svc = require("../conversations.js");
const {
  HttpError,
  wrap,
  parsePhone,
  intParam,
  searchTerm,
  cleanText,
} = require("../apiUtil.js");

const router = express.Router();

function shapeConversation(row) {
  return {
    phone: row.phone,
    name: row.name || null,
    mode: row.mode,
    status: row.status,
    unread_count: Number(row.unread_count) || 0,
    assigned_to: row.assigned_to || null,
    assigned_name: row.assigned_name || null,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    last_customer_message_at: row.last_customer_message_at,
    window: svc.windowInfo(row.last_customer_message_at),
    open_issues: Number(row.open_issues) || 0,
    open_orders: Number(row.open_orders) || 0,
    open_appointments: Number(row.open_appointments) || 0,
  };
}

const CONVERSATION_SELECT = `
  SELECT c.phone, c.mode, c.status, c.unread_count, c.assigned_to,
         c.last_customer_message_at, c.last_message_at, c.last_message_preview,
         COALESCE(cu.display_name, cu.whatsapp_name) AS name,
         su.name AS assigned_name,
         (SELECT COUNT(*) FROM issues i WHERE i.phone = c.phone AND i.status IN ('new','in_progress')) AS open_issues,
         (SELECT COUNT(*) FROM orders o WHERE o.phone = c.phone AND o.status IN ('new','in_progress')) AS open_orders,
         (SELECT COUNT(*) FROM appointments a WHERE a.phone = c.phone AND a.status IN ('new','in_progress')) AS open_appointments
    FROM conversations c
    JOIN customers cu ON cu.phone = c.phone
    LEFT JOIN staff_users su ON su.id = c.assigned_to`;

// ---------------------------------------------------------------------------
// Summary (badges + "something new happened" detection)
// ---------------------------------------------------------------------------

router.get(
  "/summary",
  wrap(async (_req, res) => {
    const row = await db.one(`
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE status = 'escalated') AS escalated_chats,
        (SELECT COUNT(*) FROM conversations WHERE mode = 'human' AND status <> 'resolved') AS human_chats,
        (SELECT COUNT(*) FROM conversations WHERE unread_count > 0 AND status <> 'resolved') AS unread_chats,
        (SELECT COALESCE(SUM(unread_count), 0) FROM conversations
          WHERE (mode = 'human' OR status = 'escalated') AND status <> 'resolved') AS unread_needing_staff,
        (SELECT COUNT(*) FROM issues WHERE status = 'new') AS new_issues,
        (SELECT COUNT(*) FROM orders WHERE status = 'new') AS new_orders,
        (SELECT COUNT(*) FROM appointments WHERE status = 'new') AS new_appointments,
        (SELECT COALESCE(MAX(id), 0) FROM messages WHERE direction = 'in') AS last_incoming_message_id,
        (SELECT COALESCE(MAX(id), 0) FROM messages) AS last_message_id,
        (SELECT COALESCE(MAX(id), 0) FROM issues) AS last_issue_id,
        (SELECT COALESCE(MAX(id), 0) FROM orders) AS last_order_id,
        (SELECT COALESCE(MAX(id), 0) FROM appointments) AS last_appointment_id`);

    const summary = {};
    for (const [key, value] of Object.entries(row)) summary[key] = Number(value) || 0;
    res.json({ summary });
  })
);

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

router.get(
  "/conversations",
  wrap(async (req, res) => {
    const filter = String(req.query.filter || "active");
    const where = [];
    const params = [];

    switch (filter) {
      case "all":
        break;
      case "unread":
        where.push("c.unread_count > 0");
        break;
      case "human":
        where.push("c.mode = 'human'");
        break;
      case "escalated":
        where.push("c.status = 'escalated'");
        break;
      case "window_open":
        where.push("c.last_customer_message_at >= ?");
        params.push(new Date(Date.now() - svc.WINDOW_MS));
        break;
      case "open_issue":
        where.push(
          "EXISTS (SELECT 1 FROM issues i WHERE i.phone = c.phone AND i.status IN ('new','in_progress'))"
        );
        break;
      case "resolved":
        where.push("c.status = 'resolved'");
        break;
      case "active":
        where.push("c.status <> 'resolved'");
        break;
      default:
        throw new HttpError(400, "Unknown filter.", "BAD_FILTER");
    }

    const term = searchTerm(req.query.search);
    if (term) {
      where.push("(cu.display_name LIKE ? OR cu.whatsapp_name LIKE ? OR c.phone LIKE ?)");
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }

    const limit = intParam(req.query.limit, 30, 1, 100);
    const offset = intParam(req.query.offset, 0, 0, 100000);

    const rows = await db.all(
      `${CONVERSATION_SELECT}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY (c.status = 'escalated') DESC, COALESCE(c.last_message_at, c.created_at) DESC, c.phone
       LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    );

    res.json({
      conversations: rows.slice(0, limit).map(shapeConversation),
      has_more: rows.length > limit,
    });
  })
);

// ---------------------------------------------------------------------------
// One chat
// ---------------------------------------------------------------------------

router.get(
  "/conversations/:phone",
  wrap(async (req, res) => {
    const phone = parsePhone(req.params.phone);
    const row = await db.one(`${CONVERSATION_SELECT} WHERE c.phone = ?`, [phone]);
    if (!row) throw new HttpError(404, "Chat not found.", "NOT_FOUND");

    const customer = await db.one(
      "SELECT phone, whatsapp_name, display_name, notes, created_at FROM customers WHERE phone = ?",
      [phone]
    );
    const orders = await db.all(
      `SELECT id, ref, items, quantity, delivery_address, delivery_date, status, created_at
         FROM orders WHERE phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
      [phone]
    );
    const appointments = await db.all(
      `SELECT id, ref, appt_date, appt_time, purpose, status, created_at
         FROM appointments WHERE phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
      [phone]
    );
    const issues = await db.all(
      `SELECT id, ref, type, summary, details, status, created_at
         FROM issues WHERE phone = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
      [phone]
    );

    res.json({
      conversation: shapeConversation(row),
      customer,
      orders: orders.map((order) => ({ ...order, items: parseItems(order.items) })),
      appointments,
      issues,
    });
  })
);

function parseItems(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return text ? [String(text)] : [];
  }
}

router.get(
  "/conversations/:phone/messages",
  wrap(async (req, res) => {
    const phone = parsePhone(req.params.phone);
    await svc.requireConversation(phone);

    const after = intParam(req.query.after, null, 1, Number.MAX_SAFE_INTEGER);
    const before = intParam(req.query.before, null, 1, Number.MAX_SAFE_INTEGER);
    const limit = intParam(req.query.limit, after ? 100 : 50, 1, 200);

    const messages = await svc.listMessages(phone, { after, before, limit });
    res.json({ messages });
  })
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

router.post(
  "/conversations/:phone/messages",
  wrap(async (req, res) => {
    const phone = parsePhone(req.params.phone);
    const result = await svc.sendStaffMessage({
      phone,
      text: req.body && req.body.text,
      staff: req.staff,
    });

    if (!result.delivered) {
      return res.status(502).json({
        error: `WhatsApp did not accept the message: ${result.error}`,
        code: "SEND_FAILED",
        delivered: false,
        messages: result.messages,
      });
    }
    res.status(201).json({ delivered: true, messages: result.messages });
  })
);

router.post(
  "/messages/:id/retry",
  wrap(async (req, res) => {
    const id = intParam(req.params.id, null, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new HttpError(404, "Message not found.", "NOT_FOUND");

    const result = await svc.retryStaffMessage(id);
    if (!result.delivered) {
      return res.status(502).json({
        error: `WhatsApp did not accept the message: ${result.error}`,
        code: "SEND_FAILED",
        delivered: false,
        message: result.message,
      });
    }
    res.json({ delivered: true, message: result.message });
  })
);

router.post(
  "/conversations/:phone/read",
  wrap(async (req, res) => {
    const phone = parsePhone(req.params.phone);
    await svc.requireConversation(phone);
    await svc.markRead(phone);
    res.json({ ok: true });
  })
);

router.post(
  "/conversations/:phone/takeover",
  wrap(async (req, res) => {
    await svc.takeOver(parsePhone(req.params.phone), req.staff);
    res.json({ ok: true });
  })
);

router.post(
  "/conversations/:phone/handback",
  wrap(async (req, res) => {
    const result = await svc.handBack(parsePhone(req.params.phone));
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/conversations/:phone/resolve",
  wrap(async (req, res) => {
    const note = cleanText(req.body && req.body.note, 2000);
    const result = await svc.resolve(parsePhone(req.params.phone), req.staff, note);
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/conversations/:phone/reopen",
  wrap(async (req, res) => {
    await svc.reopen(parsePhone(req.params.phone));
    res.json({ ok: true });
  })
);

router.patch(
  "/conversations/:phone/customer",
  wrap(async (req, res) => {
    const phone = parsePhone(req.params.phone);
    await svc.requireConversation(phone);

    const body = req.body || {};
    const displayName = cleanText(body.display_name, 150);
    const notes = cleanText(body.notes, 5000);

    const sets = [];
    const params = [];
    if (displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(displayName);
    }
    if (notes !== undefined) {
      sets.push("notes = ?");
      params.push(notes);
    }
    if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

    params.push(phone);
    await db.run(`UPDATE customers SET ${sets.join(", ")} WHERE phone = ?`, params);

    const customer = await db.one(
      "SELECT phone, whatsapp_name, display_name, notes FROM customers WHERE phone = ?",
      [phone]
    );
    res.json({ customer });
  })
);

module.exports = router;