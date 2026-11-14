/**
 * routes/index.js
 *
 * Builds the dashboard API router, mounted at /api by server.js.
 *
 *   public        /api/setup/*   one-time creation of the first admin
 *                 /api/auth/login, /api/auth/me
 *   login wall    everything below needs a logged-in staff member
 *                 /api/auth/logout, /api/auth/change-password
 *                 chats, items (issues/orders/appointments), staff (admin only)
 */

const express = require("express");
const auth = require("../auth.js");
const { HttpError } = require("../apiUtil.js");
const authRoutes = require("./authRoutes.js");
const chatRoutes = require("./chatRoutes.js");
const itemRoutes = require("./itemRoutes.js");
const { setupRouter, staffRouter } = require("./staffRoutes.js");

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error("[api] Unexpected error:", err);

  res.status(status).json({
    error: status >= 500 ? "Something went wrong on the server." : err.message,
    code: err instanceof HttpError ? err.code : undefined,
  });
}

function createApiRouter() {
  const router = express.Router();

  // Never let browsers or proxies keep copies of API answers.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.use("/setup", setupRouter);
  router.use("/auth", authRoutes); // login/me are public; logout/change-password check login themselves

  // ---- everything below needs a logged-in staff member ----
  router.use(auth.requireAuth);
  router.use(chatRoutes);
  router.use(itemRoutes);
  router.use("/staff", staffRouter);

  router.use((_req, _res, next) => next(new HttpError(404, "Not found.", "NOT_FOUND")));
  router.use(errorHandler);

  return router;
}

module.exports = { createApiRouter };
