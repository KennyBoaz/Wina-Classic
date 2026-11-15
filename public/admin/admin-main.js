/* Shop Desk - sign in, app shell, live updates (polling) and alerts. Loaded last. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, R = WC.R, api = WC.api, icon = WC.icon, setKids = WC.setKids;

  var TABS = [
    ["chats", "Chats", "chat"],
    ["issues", "Tickets", "ticket"],
    ["orders", "Orders", "box"],
    ["appointments", "Appointments", "calendar", "Visits"],
    ["products", "Products", "tag", "Prices"],
    ["staff", "Team", "users"],
  ];
  var BASE_TITLE = "Shop Desk · Wina Classic";

  var pollTimer = null;
  var pollCount = 0;
  var snapshot = null; // last list of active chats, used to spot "new message" / "newly escalated"
  var alertsOn = false;
  var audioCtx = null;
  var loggedOut = true;

  // ====================================================================
  // Brand pieces
  // ====================================================================
  function brand() {
    var mark = h("span", { class: "brand-mark" }, "Wina ", h("em", null, "Classic"));
    var wrap = h("div", { class: "brand" });
    if (WC.config.LOGO_URL) {
      var img = h("img", { class: "brand-logo", src: WC.config.LOGO_URL, alt: "Wina Classic" });
      img.addEventListener("error", function () { setKids(wrap, [mark, h("span", { class: "brand-sub" }, "Shop Desk")]); });
      setKids(wrap, [img, h("span", { class: "brand-sub" }, "Shop Desk")]);
    } else {
      setKids(wrap, [mark, h("span", { class: "brand-sub" }, "Shop Desk")]);
    }
    return wrap;
  }

  function announce() { return h("div", { class: "announce" }, "Quality & Elegance"); }

  // ====================================================================
  // Sign in / first-time setup
  // ====================================================================
  function authScreen(card) {
    stopPolling();
    document.body.classList.remove("chat-open");
    document.title = BASE_TITLE;
    setKids(document.getElementById("app"), [announce(), h("div", { class: "auth-wrap" }, card)]);
  }

  function showLogin(message, info) {
    S.user = null;
    S.csrf = "";
    loggedOut = true;

    var email = h("input", { class: "input", type: "email", autocomplete: "username", required: true, placeholder: "you@example.com", "aria-label": "Email" });
    var pass = h("input", { class: "input", type: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
    var error = h("div", { class: "auth-error hidden", role: "alert" });
    var button = h("button", { class: "btn wide", type: "submit" }, "Sign in");

    function say(text) { error.textContent = text; error.classList.toggle("hidden", !text); }

    var form = h("form", {
      onSubmit: function (e) {
        e.preventDefault();
        say("");
        button.disabled = true;
        api("POST", "/auth/login", { email: email.value, password: pass.value }, { keepOn401: true }).then(function (r) {
          button.disabled = false;
          if (!r.ok) { say((r.data && r.data.error) || "Could not sign in."); pass.value = ""; pass.focus(); return; }
          S.user = r.data.user;
          S.csrf = r.data.csrfToken;
          startApp();
        });
      },
    },
      info ? h("div", { class: "auth-info" }, info) : null,
      error,
      WC.field("Email", email), WC.field("Password", pass), button);

    authScreen(h("div", { class: "auth-card" },
      h("span", { class: "brand-mark" }, "Wina ", h("em", null, "Classic")),
      h("div", { class: "auth-eyebrow" }, "Shop Desk"),
      h("h1", { class: "auth-title" }, "Welcome ", h("em", null, "back")),
      h("p", { class: "auth-sub" }, "Sign in to answer customers and manage orders."),
      form));
    if (message) say(message);
    email.focus();
  }

  function showSetup(enabled) {
    loggedOut = true;
    if (!enabled) {
      authScreen(h("div", { class: "auth-card" },
        h("span", { class: "brand-mark" }, "Wina ", h("em", null, "Classic")),
        h("div", { class: "auth-eyebrow" }, "First-time setup"),
        h("div", { class: "auth-info" }, "No staff accounts exist yet. To create the first admin, add a line like SETUP_TOKEN=a-long-secret-phrase to your .env file, restart the app, and reload this page.")));
      return;
    }

    var token = h("input", { class: "input", type: "password", autocomplete: "off", "aria-label": "Setup token" });
    var name = h("input", { class: "input", type: "text", maxlength: "100", autocomplete: "name" });
    var email = h("input", { class: "input", type: "email", maxlength: "190", autocomplete: "username" });
    var pass = h("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
    var error = h("div", { class: "auth-error hidden", role: "alert" });
    var button = h("button", { class: "btn wide", type: "submit" }, "Create admin account");

    var form = h("form", {
      onSubmit: function (e) {
        e.preventDefault();
        error.classList.add("hidden");
        button.disabled = true;
        api("POST", "/setup", { token: token.value, name: name.value, email: email.value, password: pass.value }, { keepOn401: true }).then(function (r) {
          button.disabled = false;
          if (!r.ok) { error.textContent = (r.data && r.data.error) || "Could not create the account."; error.classList.remove("hidden"); return; }
          showLogin(null, "Admin account created. Please sign in.");
        });
      },
    },
      error,
      WC.field("Setup token", token, "The SETUP_TOKEN value from your .env file."),
      WC.field("Your name", name), WC.field("Email (used to sign in)", email), WC.field("Password", pass), button);

    authScreen(h("div", { class: "auth-card" },
      h("span", { class: "brand-mark" }, "Wina ", h("em", null, "Classic")),
      h("div", { class: "auth-eyebrow" }, "First-time setup"),
      h("h1", { class: "auth-title" }, "Create the first ", h("em", null, "admin")),
      h("p", { class: "auth-sub" }, "This page only works while there are no staff accounts."),
      form));
    token.focus();
  }

  WC.onUnauthorized = function () {
    if (loggedOut) return;
    showLogin("Your session has ended. Please sign in again.");
  };

  // ====================================================================
  // App shell
  // ====================================================================
  function startApp() {
    loggedOut = false;
    snapshot = null;
    S.summary = null;
    S.tab = "chats";
    S.chats.selected = null;
    S.chats.detail = null;
    S.chats.messages = [];
    Object.keys(S.items).forEach(function (k) { S.items[k].loaded = false; S.items[k].rows = []; });

    try { alertsOn = localStorage.getItem("wc_alerts") === "on"; } catch (e) { alertsOn = false; }

    var isAdmin = S.user.role === "admin";
    var tabs = TABS.filter(function (t) { return t[0] !== "staff" || isAdmin; });

    R.tabButtons = {};
    var tabBar = h("nav", { class: "tabs", "aria-label": "Sections" }, tabs.map(function (t) {
      var badge = h("span", { class: "badge hidden" });
      var btn = h("button", { class: "tab", type: "button", onClick: function () { WC.showTab(t[0]); } }, icon(t[2]), h("span", { class: "tl" }, t[1]), h("span", { class: "tl-s" }, t[3] || t[1]), badge);
      R.tabButtons[t[0]] = { btn: btn, badge: badge };
      return btn;
    }));

    R.live = h("span", { class: "live" });
    R.liveText = h("span", { class: "lt" }, "Live");
    R.live.appendChild(R.liveText);
    R.alertsBtn = h("button", { class: "btn ghost small alerts-btn", type: "button", onClick: toggleAlerts });
    renderAlertsButton();

    var topbar = h("header", { class: "topbar" }, brand(), tabBar, h("div", { class: "top-right" }, R.live, R.alertsBtn, userMenu()));

    R.views = { chats: h("div", { class: "view chats-view" }, WC.buildChats()) };
    ["issues", "orders", "appointments"].forEach(function (k) { R.views[k] = h("div", { class: "view" }, WC.buildItems(k)); });
    R.views.products = h("div", { class: "view" }, WC.buildProducts());
    if (isAdmin) R.views.staff = h("div", { class: "view" }, WC.buildStaff());
    var main = h("main", { class: "main" }, Object.keys(R.views).map(function (k) { return R.views[k]; }));

    setKids(document.getElementById("app"), [announce(), topbar, main]);
    WC.showTab("chats");

    WC.loadChats(true);
    WC.refreshSummary();
    refreshSnapshot(); // starting point for "what's new" detection
    schedulePoll();
  }

  WC.showTab = function (name) {
    if (!R.views || !R.views[name]) return;
    S.tab = name;
    Object.keys(R.views).forEach(function (k) {
      R.views[k].classList.toggle("active", k === name);
      R.tabButtons[k].btn.classList.toggle("active", k === name);
    });
    document.body.classList.toggle("chat-open", name === "chats" && !!S.chats.selected);
    if (name === "issues" || name === "orders" || name === "appointments") {
      if (!S.items[name].loaded) WC.loadItems(name, true); else WC.refreshItems(name);
    }
    if (name === "staff") WC.loadStaff();
    if (name === "products") WC.loadProducts(true);
    if (name === "chats") WC.refreshChatList();
  };

  function userMenu() {
    var menu = h("div", { class: "menu hidden", role: "menu" },
      h("div", { class: "who" }, h("b", null, S.user.name), h("small", null, S.user.email + " · " + (S.user.role === "admin" ? "Admin" : "Staff"))),
      h("button", { type: "button", role: "menuitem", onClick: function () { menu.classList.add("hidden"); WC.changePasswordDialog(); } }, icon("key"), "Change password"),
      h("button", { type: "button", role: "menuitem", onClick: logout }, icon("logout"), "Sign out"));
    var btn = h("button", { class: "user-btn", type: "button", "aria-haspopup": "menu", "aria-label": "Account menu", onClick: function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); } },
      WC.avatar(S.user.name, "u" + S.user.id), h("span", { class: "nm" }, S.user.name));
    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) menu.classList.add("hidden"); });
    return h("div", { class: "user-wrap" }, btn, menu);
  }

  function logout() {
    api("POST", "/auth/logout", {}, { keepOn401: true }).then(function () {
      showLogin(null, "You have been signed out.");
    });
  }

  // ====================================================================
  // Live updates: a small check every few seconds
  // ====================================================================
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function schedulePoll() {
    stopPolling();
    pollTimer = setTimeout(pollOnce, document.hidden ? WC.config.POLL_HIDDEN_MS : WC.config.POLL_MS);
  }

  function pollOnce() {
    if (loggedOut) return;
    pollCount += 1;
    var jobs = [WC.refreshSummary()];
    if (S.chats.selected) jobs.push(WC.pollThread());
    WC.tickWindow();
    // Safety net: now and then re-read what is on screen even if nothing "new" was reported.
    if (pollCount % 4 === 0) {
      if (S.tab === "chats") jobs.push(WC.refreshChatList());
      else if (S.items[S.tab]) jobs.push(WC.refreshItems(S.tab));
    }
    function done() { if (!loggedOut) schedulePoll(); }
    Promise.all(jobs).then(done, done);
  }

  document.addEventListener("visibilitychange", function () {
    if (!loggedOut && !document.hidden) { stopPolling(); pollOnce(); }
  });
  window.addEventListener("focus", function () { if (!loggedOut) WC.autoRead(); });

  var SUMMARY_WATCH = [
    "last_message_id", "last_incoming_message_id", "unread_chats", "unread_needing_staff", "escalated_chats", "human_chats",
    "new_issues", "new_orders", "new_appointments", "last_issue_id", "last_order_id", "last_appointment_id",
  ];

  WC.refreshSummary = function () {
    return api("GET", "/summary").then(function (r) {
      if (!r.ok) return;
      var prev = S.summary, cur = r.data.summary;
      S.summary = cur;
      updateBadges();
      WC.renderChips();
      if (!prev) return;
      var changed = SUMMARY_WATCH.some(function (k) { return prev[k] !== cur[k]; });
      if (changed) return onNews(prev, cur);
    });
  };

  function updateBadges() {
    var sm = S.summary || {};
    var counts = { chats: sm.unread_needing_staff, issues: sm.new_issues, orders: sm.new_orders, appointments: sm.new_appointments };
    Object.keys(R.tabButtons || {}).forEach(function (k) {
      var n = counts[k] || 0, badge = R.tabButtons[k].badge;
      badge.textContent = n > 99 ? "99+" : n;
      badge.classList.toggle("hidden", !n);
    });
    var total = (counts.chats || 0) + (counts.issues || 0) + (counts.orders || 0) + (counts.appointments || 0);
    document.title = (total ? "(" + total + ") " : "") + BASE_TITLE;
  }

  /** Something changed on the server: refresh what is on screen and raise alerts. */
  function onNews(prev, cur) {
    var jobs = [];
    if (S.tab === "chats") jobs.push(WC.refreshChatList().then(function () { return WC.autoRead(); }));
    if (S.chats.selected) jobs.push(WC.refreshDetail());
    ["issues", "orders", "appointments"].forEach(function (k) {
      if (S.tab === k) jobs.push(WC.refreshItems(k));
    });
    jobs.push(refreshSnapshot().then(chatAlerts));
    if (cur.last_issue_id > prev.last_issue_id) jobs.push(itemAlerts("issues", prev.last_issue_id));
    if (cur.last_order_id > prev.last_order_id) jobs.push(itemAlerts("orders", prev.last_order_id));
    if (cur.last_appointment_id > prev.last_appointment_id) jobs.push(itemAlerts("appointments", prev.last_appointment_id));
    return Promise.all(jobs);
  }

  // ====================================================================
  // Alerts (sound + browser notifications + small on-screen messages)
  // ====================================================================
  function refreshSnapshot() {
    return api("GET", "/conversations?filter=active&limit=50").then(function (r) {
      var prev = snapshot;
      if (r.ok) snapshot = r.data.conversations || [];
      return { prev: prev, now: snapshot };
    });
  }

  function chatAlerts(res) {
    if (!res.prev || !res.now) return;
    var before = {};
    res.prev.forEach(function (c) { before[c.phone] = c; });
    res.now.forEach(function (c) {
      var p = before[c.phone];
      var label = c.name || WC.phone(c.phone);
      var looking = S.chats.selected === c.phone && document.visibilityState === "visible" && document.hasFocus();
      if (c.status === "escalated" && (!p || p.status !== "escalated")) {
        notify("Needs a person", label + " asked to speak to the team.", "esc-" + c.phone, c.phone);
      } else if ((c.mode === "human" || c.status === "escalated") && c.unread_count > (p ? p.unread_count : 0) && !looking) {
        notify(label, c.last_message_preview || "New message", "msg-" + c.phone, c.phone);
      }
    });
  }

  function itemAlerts(kind, afterId) {
    return api("GET", "/" + kind + "?status=new&limit=5").then(function (r) {
      if (!r.ok) return;
      (r.data[kind] || []).filter(function (it) { return it.id > afterId; }).reverse().forEach(function (it) {
        var who = it.customer_name || it.chat_name || WC.phone(it.phone);
        if (kind === "orders") notify("New order", (it.items || []).join(", ") + " · " + who, "order-" + it.id, it.phone);
        else if (kind === "appointments") notify("New appointment request", [it.appt_date, it.appt_time].filter(Boolean).join(" ") + " · " + who, "appt-" + it.id, it.phone);
        else if (it.type === "inquiry") notify("New inquiry", (it.summary || "") + " · " + who, "issue-" + it.id, it.phone);
        else if (it.type !== "escalation") notify("New support ticket", (it.summary || "") + " · " + who, "issue-" + it.id, it.phone);
      });
    });
  }

  function notify(title, body, tag, phone) {
    if (document.visibilityState === "visible") WC.toast(title + ": " + body);
    if (!alertsOn) return;
    chime();
    if ("Notification" in window && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
      try {
        var n = new Notification(title, { body: body, tag: tag });
        n.onclick = function () { window.focus(); if (phone) WC.openChat(phone); n.close(); };
      } catch (e) { /* some browsers only allow this from a service worker */ }
    }
  }

  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var now = audioCtx.currentTime;
      [[880, 0], [1175, 0.15]].forEach(function (n) {
        var osc = audioCtx.createOscillator(), gain = audioCtx.createGain(), t = now + n[1];
        osc.type = "sine";
        osc.frequency.value = n[0];
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.42);
      });
    } catch (e) { /* no audio available: silently skip */ }
  }

  function renderAlertsButton() {
    var denied = "Notification" in window && Notification.permission === "denied";
    setKids(R.alertsBtn, [icon("bell"), h("span", { class: "lbl" }, alertsOn ? (denied ? "Alerts on (sound)" : "Alerts on") : "Enable alerts")]);
    R.alertsBtn.classList.toggle("gold", alertsOn);
    R.alertsBtn.classList.toggle("ghost", !alertsOn);
    R.alertsBtn.title = alertsOn ? "Click to turn alerts off" : "Get a chime and a notification when something needs the team";
  }

  function toggleAlerts() {
    if (alertsOn) {
      alertsOn = false;
      try { localStorage.setItem("wc_alerts", "off"); } catch (e) { /* ignore */ }
      renderAlertsButton();
      WC.toast("Alerts are off.");
      return;
    }
    alertsOn = true;
    try { localStorage.setItem("wc_alerts", "on"); } catch (e) { /* ignore */ }
    chime(); // a click is needed before browsers allow sound
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(renderAlertsButton, renderAlertsButton);
    }
    renderAlertsButton();
    WC.toast("Alerts are on. You'll hear a chime and get a notification while this page stays open.", "ok");
  }

  // Browsers keep sound locked until the page has been clicked once.
  document.addEventListener("click", function () {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });

  // ====================================================================
  // Start
  // ====================================================================
  function boot() {
    api("GET", "/auth/me", null, { keepOn401: true }).then(function (r) {
      if (r.ok) {
        S.user = r.data.user;
        S.csrf = r.data.csrfToken;
        return startApp();
      }
      api("GET", "/setup/status", null, { keepOn401: true }).then(function (s) {
        if (s.ok && s.data.needed) showSetup(!!s.data.enabled);
        else showLogin();
      });
    });
  }

  boot();
})();