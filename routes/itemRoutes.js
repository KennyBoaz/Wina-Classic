/**
 * routes/itemRoutes.js   (all require a logged-in staff member)
 *
 * The same three endpoints exist for issues, orders and appointments:
 *
 *   GET   /api/issues        ?status=open|all|new|in_progress|resolved&type=&phone=&search=&limit=&offset=
 *   PATCH /api/issues/:id    { status?, note?, assign_to_me? }
 *
 *   GET   /api/orders        (same filters, no type)       statuses also include "cancelled"
 *   PATCH /api/orders/:id
 *
 *   GET   /api/appointments  (same)
 *   PATCH /api/appointments/:id
 *
 * status=open (the default) means "new" + "in_progress".
 * Marking something "resolved" (or "cancelled") records who did it and when.
 * `note` is the staff's note: "resolution_note" for issues, "staff_note"
 * for orders and appointments. Send note: "" to clear it.
 */

const express = require("express");
const db = require("../db.js");
const {
  HttpError,
  wrap,
  parsePhone,
  intParam,
  searchTerm,
  cleanText,
} = require("../apiUtil.js");

const router = express.Router();

const STATUS_FLOW = ["new", "in_progress", "resolved", "cancelled"];

// Table names, aliases and column names below are fixed here in the code
// (never taken from the request), so the SQL built from them is safe.
const TYPES = {
  issues: {
    table: "issues",
    alias: "i",
    statuses: ["new", "in_progress", "resolved"],
    doneStatuses: ["resolved"],
    noteColumn: "resolution_note",
    ownerColumn: "assigned_to",
    doneColumn: "resolved_by",
    from: `issues i
      LEFT JOIN customers cu ON cu.phone = i.phone
      LEFT JOIN staff_users sa ON sa.id = i.assigned_to
      LEFT JOIN staff_users sr ON sr.id = i.resolved_by`,
    select: `i.id, i.ref, i.type, i.phone, i.contact_phone, i.customer_name, i.order_ref,
      i.summary, i.details, i.status, i.assigned_to, sa.name AS assigned_name,
      i.resolution_note, i.resolved_by, sr.name AS resolved_by_name, i.resolved_at,
      i.created_at, i.updated_at, COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["i.ref", "i.customer_name", "i.phone", "i.summary", "i.details", "i.order_ref"],
  },
  orders: {
    table: "orders",
    alias: "o",
    statuses: STATUS_FLOW,
    doneStatuses: ["resolved", "cancelled"],
    noteColumn: "staff_note",
    ownerColumn: "handled_by",
    doneColumn: "handled_by",
    from: `orders o
      LEFT JOIN customers cu ON cu.phone = o.phone
      LEFT JOIN staff_users sh ON sh.id = o.handled_by`,
    select: `o.id, o.ref, o.phone, o.contact_phone, o.customer_name, o.items, o.quantity,
      o.delivery_address, o.delivery_date, o.status, o.staff_note, o.handled_by,
      sh.name AS handled_by_name, o.resolved_at, o.created_at, o.updated_at,
      COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["o.ref", "o.customer_name", "o.phone", "o.items", "o.delivery_address"],
  },
  appointments: {
    table: "appointments",
    alias: "a",
    statuses: STATUS_FLOW,
    doneStatuses: ["resolved", "cancelled"],
    noteColumn: "staff_note",
    ownerColumn: "handled_by",
    doneColumn: "handled_by",
    from: `appointments a
      LEFT JOIN customers cu ON cu.phone = a.phone
      LEFT JOIN staff_users sh ON sh.id = a.handled_by`,
    select: `a.id, a.ref, a.phone, a.contact_phone, a.name AS customer_name, a.appt_date,
      a.appt_time, a.purpose, a.status, a.staff_note, a.handled_by,
      sh.name AS handled_by_name, a.resolved_at, a.created_at, a.updated_at,
      COALESCE(cu.display_name, cu.whatsapp_name) AS chat_name`,
    searchColumns: ["a.ref", "a.name", "a.phone", "a.purpose"],
  },
};

const ISSUE_TYPES = ["support", "escalation", "inquiry"];

function shapeRow(key, row) {
  if (key === "orders") {
    let items = [];
    try {
      const parsed = JSON.parse(row.items);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = row.items ? [String(row.items)] : [];
    }
    return { ...row, items };
  }
  return row;
}

for (const [key, cfg] of Object.entries(TYPES)) {
  const a = cfg.alias;

  router.get(
    `/${key}`,
    wrap(async (req, res) => {
      const where = [];
      const params = [];

      const status = String(req.query.status || "open");
      if (status === "open") {
        where.push(`${a}.status IN ('new','in_progress')`);
      } else if (status !== "all") {
        if (!cfg.statuses.includes(status)) throw new HttpError(400, "Unknown status.", "BAD_STATUS");
        where.push(`${a}.status = ?`);
        params.push(status);
      }

      if (key === "issues" && req.query.type) {
        const type = String(req.query.type);
        if (!ISSUE_TYPES.includes(type)) throw new HttpError(400, "Unknown issue type.", "BAD_TYPE");
        where.push("i.type = ?");
        params.push(type);
      }

      if (req.query.phone) {
        where.push(`${a}.phone = ?`);
        params.push(parsePhone(req.query.phone, 400));
      }

      const term = searchTerm(req.query.search);
      if (term) {
        where.push(`(${cfg.searchColumns.map((column) => `${column} LIKE ?`).join(" OR ")})`);
        for (let n = 0; n < cfg.searchColumns.length; n += 1) params.push(`%${term}%`);
      }

      const limit = intParam(req.query.limit, 30, 1, 100);
      const offset = intParam(req.query.offset, 0, 0, 100000);

      const rows = await db.all(
        `SELECT ${cfg.select}
           FROM ${cfg.from}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${a}.created_at DESC, ${a}.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit + 1, offset]
      );

      res.json({
        [key]: rows.slice(0, limit).map((row) => shapeRow(key, row)),
        has_more: rows.length > limit,
      });
    })
  );

  router.patch(
    `/${key}/:id`,
    wrap(async (req, res) => {
      const id = intParam(req.params.id, null, 1, Number.MAX_SAFE_INTEGER);
      const existing = id
        ? await db.one(`SELECT id FROM ${cfg.table} WHERE id = ?`, [id])
        : null;
      if (!existing) throw new HttpError(404, "Not found.", "NOT_FOUND");

      const body = req.body || {};
      const sets = [];
      const params = [];

      if (body.status !== undefined) {
        if (!cfg.statuses.includes(body.status)) {
          throw new HttpError(400, `Status must be one of: ${cfg.statuses.join(", ")}.`, "BAD_STATUS");
        }
        sets.push("status = ?");
        params.push(body.status);

        if (cfg.doneStatuses.includes(body.status)) {
          sets.push("resolved_at = UTC_TIMESTAMP(3)", `${cfg.doneColumn} = ?`);
          params.push(req.staff.id);
        } else {
          sets.push("resolved_at = NULL");
          if (cfg.doneColumn !== cfg.ownerColumn) sets.push(`${cfg.doneColumn} = NULL`);
          if (body.status === "in_progress") {
            sets.push(`${cfg.ownerColumn} = ?`);
            params.push(req.staff.id);
          }
        }
      }

      if (body.assign_to_me === true && !sets.some((s) => s.startsWith(`${cfg.ownerColumn} =`))) {
        sets.push(`${cfg.ownerColumn} = ?`);
        params.push(req.staff.id);
      }

      const note = cleanText(body.note, 2000);
      if (note !== undefined) {
        sets.push(`${cfg.noteColumn} = ?`);
        params.push(note);
      }

      if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

      sets.push("updated_at = UTC_TIMESTAMP(3)");
      params.push(id);
      await db.run(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = ?`, params);

      const row = await db.one(`SELECT ${cfg.select} FROM ${cfg.from} WHERE ${a}.id = ?`, [id]);
      res.json({ item: shapeRow(key, row) });
    })
  );
}

module.exports = router;
