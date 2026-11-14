/* Temporary test page for the Phase 2 API. Replaced by the real dashboard in Phase 3. */
(function () {
  "use strict";

  // Works whether the app is reached at /admin/... or /winaclassic/admin/...
  var base = location.pathname.replace(/\/admin\/[^/]*$/, "");
  var api = base + "/api";
  var csrf = "";
  var currentPhone = "";

  function $(id) { return document.getElementById(id); }
  function show(title, data) { $("out").textContent = title + "\n\n" + (typeof data === "string" ? data : JSON.stringify(data, null, 2)); }

  function call(method, path, body) {
    var options = { method: method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      options.headers["Content-Type"] = "application/json";
      options.headers["X-CSRF-Token"] = csrf;
      options.body = JSON.stringify(body || {});
    }
    return fetch(api + path, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function run(method, path, body) {
    return call(method, path, body).then(function (r) {
      show(method + " " + path + "  ->  HTTP " + r.status, r.data);
      return r;
    }).catch(function (err) { show("Network error", String(err)); });
  }

  function loggedIn(data) {
    csrf = data.csrfToken;
    $("who").textContent = data.user.name + " (" + data.user.role + ")";
    $("loginBox").classList.add("hidden");
    $("setupBox").classList.add("hidden");
    $("tools").classList.remove("hidden");
  }

  function loadChats() {
    return call("GET", "/conversations?filter=active&limit=20").then(function (r) {
      var box = $("chats");
      box.textContent = "";
      var list = (r.data && r.data.conversations) || [];
      if (!list.length) box.textContent = "No chats yet.";
      list.forEach(function (c) {
        var b = document.createElement("button");
        b.textContent = (c.name || c.phone) + " [" + c.mode + "/" + c.status + (c.unread_count ? ", " + c.unread_count + " unread" : "") + "]";
        b.addEventListener("click", function () { currentPhone = c.phone; $("current").textContent = c.phone; show("Selected", c); });
        box.appendChild(b);
      });
    });
  }

  function needChat() {
    if (!currentPhone) { show("Pick a chat first", "Click one of the chat buttons above."); return false; }
    return true;
  }

  // ---- start up: are we already logged in? is setup needed? ----
  call("GET", "/auth/me").then(function (r) {
    if (r.status === 200) { loggedIn(r.data); loadChats(); return; }
    call("GET", "/setup/status").then(function (s) {
      if (s.data && s.data.needed) {
        $("setupBox").classList.remove("hidden");
        show("No staff accounts yet", s.data.enabled
          ? "Create the first admin above."
          : "Setup is not enabled. Add SETUP_TOKEN=some-long-secret to your .env file, restart the app, and reload this page.");
      }
    });
  });

  $("setupBtn").addEventListener("click", function () {
    run("POST", "/setup", {
      token: $("setupToken").value, name: $("setupName").value,
      email: $("setupEmail").value, password: $("setupPassword").value
    }).then(function (r) { if (r && r.status === 201) { $("setupBox").classList.add("hidden"); show("Admin created", "Now log in below."); } });
  });

  $("loginBtn").addEventListener("click", function () {
    call("POST", "/auth/login", { email: $("email").value, password: $("password").value }).then(function (r) {
      if (r.status === 200) { loggedIn(r.data); show("Logged in", r.data.user); loadChats(); }
      else show("Login failed (HTTP " + r.status + ")", r.data);
    });
  });

  $("logoutBtn").addEventListener("click", function () {
    call("POST", "/auth/logout", {}).then(function () { location.reload(); });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-get]"), function (b) {
    b.addEventListener("click", function () { run("GET", b.getAttribute("data-get")); });
  });

  $("msgsBtn").addEventListener("click", function () { if (needChat()) run("GET", "/conversations/" + currentPhone + "/messages"); });
  $("detailBtn").addEventListener("click", function () { if (needChat()) run("GET", "/conversations/" + currentPhone); });
  $("takeBtn").addEventListener("click", function () { if (needChat()) run("POST", "/conversations/" + currentPhone + "/takeover").then(loadChats); });
  $("backBtn").addEventListener("click", function () { if (needChat()) run("POST", "/conversations/" + currentPhone + "/handback").then(loadChats); });
  $("resolveBtn").addEventListener("click", function () { if (needChat()) run("POST", "/conversations/" + currentPhone + "/resolve", { note: "Resolved from the API check page" }).then(loadChats); });
  $("reopenBtn").addEventListener("click", function () { if (needChat()) run("POST", "/conversations/" + currentPhone + "/reopen").then(loadChats); });
  $("sendBtn").addEventListener("click", function () {
    if (!needChat()) return;
    run("POST", "/conversations/" + currentPhone + "/messages", { text: $("text").value }).then(function (r) {
      if (r && r.status === 201) $("text").value = "";
      loadChats();
    });
  });

  $("itemBtn").addEventListener("click", function () {
    var id = parseInt($("itemId").value, 10);
    if (!id) { show("Enter the item's id number first", "Use the lists above to find it."); return; }
    var body = { status: $("status").value };
    if ($("note").value) body.note = $("note").value;
    run("PATCH", "/" + $("kind").value + "/" + id, body);
  });
})();
