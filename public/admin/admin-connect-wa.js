/* Connect WhatsApp page. A separate file because the dashboard's security
 * policy forbids inline scripts. ES5 style, like the rest of the dashboard.
 * Everything that comes from the server is inserted as text, never as HTML. */
(function () {
  "use strict";

  var BASE = location.pathname.replace(/\/admin\/[^/]*$/, "");
  var API = BASE + "/api/whatsapp";
  var FB_ORIGINS = ["https://www.facebook.com", "https://web.facebook.com"];

  var csrf = "";
  var cfg = null;
  var sdkReady = false;
  var busy = false;
  var session = null;
  var authCode = null;
  var waitTimer = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function note(msg, kind) {
    var box = $("note");
    box.className = "note " + (kind || "");
    box.textContent = msg || "";
    box.hidden = !msg;
  }
  function row(label, value) {
    var d = el("div", "kv");
    d.appendChild(el("span", "k", label));
    d.appendChild(el("span", "v", value));
    return d;
  }
  function credsOk() { return !!(cfg && cfg.credentials && cfg.credentials.ok); }
  function refresh() {
    $("connect").disabled = busy || !sdkReady || !cfg || !cfg.ready || !credsOk() || !$("agree").checked;
  }
  function setBusy(v) {
    busy = v;
    refresh();
    $("resync").disabled = v;
    $("disconnect").disabled = v;
  }

  function api(method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.headers["X-CSRF-Token"] = csrf;
      init.body = JSON.stringify(body || {});
    }
    return fetch(API + path, init).then(
      function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, status: res.status, data: data || {} };
        });
      },
      function () { return { ok: false, status: 0, data: { error: "Can't reach the server." } }; }
    );
  }

  function showSteps(steps) {
    var ul = $("steps");
    clear(ul);
    (steps || []).forEach(function (s) {
      ul.appendChild(
        el("li", s.ok ? "" : "bad", (s.ok ? "Done: " : "Needs attention: ") + s.label + (s.detail ? " (" + s.detail + ")" : ""))
      );
    });
  }

  function renderStatus(d) {
    var box = $("status");
    clear(box);
    var c = d.connection;
    if (!c) {
      box.appendChild(row("Saved connection", "None yet"));
      box.appendChild(row("The bot sends from", d.source === "env" ? "the test number from the environment variables" : "nothing configured"));
    } else {
      box.appendChild(row("Number", (c.displayPhone || c.phoneNumberId) + (c.verifiedName ? " (" + c.verifiedName + ")" : "")));
      box.appendChild(row("WhatsApp account ID", c.wabaId));
      box.appendChild(row("Connected on", c.connectedAt ? new Date(c.connectedAt).toLocaleString() : "-"));
      box.appendChild(row("Access token expires", c.tokenExpiresAt ? new Date(c.tokenExpiresAt).toLocaleString() : "no expiry reported"));
      var live = d.live;
      var text = "unknown";
      if (live && live.error) text = "could not check: " + live.error;
      else if (live && live.onBusinessApp === true) text = "yes, coexistence is active";
      else if (live && live.onBusinessApp === false) text = "NO, the app is no longer linked";
      box.appendChild(row("Business app still linked", text));
    }
    var cr = d.credentials;
    if (cr) {
      var crText = cr.ok ? "accepted by Meta" : "rejected by Meta: " + (cr.detail || "unknown reason");
      if (!cr.ok && cr.secretFormatOk === false) {
        crText += ". The saved secret does not look like a 32-character app secret; check for spaces or quotes.";
      }
      box.appendChild(row("App ID and app secret", crText));
    }
    $("resync").hidden = !c;
    $("disconnect").hidden = !c;
  }

  // ---- Facebook SDK ------------------------------------------------------
  function loadSdk() {
    window.fbAsyncInit = function () {
      window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.graphVersion });
      sdkReady = true;
      refresh();
    };
    var s = document.createElement("script");
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.onerror = function () {
      note("Facebook's SDK could not load. It may be blocked by the browser, an ad blocker, or the page's security policy.", "error");
    };
    document.head.appendChild(s);
  }

  // Meta sends the chosen account and number in a window message, around the
  // same time as the login callback. Either can arrive first.
  window.addEventListener("message", function (event) {
    if (FB_ORIGINS.indexOf(event.origin) === -1) return;
    var data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;

    if (/^FINISH/.test(String(data.event))) {
      session = data.data || {};
      maybeComplete();
    } else if (data.event === "CANCEL") {
      var where = data.data && data.data.current_step ? " at step: " + data.data.current_step : "";
      note("Signup was cancelled" + where + ". Nothing was changed.", "error");
    } else if (data.event === "ERROR") {
      note("Meta reported an error: " + ((data.data && (data.data.error_message || data.data.error_id)) || "unknown"), "error");
    }
  });

  function launch() {
    session = null;
    authCode = null;
    note("");
    showSteps([]);
    window.FB.login(
      function (response) {
        if (response && response.authResponse && response.authResponse.code) {
          authCode = response.authResponse.code;
          maybeComplete();
        } else {
          note("The popup was closed or access was not granted. Nothing was changed.", "error");
        }
      },
      {
        config_id: cfg.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding" }
      }
    );
  }

  function maybeComplete() {
    if (busy || !authCode) return;
    if (session) return complete();
    // No session message yet: give it a few seconds, then let the server work it out.
    if (!waitTimer) {
      waitTimer = setTimeout(function () {
        waitTimer = null;
        if (!busy && authCode) complete();
      }, 6000);
    }
  }

  function complete() {
    clearTimeout(waitTimer);
    waitTimer = null;
    setBusy(true);
    note("Finishing setup on the server. Keep this page open.");
    var payload = {
      code: authCode,
      wabaId: (session && session.waba_id) || "",
      phoneNumberId: (session && session.phone_number_id) || ""
    };
    authCode = null;
    api("POST", "/onboard", payload).then(function (r) {
      setBusy(false);
      if (!r.ok) {
        note(r.data.error || "Setup failed.", "error");
        return;
      }
      var allOk = (r.data.steps || []).every(function (s) { return s.ok; });
      note(allOk ? "Connected. Check the list below." : "Connected, but some steps need attention (see below).", allOk ? "ok" : "error");
      showSteps(r.data.steps);
      load();
    });
  }

  function load() {
    return api("GET", "/status").then(function (r) {
      if (r.status === 401) {
        var box = $("status");
        clear(box);
        box.appendChild(document.createTextNode("Please log in to the Shop Desk first, then come back to this page. "));
        var a = el("a", "", "Open the Shop Desk");
        a.href = BASE + "/admin/";
        box.appendChild(a);
        return;
      }
      if (r.status === 403) { $("status").textContent = "Only an admin can use this page."; return; }
      if (!r.ok) { $("status").textContent = r.data.error || "Could not load."; return; }

      var first = !cfg;
      csrf = r.data.csrf;
      cfg = r.data;
      renderStatus(cfg);
      $("actions").hidden = false;
      if (!cfg.ready) {
        note("Missing environment variables: " + cfg.missing.join(", "), "error");
      } else if (!cfg.credentials || !cfg.credentials.ok) {
        note("Meta does not accept the App ID and app secret saved in cPanel. Fix them, restart the app and reload this page. The Connect button stays off until Meta accepts them.", "error");
        if (first) loadSdk();
      } else if (first) {
        loadSdk();
      }
      refresh();
    });
  }

  $("agree").addEventListener("change", refresh);
  $("connect").addEventListener("click", launch);
  $("resync").addEventListener("click", function () {
    setBusy(true);
    api("POST", "/resync").then(function (r) {
      setBusy(false);
      if (!r.ok) return note(r.data.error || "Could not request the sync.", "error");
      showSteps(r.data.steps);
    });
  });
  $("disconnect").addEventListener("click", function () {
    if (!window.confirm("Remove the saved connection? The bot goes back to the test number. The number stays linked at Meta until you unlink it in the Business app.")) return;
    setBusy(true);
    api("POST", "/disconnect").then(function (r) {
      setBusy(false);
      note(r.ok ? (r.data.note || "Removed.") : (r.data.error || "Failed."), r.ok ? "ok" : "error");
      load();
    });
  });

  load();
})();