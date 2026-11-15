/**
 * tools.js  (CommonJS build, MySQL-backed)
 *
 * 1) The five JavaScript functions Gemini can ask us to run.
 * 2) The Gemini-format functionDeclarations (name, description, parameters).
 * 3) executeTool(name, args, ctx) - looks up the matching function and runs it.
 *
 * Bookings, orders, tickets and escalations are now saved in MySQL
 * (tables: appointments, orders, issues) instead of JSON files, so staff can
 * see and resolve them in the dashboard.
 *
 * `ctx` is { phone, customerName }: the REAL WhatsApp number of the chat that
 * triggered the tool. We trust it over whatever number the AI typed into the
 * arguments, so every record is linked to the right conversation.
 *
 * .env:
 *   PAUSE_BOT_ON_ESCALATION   "true" = after escalate_to_human the bot stops
 *                             replying to that customer until staff hand the
 *                             chat back. Leave "false" until the dashboard
 *                             (Phase 2) is live, otherwise nobody can
 *                             hand a chat back to the bot.
 */

const { Type } = require("@google/genai");
const db = require("./db.js");
const chatStore = require("./chatStore.js");

const PAUSE_BOT_ON_ESCALATION =
  String(process.env.PAUSE_BOT_ON_ESCALATION || "false").toLowerCase() === "true";

function makeId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}${rand}`;
}

/** Trim text to a column's max length so MySQL never rejects a long value. */
function clip(value, max) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Opening hours and appointment slots (Phase 5)
// ---------------------------------------------------------------------------
//   BUSINESS_HOURS             e.g. "mon-sat 08:00-20:00; sun 10:00-16:00"  (Africa/Kampala time)
//   APPOINTMENT_SLOT_MINUTES   length of one appointment, default 60
// Days that are not listed count as closed.

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_HOURS = "mon-sat 08:00-20:00; sun 10:00-16:00";
const SLOT_MINUTES = Math.max(15, Number(process.env.APPOINTMENT_SLOT_MINUTES) || 60);
const NOTICE_MINUTES = 30; // a slot must start at least this long from now
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no daylight saving

/** "mon-sat 08:00-20:00; sun 10:00-16:00" -> { 1: [480, 1200], ..., 0: [600, 960] } (minutes from midnight) */
function parseHours(text) {
  const hours = {};
  String(text || "").split(";").forEach((part) => {
    const m = part.trim().toLowerCase().match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const from = DAY_NAMES.indexOf(m[1]);
    const to = m[2] ? DAY_NAMES.indexOf(m[2]) : from;
    const open = Number(m[3]) * 60 + Number(m[4]);
    const close = Number(m[5]) * 60 + Number(m[6]);
    if (from < 0 || to < 0 || close <= open) return;
    let day = from;
    for (let n = 0; n < 7; n += 1) {
      hours[day] = [open, close];
      if (day === to) break;
      day = (day + 1) % 7;
    }
  });
  return hours;
}

let HOURS = parseHours(process.env.BUSINESS_HOURS || DEFAULT_HOURS);
if (Object.keys(HOURS).length === 0) HOURS = parseHours(DEFAULT_HOURS);

function minutesToTime(min) {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

function clockText(min) {
  const h24 = Math.floor(min / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Human-readable opening hours, e.g. "Monday to Saturday 8:00 AM - 8:00 PM; Sunday 10:00 AM - 4:00 PM". */
function describeHours() {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  order.forEach((day) => {
    const range = HOURS[day];
    if (!range) return;
    const last = groups[groups.length - 1];
    if (last && last.range[0] === range[0] && last.range[1] === range[1] && last.days[last.days.length - 1] === order[order.indexOf(day) - 1]) {
      last.days.push(day);
    } else {
      groups.push({ days: [day], range });
    }
  });
  const text = groups.map((g) => {
    const label = g.days.length === 1 ? DAY_LONG[g.days[0]] : `${DAY_LONG[g.days[0]]} to ${DAY_LONG[g.days[g.days.length - 1]]}`;
    return `${label} ${clockText(g.range[0])} - ${clockText(g.range[1])}`;
  }).join("; ");
  const closed = order.filter((d) => !HOURS[d]).map((d) => DAY_LONG[d]);
  return text + (closed.length ? `; closed on ${closed.join(", ")}` : "");
}

/** "2pm", "2:30 PM", "14:00", "14" -> "14:00". Returns null if it is not a clear time. */
function normalizeTime(value) {
  const m = String(value === undefined || value === null ? "" : value).trim().toLowerCase().replace(/\./g, "")
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Valid calendar date "YYYY-MM-DD" -> { weekday } or null. */
function parseDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return { weekday: d.getUTCDay() };
}

/** Today's date and the time now in Kampala. */
function kampalaNow(now = Date.now()) {
  const d = new Date(now + KAMPALA_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Free appointment slots on a date. Returns { error } for a bad/past date,
 * { closed: true } for a closed day, otherwise { slots, isFree(minutes) }.
 */
async function availableSlots(dateStr, nowMs = Date.now()) {
  const parsed = parseDate(dateStr);
  if (!parsed) return { error: "Use a real date in YYYY-MM-DD format, for example 2026-10-12." };
  const today = kampalaNow(nowMs);
  if (dateStr < today.date) return { error: `That date has already passed. Today is ${today.date}.` };

  const range = HOURS[parsed.weekday];
  if (!range) return { closed: true, slots: [], isFree: () => false };

  const booked = (await db.all(
    "SELECT appt_time FROM appointments WHERE appt_date = ? AND status IN ('new','in_progress')",
    [dateStr]
  )).map((row) => toMinutes(normalizeTime(row.appt_time))).filter((n) => n !== null);

  const isFree = (min) =>
    min >= range[0] && min + SLOT_MINUTES <= range[1] &&
    !(dateStr === today.date && min < today.minutes + NOTICE_MINUTES) &&
    !booked.some((b) => Math.abs(b - min) < SLOT_MINUTES);

  const slots = [];
  for (let min = range[0]; min + SLOT_MINUTES <= range[1]; min += SLOT_MINUTES) {
    if (isFree(min)) slots.push(minutesToTime(min));
  }
  return { closed: false, slots, isFree };
}

/** Free slots from the real appointments table, within real opening hours. */
async function check_availability({ date, time } = {}) {
  console.log("[tool] check_availability", { date, time });
  const res = await availableSlots(date);
  if (res.error) return { date: date || null, error: res.error };

  const requested = normalizeTime(time);
  return {
    date,
    store_closed_that_day: Boolean(res.closed),
    opening_hours: describeHours(),
    appointment_length_minutes: SLOT_MINUTES,
    available_slots: res.slots,
    requested_time: requested,
    requested_time_available: requested ? res.slots.includes(requested) || (res.isFree && res.isFree(toMinutes(requested))) : null,
    timezone: "Africa/Kampala",
    note: res.closed
      ? "The store is closed on that day."
      : res.slots.length === 0 ? "No free slots remain on that day." : undefined,
  };
}

/**
 * Save an appointment (appointments table). Refuses closed days, times outside
 * opening hours, and times already taken, and then offers the free slots.
 */
async function book_appointment(
  { name, phone, date, time, purpose } = {},
  ctx = {}
) {
  console.log("[tool] book_appointment", { name, phone, date, time, purpose });

  const when = normalizeTime(time);
  if (!when) {
    return { success: false, reason: "A specific time is needed, for example 14:00 or 2pm." };
  }
  const res = await availableSlots(date);
  if (res.error) return { success: false, reason: res.error };
  if (res.closed) return { success: false, reason: "The store is closed on that day.", opening_hours: describeHours() };
  if (!res.isFree(toMinutes(when))) {
    return {
      success: false,
      reason: "That time is not available (outside opening hours, in the past, or already booked).",
      available_slots: res.slots,
      opening_hours: describeHours(),
    };
  }

  const ref = makeId("APT");
  await db.run(
    `INSERT INTO appointments
       (ref, phone, contact_phone, name, appt_date, appt_time, purpose,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [
      ref,
      clip(ctx.phone || phone, 32),
      clip(phone, 40),
      clip(name || ctx.customerName, 150),
      date,
      when,
      clip(purpose, 500),
    ]
  );

  return {
    success: true,
    appointment_id: ref,
    name: name || null,
    phone: phone || null,
    date,
    time: when,
    purpose: purpose || null,
    message: "Appointment booked. A team member will confirm if needed.",
  };
}

/**
 * Log a customer inquiry (issues table, type 'inquiry'). With follow_up_needed
 * the team sees it as NEW and gets an alert; otherwise it is stored as already handled.
 */
async function log_inquiry({ category, summary, details, follow_up_needed } = {}, ctx = {}) {
  console.log("[tool] log_inquiry", { category, summary, follow_up_needed });
  const ref = makeId("INQ");
  const follow = follow_up_needed !== false;
  const text = (category ? `[${String(category).slice(0, 40)}] ` : "") + (details || "");

  await db.run(
    `INSERT INTO issues
       (ref, type, phone, customer_name, summary, details, status, resolution_note,
        resolved_at, created_at, updated_at)
     VALUES (?, 'inquiry', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [
      ref,
      clip(ctx.phone, 32),
      clip(ctx.customerName, 150),
      summary || "Customer inquiry",
      text || null,
      follow ? "new" : "resolved",
      follow ? null : "No follow-up needed",
      follow ? null : new Date(),
    ]
  );
  return { success: true, inquiry_id: ref, message: "Inquiry noted for the team." };
}

/** Look up confirmed prices and stock in the products table (active items only). */
async function search_products({ query, category } = {}) {
  console.log("[tool] search_products", { query, category });
  const terms = String(query || "").replace(/[%_\\]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4);
  const where = ["active = 1"];
  const params = [];
  terms.forEach((term) => {
    where.push("(name LIKE ? OR brand LIKE ? OR category LIKE ? OR details LIKE ?)");
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
  });
  if (category) {
    where.push("category LIKE ?");
    params.push(`%${String(category).replace(/[%_\\]/g, " ").trim()}%`);
  }

  const rows = await db.all(
    `SELECT name, brand, category, price_ugx, stock, details
       FROM products WHERE ${where.join(" AND ")} ORDER BY name LIMIT 6`,
    params
  );
  if (rows.length === 0) {
    return {
      found: 0,
      message: "Nothing like that is in our price list. Do not guess a price or stock level: say you will check with the team and log an inquiry.",
    };
  }
  return {
    found: rows.length,
    items: rows.map((r) => ({
      name: r.name,
      brand: r.brand || null,
      category: r.category || null,
      price: r.price_ugx === null || r.price_ugx === undefined ? "price on request" : "UGX " + Number(r.price_ugx).toLocaleString("en-US"),
      stock: { in_stock: "in stock", low: "low stock", out: "out of stock" }[r.stock] || r.stock,
      details: r.details || null,
    })),
  };
}

/**
 * Save an order (orders table).
 */
async function create_order(
  { items, quantity, delivery_address, delivery_date, customer_name, phone } = {},
  ctx = {}
) {
  console.log("[tool] create_order", {
    items,
    quantity,
    delivery_address,
    delivery_date,
    customer_name,
    phone,
  });

  const itemList = Array.isArray(items)
    ? items
    : items
      ? [String(items)]
      : [];

  const ref = makeId("ORD");

  await db.run(
    `INSERT INTO orders
       (ref, phone, contact_phone, customer_name, items, quantity,
        delivery_address, delivery_date, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [
      ref,
      clip(ctx.phone || phone, 32),
      clip(phone, 40),
      clip(customer_name || ctx.customerName, 150),
      JSON.stringify(itemList),
      clip(quantity, 100),
      clip(delivery_address, 500),
      clip(delivery_date, 60),
    ]
  );

  return {
    success: true,
    order_ref: ref,
    items: itemList,
    quantity: quantity ?? null,
    delivery_address: delivery_address || null,
    delivery_date: delivery_date || null,
    message: "Order logged. The team will follow up to confirm stock and delivery.",
  };
}

/**
 * Save a support ticket (issues table, type 'support').
 */
async function create_support_ticket(
  { order_ref, issue_description, customer_name, phone } = {},
  ctx = {}
) {
  console.log("[tool] create_support_ticket", {
    order_ref,
    issue_description,
    customer_name,
    phone,
  });

  const ref = makeId("TCK");

  await db.run(
    `INSERT INTO issues
       (ref, type, phone, contact_phone, customer_name, order_ref, summary,
        status, created_at, updated_at)
     VALUES (?, 'support', ?, ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [
      ref,
      clip(ctx.phone || phone, 32),
      clip(phone, 40),
      clip(customer_name || ctx.customerName, 150),
      clip(order_ref, 40),
      issue_description || null,
    ]
  );

  return {
    success: true,
    ticket_id: ref,
    order_ref: order_ref || null,
    message: "Support ticket created. The team will get back to the customer.",
  };
}

/**
 * Hand the chat to a human: save an issue (type 'escalation'), flag the chat
 * as escalated, and print a loud alert in the log.
 */
async function escalate_to_human({ reason, conversation_summary } = {}, ctx = {}) {
  console.log("[tool] escalate_to_human", { reason, conversation_summary });

  const ref = makeId("ESC");

  await db.run(
    `INSERT INTO issues
       (ref, type, phone, customer_name, summary, details,
        status, created_at, updated_at)
     VALUES (?, 'escalation', ?, ?, ?, ?, 'new', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [
      ref,
      clip(ctx.phone, 32),
      clip(ctx.customerName, 150),
      reason || null,
      conversation_summary || null,
    ]
  );

  // Mark the chat itself so it jumps to the top of the dashboard.
  if (ctx.phone) {
    try {
      await chatStore.markEscalated(ctx.phone, { pauseBot: PAUSE_BOT_ON_ESCALATION });
    } catch (err) {
      console.error("[tool] Could not flag the conversation as escalated:", err.message);
    }
  }

  console.log("============================================================");
  console.log("  HUMAN HANDOFF NEEDED");
  console.log(`  Escalation ID : ${ref}`);
  console.log(`  Customer      : ${ctx.phone || "unknown"}`);
  console.log(`  Reason        : ${reason}`);
  console.log(`  Summary       : ${conversation_summary}`);
  console.log(`  Bot paused    : ${PAUSE_BOT_ON_ESCALATION && ctx.phone ? "yes" : "no"}`);
  console.log("============================================================");

  return {
    success: true,
    escalation_id: ref,
    message:
      "A human teammate has been alerted. Stay with the customer and let them know someone will follow up.",
  };
}

const implementations = {
  check_availability,
  book_appointment,
  log_inquiry,
  search_products,
  create_order,
  create_support_ticket,
  escalate_to_human,
};

/**
 * Run the local function Gemini asked for.
 * Always returns a plain object (never throws) so the model can explain errors.
 *
 * @param {string} name
 * @param {object} args  arguments chosen by Gemini
 * @param {{ phone?: string, customerName?: string|null }} [ctx]  the chat this call belongs to
 */
async function executeTool(name, args, ctx = {}) {
  const fn = implementations[name];
  if (!fn) {
    console.error(`[tool] Gemini called unknown function: ${name}`);
    return { error: `Unknown function: ${name}` };
  }

  try {
    const result = await fn(args || {}, ctx || {});
    return result && typeof result === "object" ? result : { result };
  } catch (err) {
    console.error(`[tool] ${name} failed:`, err);
    return { error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Gemini function declarations
// The SDK sends this schema to the model so it knows what it can call.
// ---------------------------------------------------------------------------

const functionDeclarations = [
  {
    name: "check_availability",
    description:
      "Look up REAL free appointment slots for a date from the appointments diary and the store's opening hours. Always call this before offering appointment times. Dates must be YYYY-MM-DD.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "Date to check as YYYY-MM-DD (for example 2026-10-12). Work it out from today's date if the customer says 'tomorrow' or 'Monday'." },
        time: { type: Type.STRING, description: "Optional preferred time, e.g. 14:00 or 2pm." },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment ONLY after the customer has confirmed a slot that check_availability showed as free. If it fails, offer the alternative slots it returns.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Customer's full name." },
        phone: { type: Type.STRING, description: "Customer's WhatsApp / phone number." },
        date: { type: Type.STRING, description: "Appointment date as YYYY-MM-DD." },
        time: { type: Type.STRING, description: "Appointment time, e.g. 14:00." },
        purpose: { type: Type.STRING, description: "Why they want the appointment (visit, consultation, fitting, pickup...)." },
      },
      required: ["name", "phone", "date", "time"],
    },
  },
  {
    name: "create_order",
    description:
      "Create an order after the customer has confirmed what they want, how much, and where/when to deliver.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "List of product names the customer wants.",
        },
        quantity: {
          type: Type.STRING,
          description: "Quantity, e.g. '2' or '3 crates'.",
        },
        delivery_address: {
          type: Type.STRING,
          description: "Where to deliver the order.",
        },
        delivery_date: {
          type: Type.STRING,
          description: "Requested delivery date, preferably YYYY-MM-DD.",
        },
        customer_name: {
          type: Type.STRING,
          description: "Customer's full name.",
        },
        phone: {
          type: Type.STRING,
          description: "Customer's WhatsApp / phone number.",
        },
      },
      required: ["items", "quantity", "customer_name", "phone"],
    },
  },
  {
    name: "create_support_ticket",
    description:
      "Open a support ticket when a customer has a problem with an order or needs follow-up that is not a new booking.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        order_ref: {
          type: Type.STRING,
          description: "Existing order reference if the customer has one.",
        },
        issue_description: {
          type: Type.STRING,
          description: "What went wrong, in the customer's words.",
        },
        customer_name: {
          type: Type.STRING,
          description: "Customer's full name.",
        },
        phone: {
          type: Type.STRING,
          description: "Customer's WhatsApp / phone number.",
        },
      },
      required: ["issue_description", "customer_name", "phone"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human teammate. Use when the customer asks for a person, is upset, or the assistant cannot help.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: "Short reason for the handoff.",
        },
        conversation_summary: {
          type: Type.STRING,
          description: "A brief summary of the conversation so far, so the human can pick it up.",
        },
      },
      required: ["reason", "conversation_summary"],
    },
  },
  {
    name: "log_inquiry",
    description:
      "Record a customer's interest or question for the team (a product, price, availability, sizing, a visit) when they are NOT placing an order or booking. Use it quietly, without mentioning it to the customer, then keep helping. Set follow_up_needed true if the team should contact them.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, description: "One of: product, pricing, availability, sizing, delivery, visit, other." },
        summary: { type: Type.STRING, description: "One short line, e.g. 'Wants black leather belt for a party, asked exact price'." },
        details: { type: Type.STRING, description: "Useful details: item, size, occasion, budget, when they need it." },
        follow_up_needed: { type: Type.BOOLEAN, description: "True if a team member should contact the customer." },
      },
      required: ["summary"],
    },
  },
  {
    name: "search_products",
    description:
      "Look up CONFIRMED prices and stock in the store's price list. Call this whenever a customer asks about a specific item, brand, price or availability, and quote only what it returns. If nothing is found, never guess.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Words to search for, e.g. 'santoni loafers' or 'amouage'." },
        category: { type: Type.STRING, description: "Optional category, e.g. shoes, fragrances, belts, suits." },
      },
      required: ["query"],
    },
  },
];

module.exports = {
  describeHours,
  normalizeTime,
  availableSlots,
  log_inquiry,
  search_products,
  check_availability,
  book_appointment,
  create_order,
  create_support_ticket,
  escalate_to_human,
  executeTool,
  functionDeclarations,
};