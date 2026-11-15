/* Shop Desk - Products (the price list the bot quotes from).
 * Everyone signed in can see it and change a stock level. Admins can also add, edit, archive and import. */
(function () {
  "use strict";

  var WC = window.WC;
  var h = WC.h, S = WC.S, R = WC.R, api = WC.api, icon = WC.icon, setKids = WC.setKids;

  var P = (S.products = { status: "active", search: "", category: "", rows: [], hasMore: false, offset: 0, loaded: false, categories: [] });
  var reqId = 0;
  var STOCK = [["in_stock", "In stock"], ["low", "Low stock"], ["out", "Out of stock"]];

  function isAdmin() { return S.user && S.user.role === "admin"; }
  function money(n) { return n === null || n === undefined ? "On request" : "UGX " + Number(n).toLocaleString("en-US"); }

  // ====================================================================
  // Screen
  // ====================================================================
  WC.buildProducts = function () {
    var ref = (R.products = {});
    ref.seg = h("div", { class: "seg" });
    ref.search = h("input", {
      class: "search", type: "search", placeholder: "Search items", "aria-label": "Search products",
      onInput: WC.debounce(function () { P.search = ref.search.value.trim(); WC.loadProducts(true); }, 250),
    });
    ref.cat = h("select", { class: "input", "aria-label": "Category", onChange: function () { P.category = ref.cat.value; WC.loadProducts(true); } });
    ref.body = h("div");
    ref.more = h("div", { class: "hidden", style: { marginTop: "14px" } },
      h("button", { class: "btn ghost wide", type: "button", onClick: function () { WC.loadProducts(false); } }, "Load more"));
    renderSeg();

    var buttons = isAdmin()
      ? h("div", { class: "head-actions" },
          h("button", { class: "btn ghost", type: "button", onClick: importDialog }, icon("download"), "Import CSV"),
          h("button", { class: "btn", type: "button", onClick: function () { productDialog(null); } }, icon("plus"), "Add product"))
      : null;

    return h("div", { class: "items-view" },
      h("div", { class: "items-inner" },
        h("div", { class: "view-head" },
          h("div", null, h("h2", null, "Price ", h("em", null, "list")),
            h("p", null, "What the bot quotes to customers. It never guesses a price that is not on this list.")),
          buttons),
        h("div", { class: "toolbar" }, ref.seg, h("div", { class: "search-wrap" }, icon("search"), ref.search), ref.cat),
        ref.body, ref.more));
  };

  function renderSeg() {
    setKids(R.products.seg, [["active", "Active"], ["archived", "Archived"], ["all", "All"]].map(function (t) {
      return h("button", {
        class: P.status === t[0] ? "active" : "", type: "button",
        onClick: function () { P.status = t[0]; renderSeg(); WC.loadProducts(true); },
      }, t[1]);
    }));
  }

  function renderCategories() {
    var sel = R.products.cat;
    var opts = [h("option", { value: "" }, "All categories")].concat(P.categories.map(function (c) { return h("option", { value: c }, c); }));
    setKids(sel, opts);
    sel.value = P.categories.indexOf(P.category) >= 0 ? P.category : "";
  }

  WC.loadProducts = function (reset) {
    var token = ++reqId;
    if (reset) P.offset = 0;
    var q = "/products?status=" + P.status + "&limit=50&offset=" + P.offset +
      (P.search ? "&search=" + encodeURIComponent(P.search) : "") + (P.category ? "&category=" + encodeURIComponent(P.category) : "");
    return api("GET", q).then(function (r) {
      if (token !== reqId) return;
      if (!r.ok) return WC.fail(r);
      P.rows = reset ? r.data.products : P.rows.concat(r.data.products);
      P.hasMore = !!r.data.has_more;
      P.offset = P.rows.length;
      P.categories = r.data.categories || [];
      P.loaded = true;
      renderCategories();
      renderRows();
    });
  };

  function stockSelect(p) {
    var sel = h("select", { class: "input stock-select s-" + p.stock, "aria-label": "Stock for " + p.name });
    STOCK.forEach(function (s) { sel.appendChild(h("option", { value: s[0] }, s[1])); });
    sel.value = p.stock;
    sel.addEventListener("change", function () {
      api("PATCH", "/products/" + p.id, { stock: sel.value }).then(function (r) {
        if (!r.ok) { sel.value = p.stock; return WC.fail(r); }
        p.stock = r.data.product.stock;
        sel.className = "input stock-select s-" + p.stock;
        WC.toast("Stock updated.", "ok");
      });
    });
    return sel;
  }

  function renderRows() {
    var ref = R.products;
    if (!P.rows.length) {
      setKids(ref.body, [h("div", { class: "empty-state" },
        h("h3", null, P.search || P.category ? "Nothing matches" : "No products yet"),
        h("p", null, P.search || P.category ? "Try a different search." : (isAdmin()
          ? "Add items one by one, or import your price list from a CSV file (Excel can save one)."
          : "An admin needs to add the price list first.")))]);
      ref.more.classList.add("hidden");
      return;
    }
    var rows = P.rows.map(function (p) {
      return h("tr", { class: p.active ? "" : "is-archived" },
        h("td", null, h("b", null, p.name), p.brand ? h("div", { class: "muted" }, p.brand) : null),
        h("td", { class: "muted" }, p.category || ""),
        h("td", { class: "price" }, money(p.price_ugx)),
        h("td", null, stockSelect(p)),
        h("td", { class: "muted det" }, p.details || ""),
        h("td", { class: "actions" }, isAdmin() ? [
          h("button", { class: "btn ghost small", type: "button", onClick: function () { productDialog(p); } }, icon("edit"), "Edit"),
          h("button", { class: "btn ghost small", type: "button", onClick: function () { archive(p); } }, p.active ? "Archive" : "Restore"),
        ] : null));
    });
    setKids(ref.body, [h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, ["Item", "Category", "Price", "Stock", "Details", ""].map(function (t) { return h("th", null, t); }))),
      h("tbody", null, rows)))]);
    ref.more.classList.toggle("hidden", !P.hasMore);
  }

  function archive(p) {
    api("PATCH", "/products/" + p.id, { active: !p.active }).then(function (r) {
      if (!r.ok) return WC.fail(r);
      WC.toast(p.active ? "Archived. The bot will no longer quote it." : "Restored.", "ok");
      WC.loadProducts(true);
    });
  }

  // ====================================================================
  // Add / edit
  // ====================================================================
  function productDialog(p) {
    var name = h("input", { class: "input", type: "text", maxlength: "190", placeholder: "e.g. Santoni black loafers" });
    var brand = h("input", { class: "input", type: "text", maxlength: "100", placeholder: "e.g. Santoni" });
    var category = h("input", { class: "input", type: "text", maxlength: "60", placeholder: "e.g. Shoes", list: "cat-list" });
    var catList = h("datalist", { id: "cat-list" }, P.categories.map(function (c) { return h("option", { value: c }); }));
    var price = h("input", { class: "input", type: "text", inputmode: "numeric", placeholder: "e.g. 2450000 (leave empty for 'on request')" });
    var stock = h("select", { class: "input" }, STOCK.map(function (s) { return h("option", { value: s[0] }, s[1]); }));
    var details = h("textarea", { class: "input", maxlength: "500", placeholder: "Sizes, colours, notes the bot may share" });
    if (p) {
      name.value = p.name; brand.value = p.brand || ""; category.value = p.category || "";
      price.value = p.price_ugx === null ? "" : String(p.price_ugx); stock.value = p.stock; details.value = p.details || "";
    }
    WC.dialog({
      title: p ? "Edit product" : "Add product",
      body: [WC.field("Name", name), WC.field("Brand", brand), WC.field("Category", category), catList,
        WC.field("Price (UGX)", price), WC.field("Stock", stock), WC.field("Details", details)],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: p ? "Save" : "Add",
          onClick: function (dlg) {
            var body = { name: name.value, brand: brand.value, category: category.value, price_ugx: price.value, stock: stock.value, details: details.value };
            return api(p ? "PATCH" : "POST", p ? "/products/" + p.id : "/products", body).then(function (r) {
              if (!r.ok) { dlg.error((r.data && r.data.error) || "Could not save."); return false; }
              WC.toast(p ? "Saved." : "Product added.", "ok");
              WC.loadProducts(true);
            });
          },
        },
      ],
    });
  }

  // ====================================================================
  // CSV import (parsed in the browser, checked again by the server)
  // ====================================================================
  var ALIASES = {
    name: ["name", "item", "product", "product name", "item name", "description of item"],
    brand: ["brand", "make", "designer"],
    category: ["category", "type", "department", "group"],
    price_ugx: ["price", "price ugx", "price (ugx)", "price_ugx", "selling price", "ugx", "amount", "cost"],
    stock: ["stock", "stock status", "availability", "status", "in stock"],
    details: ["details", "notes", "sizes", "description", "info"],
  };

  /** Comma, semicolon or tab separated text -> array of rows (handles "quoted, values"). */
  function parseTable(text) {
    var first = String(text).split(/\r?\n/)[0] || "";
    var delim = [",", ";", "\t"].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], cell = "", inQ = false, i, c;
    text = String(text).replace(/^\uFEFF/, "");
    for (i = 0; i < text.length; i += 1) {
      c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (c === '"') inQ = false;
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i += 1;
        row.push(cell); cell = "";
        if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(function (x) { return x.trim() !== ""; })) rows.push(row);
    return rows;
  }

  function stockFrom(value) {
    var v = String(value || "").trim().toLowerCase();
    if (!v) return undefined;
    if (/^(out|no|sold|0|none|unavailable)/.test(v)) return "out";
    if (/^(low|few|limited|last)/.test(v)) return "low";
    return "in_stock";
  }

  function rowsFromTable(table) {
    if (table.length < 2) return { error: "The file needs a header row and at least one item." };
    var headers = table[0].map(function (x) { return x.trim().toLowerCase(); });
    var map = {};
    Object.keys(ALIASES).forEach(function (field) {
      var idx = headers.findIndex(function (hd) { return ALIASES[field].indexOf(hd) >= 0; });
      if (idx >= 0) map[field] = idx;
    });
    if (map.name === undefined) return { error: "I could not find a column called name (or item / product). Check the first row." };
    var rows = table.slice(1).map(function (cells) {
      var o = {};
      Object.keys(map).forEach(function (field) { o[field] = (cells[map[field]] || "").trim(); });
      if (o.stock !== undefined) { var s = stockFrom(o.stock); if (s) o.stock = s; else delete o.stock; }
      return o;
    }).filter(function (o) { return o.name; });
    return { rows: rows, columns: Object.keys(map) };
  }

  function importDialog() {
    var file = h("input", { type: "file", accept: ".csv,.txt,.tsv,text/csv" });
    var paste = h("textarea", { class: "input", placeholder: "...or paste rows copied from Excel here (first row = column names)" });
    var preview = h("div", { class: "import-preview" });
    var parsed = null;

    function show(text) {
      parsed = rowsFromTable(parseTable(text));
      if (parsed.error) { setKids(preview, [h("div", { class: "dialog-error" }, parsed.error)]); parsed = null; return; }
      var sample = parsed.rows.slice(0, 5);
      setKids(preview, [
        h("p", null, h("b", null, parsed.rows.length + " items"), " found. Columns used: " + parsed.columns.join(", ") + "."),
        h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, parsed.columns.map(function (c) { return h("th", null, c); }))),
          h("tbody", null, sample.map(function (o) { return h("tr", null, parsed.columns.map(function (c) { return h("td", null, o[c] === undefined ? "" : String(o[c])); })); })))),
        parsed.rows.length > 5 ? h("div", { class: "hint" }, "Showing the first 5 rows.") : null,
      ]);
    }
    file.addEventListener("change", function () {
      var f = file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { show(String(reader.result)); };
      reader.readAsText(f);
    });
    paste.addEventListener("input", function () { if (paste.value.trim()) show(paste.value); });

    var sample = h("button", {
      class: "link", type: "button",
      onClick: function () {
        var csv = "name,brand,category,price,stock,details\nSantoni black loafers,Santoni,Shoes,2450000,in stock,Sizes 40-45\nAmouage Reflection Man 100ml,Amouage,Fragrances,1850000,low,\n";
        var url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        var a = h("a", { href: url, download: "price-list-sample.csv", style: { display: "none" } });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      },
    }, "Download a sample file");

    WC.dialog({
      title: "Import price list",
      wide: true,
      body: [
        h("p", { class: "muted" }, "Columns: name (required), brand, category, price, stock, details. Items that already exist (same name and brand) are updated; new ones are added. ", sample, "."),
        WC.field("CSV file", file), paste, preview,
      ],
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Import",
          onClick: function (dlg) {
            if (!parsed || !parsed.rows.length) { dlg.error("Choose a file or paste your rows first."); return false; }
            var chunks = [], i;
            for (i = 0; i < parsed.rows.length; i += 400) chunks.push(parsed.rows.slice(i, i + 400));
            var total = { created: 0, updated: 0, skipped: 0, errors: [] };
            return chunks.reduce(function (p, chunk) {
              return p.then(function (ok) {
                if (!ok) return false;
                return api("POST", "/products/import", { rows: chunk }).then(function (r) {
                  if (!r.ok) { dlg.error((r.data && r.data.error) || "Import failed."); return false; }
                  total.created += r.data.created; total.updated += r.data.updated; total.skipped += r.data.skipped;
                  total.errors = total.errors.concat(r.data.errors || []);
                  return true;
                });
              });
            }, Promise.resolve(true)).then(function (ok) {
              if (!ok) return false;
              WC.toast("Imported: " + total.created + " added, " + total.updated + " updated" + (total.skipped ? ", " + total.skipped + " skipped" : "") + ".", total.skipped ? "" : "ok");
              WC.loadProducts(true);
            });
          },
        },
      ],
    });
  }
})();