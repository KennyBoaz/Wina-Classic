/**
 * server.js  (CommonJS build - required for cPanel's lsnode.js loader)
 *
 * Express app:
 *   GET  /webhook  - Meta's verification handshake
 *   POST /webhook  - incoming WhatsApp messages + delivery receipts
 *   GET  /health   - is the app (and the database) alive?
 *
 * Meta retries the webhook if we take more than a few seconds, so we send
 * HTTP 200 immediately and process the message in the background.
 *
 * CHANGES IN PHASE 2 (dashboard API)
 * -----------------------------------
 * - /api/*    the staff dashboard API (login, chats, replies, orders...)
 * - /admin/*  the dashboard pages (static files in ./public/admin)
 *
 * CHANGES IN PHASE 1 (database)
 * -----------------------------
 * 1. Every customer message and every reply is saved in MySQL
 *    (tables: customers, conversations, messages) for the dashboard.
 * 2. Delivery receipts from Meta (sent / delivered / read / failed) update
 *    the saved messages, so the dashboard can show ticks and failures.
 * 3. HUMAN MODE: if a conversation is set to mode = 'human', the customer's
 *    message is saved but Gemini is NOT called (staff will answer).
 * 4. Duplicate detection also works across restarts (database check).
 * 5. If the database is down the bot still answers (it just can't remember
 *    or save), and the problem is logged loudly. /health shows the DB state.
 */

require("dotenv").config();
const express = require("express");
const {
  parseIncomingMessages,
  parseStatusUpdates,
  sendWhatsAppText,
  markReadAndTyping,
} = require("./whatsapp.js");
const { generateReply } = require("./gemini.js");
const { getHistory, saveHistory } = require("./memory.js");
const chatStore = require("./chatStore.js");
const db = require("./db.js");
const path = require("path");
const { createApiRouter } = require("./routes/index.js");

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// ---------------------------------------------------------------------------
// Step-by-step trace (for "the bot did not reply" problems)
// ---------------------------------------------------------------------------
// Written with console.error because stderr.log is the log file this host
// reliably keeps; normal console.log output may not be saved anywhere.
// Each message prints numbered steps. The LAST step you see tells you where
// it stopped. Set BOT_TRACE=false in .env to switch this off later.
const TRACE = String(process.env.BOT_TRACE || "true").toLowerCase() !== "false";

function trace(id, step) {
  if (!TRACE) return;
  console.error(`[trace] ${new Date().toISOString()} ...${String(id).slice(-8)} ${step}`);
}

// If Gemini takes longer than this, give up, tell the customer a team member
// will follow up, and flag the chat for staff (instead of silence).
const GEMINI_STEP_TIMEOUT_MS = Number(process.env.GEMINI_STEP_TIMEOUT_MS) || 90000;
const FALLBACK_REPLY =
  "Sorry, we're having a technical problem right now. A member of our team will get back to you shortly.";

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

if (TRACE) {
  // If this line appears BETWEEN a customer message and its reply in
  // stderr.log, the host restarted the app while it was working on the reply.
  console.error(
    `[boot] ${new Date().toISOString()} process started (pid ${process.pid})`
  );
  process.on("SIGTERM", () => {
    console.error("[process] SIGTERM received - the host is stopping this app.");
    process.exit(0);
  });
}

const app = express();

// Keep query keys as Meta sends them: hub.mode, hub.verify_token, hub.challenge.
app.set("query parser", "simple");

// Parse JSON bodies from Meta.
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// Routing note for this specific host (cPanel + LiteSpeed Node.js Selector)
// ---------------------------------------------------------------------------
// LiteSpeed's proxy does NOT strip the Application URL prefix, so the app
// receives e.g. /winaclassic/webhook. All routes live on one Router that is
// mounted at BOTH the bare path and the prefix.
const MOUNT_PREFIX = process.env.APP_MOUNT_PREFIX || "/winaclassic";

const router = express.Router();

/**
 * Meta's webhook verification (the "Verify and save" handshake).
 */
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"] || req.query.hub?.mode;
  const token = req.query["hub.verify_token"] || req.query.hub?.verify_token;
  const challenge = req.query["hub.challenge"] || req.query.hub?.challenge;

  console.log("[webhook] Verification request", { mode, tokenSet: Boolean(token) });

  if (!VERIFY_TOKEN) {
    console.error("[webhook] WEBHOOK_VERIFY_TOKEN is not set in .env");
    return res.sendStatus(500);
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] Verification succeeded.");
    return res.status(200).send(String(challenge));
  }

  console.warn("[webhook] Verification failed. Token did not match.");
  return res.sendStatus(403);
});

/**
 * Incoming messages and delivery receipts. Always 200 quickly.
 */
router.post("/webhook", (req, res) => {
  res.sendStatus(200);

  processWebhook(req.body).catch((err) => {
    console.error("[webhook] Uncaught error while processing payload:", err);
  });
});

/**
 * Health check (use it with an uptime monitor too). Returns 503 if the
 * database cannot be reached.
 */
router.get("/health", async (_req, res) => {
  let dbOk = false;
  try {
    dbOk = await db.ping();
  } catch (err) {
    console.error("[health] Database check failed:", err.message);
  }
  res
    .status(dbOk ? 200 : 503)
    .json({ ok: dbOk, db: dbOk, service: "wina-classic-whatsapp-bot" });
});

router.get("/", (_req, res) => {
  res
    .status(200)
    .send("Wina Classic Uganda WhatsApp bot is running. Webhook: POST /webhook");
});

// ---------------------------------------------------------------------------
// Staff dashboard (Phase 2)
// ---------------------------------------------------------------------------
function adminHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: https://winaclassic.ug; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
}

router.use("/api", createApiRouter());
router.use("/admin", adminHeaders, express.static(path.join(__dirname, "public", "admin")));

app.use(router);
app.use(MOUNT_PREFIX, router);

// Last resort: any error that reaches here becomes a small JSON reply
// (for example a malformed JSON body) instead of an HTML error page.
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error("[server] Unhandled error:", err);
  res.status(status).json({ error: status >= 500 ? "Server error." : err.message || "Bad request." });
});

// ---------------------------------------------------------------------------
// Background processing
// ---------------------------------------------------------------------------

// Quick in-memory duplicate filter (the database check in chatStore is the
// real one and survives restarts).
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 2000;

function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.add(id);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
  return false;
}

// One customer can send two messages quickly. Queue work per phone so
// history does not get tangled.
const phoneQueues = new Map();

function enqueueForPhone(phone, task) {
  const previous = phoneQueues.get(phone) || Promise.resolve();
  const next = previous.then(task, task);
  phoneQueues.set(phone, next);
  next.finally(() => {
    if (phoneQueues.get(phone) === next) {
      phoneQueues.delete(phone);
    }
  });
  return next;
}

async function processWebhook(body) {
  // 1) Delivery receipts for messages WE sent. These do not need the
  //    per-customer queue; update them in the background.
  for (const update of parseStatusUpdates(body)) {
    chatStore.applyStatusUpdate(update).catch((err) => {
      console.error("[db] Could not save a delivery receipt:", err.message);
    });
  }

  // 2) Incoming customer messages.
  const messages = parseIncomingMessages(body);
  if (messages.length === 0) return;

  for (const message of messages) {
    enqueueForPhone(message.from, () =>
      handleIncomingMessage(message).catch((err) => {
        console.error(`[webhook] Error handling message ${message.id}:`, err);
      })
    );
  }
}

/**
 * Send a reply and save each sent message (with its WhatsApp id and whether
 * Meta accepted it) in the database.
 * Returns true only if every part of the message was accepted by Meta.
 */
async function sendAndRecord(to, body, senderType = "bot") {
  let results;
  try {
    results = await sendWhatsAppText(to, body);
  } catch (err) {
    console.error(`[whatsapp] Could not send to ${to}:`, err.message);
    results = [{ text: body, id: null, ok: false, error: err.message }];
  }

  for (const result of results) {
    try {
      await chatStore.recordOutgoing({
        phone: to,
        body: result.text,
        senderType,
        waMessageId: result.id,
        status: result.ok ? "sent" : "failed",
        error: result.error,
      });
    } catch (err) {
      console.error("[db] Could not save the outgoing message:", err.message);
    }
  }

  return results.length > 0 && results.every((result) => result.ok);
}

async function handleIncomingMessage(message) {
  const { id, from, name, type, text, timestamp } = message;
  const receivedAt = Date.now();

  if (alreadyProcessed(id)) {
    console.log(`[webhook] Skipping duplicate message ${id}`);
    return;
  }

  // Emoji reactions are not messages we answer or store.
  if (type === "reaction") {
    return;
  }

  // How old was the message by the time it reached our code? A big number
  // here means the delay is BEFORE your server (Meta / network / LiteSpeed
  // cold start). Includes small clock drift, so ignore a few seconds.
  const ageSec = timestamp ? Math.round(receivedAt / 1000 - Number(timestamp)) : "?";
  console.log(
    `[webhook] ${from} (${name || "unknown"}) sent ${type}: ${text || "(empty)"}`
  );
  console.log(`[timing] ${id} reached handler ${ageSec}s after WhatsApp timestamp`);
  trace(id, `1 message from ${from} reached the handler (${ageSec}s after WhatsApp timestamp)`);

  // Save the customer's message first. This also tells us if it is a
  // duplicate and whether a staff member has taken over this chat.
  let conversation = null;
  try {
    const saved = await chatStore.recordIncoming(message);
    if (saved.duplicate) {
      console.log(`[webhook] Skipping duplicate message ${id} (already in database)`);
      trace(id, "duplicate (already in database) - skipped");
      return;
    }
    conversation = saved.conversation;
  } catch (err) {
    console.error(
      "[db] Could not save the incoming message. The bot will still reply:",
      err.message
    );
  }
  trace(
    id,
    `2 saved to database (chat mode: ${
      conversation ? conversation.mode : "UNKNOWN - database problem"
    })`
  );

  // HUMAN MODE: staff are handling this customer. Saved, but no AI reply.
  if (conversation && conversation.mode === "human") {
    console.log(`[webhook] ${from} is in HUMAN mode - message saved, bot stays silent.`);
    trace(id, "HUMAN mode - bot stays silent on purpose");
    return;
  }

  // Read receipt + "typing..." (fire-and-forget, does not slow anything down)
  markReadAndTyping(id);

  if (!text) {
    await sendAndRecord(
      from,
      "I can read text messages on WhatsApp. Please type your question and I will help."
    );
    return;
  }

  let history = [];
  try {
    history = await getHistory(from);
  } catch (err) {
    console.error(
      "[db] Could not load the chat history. Answering without it:",
      err.message
    );
  }
  trace(id, `3 history loaded (${history.length} stored turns)`);

  trace(id, "4 asking Gemini...");
  const geminiStartedAt = Date.now();
  let result;
  try {
    result = await withTimeout(
      generateReply({
        userMessage: text,
        history,
        phone: from,
        customerName: name,
      }),
      GEMINI_STEP_TIMEOUT_MS,
      "Gemini step"
    );
  } catch (err) {
    console.error(`[bot] Gemini step failed: ${err.message}`);
    trace(id, `4x Gemini step FAILED (${err.message}) - sending a fallback reply`);
    await sendAndRecord(from, FALLBACK_REPLY, "bot");
    try {
      await chatStore.markEscalated(from);
    } catch (flagErr) {
      console.error("[db] Could not flag the chat for staff:", flagErr.message);
    }
    return;
  }
  const { reply, updatedHistory } = result;
  console.log(`[timing] ${id} Gemini step took ${Date.now() - geminiStartedAt}ms`);
  trace(id, `5 Gemini answered in ${Date.now() - geminiStartedAt}ms`);

  // Did a staff member take over while Gemini was thinking? Then do not send
  // the bot's reply on top of theirs.
  try {
    const latest = await chatStore.getConversation(from);
    if (latest && latest.mode === "human") {
      console.log(
        `[webhook] Staff took over ${from} while the bot was thinking - bot reply discarded.`
      );
      trace(id, "staff took over while Gemini was thinking - bot reply discarded");
      return;
    }
  } catch (err) {
    // If we cannot check, carry on and send the reply.
  }

  try {
    await saveHistory(from, updatedHistory);
  } catch (err) {
    console.error("[db] Could not save the chat history:", err.message);
  }
  trace(id, "6 history saved");

  trace(id, "7 sending the reply to WhatsApp...");
  const sendStartedAt = Date.now();
  const delivered = await sendAndRecord(from, reply, "bot");
  console.log(
    `[timing] ${id} WhatsApp send took ${Date.now() - sendStartedAt}ms ` +
      `(${delivered ? "accepted by Meta" : "NOT delivered - check errors above"}); ` +
      `total ${Date.now() - receivedAt}ms`
  );
  trace(
    id,
    `8 finished: ${delivered ? "accepted by Meta" : "NOT delivered"} (total ${Date.now() - receivedAt}ms)`
  );
}

function warnIfMissingEnv() {
  const required = [
    "WHATSAPP_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WEBHOOK_VERIFY_TOKEN",
    "GEMINI_API_KEY",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(
      "[boot] Missing environment variables:",
      missing.join(", "),
      "- add them to your .env file."
    );
  }
}

// IMPORTANT: no port is passed here on purpose.
// cPanel's LiteSpeed Node.js Selector patches http.Server.listen() so that
// calling it with no arguments binds to the internal socket LiteSpeed's
// proxy expects. Passing an explicit port makes the app start fine but
// LiteSpeed will never reach it (shows up as a 503).
// If you move this app off cPanel (Render, Railway, a VPS...), change this
// to app.listen(PORT, ...) with const PORT = Number(process.env.PORT) || 3000;
app.listen(() => {
  warnIfMissingEnv();
  console.log("Wina Classic WhatsApp bot listening (LiteSpeed-managed socket)");
  console.log(`Webhook URL path: /webhook`);
  console.log(
    `Gemini models: ${process.env.GEMINI_MODEL || "gemini-3.7-flash"} (fallback ${
      process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash"
    })`
  );

  db.ping()
    .then(() => console.log("[boot] Database connection OK."))
    .catch((err) =>
      console.error(
        "[boot] DATABASE CONNECTION FAILED:",
        err.message,
        "- check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in .env and that the schema was imported."
      )
    );
});