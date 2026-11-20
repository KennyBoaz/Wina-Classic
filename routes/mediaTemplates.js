/**
 * routes/mediaTemplates.js
 *
 * The Phase 6 API behind the dashboard's photos, files, templates and alerts.
 * Mounted at /api in server.js, BEFORE the main API router.
 *
 *   GET  /media/:id                      a stored file (logged-in staff only)
 *   POST /conversations/:phone/media     staff sends a photo / document (raw bytes, X-Upload header)
 *   GET  /templates                      approved WhatsApp templates
 *   POST /conversations/:phone/template  staff sends a template
 *   GET  /alerts/test                    admin: send one test email/SMS alert
 *
 * It also adds the file details (has_media, media_mime, media_name, media_size)
 * to the message lists the dashboard loads, so the main router needs no edits.
 */

const express = require("express");
const db = require("../db.js");
const chatStore = require("../chatStore.js");
const whatsapp = require("../whatsapp.js");
const mediaStore = require("../media.js");
const alerts = require("../alerts.js");
const { requireAuth, requireAdmin, loadSession } = require("../auth.js");
const { HttpError, wrap, safeEqual } = require("../apiUtil.js");

const router = express.Router();
const WINDOW_MS = 24 * 60 * 60 * 1000;

// What staff may send, and the kind WhatsApp files it under.
const OUT_TYPES = {
  "image/jpeg": "image", "image/png": "image",
  "video/mp4": "video", "video/3gpp": "video",
  "audio/aac": "audio", "audio/mp4": "audio", "audio/mpeg": "audio", "audio/amr": "audio", "audio/ogg": "audio",
  "application/pdf": "document", "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "text/plain": "document",
};
const PLACEHOLDER = { image: "[Photo]", video: "[Video]", audio: "[Audio]" };
const IMAGE_LIMIT = 5 * 1024 * 1024; // WhatsApp's own limit for photos

const checkPhone = (value) => {
  const phone = String(value || "");
  if (!/^\d{6,20}$/.test(phone)) throw new HttpError(400, "That phone number is not valid.", "BAD_PHONE");
  return phone;
};

const windowOpen = (conv) =>
  Boolean(conv && conv.last_customer_message_at &&
    Date.now() - new Date(conv.last_customer_message_at).getTime() < WINDOW_MS);

// ---------------------------------------------------------------------------
// File details on message lists (the main router does not know these columns)
// ---------------------------------------------------------------------------
async function addMediaFields(body) {
  if (!body || typeof body !== "object") return;
  const rows = [];
  if (Array.isArray(body.messages)) rows.push(...body.messages);
  if (body.message && typeof body.message === "object") rows.push(body.message);
  const ids = rows.map((m) => m && m.id).filter((id) => Number.isInteger(Number(id)) && Number(id) > 0);
  if (!ids.length) return;

  const found = await db.all(
    "SELECT id, has_media, media_mime, media_name, media_size FROM messages WHERE id IN (?)",
    [ids]
  );
  const byId = new Map(found.map((r) => [Number(r.id), r]));
  for (const m of rows) {
    const extra = byId.get(Number(m && m.id));
    if (extra) {
      m.has_media = extra.has_media;
      m.media_mime = extra.media_mime;
      m.media_name = extra.media_name;
      m.media_size = extra.media_size;
    }
  }
}

router.get("/conversations/:phone/messages", (req, res, next) => {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) return original(body);
    addMediaFields(body).then(() => original(body), () => original(body));
    return res;
  };
  next();
});

// ---------------------------------------------------------------------------
// Serving a file (only through here; the folder is not part of the website)
// ---------------------------------------------------------------------------
router.get(
  "/media/:id",
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, "File not found.", "NOT_FOUND");

    const row = await db.one("SELECT has_media, media_mime, media_name FROM messages WHERE id = ?", [id]);
    const mime = row && mediaStore.normalizeMime(row.media_mime);
    if (!row || !row.has_media || !mediaStore.isAllowed(mime)) throw new HttpError(404, "File not found.", "NOT_FOUND");

    const inline = /^(image|audio|video)\//.test(mime);
    const name = mediaStore.cleanName(row.media_name, "file");
    res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    res.sendFile(mediaStore.pathFor(id), { dotfiles: "allow", cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "File not found." });
    });
  })
);

// ---------------------------------------------------------------------------
// Staff sends a photo or document
// ---------------------------------------------------------------------------
// The dashboard sends the file as raw bytes (not JSON), so the normal JSON-only
// check in requireAuth does not fit. This does the same login + CSRF checks.
const requireUploadAuth = wrap(async (req, res, next) => {
  const auth = await loadSession(req);
  if (!auth) throw new HttpError(401, "Please log in.", "UNAUTHENTICATED");
  if (req.headers["x-upload"] !== "1") throw new HttpError(400, "That is not a valid upload.", "BAD_UPLOAD");
  if (!safeEqual(req.headers["x-csrf-token"], auth.csrf)) {
    throw new HttpError(403, "Security token missing or expired. Refresh the page and try again.", "CSRF");
  }
  req.staff = auth.staff;
  req.csrf = auth.csrf;
  req.sessionId = auth.sessionId;
  next();
});

const headerText = (req, name, max) => {
  try {
    return decodeURIComponent(String(req.headers[name] || "")).slice(0, max);
  } catch {
    return "";
  }
};

router.post(
  "/conversations/:phone/media",
  requireUploadAuth,
  express.raw({ type: () => true, limit: mediaStore.MAX_BYTES }),
  wrap(async (req, res) => {
    const phone = checkPhone(req.params.phone);
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, "No file was received.", "EMPTY");

    const mime = mediaStore.normalizeMime(req.headers["content-type"]);
    const type = OUT_TYPES[mime];
    if (!type) {
      throw new HttpError(
        415,
        mime === "image/webp"
          ? "WhatsApp does not accept WebP photos. Send a JPEG or PNG instead."
          : "That file type can't be sent on WhatsApp. Use a JPEG/PNG photo, MP4 video, audio, PDF, Word, Excel, PowerPoint or text file.",
        "BAD_TYPE"
      );
    }
    if (type === "image" && buffer.length > IMAGE_LIMIT) throw new HttpError(413, "Photos must be 5 MB or smaller on WhatsApp.", "TOO_BIG");
    if (!mediaStore.sniffOk(buffer, mime)) throw new HttpError(415, "That file does not look like a real " + mime + ".", "BAD_CONTENT");

    const conv = await chatStore.getConversation(phone);
    if (!conv) throw new HttpError(404, "That chat was not found.", "NOT_FOUND");
    if (!windowOpen(conv)) {
      throw new HttpError(409, "The 24-hour window has closed. Send an approved template instead.", "WINDOW_CLOSED");
    }

    const name = mediaStore.cleanName(headerText(req, "x-filename", 200), mediaStore.defaultName(type, mime));
    const caption = type === "audio" ? "" : headerText(req, "x-caption", 1000).trim();

    let sent;
    try {
      const mediaId = await whatsapp.uploadMedia(buffer, mime, name);
      sent = await whatsapp.sendWhatsAppMedia(phone, { type, mediaId, caption, filename: name });
    } catch (err) {
      console.error(`[media] Upload to WhatsApp failed for ${phone}:`, err.message);
      sent = { ok: false, id: null, error: err.message };
    }

    const body = caption || PLACEHOLDER[type] || `[Document: ${name}]`;
    const id = await chatStore.recordOutgoingMedia({
      phone, body, msgType: type, mime, name, size: buffer.length,
      staffId: req.staff.id, waMessageId: sent.id, status: sent.ok ? "sent" : "failed", error: sent.error,
    });
    try {
      await mediaStore.save(id, buffer);
    } catch (err) {
      console.error("[media] Could not keep a copy of the sent file:", err.message);
      await db.run("UPDATE messages SET has_media = 0 WHERE id = ?", [id]).catch(() => {});
    }
    await chatStore.takeOverByStaff(phone, req.staff.id).catch(() => {});

    const messages = await chatStore.getMessagesByIds([id]);
    if (!sent.ok) {
      return res.status(502).json({ error: sent.error || "WhatsApp did not accept the file.", messages });
    }
    res.json({ messages });
  })
);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
let templateCache = { at: 0, list: [] };

async function approvedTemplates() {
  if (Date.now() - templateCache.at < 5 * 60 * 1000) return templateCache.list;
  const all = await whatsapp.fetchTemplates();
  const list = all
    .filter((t) => String(t.status).toUpperCase() === "APPROVED")
    .map(whatsapp.summariseTemplate)
    .sort((a, b) => a.name.localeCompare(b.name));
  templateCache = { at: Date.now(), list };
  return list;
}

router.get(
  "/templates",
  requireAuth,
  wrap(async (_req, res) => {
    if (!whatsapp.getBusinessAccountId()) return res.json({ configured: false, templates: [] });
    try {
      res.json({ configured: true, templates: await approvedTemplates() });
    } catch (err) {
      // 424 (not 5xx) so the dashboard shows Meta's reason instead of "Server error."
      throw new HttpError(424, "Could not load templates from WhatsApp: " + whatsapp.describeSendError(err), "META_TEMPLATES");
    }
  })
);

/** WhatsApp rejects values with line breaks, tabs or long runs of spaces. */
const cleanParam = (v) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 1000);

router.post(
  "/conversations/:phone/template",
  requireAuth,
  wrap(async (req, res) => {
    const phone = checkPhone(req.params.phone);
    const { name, language } = req.body || {};
    if (!/^[a-z0-9_]{1,512}$/.test(String(name || ""))) throw new HttpError(400, "Choose a template.", "BAD_TEMPLATE");
    if (!/^[A-Za-z]{2,3}(_[A-Za-z]{2})?$/.test(String(language || ""))) throw new HttpError(400, "The template language is not valid.", "BAD_LANGUAGE");
    const params = (Array.isArray(req.body.params) ? req.body.params : []).map(cleanParam);

    const conv = await chatStore.getConversation(phone);
    if (!conv) throw new HttpError(404, "That chat was not found.", "NOT_FOUND");

    let list;
    try {
      list = await approvedTemplates();
    } catch (err) {
      throw new HttpError(424, "Could not check the template with WhatsApp: " + whatsapp.describeSendError(err), "META_TEMPLATES");
    }
    const template = list.find((t) => t.name === name && t.language === language);
    if (!template) throw new HttpError(404, "That template is not approved (or no longer exists).", "NOT_FOUND");
    if (!template.supported) throw new HttpError(400, `That template can't be sent from here (${template.reason}).`, "UNSUPPORTED");
    if (params.length !== template.variables || params.some((p) => !p)) {
      throw new HttpError(400, `This template needs ${template.variables} value(s). Fill in every blank.`, "BAD_PARAMS");
    }

    const fill = (text) => String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || "");
    const shown = [template.header, fill(template.body)].filter(Boolean).join("\n");

    const sent = await whatsapp.sendWhatsAppTemplate(phone, { name, language, params });
    const id = await chatStore.recordOutgoing({
      phone, body: shown, senderType: "staff", staffId: req.staff.id,
      waMessageId: sent.id, status: sent.ok ? "sent" : "failed", error: sent.error,
    });
    await chatStore.takeOverByStaff(phone, req.staff.id).catch(() => {});

    const messages = await chatStore.getMessagesByIds([id]);
    if (!sent.ok) {
      return res.status(502).json({ error: sent.error || "WhatsApp did not accept the template.", messages });
    }
    res.json({ messages });
  })
);

// ---------------------------------------------------------------------------
// Alerts: one test message (open this link in the browser where you are logged in)
// ---------------------------------------------------------------------------
router.get(
  "/alerts/test",
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    res.json({ settings: alerts.summary(), result: await alerts.sendTest() });
  })
);

module.exports = { router, addMediaFields, cleanParam, OUT_TYPES };
