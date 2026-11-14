/**
 * memory.js  (CommonJS build, MySQL-backed)
 *
 * What GEMINI remembers about each customer, keyed by WhatsApp phone number.
 * (The visible chat log that staff read lives in the `messages` table, which
 * chatStore.js writes. This file stores the model-facing history, including
 * tool calls, so it survives server restarts.)
 *
 * Same exported function names as the old in-memory version, but
 * getHistory / saveHistory / appendMessages are now ASYNC - always `await` them.
 *
 * .env:
 *   MAX_STORED_MESSAGES   how many recent turns to keep (default 30).
 *                         Smaller = faster, cheaper Gemini calls.
 */

const db = require("./db.js");

/** @typedef {{ role: string, content?: string, parts?: object[], timestamp?: string }} StoredMessage */

const MAX_STORED_MESSAGES = Number(process.env.MAX_STORED_MESSAGES) || 30;

/**
 * Load a customer's stored history (empty array if none yet).
 * @param {string} phone
 * @returns {Promise<StoredMessage[]>}
 */
async function getHistory(phone) {
  const row = await db.one(
    "SELECT history_json FROM bot_history WHERE phone = ?",
    [String(phone)]
  );
  if (!row) return [];

  try {
    const parsed = JSON.parse(row.history_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(
      `[memory] Stored history for ${phone} is not valid JSON; starting fresh.`
    );
    return [];
  }
}

/**
 * Overwrite a customer's history (keeps only the most recent turns).
 * @param {string} phone
 * @param {StoredMessage[]} messages
 */
async function saveHistory(phone, messages) {
  const trimmed = Array.isArray(messages)
    ? messages.slice(-MAX_STORED_MESSAGES)
    : [];

  await db.run(
    `INSERT INTO bot_history (phone, history_json, updated_at)
     VALUES (?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       history_json = VALUES(history_json),
       updated_at = UTC_TIMESTAMP(3)`,
    [String(phone), JSON.stringify(trimmed)]
  );
}

/**
 * Append one or more turns, then return the updated history.
 * @param {string} phone
 * @param {StoredMessage | StoredMessage[]} messages
 * @returns {Promise<StoredMessage[]>}
 */
async function appendMessages(phone, messages) {
  const list = await getHistory(phone);
  const extra = Array.isArray(messages) ? messages : [messages];
  const stamped = extra.map((msg) => ({
    timestamp: new Date().toISOString(),
    ...msg,
  }));
  const updated = list.concat(stamped).slice(-MAX_STORED_MESSAGES);
  await saveHistory(phone, updated);
  return updated;
}

/**
 * Convert our stored messages into the Content[] array the Gemini SDK expects.
 * @param {StoredMessage[]} stored
 * @returns {Array<{ role: string, parts: object[] }>}
 */
function toGeminiHistory(stored) {
  const contents = [];

  for (const msg of stored || []) {
    const role = storedRoleToGeminiRole(msg.role);
    if (!role) continue;

    let parts = Array.isArray(msg.parts) ? msg.parts.filter(Boolean) : [];

    // Older / simpler rows may only have { role, content }.
    if (parts.length === 0) {
      parts = partsFromSimpleMessage(msg);
    }

    if (parts.length === 0) continue;

    contents.push({ role, parts });
  }

  // chats.create() needs the history to START with a normal customer message.
  // Because we only keep the most recent turns, the cut can land in the middle
  // of a tool exchange, leaving a "tool result" with no matching tool call at
  // the front - Gemini rejects that with a 400 error. Drop such leading turns.
  while (contents.length > 0 && !isPlainUserTurn(contents[0])) {
    contents.shift();
  }

  return contents;
}

function isPlainUserTurn(content) {
  return (
    content.role === "user" &&
    !content.parts.some((part) => part.functionResponse)
  );
}

/**
 * Convert Gemini Content[] (for example chat.getHistory()) back into
 * our stored format.
 * @param {Array<{ role: string, parts?: object[] }>} contents
 * @returns {StoredMessage[]}
 */
function fromGeminiHistory(contents) {
  const now = new Date().toISOString();

  return (contents || []).map((content) => {
    const parts = content.parts || [];

    // @google/genai never sets role "function". Tool results come back as
    // role "user" with functionResponse parts. Detect those so logs/UI
    // can tell them apart from real customer messages.
    const hasFunctionResponse = parts.some((part) => part.functionResponse);
    let role = content.role;
    if (content.role === "function" || content.role === "tool" || hasFunctionResponse) {
      role = "tool";
    }

    return {
      role,
      content: readableText(parts),
      parts,
      timestamp: now,
    };
  });
}

function storedRoleToGeminiRole(role) {
  if (role === "user") return "user";
  if (role === "model") return "model";
  // Tool results must be sent as role "user". chats.create() throws:
  //   "Role must be user or model, but got function."
  if (role === "tool" || role === "function") return "user";
  return null;
}

function partsFromSimpleMessage(msg) {
  if (msg.functionCalls && msg.functionCalls.length > 0) {
    return msg.functionCalls.map((call) => ({
      functionCall: {
        name: call.name,
        args: call.args || {},
      },
    }));
  }

  if (msg.functionResponses && msg.functionResponses.length > 0) {
    return msg.functionResponses.map((fr) => ({
      functionResponse: {
        name: fr.name,
        response: asObject(fr.response),
      },
    }));
  }

  if (msg.name && msg.args && msg.role === "model") {
    return [{ functionCall: { name: msg.name, args: msg.args } }];
  }

  if (msg.role === "tool" && (msg.name || msg.content)) {
    return [
      {
        functionResponse: {
          name: msg.name || "unknown",
          response: asObject(parseToolContent(msg.content)),
        },
      },
    ];
  }

  if (msg.content) {
    return [{ text: msg.content }];
  }

  return [];
}

function readableText(parts) {
  return (parts || [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseToolContent(content) {
  if (content == null) return { result: null };
  if (typeof content === "object") return content;
  try {
    return JSON.parse(content);
  } catch {
    return { result: String(content) };
  }
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return { result: value };
}

module.exports = {
  getHistory,
  saveHistory,
  appendMessages,
  toGeminiHistory,
  fromGeminiHistory,
};