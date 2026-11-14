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

/**
 * Stub calendar check. Later, replace the dummy slots with a real calendar
 * (Google Calendar, or by excluding times already in the appointments table).
 */
async function check_availability({ date, time } = {}) {
  console.log("[tool] check_availability", { date, time });

  const slots = ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"];

  const requested = String(time || "").trim();
  const requestedAvailable =
    !requested ||
    slots.some((slot) => requested.includes(slot) || slot.includes(requested));

  return {
    date: date || null,
    requested_time: time || null,
    requested_time_available: requestedAvailable,
    available_slots: slots,
    timezone: "Africa/Kampala",
    note: "These are dummy slots. Connect a real calendar later.",
  };
}

/**
 * Save an appointment (appointments table).
 */
async function book_appointment(
  { name, phone, date, time, purpose } = {},
  ctx = {}
) {
  console.log("[tool] book_appointment", { name, phone, date, time, purpose });

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
      clip(name, 150),
      clip(date, 60),
      clip(time, 40),
      clip(purpose, 500),
    ]
  );

  return {
    success: true,
    appointment_id: ref,
    name: name || null,
    phone: phone || null,
    date: date || null,
    time: time || null,
    purpose: purpose || null,
    message: "Appointment logged. A team member will confirm if needed.",
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
      "Check appointment availability for a given date and optional preferred time. Returns dummy slots until a real calendar is connected.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: {
          type: Type.STRING,
          description: "Date to check, preferably YYYY-MM-DD (e.g. 2026-09-22).",
        },
        time: {
          type: Type.STRING,
          description: "Preferred time, e.g. 14:00 or 2pm. Use 'any' if the customer has no preference.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment after the customer has confirmed the details. Do not call this until name, phone, date, and time are known.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: "Customer's full name.",
        },
        phone: {
          type: Type.STRING,
          description: "Customer's WhatsApp / phone number.",
        },
        date: {
          type: Type.STRING,
          description: "Appointment date, preferably YYYY-MM-DD.",
        },
        time: {
          type: Type.STRING,
          description: "Appointment time, e.g. 14:00.",
        },
        purpose: {
          type: Type.STRING,
          description: "Why they want the appointment (visit, consultation, pickup, etc.).",
        },
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
];

module.exports = {
  check_availability,
  book_appointment,
  create_order,
  create_support_ticket,
  escalate_to_human,
  executeTool,
  functionDeclarations,
};