/**
 * routes/whatsappOnboard.js
 *
 * Connects the shop's real WhatsApp Business app number to the Cloud API
 * (Embedded Signup + Coexistence) and stores the resulting token.
 * Mounted at /api/whatsapp (see server.js). Admin staff only.
 *
 *   GET  /status      what is connected now (+ the CSRF token for the connect page)
 *   POST /onboard     finish signup: code -> token -> save -> subscribe -> request syncs
 *   POST /resync      ask Meta again for contacts + history (only works shortly after onboarding)
 *   POST /disconnect  forget the saved connection (does NOT unlink the number at Meta)
 *
 * Needs these environment variables (cPanel > Node.js app > Environment variables):
 *   META_APP_ID, META_APP_SECRET, META_ES_CONFIG_ID, and optionally META_GRAPH_VERSION.
 */

const express = require("express");
const axios = require("axios");
const db = require("../db.js");
const whatsapp = require("../whatsapp.js");
const { requireAuth, requireAdmin, allowAttempt } = require("../auth.js");
const { HttpError, wrap } = require("../apiUtil.js");

const GRAPH_BASE = "https://graph.facebook.com";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

// ---------------------------------------------------------------------------
// Graph API helper
// ---------------------------------------------------------------------------
class MetaError extends Error {
  constructor(err) {
    const e = err.response && err.response.data && err.response.data.error;
    const detail = e && e.error_data && e.error_data.details;
    super(e ? `${e.message}${detail ? " - " + detail : ""}` : String(err.code || err.message));
    this.metaCode = e ? e.code : undefined;
    this.metaSubcode = e ? e.error_subcode : undefined;
    this.httpStatus = err.response ? err.response.status : undefined;
  }
}

async function graph(method, path, { params, data, token } = {}) {
  try {
    const res = await axios({
      method,
      url: `${GRAPH_BASE}/${GRAPH_VERSION}${path}`,
      params,
      data,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    throw new MetaError(err); // message only: never logs tokens or the app secret
  }
}

/**
 * Exchange the login code for a business token.
 * A code from FB.login (JavaScript SDK) is tied to the SDK's own, EMPTY redirect
 * URI, and Meta rejects the exchange (error 100 / subcode 36008) when the field
 * is simply left out. So: try an explicit blank redirect_uri first, then none,
 * then the page address. Only a 36008 triggers the next variant.
 */
async function exchangeCode(appId, appSecret, code, pageUrl) {
  const attempts = [
    { label: "blank redirect_uri", extra: { redirect_uri: "" } },
    { label: "no redirect_uri", extra: {} },
  ];
  if (pageUrl) attempts.push({ label: "page address", extra: { redirect_uri: pageUrl } });

  let lastErr;
  for (const a of attempts) {
    try {
      const t = await graph("GET", "/oauth/access_token", {
        params: { client_id: appId, client_secret: appSecret, code, ...a.extra },
      });
      console.error(`[whatsapp] Code exchange worked with: ${a.label}`);
      return t;
    } catch (err) {
      lastErr = err;
      console.error(
        `[whatsapp] Code exchange (${a.label}) failed: ${err.message} [${err.metaCode || "?"}/${err.metaSubcode || "?"}]`
      );
      if (err.metaSubcode !== 36008) break;
    }
  }
  throw lastErr;
}

function creds() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const configId = process.env.META_ES_CONFIG_ID;
  const missing = [];
  if (!appId) missing.push("META_APP_ID");
  if (!appSecret) missing.push("META_APP_SECRET");
  if (!configId) missing.push("META_ES_CONFIG_ID");
  return { appId, appSecret, configId, missing };
}

const digits = (v) => {
  const s = String(v || "").trim();
  return /^\d{5,30}$/.test(s) ? s : "";
};

// ---------------------------------------------------------------------------
// Meta calls used by more than one route
// ---------------------------------------------------------------------------
async function fetchPhoneInfo(token, phoneNumberId) {
  try {
    return await graph("GET", `/${phoneNumberId}`, {
      token,
      params: { fields: "display_phone_number,verified_name,is_on_biz_app,platform_type" },
    });
  } catch (err) {
    // some versions reject the extra fields: fall back to the basics
    return graph("GET", `/${phoneNumberId}`, {
      token,
      params: { fields: "display_phone_number,verified_name" },
    });
  }
}

// Meta expects contacts + history to be requested after onboarding, once each.
async function requestSync(phoneNumberId, token, syncType) {
  try {
    await graph("POST", `/${phoneNumberId}/smb_app_data`, {
      token,
      data: { messaging_product: "whatsapp", sync_type: syncType },
    });
    return { ok: true, detail: "requested - the data arrives by webhook" };
  } catch (err) {
    if (err.metaCode === 135000) return { ok: true, detail: "already requested / in progress" };
    return { ok: false, detail: err.message };
  }
}

async function discoverNumber(token, appId, appSecret, knownWaba) {
  let wabaId = knownWaba;
  if (!wabaId) {
    const dbg = await graph("GET", "/debug_token", {
      params: { input_token: token, access_token: `${appId}|${appSecret}` },
    });
    const scopes = (dbg && dbg.data && dbg.data.granular_scopes) || [];
    const wa = scopes.find((s) => s.scope === "whatsapp_business_management");
    wabaId = (wa && wa.target_ids && wa.target_ids[0]) || "";
  }
  if (!wabaId) throw new Error("Could not work out which WhatsApp Business Account was shared.");

  const list = await graph("GET", `/${wabaId}/phone_numbers`, {
    token,
    params: { fields: "id,display_phone_number,verified_name" },
  });
  const numbers = (list && list.data) || [];
  if (numbers.length !== 1) {
    throw new Error(
      numbers.length
        ? "That account has several numbers; I can't tell which one to use."
        : "That account has no phone number yet."
    );
  }
  return { wabaId, phoneNumberId: numbers[0].id };
}

function publicConnection(row) {
  return {
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhone: row.display_phone,
    verifiedName: row.verified_name,
    mode: row.mode,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
  };
}

/** Called once at boot (server.js): hands the saved token to whatsapp.js. */
async function applyStoredConnection() {
  try {
    const row = await db.one(
      "SELECT phone_number_id, access_token FROM whatsapp_connection WHERE id = 1"
    );
    if (row) {
      whatsapp.setConnection({ token: row.access_token, phoneNumberId: row.phone_number_id });
      console.error(`[boot] WhatsApp connection loaded from the database (number id ${row.phone_number_id}).`);
    }
  } catch (err) {
    console.error("[boot] Could not load the saved WhatsApp connection:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const router = express.Router();
router.use(requireAuth);

router.get(
  "/status",
  requireAdmin,
  wrap(async (req, res) => {
    const c = creds();
    const row = await db.one("SELECT * FROM whatsapp_connection WHERE id = 1");

    // Does Meta accept this App ID + App secret pair? (Tested without a login code,
    // so a wrong secret is found here instead of after a popup run.)
    let credentials = { ok: false, detail: "not checked" };
    if (c.missing.length === 0) {
      try {
        await graph("GET", "/oauth/access_token", {
          params: { client_id: c.appId, client_secret: c.appSecret, grant_type: "client_credentials" },
        });
        credentials = { ok: true };
      } catch (err) {
        credentials = {
          ok: false,
          detail: err.message,
          // an app secret is 32 hex characters; spaces or quotes break that
          secretFormatOk: /^[0-9a-f]{32}$/i.test(c.appSecret),
        };
      }
    }

    let live = null;
    if (row) {
      try {
        const info = await fetchPhoneInfo(row.access_token, row.phone_number_id);
        live = {
          displayPhone: info.display_phone_number || null,
          verifiedName: info.verified_name || null,
          onBusinessApp: typeof info.is_on_biz_app === "boolean" ? info.is_on_biz_app : null,
          platformType: info.platform_type || null,
        };
      } catch (err) {
        live = { error: err.message };
      }
    }

    res.json({
      csrf: req.csrf,
      appId: c.appId || "",
      configId: c.configId || "",
      graphVersion: GRAPH_VERSION,
      ready: c.missing.length === 0,
      missing: c.missing,
      credentials,
      source: whatsapp.getConnectionSource(),
      connection: row ? publicConnection(row) : null,
      live,
    });
  })
);

router.post(
  "/onboard",
  requireAdmin,
  wrap(async (req, res) => {
    if (!allowAttempt(`wa-onboard:${req.staff.id}`, 10, 15 * 60 * 1000)) {
      throw new HttpError(429, "Too many attempts. Wait a few minutes.", "RATE_LIMIT");
    }
    const c = creds();
    if (c.missing.length) {
      throw new HttpError(500, `Missing environment variables: ${c.missing.join(", ")}`, "CONFIG");
    }

    const code = String((req.body && req.body.code) || "").trim();
    if (!code || code.length > 2000) {
      throw new HttpError(400, "Missing the authorization code from Meta.", "BAD_REQUEST");
    }
    const rawPage = String((req.body && req.body.pageUrl) || "");
    const pageUrl = /^https:\/\/[^\s"'<>]{1,300}$/.test(rawPage) ? rawPage : "";
    let wabaId = digits(req.body.wabaId);
    let phoneNumberId = digits(req.body.phoneNumberId);

    const steps = [];
    const step = (label, ok, detail) => steps.push({ label, ok, detail: detail || "" });

    // 1) code -> business token
    let token;
    let expiresAt = null;
    try {
      const t = await exchangeCode(c.appId, c.appSecret, code, pageUrl);
      token = t.access_token;
      if (t.expires_in) expiresAt = new Date(Date.now() + Number(t.expires_in) * 1000);
      step("Exchanged the code for an access token", true);
    } catch (err) {
      console.error("[whatsapp] Onboarding: code exchange failed:", err.message);
      // 424, not 5xx: the catch-all handler in server.js hides the message of 5xx errors.
      throw new HttpError(424, `Meta refused the authorization code: ${err.message}`, "META_TOKEN");
    }

    // 2) which account / number?
    if (!wabaId || !phoneNumberId) {
      try {
        const found = await discoverNumber(token, c.appId, c.appSecret, wabaId);
        wabaId = found.wabaId;
        phoneNumberId = found.phoneNumberId;
        step("Worked out the account and number from the token", true);
      } catch (err) {
        console.error("[whatsapp] Onboarding: could not find the account/number:", err.message);
        throw new HttpError(424, `Could not identify the WhatsApp number: ${err.message}`, "META_DISCOVER");
      }
    }

    // 3) number details (and whether the Business app is still linked)
    let info = {};
    try {
      info = await fetchPhoneInfo(token, phoneNumberId);
      const linked =
        typeof info.is_on_biz_app === "boolean"
          ? info.is_on_biz_app
            ? "Business app still linked (coexistence)"
            : "WARNING: Business app is NOT linked"
          : "";
      step(
        `Read number details: ${info.display_phone_number || phoneNumberId}`,
        info.is_on_biz_app !== false,
        linked
      );
    } catch (err) {
      step("Read number details", false, err.message);
    }

    // 4) save + activate
    const now = new Date();
    await db.run(
      `INSERT INTO whatsapp_connection
         (id, waba_id, phone_number_id, display_phone, verified_name, access_token,
          token_expires_at, mode, connected_by, connected_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'coexistence', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         waba_id = VALUES(waba_id), phone_number_id = VALUES(phone_number_id),
         display_phone = VALUES(display_phone), verified_name = VALUES(verified_name),
         access_token = VALUES(access_token), token_expires_at = VALUES(token_expires_at),
         mode = VALUES(mode), connected_by = VALUES(connected_by),
         connected_at = VALUES(connected_at), updated_at = VALUES(updated_at)`,
      [
        wabaId,
        phoneNumberId,
        info.display_phone_number || null,
        info.verified_name || null,
        token,
        expiresAt,
        req.staff.id,
        now,
        now,
      ]
    );
    whatsapp.setConnection({ token, phoneNumberId });
    step("Saved the connection - the bot now sends from this number", true);

    // 5) subscribe our app to this account's webhooks
    try {
      await graph("POST", `/${wabaId}/subscribed_apps`, { token });
      step("Subscribed the app to the account's webhooks", true);
    } catch (err) {
      step("Subscribed the app to the account's webhooks", false, err.message);
    }

    // 6) ask Meta for contacts + chat history (one time, shortly after onboarding)
    for (const [label, type] of [
      ["Requested contacts sync", "smb_app_state_sync"],
      ["Requested chat history sync", "history"],
    ]) {
      const r = await requestSync(phoneNumberId, token, type);
      step(label, r.ok, r.detail);
    }

    res.json({ ok: true, steps });
  })
);

router.post(
  "/resync",
  requireAdmin,
  wrap(async (_req, res) => {
    const row = await db.one(
      "SELECT phone_number_id, access_token FROM whatsapp_connection WHERE id = 1"
    );
    if (!row) throw new HttpError(404, "No saved connection.", "NOT_CONNECTED");
    const steps = [];
    for (const [label, type] of [
      ["Contacts sync", "smb_app_state_sync"],
      ["Chat history sync", "history"],
    ]) {
      const r = await requestSync(row.phone_number_id, row.access_token, type);
      steps.push({ label, ok: r.ok, detail: r.detail });
    }
    res.json({ ok: true, steps });
  })
);

router.post(
  "/disconnect",
  requireAdmin,
  wrap(async (_req, res) => {
    await db.run("DELETE FROM whatsapp_connection WHERE id = 1");
    whatsapp.setConnection(null);
    res.json({
      ok: true,
      note:
        "Saved connection removed; the bot is back on the test number from the environment variables. " +
        "To unlink the Business app at Meta, do it in the app itself.",
    });
  })
);

module.exports = { router, applyStoredConnection };