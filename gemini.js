/**
 * gemini.js  (CommonJS build)
 *
 * Sends the customer's message + history + tools to Gemini, runs any
 * function calls locally, then returns Gemini's final natural-language reply.
 *
 * Package: @google/genai
 *
 * WHAT CHANGED IN THIS VERSION (speed fixes)
 * ------------------------------------------
 * 1. Request timeout: a hung/overloaded model call now gives up after
 *    REQUEST_TIMEOUT_MS instead of waiting a minute or more.
 * 2. Model health memory: when a model fails (503 / 429 / timeout) it is
 *    marked "down" for COOLDOWN_MS, and later messages skip it and go
 *    straight to a healthy model. Before, EVERY message re-tried the broken
 *    primary model first and paid the full delay again.
 * 3. Fewer retries (2 per model instead of 3) with a shorter backoff.
 * 4. One shared Gemini client (reuses connections) instead of a new one
 *    per message.
 * 5. Timing logs so you can see exactly where the seconds go.
 * 6. Optional GEMINI_THINKING_LEVEL env var to cut "thinking" time.
 *
 * ENV VARS
 * --------
 *   GEMINI_API_KEY            required
 *   GEMINI_MODEL              primary model   (default: gemini-3.7-flash)
 *   GEMINI_FALLBACK_MODEL     fallback model  (default: gemini-3.8-flash)
 *   GEMINI_TIMEOUT_MS         per-request timeout   (default: 12000)
 *   GEMINI_COOLDOWN_MS        how long a failing model is skipped (default: 300000 = 5 min)
 *   GEMINI_THINKING_LEVEL     optional, e.g. "low" or "minimal". Leave unset to use the default.
 *
 * NOTE: if your .env / cPanel environment already sets GEMINI_MODEL, those
 * values override the defaults above. Update them there too.
 * Confirm model names at https://ai.google.dev/gemini-api/docs/models
 */

const { GoogleGenAI } = require("@google/genai");
const { SYSTEM_PROMPT } = require("./systemPrompt.js");
const { functionDeclarations, executeTool } = require("./tools.js");
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
 * Config sent on every chat turn: system prompt, tool schemas, and
 * automaticFunctionCalling disabled so WE run the tool loop (not the SDK).
 */
function buildChatConfig({ phone, customerName }) {
  const today = new Date().toISOString().slice(0, 10);
  const systemInstruction = [
    SYSTEM_PROMPT,
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
 * @returns {Promise<{ reply: string, updatedHistory: Array, rateLimited: boolean }>}
 */
async function generateReply({ userMessage, history, phone, customerName }) {
  const turnStartedAt = Date.now();
  const ai = getClient();
  const config = buildChatConfig({ phone, customerName });
  const seedHistory = toGeminiHistory(history || []);

  // Healthy models first. Narrowed after a fallback so later calls in this
  // turn keep using whichever model actually answered.
  let models = orderedModels();

  let chat = ai.chats.create({
    model: models[0],
    history: seedHistory,
    config,
  });

  console.log(
    `[gemini] Sending turn for ${phone}. Model order: ${models.join(" -> ")}`
  );

  let response;
  try {
    const result = await sendResilient({
      ai,
      models,
      chat,
      history: seedHistory,
      config,
      messageOrParts: userMessage,
    });
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

      const reply = getText(response);
      const updatedHistory = fromGeminiHistory(chat.getHistory());
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
  const updatedHistory = fromGeminiHistory(chat.getHistory());
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
    ...(history || []),
    {
      role: "user",
      content: userMessage,
      parts: [{ text: userMessage }],
      timestamp: now,
    },
    {
      role: "model",
      content: reply,
      parts: [{ text: reply }],
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

module.exports = { generateReply };