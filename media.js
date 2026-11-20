/**
 * media.js  (CommonJS build)
 *
 * Keeps the photos, voice notes, videos and documents of a chat.
 *
 *  - A customer's file is downloaded from WhatsApp right away (the link Meta
 *    gives expires after a few minutes) and saved on disk.
 *  - A file a staff member sends from the dashboard is saved the same way.
 *  - Files live in a folder that is NOT served by the website. They are only
 *    handed out by the logged-in /api/media/:id route (routes/mediaTemplates.js).
 *  - Only known-safe file types are kept (no HTML, SVG, scripts), with a size
 *    limit, and old files are removed automatically.
 *
 * Each file is stored as <MEDIA_DIR>/<message id> (no extension, no user-chosen
 * name), and the messages table remembers its type, name and size.
 *
 * Environment variables (all optional):
 *   MEDIA_DIR              where files are kept. Default: ./storage/media (inside the app folder)
 *   MEDIA_MAX_MB           biggest file accepted. Default 16
 *   MEDIA_RETENTION_DAYS   files older than this are deleted. Default 180
 *   MEDIA_MAX_TOTAL_MB     if the folder grows past this, the oldest files go first. Default 2000
 */

const fs = require("fs");
const path = require("path");
const db = require("./db.js");
const whatsapp = require("./whatsapp.js");

const DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.join(__dirname, "storage", "media");
const MAX_BYTES = Math.max(1, Number(process.env.MEDIA_MAX_MB) || 16) * 1024 * 1024;
const RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS) || 180;
const MAX_TOTAL_BYTES = (Number(process.env.MEDIA_MAX_TOTAL_MB) || 2000) * 1024 * 1024;

const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

// The only types we keep and serve.
const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp",
  "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr",
  "video/mp4", "video/3gpp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "audio/ogg; codecs=opus" -> "audio/ogg" */
function normalizeMime(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

function isAllowed(mime) {
  return ALLOWED.has(normalizeMime(mime));
}

/** Cheap check that the bytes really look like the type they claim to be. */
function sniffOk(buffer, mime) {
  const type = normalizeMime(mime);
  const head = buffer.subarray(0, 12);
  if (type === "image/jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === "image/png") return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (type === "image/webp") return head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP";
  if (type === "application/pdf") return head.subarray(0, 4).toString() === "%PDF";
  return true;
}

/** A safe file name to show in the dashboard (never used as a path). */
function cleanName(name, fallback) {
  const text = String(name || "")
    .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, "_")
    .trim()
    .slice(0, 120);
  return text || fallback;
}

function defaultName(type, mime) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
    "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf", "text/plain": "txt" }[normalizeMime(mime)];
  return (type || "file") + (ext ? "." + ext : "");
}

/** Where a message's file lives on disk. */
function pathFor(messageId) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id < 1) throw new Error("bad message id");
  return path.join(DIR, String(id));
}

/** Write a file for a message (atomically, so a half-written file is never served). */
async function save(messageId, buffer) {
  await fs.promises.mkdir(DIR, { recursive: true, mode: 0o750 });
  const target = pathFor(messageId);
  const temp = `${target}.tmp`;
  await fs.promises.writeFile(temp, buffer, { mode: 0o640 });
  await fs.promises.rename(temp, target);
}

/**
 * Download a customer's file from WhatsApp, keep it, and mark the message.
 * Throws on failure (server.js logs it); the chat keeps working without the file.
 */
async function attach(messageId, phone, media) {
  if (!media || !media.id) return false;

  let got;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      got = await whatsapp.downloadMedia(media.id, { maxBytes: MAX_BYTES });
      break;
    } catch (err) {
      if (err.code === "TOO_LARGE" || attempt === 2) throw err;
      await sleep(1500);
    }
  }

  const mime = normalizeMime(got.mime || media.mime);
  if (!isAllowed(mime)) throw new Error(`file type not kept (${mime || "unknown"})`);
  if (!sniffOk(got.buffer, mime)) throw new Error(`file content does not match its type (${mime})`);

  await save(messageId, got.buffer);
  await db.run(
    "UPDATE messages SET has_media = 1, media_mime = ?, media_name = ?, media_size = ? WHERE id = ?",
    [mime, cleanName(media.filename, defaultName(media.type, mime)), got.size, messageId]
  );
  console.error(`[media] Saved ${mime} (${got.size} bytes) for message ${messageId} from ${phone}.`);
  return true;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Delete files past the retention period, then the oldest ones if the folder is too big. */
async function cleanupOnce() {
  let names;
  try {
    names = await fs.promises.readdir(DIR);
  } catch {
    return { deleted: 0 }; // folder does not exist yet: nothing to clean
  }

  const files = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.promises.stat(path.join(DIR, name));
      files.push({ id: Number(name), size: stat.size, mtime: stat.mtimeMs });
    } catch { /* gone already */ }
  }

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const doomed = new Set(files.filter((f) => f.mtime < cutoff).map((f) => f.id));

  let total = files.filter((f) => !doomed.has(f.id)).reduce((sum, f) => sum + f.size, 0);
  const oldestFirst = files.filter((f) => !doomed.has(f.id)).sort((a, b) => a.mtime - b.mtime);
  while (total > MAX_TOTAL_BYTES && oldestFirst.length) {
    const next = oldestFirst.shift();
    doomed.add(next.id);
    total -= next.size;
  }

  const ids = Array.from(doomed);
  for (const id of ids) {
    try { await fs.promises.unlink(pathFor(id)); } catch { /* already gone */ }
  }
  for (let i = 0; i < ids.length; i += 500) {
    await db.run("UPDATE messages SET has_media = 0 WHERE id IN (?)", [ids.slice(i, i + 500)]).catch((err) =>
      console.error("[media] Could not update messages after cleanup:", err.message));
  }
  if (ids.length) console.error(`[media] Cleanup removed ${ids.length} old file(s).`);
  return { deleted: ids.length };
}

let timer = null;

/** Called once at boot: cleans a couple of minutes after start, then every 6 hours. */
function startCleanup() {
  if (timer) return;
  const run = () => cleanupOnce().catch((err) => console.error("[media] Cleanup failed:", err.message));
  setTimeout(run, 2 * 60 * 1000).unref();
  timer = setInterval(run, CLEANUP_EVERY_MS);
  timer.unref();
}

module.exports = {
  DIR,
  MAX_BYTES,
  ALLOWED,
  normalizeMime,
  isAllowed,
  sniffOk,
  cleanName,
  defaultName,
  pathFor,
  save,
  attach,
  cleanupOnce,
  startCleanup,
};
