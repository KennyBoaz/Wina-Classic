/**
 * routes/productRoutes.js   (all require a logged-in staff member)
 *
 *   GET   /api/products          ?status=active|archived|all&search=&category=&limit=&offset=
 *   POST  /api/products          (admin)  { name, brand, category, price_ugx, stock, details }
 *   PATCH /api/products/:id      admin: any field incl. active.  Staff: only { stock }.
 *   POST  /api/products/import   (admin)  { rows: [ {name, brand, category, price_ugx, stock, details} ] }  up to 500
 *
 * The bot's search_products tool reads this table, so it only ever quotes confirmed prices.
 */

const express = require("express");
const db = require("../db.js");
const auth = require("../auth.js");
const { HttpError, wrap, intParam, searchTerm, cleanText } = require("../apiUtil.js");

const router = express.Router();
const STOCK = ["in_stock", "low", "out"];
const COLUMNS = "id, name, brand, category, price_ugx, stock, details, active, created_at, updated_at";

function cleanPrice(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "") return null;
  const digits = String(value).replace(/[^\d.]/g, "");
  const n = Math.round(Number(digits));
  if (!digits || !Number.isFinite(n) || n < 0 || n > 100000000000) {
    throw new HttpError(400, "Price must be a number of shillings, for example 1250000.", "BAD_PRICE");
  }
  return n;
}

/** Validate the fields that were sent. Only keys present in `body` appear in the result. */
function cleanProduct(body, requireName) {
  const out = {};
  if (body.name !== undefined || requireName) {
    const name = String(body.name === undefined ? "" : body.name).trim().replace(/\s+/g, " ");
    if (!name) throw new HttpError(400, "Enter the product name.", "BAD_NAME");
    if (name.length > 190) throw new HttpError(400, "The product name is too long.", "BAD_NAME");
    out.name = name;
  }
  const brand = cleanText(body.brand, 100);
  if (brand !== undefined) out.brand = brand;
  const category = cleanText(body.category, 60);
  if (category !== undefined) out.category = category;
  const price = cleanPrice(body.price_ugx);
  if (price !== undefined) out.price_ugx = price;
  if (body.stock !== undefined) {
    if (!STOCK.includes(body.stock)) throw new HttpError(400, "Stock must be in_stock, low or out.", "BAD_STOCK");
    out.stock = body.stock;
  }
  const details = cleanText(body.details, 500);
  if (details !== undefined) out.details = details;
  return out;
}

router.get(
  "/products",
  wrap(async (req, res) => {
    const where = [];
    const params = [];
    const status = String(req.query.status || "active");
    if (status === "active") where.push("active = 1");
    else if (status === "archived") where.push("active = 0");
    else if (status !== "all") throw new HttpError(400, "Unknown status.", "BAD_STATUS");

    const term = searchTerm(req.query.search);
    if (term) {
      where.push("(name LIKE ? OR brand LIKE ? OR category LIKE ? OR details LIKE ?)");
      params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
    }
    if (req.query.category) {
      where.push("category = ?");
      params.push(String(req.query.category).slice(0, 60));
    }

    const limit = intParam(req.query.limit, 50, 1, 200);
    const offset = intParam(req.query.offset, 0, 0, 100000);
    const rows = await db.all(
      `SELECT ${COLUMNS} FROM products ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY name LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    );
    const categories = (await db.all(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category"
    )).map((r) => r.category);

    res.json({
      products: rows.slice(0, limit).map((p) => ({ ...p, active: Boolean(p.active), price_ugx: p.price_ugx === null ? null : Number(p.price_ugx) })),
      has_more: rows.length > limit,
      categories,
    });
  })
);

router.post(
  "/products",
  auth.requireAdmin,
  wrap(async (req, res) => {
    const p = cleanProduct(req.body || {}, true);
    const insert = await db.run(
      `INSERT INTO products (name, brand, category, price_ugx, stock, details, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [p.name, p.brand || null, p.category || null, p.price_ugx === undefined ? null : p.price_ugx, p.stock || "in_stock", p.details || null]
    );
    const row = await db.one(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [insert.insertId]);
    res.status(201).json({ product: { ...row, active: Boolean(row.active) } });
  })
);

router.patch(
  "/products/:id",
  wrap(async (req, res) => {
    const id = intParam(req.params.id, null, 1, Number.MAX_SAFE_INTEGER);
    const existing = id ? await db.one("SELECT id FROM products WHERE id = ?", [id]) : null;
    if (!existing) throw new HttpError(404, "Product not found.", "NOT_FOUND");

    const body = req.body || {};
    const keys = Object.keys(body);
    if (req.staff.role !== "admin" && keys.some((k) => k !== "stock")) {
      throw new HttpError(403, "Staff can only change the stock level. Ask an admin to edit the rest.", "FORBIDDEN");
    }

    const p = cleanProduct(body, false);
    const sets = [];
    const params = [];
    Object.keys(p).forEach((k) => { sets.push(`${k} = ?`); params.push(p[k]); }); // keys come from cleanProduct, not the request
    if (body.active !== undefined) { sets.push("active = ?"); params.push(body.active ? 1 : 0); }
    if (sets.length === 0) throw new HttpError(400, "Nothing to change.", "NO_CHANGES");

    sets.push("updated_at = UTC_TIMESTAMP(3)");
    params.push(id);
    await db.run(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, params);

    const row = await db.one(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
    res.json({ product: { ...row, active: Boolean(row.active), price_ugx: row.price_ugx === null ? null : Number(row.price_ugx) } });
  })
);

/** Add new items and update existing ones (matched by name + brand, ignoring capitals). */
router.post(
  "/products/import",
  auth.requireAdmin,
  wrap(async (req, res) => {
    const rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) throw new HttpError(400, "There are no rows to import.", "NO_ROWS");
    if (rows.length > 500) throw new HttpError(400, "Import at most 500 rows at a time.", "TOO_MANY");

    let created = 0, updated = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i += 1) {
      try {
        const p = cleanProduct(rows[i] || {}, true);
        const existing = await db.one(
          "SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND LOWER(COALESCE(brand, '')) = LOWER(?)",
          [p.name, p.brand || ""]
        );
        if (existing) {
          const sets = [];
          const params = [];
          Object.keys(p).forEach((k) => { sets.push(`${k} = ?`); params.push(p[k]); });
          sets.push("active = 1", "updated_at = UTC_TIMESTAMP(3)");
          params.push(existing.id);
          await db.run(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, params);
          updated += 1;
        } else {
          await db.run(
            `INSERT INTO products (name, brand, category, price_ugx, stock, details, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
            [p.name, p.brand || null, p.category || null, p.price_ugx === undefined ? null : p.price_ugx, p.stock || "in_stock", p.details || null]
          );
          created += 1;
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        errors.push({ row: i + 1, error: err.message });
      }
    }
    res.json({ created, updated, skipped: errors.length, errors: errors.slice(0, 20) });
  })
);

module.exports = router;