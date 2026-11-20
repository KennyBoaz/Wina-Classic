/**
 * alerts.js  (CommonJS build)
 *
 * Tells the team by email and/or SMS when something needs a person and nobody
 * has the dashboard open. No extra npm packages: email goes straight to your
 * mail server over SMTP, SMS through Africa's Talking or EgoSMS.
 *
 *   notifyTeam({ type, phone, name, title, text })   never throws, returns a short result
 *
 * type is "escalation", "order", "appointment" or "inquiry".
 *
 * Everything is switched on by cPanel environment variables:
 *
 *   ALERT_TYPES               which types alert. Default: escalation,order,appointment,inquiry
 *   ALERT_WHEN_DASHBOARD_OPEN true = alert even when a staff member is online. Default false
 *   ALERT_PRESENCE_MINUTES    "online" means seen in the dashboard within this many minutes. Default 7
 *   ALERT_THROTTLE_MINUTES    one alert per customer and type in this time. Default 10
 *   ALERT_MAX_PER_HOUR        hard cap on alerts per hour. Default 20
 *   SHOP_NAME                 shown in the subject / SMS. Default "Wina Classic"
 *   DASHBOARD_URL             e.g. https://kadoshenergies.com/winaclassic/admin/ (adds a link)
 *
 *   Email:  ALERT_EMAIL_ENABLED (default true), ALERT_EMAIL_TO (comma separated),
 *           SMTP_HOST, SMTP_PORT, SMTP_SECURE (ssl | starttls | none, default ssl),
 *           SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_REJECT_UNAUTHORIZED (default true)
 *   SMS:    ALERT_SMS_ENABLED (default true), ALERT_SMS_TO (comma separated, e.g. +256700000000),
 *           SMS_PROVIDER (africastalking | egosms),
 *           Africa's Talking: AT_USERNAME, AT_API_KEY, AT_SENDER_ID (optional)
 *           EgoSMS:           EGOSMS_USERNAME, EGOSMS_PASSWORD, EGOSMS_SENDER_ID (optional)
 */

const net = require("net");
const tls = require("tls");
const os = require("os");
const axios = require("axios");
const db = require("./db.js");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const flag = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
};
const list = (name) => String(process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);

function config() {
  const smsProvider = String(process.env.SMS_PROVIDER || "").trim().toLowerCase();
  const smsReady =
    (smsProvider === "africastalking" && process.env.AT_USERNAME && process.env.AT_API_KEY) ||
    (smsProvider === "egosms" && process.env.EGOSMS_USERNAME && process.env.EGOSMS_PASSWORD);

  return {
    shop: process.env.SHOP_NAME || "Wina Classic",
    dashboardUrl: process.env.DASHBOARD_URL || "",
    types: new Set((process.env.ALERT_TYPES || "escalation,order,appointment,inquiry").split(",").map((s) => s.trim()).filter(Boolean)),
    whenDashboardOpen: flag("ALERT_WHEN_DASHBOARD_OPEN", false),
    presenceMinutes: Number(process.env.ALERT_PRESENCE_MINUTES) || 7,
    throttleMinutes: Number(process.env.ALERT_THROTTLE_MINUTES) || 10,
    maxPerHour: Number(process.env.ALERT_MAX_PER_HOUR) || 20,
    email: {
      enabled: flag("ALERT_EMAIL_ENABLED", true) && list("ALERT_EMAIL_TO").length > 0 && Boolean(process.env.SMTP_HOST),
      to: list("ALERT_EMAIL_TO"),
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || ((process.env.SMTP_SECURE || "ssl").toLowerCase() === "ssl" ? 465 : 587),
      secure: String(process.env.SMTP_SECURE || "ssl").toLowerCase(),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
      from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
      rejectUnauthorized: flag("SMTP_REJECT_UNAUTHORIZED", true),
    },
    sms: {
      enabled: flag("ALERT_SMS_ENABLED", true) && list("ALERT_SMS_TO").length > 0 && Boolean(smsReady),
      to: list("ALERT_SMS_TO"),
      provider: smsProvider,
    },
  };
}

// ---------------------------------------------------------------------------
// Is somebody watching the dashboard?
// ---------------------------------------------------------------------------
// The dashboard asks the server for news every few seconds, and the server notes
// a session as "seen" at least every 5 minutes while that goes on. So a session
// seen within the last few minutes means a staff member has it open.
async function dashboardWatched(minutes) {
  try {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const row = await db.one(
      `SELECT 1 AS watched
         FROM staff_sessions s
         JOIN staff_users u ON u.id = s.staff_id
        WHERE u.active = 1 AND s.expires_at > ? AND s.last_seen_at > ?
        LIMIT 1`,
      [new Date(), since]
    );
    return Boolean(row);
  } catch (err) {
    console.error("[alerts] Could not check who is online (alerting anyway):", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email (SMTP, no packages)
// ---------------------------------------------------------------------------
function addressOf(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim();
}

function encodeHeader(text) {
  const clean = String(text).replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function buildMessage({ from, to, subject, text }) {
  const body = Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${String(from).replace(/[\r\n]+/g, " ")}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${os.hostname()}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** Reads SMTP replies (including multi-line ones) from a socket. */
function makeConnection(initialSocket, opts) {
  let socket = initialSocket;
  let buffer = "";
  let current = [];
  let failure = null;
  const replies = [];
  const waiting = [];

  function pump() {
    while (waiting.length && (replies.length || failure)) {
      const w = waiting.shift();
      if (replies.length) w.resolve(replies.shift());
      else w.reject(failure);
    }
  }
  function onData(chunk) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      current.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), text: current.join("\n") });
        current = [];
        pump();
      }
    }
  }
  function onFail(err) { failure = failure || err || new Error("SMTP connection closed"); pump(); }
  function attach(s) {
    s.setEncoding("utf8");
    s.on("data", onData);
    s.on("error", onFail);
    s.on("close", () => onFail());
  }
  attach(socket);

  const conn = {
    read: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); pump(); }),
    send: (line) => socket.write(line + "\r\n"),
    async cmd(line) { conn.send(line); return conn.read(); },
    async upgrade() {
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      buffer = ""; current = []; replies.length = 0;
      await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: opts.host, rejectUnauthorized: opts.rejectUnauthorized });
        secure.once("secureConnect", () => { socket = secure; attach(secure); resolve(); });
        secure.once("error", reject);
      });
    },
    close() { try { socket.end(); socket.destroy(); } catch { /* ignore */ } },
  };
  return conn;
}

function openSocket(o) {
  return new Promise((resolve, reject) => {
    const socket = o.secure === "ssl"
      ? tls.connect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized: o.rejectUnauthorized })
      : net.connect({ host: o.host, port: o.port });
    socket.setTimeout(20000, () => socket.destroy(new Error("SMTP connection timed out")));
    socket.once(o.secure === "ssl" ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expect(reply, ...codes) {
  if (!codes.includes(reply.code)) throw new Error(`SMTP said: ${reply.text.replace(/\n/g, " ").slice(0, 200)}`);
  return reply;
}

async function sendEmail({ host, port, secure, user, pass, from, to, rejectUnauthorized }, subject, text) {
  const opts = { host, port, secure, rejectUnauthorized };
  const conn = makeConnection(await openSocket(opts), opts);
  const me = os.hostname() || "localhost";
  try {
    expect(await conn.read(), 220);
    expect(await conn.cmd(`EHLO ${me}`), 250);

    if (secure === "starttls") {
      expect(await conn.cmd("STARTTLS"), 220);
      await conn.upgrade();
      expect(await conn.cmd(`EHLO ${me}`), 250);
    }

    if (user) {
      const token = Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64");
      let auth = await conn.cmd(`AUTH PLAIN ${token}`);
      if (auth.code === 504 || auth.code === 502) {            // mechanism not offered: try LOGIN
        expect(await conn.cmd("AUTH LOGIN"), 334);
        expect(await conn.cmd(Buffer.from(user).toString("base64")), 334);
        auth = await conn.cmd(Buffer.from(pass).toString("base64"));
      }
      expect(auth, 235);
    }

    expect(await conn.cmd(`MAIL FROM:<${addressOf(from)}>`), 250);
    for (const rcpt of to) expect(await conn.cmd(`RCPT TO:<${addressOf(rcpt)}>`), 250, 251);
    expect(await conn.cmd("DATA"), 354);

    const message = buildMessage({ from, to, subject, text }).replace(/^\./gm, "..");
    conn.send(message + "\r\n.");
    expect(await conn.read(), 250);
    conn.send("QUIT");
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------
const digitsOnly = (n) => String(n).replace(/\D/g, "");

async function sendSms(sms, message) {
  if (sms.provider === "africastalking") {
    const base = process.env.AT_API_URL || "https://api.africastalking.com";
    const form = new URLSearchParams({
      username: process.env.AT_USERNAME,
      to: sms.to.map((n) => "+" + digitsOnly(n)).join(","),
      message,
    });
    if (process.env.AT_SENDER_ID) form.set("from", process.env.AT_SENDER_ID);
    const res = await axios.post(`${base}/version1/messaging`, form.toString(), {
      headers: { apiKey: process.env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
    const recipients = (res.data && res.data.SMSMessageData && res.data.SMSMessageData.Recipients) || [];
    const bad = recipients.filter((r) => String(r.status).toLowerCase() !== "success");
    if (!recipients.length || bad.length === recipients.length) {
      throw new Error("Africa's Talking: " + ((res.data && res.data.SMSMessageData && res.data.SMSMessageData.Message) || "no recipient accepted"));
    }
    return;
  }

  if (sms.provider === "egosms") {
    const url = process.env.EGOSMS_API_URL || "https://www.egosms.co/api/v1/json/";
    const res = await axios.post(
      url,
      {
        method: "SendSms",
        userdata: { username: process.env.EGOSMS_USERNAME, password: process.env.EGOSMS_PASSWORD },
        msgdata: sms.to.map((n) => ({
          number: digitsOnly(n),
          message,
          senderid: process.env.EGOSMS_SENDER_ID || "EgoSms",
          priority: "0",
        })),
      },
      { timeout: 20000 }
    );
    const status = res.data && (res.data.Status || res.data.status);
    if (String(status).toUpperCase() !== "OK") {
      throw new Error("EgoSMS: " + ((res.data && (res.data.Message || res.data.message)) || "request was not accepted"));
    }
    return;
  }

  throw new Error("SMS_PROVIDER must be africastalking or egosms");
}

// ---------------------------------------------------------------------------
// The alert itself
// ---------------------------------------------------------------------------
const oneLine = (text, max) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function compose(c, { type, phone, name, title, text }) {
  const who = name || (phone ? "+" + phone : "a customer");
  const link = c.dashboardUrl && phone ? `${c.dashboardUrl}${c.dashboardUrl.includes("#") ? "" : "#"}chat=${phone}` : c.dashboardUrl;
  const heading = title || "Customer needs attention";

  const emailText = [
    heading,
    "",
    `Customer: ${name || "Unknown"}${phone ? " (+" + phone + ")" : ""}`,
    text ? `Details: ${String(text).trim()}` : null,
    link ? `\nOpen the chat: ${link}` : null,
    "",
    `Sent by the ${c.shop} bot because nobody had the dashboard open.`,
  ].filter((l) => l !== null).join("\n");

  // SMS: keep to one message (160 characters) where possible
  const head = `${c.shop}: ${heading} - ${who}`;
  const tail = link ? ` ${link}` : "";
  const room = 160 - head.length - tail.length - 2;
  const smsText = (text && room > 15 ? `${head}. ${oneLine(text, room)}` : head) + tail;

  return { subject: `[${c.shop}] ${heading}: ${who}`, emailText, smsText };
}

const throttleSeen = new Map();      // "type|phone" -> last alert time
let hourStamps = [];                 // times of alerts in the last hour

async function run(event, { force = false } = {}) {
  const c = config();
  const { type = "info" } = event;
  if (!c.email.enabled && !c.sms.enabled) return { sent: [], skipped: "no alert channel is configured" };
  if (!force && !c.types.has(type)) return { sent: [], skipped: `alerts for "${type}" are switched off` };

  if (!force) {
    const now = Date.now();
    const key = `${type}|${event.phone || ""}`;
    const last = throttleSeen.get(key);
    if (last && now - last < c.throttleMinutes * 60 * 1000) return { sent: [], skipped: "throttled (already alerted recently)" };
    hourStamps = hourStamps.filter((t) => now - t < 60 * 60 * 1000);
    if (hourStamps.length >= c.maxPerHour) return { sent: [], skipped: "hourly alert limit reached" };
    if (!c.whenDashboardOpen && (await dashboardWatched(c.presenceMinutes))) {
      return { sent: [], skipped: "someone has the dashboard open" };
    }
    throttleSeen.set(key, now);
    hourStamps.push(now);
    if (throttleSeen.size > 2000) {
      for (const [k, t] of throttleSeen) if (now - t > c.throttleMinutes * 60 * 1000) throttleSeen.delete(k);
    }
  }

  const msg = compose(c, event);
  const sent = [];
  const failed = [];

  await Promise.all([
    c.email.enabled
      ? sendEmail(c.email, msg.subject, msg.emailText).then(() => sent.push("email"), (err) => failed.push("email: " + err.message))
      : null,
    c.sms.enabled
      ? sendSms(c.sms, msg.smsText).then(() => sent.push("sms"), (err) => failed.push("sms: " + err.message))
      : null,
  ]);

  console.error(`[alerts] "${msg.subject}" -> sent: ${sent.join(", ") || "none"}${failed.length ? "; FAILED: " + failed.join(" | ") : ""}`);
  return { sent, failed };
}

/** Never throws. */
async function notifyTeam(event) {
  try {
    return await run(event || {});
  } catch (err) {
    console.error("[alerts] Alert failed:", err.message);
    return { sent: [], failed: [err.message] };
  }
}

let lastTest = 0;
/** For the admin test link: sends one alert now, ignoring throttling and who is online. */
async function sendTest() {
  if (Date.now() - lastTest < 60 * 1000) return { sent: [], skipped: "wait a minute between tests" };
  lastTest = Date.now();
  return run({ type: "test", title: "Test alert", text: "If you can read this, alerts are working.", name: "Test" }, { force: true });
}

/** What is switched on (no secrets), for the admin test link. */
function summary() {
  const c = config();
  return {
    email: { enabled: c.email.enabled, recipients: c.email.to.length, host: c.email.host || null, secure: c.email.secure },
    sms: { enabled: c.sms.enabled, recipients: c.sms.to.length, provider: c.sms.provider || null },
    types: Array.from(c.types),
    whenDashboardOpen: c.whenDashboardOpen,
    throttleMinutes: c.throttleMinutes,
    link: c.dashboardUrl || null,
  };
}

module.exports = { notifyTeam, sendTest, summary, compose, config, sendEmail, sendSms };
