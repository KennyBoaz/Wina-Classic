/**
 * gemini.js  (CommonJS build)
 *
 * Sends the customer's message + history + tools to Gemini, runs any
 * function calls locally, then returns Gemini's final natural-language reply.
 *
 * Package: @google/genai
 *
 * WHAT CHANGED IN THIS VERSION
 * ----------------------------
 * A. NO MORE "THINKING OUT LOUD" IN REPLIES
 *    The model sometimes wrote its planning ("Now let's reply warmly to Kenny...")
 *    in front of the real message, and customers saw it. Now:
 *      - the model is told to put the customer's message inside <reply> tags;
 *      - only what is inside the tags is sent (planning outside is thrown away);
 *      - if the tags are missing, a filter removes obvious planning sentences;
 *      - saved chat history is cleaned the same way, so old leaked turns stop
 *        teaching the model to do it again.
 * B. THE BOT CAN SEE PHOTOS AND PDFs
 *    generateReply() accepts attachments [{ mimeType, data (base64) }]. They are
 *    shown to Gemini for THIS reply only and are never saved in the chat history
 *    (history keeps just the text), so the history stays small.
 *
 * (Earlier changes, still here: request timeout, model health memory with
 * cooldown, fewer retries, one shared client, timing logs, optional
 * GEMINI_THINKING_LEVEL.)
 *
 * ENV VARS
 * --------
 *   GEMINI_API_KEY            required
 *   GEMINI_MODEL              primary model   (default: gemini-3.7-flash)
 *   GEMINI_FALLBACK_MODEL     fallback model  (default: gemini-3.8-flash)
 *   GEMINI_TIMEOUT_MS         per-request timeout   (default: 30000)
 *   GEMINI_COOLDOWN_MS        how long a failing model is skipped (default: 300000 = 5 min)
 *   GEMINI_THINKING_LEVEL     optional, e.g. "low" or "minimal". Leave unset to use the default.
 *
 * Confirm model names at https://ai.google.dev/gemini-api/docs/models
 */

const { GoogleGenAI } = require("@google/genai");
const { SYSTEM_PROMPT } = require("./systemPrompt.js");
const { functionDeclarations, executeTool, describeHours } = require("./tools.js");
const { toGeminiHistory, fromGeminiHistory } = require("./memory.js");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash";

// De-duplicated in case both env vars point at the same model.
const MODEL_CANDIDATES = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter(
  (model, index, arr) => model && arr.indexOf(model) === index
);

// Safety valve so a confused model cannot loop on tools forever.
const MAX_TOOL_ROUNDS = 6;

// Retry tuning (worst case per model is now ~0.5s of backoff + request time).
const MAX_ATTEMPTS_PER_MODEL = 2;
const BASE_RETRY_DELAY_MS = 500;

// A single Gemini request that takes longer than this is abandoned.
// NOTE: the SDK also sends this to Google as a server-side deadline, so a
// value that is too low produces "504 DEADLINE_EXCEEDED" from Google itself.
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30000;

// How long a model that just failed is skipped for.
const COOLDOWN_MS = Number(process.env.GEMINI_COOLDOWN_MS) || 5 * 60 * 1000;

// model name -> timestamp (ms) until which it should be skipped
const modelDownUntil = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One shared client so HTTPS connections can be reused between messages.
let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in your .env file.");
  }
  cachedClient = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Model health tracking
// ---------------------------------------------------------------------------

function markModelDown(model, reason) {
  modelDownUntil.set(model, Date.now() + COOLDOWN_MS);
  console.warn(
    `[gemini] Marking "${model}" as unavailable for ${Math.round(
      COOLDOWN_MS / 1000
    )}s (${reason}). Later messages will skip it.`
  );
}

/**
 * Healthy models first, models in cooldown last (still tried as a last
 * resort, so we never end up with an empty list).
 */
function orderedModels() {
  const now = Date.now();
  const healthy = [];
  const down = [];
  for (const model of MODEL_CANDIDATES) {
    if ((modelDownUntil.get(model) || 0) > now) down.push(model);
    else healthy.push(model);
  }
  return [...healthy, ...down];
}

// ---------------------------------------------------------------------------
// Config / response helpers
// ---------------------------------------------------------------------------

/**
 * Rules added to your system prompt (they take priority over it). Opening hours come from
 * BUSINESS_HOURS in .env. Optional .env lines: DELIVERY_INFO, PAYMENT_INFO, RETURNS_INFO.
 */
function buildExtraRules() {
  const lines = [
    "ADDITIONAL RULES (these take priority over anything above)",
    "- OUTPUT FORMAT: write ONLY the message the customer will read, inside <reply> and </reply> tags, like <reply>Hello!</reply>. Put nothing outside the tags: no planning, no notes to yourself, no description of what you are about to say. The customer never sees your thinking.",
    `- Opening hours: ${describeHours()} (Africa/Kampala). Use exactly these if a customer asks.`,
    "- Prices and stock: when a customer asks about a specific item, brand, price or availability, call search_products first and quote ONLY the prices and stock it returns. If nothing is found, never guess: say you will check with the team and call log_inquiry with follow_up_needed true.",
    "- Appointments: call check_availability for the date before offering times and offer only the slots it returns. Call book_appointment only after the customer confirms a slot. If booking fails, offer the alternative slots it returns. Dates must be YYYY-MM-DD.",
    "- Interest without an order: when a customer shows interest in a product, occasion, price or visit but is not ordering or booking, call log_inquiry quietly (follow_up_needed true if the team should contact them), then carry on helping. Never mention that you logged it.",
    "- Photos and files: a message like [Customer sent a image: ...] means the customer sent a photo. If the photo or PDF is attached to this message, look at it and use what you see (for example an event invitation, a colour, an outfit). Never claim you saw something you cannot see. For voice notes, videos or files you cannot open, say so briefly, ask the customer to type what they need, or offer to connect them with a team member.",
  ];
  if (process.env.DELIVERY_INFO) lines.push(`- Delivery: ${process.env.DELIVERY_INFO}`);
  if (process.env.PAYMENT_INFO) lines.push(`- Payment: ${process.env.PAYMENT_INFO}`);
  if (process.env.RETURNS_INFO) lines.push(`- Returns and exchanges: ${process.env.RETURNS_INFO}`);
  return lines.join("\n");
}

/**
 * Config sent on every chat turn: system prompt, tool schemas, and
 * automaticFunctionCalling disabled so WE run the tool loop (not the SDK).
 */
function buildChatConfig({ phone, customerName }) {
  // Kampala is UTC+3: using the UTC date would be a day behind after 9pm.
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const systemInstruction = [
    SYSTEM_PROMPT,
    "",
    buildExtraRules(),
    "",
    `Current customer WhatsApp number: ${phone}`,
    `Current customer profile name: ${customerName || "unknown"}`,
    `Today's date: ${today} (Africa/Kampala)`,
  ].join("\n");

  const config = {
    systemInstruction,
    tools: [{ functionDeclarations }],
    automaticFunctionCalling: { disable: true },
  };

  // Optional: reduce "thinking" time. Only applied if you set the env var.
  // If Gemini ever returns a 400 error mentioning thinking, remove the env var.
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL;
  if (thinkingLevel) {
    config.thinkingConfig = { thinkingLevel: thinkingLevel.toUpperCase() };
  }

  return config;
}

/**
 * Pull function calls out of a Gemini response.
 */
function getFunctionCalls(response) {
  const fromHelper = response?.functionCalls;
  if (Array.isArray(fromHelper) && fromHelper.length > 0) {
    return fromHelper;
  }

  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((part) => part.functionCall)
    .map((part) => part.functionCall);
}

function getText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const fromParts = parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (fromParts) return fromParts;

  const text = typeof response?.text === "string" ? response.text.trim() : "";
  return text;
}

function normalizeArgs(args) {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Keeping the model's planning out of the customer's chat
// ---------------------------------------------------------------------------

// A sentence that starts like this is the model talking to itself, not to the customer.
const PLANNING_START = [
  /^(?:(?:now|next|okay|ok|so),?\s*)?let'?s\s+(?:acknowledge|reply|respond|give|confirm|ask|reassure|thank|greet|keep|be|warmly|politely|write|draft|say|send)\b/i,
  /^(?:(?:now|next|okay|ok|so),?\s*)?(?:the\s+)?(?:customer|user)\b/i,
  /^(?:(?:now|next|okay|ok|so),?\s*)?i\s+(?:should|need to|will|must)\s+(?:reply|respond|acknowledge|ask|confirm|greet|thank|keep)\b/i,
  /^keep it (?:short|brief|natural)\b/i,
];
// ...and these give a sentence away wherever they appear in it.
const PLANNING_ANYWHERE = /\blet'?s\s+(?:acknowledge|reply|respond|give|confirm|ask|reassure|thank|greet|keep|be|warmly|politely)\b|\bkeep it (?:short|brief|natural)\b|\b1-2 sentences\b|\bthe customer\b/i;

/**
 * Removes planning sentences the model wrote in front of its real message.
 * It only acts when the text STARTS like planning, so ordinary replies pass
 * through untouched. The planning and the reply are often glued together with
 * no space ("...natural.Hello Kenny!"), so that is used as a split point too.
 */
function stripPlanning(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;

  const starts = [0];
  const re = /(?<=[.!?)"\u201d])(?=[A-Z])|\n{2,}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[0] === "") re.lastIndex += 1;           // zero-width match: step forward
    starts.push(m.index + m[0].length);
  }
  const segments = starts.map((start, i) => raw.slice(start, starts[i + 1] ?? raw.length).trim());

  if (segments.length < 2 || !PLANNING_START.some((rx) => rx.test(segments[0]))) return raw;

  let i = 0;
  while (i < segments.length - 1 && (i === 0 || PLANNING_ANYWHERE.test(segments[i]))) i += 1;

  const cleaned = raw.slice(starts[i]).trim();
  return cleaned || raw;
}

/** The text the customer should get from one raw model answer. */
function extractReply(raw) {
  const text = String(raw || "");

  const closed = text.match(/<reply>([\s\S]*?)<\/reply>/i);
  if (closed && closed[1].trim()) return closed[1].trim();

  const open = text.match(/<reply>([\s\S]*)$/i);          // closing tag missing
  if (open && open[1].trim()) return open[1].trim();

  return stripPlanning(text.replace(/<\/?reply>/gi, ""));
}

const hasToolPart = (entry) =>
  (entry.parts || []).some((p) => p && (p.functionCall || p.functionResponse));

function entryText(entry) {
  if (typeof entry.content === "string" && entry.content) return entry.content;
  return (entry.parts || []).filter((p) => p && p.text && !p.thought).map((p) => p.text).join("\n");
}

function setEntryText(entry, text) {
  entry.content = text;
  entry.parts = [{ text }];
}

/**
 * Cleans one saved turn from the database. Plain model answers get their
 * planning removed and are stored in the <reply> format, so the model keeps
 * seeing the pattern it is supposed to follow.
 */
function cleanStoredTurn(entry) {
  if (!entry || entry.role !== "model" || hasToolPart(entry)) return entry;
  const text = entryText(entry);
  if (!text) return entry;
  const clean = extractReply(text);
  const wanted = `<reply>${clean}</reply>`;
  if (wanted === text) return entry;
  return { ...entry, content: wanted, parts: [{ text: wanted }] };
}

/**
 * History to save after a turn: photos are removed (only their text stays),
 * and the final model answer is stored as the clean reply.
 */
function tidyHistory(entries, reply) {
  const out = (entries || []).map((entry) => {
    if (!entry || !Array.isArray(entry.parts)) return entry;
    return { ...entry, parts: entry.parts.filter((p) => !(p && (p.inlineData || p.fileData))) };
  });

  if (reply) {
    const last = out[out.length - 1];
    if (last && last.role === "model" && !hasToolPart(last)) {
      setEntryText(last, `<reply>${reply}</reply>`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isRateLimitError(err) {
  const status = err.status || err.statusCode || err.response?.status;
  const message = String(err.message || "");
  return (
    status === 429 ||
    /429/.test(message) ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /quota/i.test(message) ||
    /rate.?limit/i.test(message)
  );
}

/**
 * Transient errors worth retrying / falling back on: overloaded model,
 * Google blips, and our own request timeouts.
 */
function isRetryableServerError(err) {
  const status = err.status || err.statusCode || err.response?.status;
  const message = String(err.message || "");
  const name = String(err.name || "");
  return (
    [500, 502, 503, 504].includes(status) ||
    /UNAVAILABLE/i.test(message) ||
    /high demand/i.test(message) ||
    /internal error/i.test(message) ||
    /timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message) ||
    name === "AbortError" ||
    name === "TimeoutError"
  );
}

// ---------------------------------------------------------------------------
// Resilient send
// ---------------------------------------------------------------------------

/**
 * Send a message with retry-with-backoff on transient errors, and automatic
 * fallback to the next candidate model. Models that fail are put on a
 * cooldown so the NEXT customer message does not pay the same penalty.
 *
 * Returns { response, chat, model }. `chat` may be a new instance if a
 * fallback model took over, so callers must keep using the returned chat.
 */
async function sendResilient({ ai, models, chat, history, config, messageOrParts }) {
  let activeChat = chat;
  let lastErr;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    // The first candidate reuses the caller's chat (created with that model).
    // A chat's model can't change, so later candidates get a fresh chat
    // seeded with the same history-so-far.
    if (modelIndex > 0) {
      activeChat = ai.chats.create({ model, history, config });
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await activeChat.sendMessage({ message: messageOrParts });
        console.log(
          `[gemini] "${model}" answered in ${Date.now() - startedAt}ms (attempt ${attempt}).`
        );
        return { response, chat: activeChat, model };
      } catch (err) {
        lastErr = err;
        const took = Date.now() - startedAt;

        if (isRateLimitError(err)) {
          console.warn(`[gemini] "${model}" rate-limited (429) after ${took}ms.`);
          markModelDown(model, "429 rate limit");
          break; // no point retrying the same model on a quota error
        }

        if (isRetryableServerError(err)) {
          console.warn(
            `[gemini] "${model}" attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL} failed after ${took}ms (status ${err.status || "?"}: ${String(err.message || "").slice(0, 80)}).`
          );
          // A 504 deadline error means this prompt is simply too slow on this
          // model right now; retrying the same model rarely helps.
          if (attempt < MAX_ATTEMPTS_PER_MODEL && err.status !== 504) {
            await sleep(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
            continue; // retry the same model
          }
          markModelDown(model, `still failing after ${attempt} attempts`);
          break; // fall through to the next model
        }

        // Bad request, auth failure, unknown model name... switching models
        // won't fix it, so fail fast.
        throw err;
      }
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run one customer turn through Gemini, including the function-calling loop.
 *
 * @param {object}  args
 * @param {Array}   [args.attachments]  photos / PDFs for THIS reply: [{ mimeType, data (base64) }]
 * @returns {Promise<{ reply: string, updatedHistory: Array, rateLimited: boolean }>}
 */
async function generateReply({ userMessage, history, phone, customerName, attachments = [] }) {
  const turnStartedAt = Date.now();
  const ai = getClient();
  const config = buildChatConfig({ phone, customerName });
  // Old turns may contain leaked planning from before this fix: clean them as they load.
  const seedHistory = toGeminiHistory((history || []).map(cleanStoredTurn));

  // Healthy models first. Narrowed after a fallback so later calls in this
  // turn keep using whichever model actually answered.
  let models = orderedModels();

  let chat = ai.chats.create({
    model: models[0],
    history: seedHistory,
    config,
  });

  console.log(
    `[gemini] Sending turn for ${phone}. Model order: ${models.join(" -> ")}` +
      (attachments.length ? ` (with ${attachments.length} attachment(s))` : "")
  );

  // Photos go first, then the text (Google's recommendation for a single image).
  const withFiles = attachments.length
    ? [
        ...attachments.map((a) => ({ inlineData: { mimeType: a.mimeType, data: a.data } })),
        { text: userMessage },
      ]
    : userMessage;

  let response;
  try {
    let result;
    try {
      result = await sendResilient({
        ai, models, chat, history: seedHistory, config, messageOrParts: withFiles,
      });
    } catch (err) {
      // If the photo itself was refused (not a rate limit or outage), answer without it.
      if (attachments.length && !isRateLimitError(err) && !isRetryableServerError(err)) {
        console.warn(`[gemini] The attachment was refused (${String(err.message || "").slice(0, 120)}). Answering without it.`);
        chat = ai.chats.create({ model: models[0], history: seedHistory, config });
        result = await sendResilient({
          ai, models, chat, history: seedHistory, config, messageOrParts: userMessage,
        });
      } else {
        throw err;
      }
    }
    response = result.response;
    chat = result.chat;
    models = models.slice(models.indexOf(result.model));
  } catch (err) {
    return handleGeminiError(err, history, userMessage);
  }

  // Function-calling loop
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const finishReason = response.candidates?.[0]?.finishReason;
    const calls = getFunctionCalls(response);

    if (!calls || calls.length === 0) {
      if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
        console.warn(`[gemini] Unusual finishReason: ${finishReason}`);
      }

      const rawText = getText(response);
      const reply = extractReply(rawText);
      if (rawText && reply !== rawText.trim() && !/<reply>/i.test(rawText)) {
        console.warn("[gemini] The model skipped the <reply> tags; planning text was filtered out.");
      }
      const updatedHistory = tidyHistory(fromGeminiHistory(chat.getHistory()), reply);
      console.log(
        `[timing] Gemini turn finished in ${Date.now() - turnStartedAt}ms (${round - 1} tool round(s)).`
      );

      if (!reply) {
        console.warn("[gemini] Model returned no text. Using a fallback reply.");
        return {
          reply:
            "Sorry, I had trouble putting a reply together. Could you say that again?",
          updatedHistory,
          rateLimited: false,
        };
      }

      return { reply, updatedHistory, rateLimited: false };
    }

    console.log(
      `[gemini] Round ${round}: model requested ${calls.length} function call(s):`,
      calls.map((c) => c.name).join(", ")
    );

    // Execute every function Gemini asked for, then send ALL results back
    // in one turn (this is how parallel function calling works).
    const functionResponseParts = [];
    for (const call of calls) {
      const args = normalizeArgs(call.args);
      console.log(`[gemini] Executing ${call.name} with`, args);
      // Pass the REAL chat identity so orders/tickets/escalations are linked
      // to the right conversation in the database.
      const toolResult = await executeTool(call.name, args, { phone, customerName });
      const functionResponse = {
        name: call.name,
        response: toolResult,
      };
      if (call.id) {
        functionResponse.id = call.id;
      }
      functionResponseParts.push({ functionResponse });
    }

    try {
      const result = await sendResilient({
        ai,
        models,
        chat,
        history: chat.getHistory(),
        config,
        messageOrParts: functionResponseParts,
      });
      response = result.response;
      chat = result.chat;
      models = models.slice(models.indexOf(result.model));
    } catch (err) {
      return handleGeminiError(err, history, userMessage);
    }
  }

  console.warn(
    `[gemini] Stopped after ${MAX_TOOL_ROUNDS} tool rounds to avoid an infinite loop.`
  );
  const updatedHistory = tidyHistory(fromGeminiHistory(chat.getHistory()), null);
  return {
    reply:
      "I need to check on that with the team. Someone will follow up with you shortly.",
    updatedHistory,
    rateLimited: false,
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function withFallbackTurn(history, userMessage, reply) {
  const now = new Date().toISOString();
  return [
    ...(history || []).map(cleanStoredTurn),
    {
      role: "user",
      content: userMessage,
      parts: [{ text: userMessage }],
      timestamp: now,
    },
    {
      role: "model",
      content: `<reply>${reply}</reply>`,
      parts: [{ text: `<reply>${reply}</reply>` }],
      timestamp: now,
    },
  ];
}

function handleGeminiError(err, history, userMessage) {
  if (isRateLimitError(err)) {
    console.error("============================================================");
    console.error("  GEMINI RATE LIMIT HIT (HTTP 429)");
    console.error("  Google is throttling this API key. Wait a minute and retry.");
    console.error("  This is NOT a generic server crash.");
    console.error("============================================================");
    console.error("[gemini] Raw error:", err.message || err);
    if (err.status) console.error("[gemini] HTTP status:", err.status);

    const reply =
      "We are getting a lot of messages right now. Please try again in a moment.";
    return {
      reply,
      updatedHistory: withFallbackTurn(history, userMessage, reply),
      rateLimited: true,
    };
  }

  console.error("[gemini] API call failed:", err.message || err);
  if (err.status) console.error("[gemini] HTTP status:", err.status);
  if (err.errorDetails) {
    console.error("[gemini] Details:", JSON.stringify(err.errorDetails, null, 2));
  }

  const reply =
    "Sorry, I am having a technical problem right now. Please try again shortly.";
  return {
    reply,
    updatedHistory: withFallbackTurn(history, userMessage, reply),
    rateLimited: false,
  };
}

module.exports = { generateReply, extractReply, stripPlanning, cleanStoredTurn, tidyHistory };