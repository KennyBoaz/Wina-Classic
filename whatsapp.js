/**
 * whatsapp.js  (CommonJS build)
 *
 * Talks to Meta's WhatsApp Cloud API:
 *   - parse incoming webhook payloads (customer messages AND delivery receipts)
 *   - send text replies back to the customer
 *   - (optional) show the "typing..." indicator while Gemini is thinking
 *
 * CHANGES IN PHASE 1
 * ------------------
 * - sendWhatsAppText() now returns a list of results, one per message chunk:
 *       [{ text, id, ok, error }]
 *   so server.js can save each sent message (with its WhatsApp id) in the
 *   database and the dashboard can show delivery ticks and failures.
 * - parseStatusUpdates() reads Meta's delivery receipts (sent / delivered /
 *   read / failed). Before, these were ignored.
 * - A send is only retried when the request clearly never reached Meta
 *   (connection refused / DNS failure) or Meta answered with a 5xx error.
 *   Timeouts are NOT retried, to avoid sending the customer the same
 *   message twice.
 */

const axios = require("axios");
const https = require("https");

// Graph API version. Bump this if Meta asks you to use a newer version.
const GRAPH_API_VERSION = "v22.0";

// WhatsApp text messages cannot be longer than this.
const MAX_TEXT_LENGTH = 4096;

const SEND_ATTEMPTS = 2;

// Network errors where the request definitely did not reach Meta.
const SAFE_RETRY_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

const graph = axios.create({
  baseURL: "https://graph.facebook.com",
  timeout: 15000,
  httpsAgent: new https.Agent({ keepAlive: true }),
  headers: { "Content-Type": "application/json" },
});

function getConfig() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error(
      "Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID in your .env file."
    );
  }

  return { token, phoneNumberId };
}

/**
 * Pull useful fields out of one WhatsApp message object.
 * Handles text, button taps, list replies, and a few media types.
 */
function extractText(message) {
  if (!message) return "";

  switch (message.type) {
    case "text":
      return message.text?.body || "";
    case "button":
      return message.button?.text || message.button?.payload || "";
    case "interactive": {
      const interactive = message.interactive || {};
      return (
        interactive.button_reply?.title ||
        interactive.list_reply?.title ||
        interactive.nfm_reply?.response_json ||
        ""
      );
    }
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker": {
      const caption =
        message[message.type]?.caption ||
        message.image?.caption ||
        message.video?.caption ||
        message.document?.caption ||
        "";
      return caption
        ? `[Customer sent a ${message.type}: ${caption}]`
        : `[Customer sent a ${message.type}]`;
    }
    case "location": {
      const loc = message.location || {};
      return `[Location: ${loc.latitude}, ${loc.longitude}]`;
    }
    default:
      return "";
  }
}

/**
 * Walk the nested Meta webhook body and return a flat list of incoming
 * customer messages. Delivery receipts are handled by parseStatusUpdates().
 *
 * @param {object} body  req.body from POST /webhook
 * @returns {Array<{ id: string, from: string, name: string|null, type: string, text: string, timestamp: string }>}
 */
function parseIncomingMessages(body) {
  const incoming = [];
  const entries = body?.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      // Delivery receipts look similar but have "statuses" instead of "messages"
      if (!value.messages) continue;

      const name = value.contacts?.[0]?.profile?.name || null;

      for (const message of value.messages) {
        incoming.push({
          id: message.id,
          from: message.from,
          name,
          type: message.type,
          text: extractText(message),
          timestamp: message.timestamp,
          // the message this one is a reply to (WhatsApp "quote"), if any
          replyTo: (message.context && message.context.id) || null,
          // set when the customer reacted with an emoji to one of our messages
          reaction: message.type === "reaction"
            ? { messageId: (message.reaction && message.reaction.message_id) || null, emoji: (message.reaction && message.reaction.emoji) || "" }
            : null,
        });
      }
    }
  }

  return incoming;
}

/**
 * Walk the webhook body and return delivery receipts for messages WE sent.
 *
 * @param {object} body  req.body from POST /webhook
 * @returns {Array<{ id: string, status: string, timestamp: string, recipient: string, errorText: string|null }>}
 *          status is one of: sent, delivered, read, failed
 */
function parseStatusUpdates(body) {
  const updates = [];

  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const status of value.statuses || []) {
        const error = Array.isArray(status.errors) ? status.errors[0] : null;
        let errorText = null;

        if (error) {
          const detail = error.error_data?.details;
          errorText = `${error.code ?? "error"}: ${error.title || error.message || "send failed"}${
            detail ? ` - ${detail}` : ""
          }`.slice(0, 480);
        }

        updates.push({
          id: status.id,
          status: status.status,
          timestamp: status.timestamp,
          recipient: status.recipient_id,
          errorText,
        });
      }
    }
  }

  return updates;
}

/**
 * Split a long reply into chunks WhatsApp will accept.
 */
function chunkText(text) {
  const value = String(text || "").trim();
  if (!value) return [];
  if (value.length <= MAX_TEXT_LENGTH) return [value];

  const chunks = [];
  let remaining = value;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_TEXT_LENGTH));
    remaining = remaining.slice(MAX_TEXT_LENGTH);
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short, human-readable reason a send failed (saved with the message). */
function describeSendError(err) {
  const apiError = err.response?.data?.error;
  if (apiError) {
    const detail = apiError.error_data?.details;
    return `${apiError.code ?? err.response.status}: ${
      apiError.message || apiError.type || "send failed"
    }${detail ? ` - ${detail}` : ""}`.slice(0, 480);
  }
  return String(err.code || err.message || "send failed").slice(0, 480);
}

/**
 * Send a text message to a WhatsApp user (split into several messages if it
 * is longer than WhatsApp allows).
 *
 * @param {string} to    Customer phone number (WhatsApp id, usually digits only)
 * @param {string} body  Message text
 * @returns {Promise<Array<{ text: string, id: string|null, ok: boolean, error: string|null }>>}
 *          one entry per chunk; [] if there was nothing to send
 */
async function sendWhatsAppText(to, body, opts = {}) {
  const { token, phoneNumberId } = getConfig();
  const url = `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const chunks = chunkText(body);

  if (chunks.length === 0) {
    console.warn("[whatsapp] Tried to send an empty message; skipped.");
    return [];
  }

  const results = [];

  for (const chunk of chunks) {
    const result = { text: chunk, id: null, ok: false, error: null };

    for (let attempt = 1; attempt <= SEND_ATTEMPTS && !result.ok; attempt += 1) {
      try {
        const response = await graph.post(
          url,
          {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { preview_url: false, body: chunk },
            // quote an earlier message (only on the first part of a long reply)
            ...(opts.replyTo && chunk === chunks[0] ? { context: { message_id: opts.replyTo } } : {}),
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        result.id = response.data?.messages?.[0]?.id || null;
        result.ok = true;
        result.error = null;
        console.log(
          `[whatsapp] Sent reply to ${to}` + (result.id ? ` (id ${result.id})` : "")
        );
      } catch (err) {
        const status = err.response?.status;
        const retryable =
          (status && status >= 500) || SAFE_RETRY_CODES.includes(err.code);

        result.error = describeSendError(err);

        if (retryable && attempt < SEND_ATTEMPTS) {
          console.warn(
            `[whatsapp] Send attempt ${attempt} failed (${status || err.code || err.message}). Retrying...`
          );
          await sleep(500);
          continue;
        }

        logWhatsAppError(err, to);
        break;
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Mark the customer's message as read and show the "typing..." indicator.
 * Fire-and-forget: never throws, never blocks the reply. If your Meta app
 * version does not support the typing indicator, the failure is only logged.
 *
 * @param {string} messageId  the incoming message id (wamid...)
 */
function markReadAndTyping(messageId) {
  if (!messageId) return;

  let config;
  try {
    config = getConfig();
  } catch {
    return;
  }

  graph
    .post(
      `/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      { headers: { Authorization: `Bearer ${config.token}` } }
    )
    .catch((err) => {
      const status = err.response?.status;
      if (status === 401 || err.response?.data?.error?.code === 190) {
        logWhatsAppError(err, "(read receipt)");
      } else {
        console.warn(
          `[whatsapp] Typing indicator skipped (${status || err.message}).`
        );
      }
    });
}

function logWhatsAppError(err, to) {
  const status = err.response?.status;
  const data = err.response?.data;
  const code = data?.error?.code;

  // Expired / invalid access token. Replies are NOT being delivered.
  if (status === 401 || code === 190) {
    console.error("============================================================");
    console.error("  WHATSAPP AUTH ERROR (HTTP 401 / code 190)");
    console.error("  Your WHATSAPP_TOKEN is expired or invalid.");
    console.error("  Replies are NOT reaching customers until you replace it.");
    console.error("  Fix: create a System User token in Meta Business Settings");
    console.error("  (never-expiring), update .env, then restart the app.");
    console.error("============================================================");
    console.error(`[whatsapp] Failed to send to ${to}:`, JSON.stringify(data, null, 2));
    return;
  }

  if (status === 429) {
    console.error(
      `[whatsapp] RATE LIMIT (HTTP 429) while sending to ${to}. Meta is throttling this number. Wait and retry later.`
    );
    console.error("[whatsapp] Response body:", JSON.stringify(data, null, 2));
    return;
  }

  console.error(`[whatsapp] Failed to send message to ${to}.`);
  if (status) {
    console.error(`[whatsapp] HTTP ${status}:`, JSON.stringify(data, null, 2));
  } else {
    console.error("[whatsapp]", err.message || err);
  }
}

/**
 * React to a customer's message with an emoji (emoji "" removes our reaction).
 * WhatsApp refuses reactions to messages older than 30 days or already deleted.
 * @returns {Promise<{ ok: boolean, id: string|null, error: string|null }>}
 */
async function sendWhatsAppReaction(to, messageId, emoji) {
  const { token, phoneNumberId } = getConfig();
  try {
    const response = await graph.post(
      `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "reaction",
        reaction: { message_id: messageId, emoji },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { ok: true, id: (response.data && response.data.messages && response.data.messages[0] && response.data.messages[0].id) || null, error: null };
  } catch (err) {
    logWhatsAppError(err, to);
    return { ok: false, id: null, error: describeSendError(err) };
  }
}

module.exports = {
  sendWhatsAppReaction,
  parseIncomingMessages,
  parseStatusUpdates,
  sendWhatsAppText,
  markReadAndTyping,
};