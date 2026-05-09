// GET /. `DASHBOARD_TRANSIT_WALLET_MARKER` → real address in express-app.ts (SSR).
export const DASHBOARD_TRANSIT_WALLET_MARKER = "%%AEGIS_TRANSIT_WALLET_ADDR%%";

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Aegis · Daemon</title>
  <style>
    :root {
      --bg:#07080b; --elev:#0e1116; --elev2:#141821; --border:#1f242e; --border2:#2a3140;
      --text:#e6e8ee; --dim:#8b93a7; --faint:#5a6275; --accent:#7cf9d0; --accent2:#2b7a63;
      --danger:#ff6b6b; --warn:#ffb86b; --mono: ui-monospace, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
      font: 14px/1.5 system-ui, sans-serif;
      padding: 28px 20px 48px;
    }
    .wrap { max-width: 920px; margin: 0 auto; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 22px; flex-wrap: wrap; gap: 12px;
    }
    .title { font-weight: 700; font-size: 18px; }
    .sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;
      border-radius: 999px; font: 12px var(--mono); border: 1px solid rgba(124,249,208,.2);
      background: rgba(124,249,208,.08); color: var(--accent);
    }
    .pill.offline {
      border-color: rgba(255,107,107,.25); background: rgba(255,107,107,.08); color: var(--danger);
    }
    .pill .dot {
      width: 8px; height: 8px; border-radius: 50%; background: currentColor;
    }
    .grid2 {
      display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;
    }
    @media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
    .card {
      background: var(--elev); border: 1px solid var(--border); border-radius: 12px;
      padding: 18px 20px;
    }
    .card h2 {
      margin: 0 0 12px; font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
      color: var(--dim); font-weight: 600;
    }
    .wallet-row {
      display: flex; align-items: center; gap: 8px; padding: 12px;
      background: var(--elev2); border: 1px solid var(--border); border-radius: 8px;
      font: 13px var(--mono); word-break: break-all;
    }
    .wallet-row .addr { flex: 1; }
    .balance-num {
      font: 600 36px var(--mono); letter-spacing: -.02em;
    }
    .balance-unit { color: var(--dim); font-size: 12px; margin-left: 6px; text-transform: uppercase; }
    .balance-sub { margin-top: 6px; font: 12px var(--mono); color: var(--dim); }
    .balance-sub.warn { color: var(--warn); }
    .hint { margin-top: 10px; font-size: 12px; color: var(--faint); line-height: 1.5; }
    .hint code {
      font: 11px var(--mono); background: var(--elev2); padding: 2px 6px;
      border-radius: 4px; border: 1px solid var(--border); color: var(--dim);
    }
    .btn {
      padding: 6px 12px; border-radius: 7px; border: 1px solid var(--border2);
      background: transparent; color: var(--dim); font: inherit; font-size: 12px;
      cursor: pointer;
    }
    .btn:hover { color: var(--text); border-color: var(--accent2); }
    .btn.primary {
      background: linear-gradient(135deg,#7cf9d0,#4a9eff); color: #061014;
      border: 0; font-weight: 600; padding: 10px 16px;
    }
    .btn.danger { border-color: rgba(255,107,107,.4); color: var(--danger); }
    .btn.sm { padding: 5px 10px; font-size: 11px; }
    table.kv { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.kv th, table.kv td {
      padding: 10px 8px; text-align: left; border-bottom: 1px solid var(--border);
    }
    table.kv th {
      font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint);
    }
    table.kv code { font: 12px var(--mono); color: var(--accent); }
    .row-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .field { margin-bottom: 12px; }
    .field label {
      display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
      color: var(--faint); margin-bottom: 6px; font-weight: 600;
    }
    .field input, .field select {
      width: 100%; max-width: 400px; padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--elev2); color: var(--text);
      font: 13px var(--mono);
    }
    .relay-banner {
      font: 12px var(--mono); color: var(--dim); padding: 12px;
      background: var(--elev2); border: 1px solid var(--border); border-radius: 8px;
      margin-top: 14px; word-break: break-all;
    }
    .relay-banner strong { color: var(--text); }
    .section-label {
      margin: 22px 0 10px; font-size: 10px; letter-spacing: .1em;
      text-transform: uppercase; color: var(--faint); font-weight: 600;
    }
    #relay-msg {
      flex: 1; font: 12px var(--mono); color: var(--dim); min-height: 18px;
    }
    #relay-msg.ok { color: var(--accent); }
    #relay-msg.err { color: var(--danger); }
    #relay-msg.busy { color: var(--warn); }
    .actions-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
    #vault-msg { flex: 1; font: 12px var(--mono); color: var(--dim); min-height: 18px; }
    #vault-msg.ok { color: var(--accent); }
    #vault-msg.err { color: var(--danger); }
    #vault-msg.busy { color: var(--warn); }
    .masked { letter-spacing: 2px; color: var(--dim); font-family: var(--mono); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <div class="title">Aegis · Local daemon</div>
        <div class="sub">Wallet and vault for this process only.</div>
      </div>
      <div class="pill" id="status"><span class="dot"></span> <span id="status-text">…</span></div>
    </header>

    <div class="grid2">
      <div class="card">
        <h2>Transit wallet</h2>
        <div class="wallet-row">
          <span class="addr" id="wallet-addr">${DASHBOARD_TRANSIT_WALLET_MARKER}</span>
          <button type="button" class="btn" id="copy-btn">Copy</button>
        </div>
        <p class="hint">Base · fund with USDC to receive credits (see Router / ledger rules).</p>
      </div>
      <div class="card">
        <h2>Credit balance</h2>
        <div>
          <span class="balance-num" id="balance-num">—</span><span class="balance-unit">credits</span>
        </div>
        <div class="balance-sub" id="balance-sub">Loading…</div>
      </div>
    </div>

    <div class="card">
      <h2>API keys &amp; relay</h2>
      <p class="hint">Stored under <code>AEGIS_HOME</code> as <code>vault.json</code>. Values are never returned after save.</p>
      <div style="overflow-x:auto;margin-top:14px;">
        <table class="kv" aria-label="Vault keys">
          <thead><tr><th>Key</th><th>Value</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody id="vault-tbody"></tbody>
        </table>
      </div>
      <p id="vault-empty" class="hint" hidden>No keys yet — add one below.</p>
      <div style="margin-top:20px;">
        <div class="field">
          <label for="vault-new-key">Key name</label>
          <input id="vault-new-key" type="text" placeholder="NEWSAPI_API_KEY" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field">
          <label for="vault-new-val">Secret</label>
          <input id="vault-new-val" type="password" autocomplete="new-password" spellcheck="false" />
        </div>
        <div class="actions-row">
          <button type="button" class="btn primary" id="vault-add-btn">Save key</button>
          <span id="vault-msg"></span>
        </div>
      </div>

      <div class="section-label">Relay listener</div>
      <div class="relay-banner" id="relay-banner">Loading relay status…</div>

      <div class="section-label">Registered relays</div>
      <p id="relay-empty" class="hint" hidden>No relays registered.</p>
      <div style="overflow-x:auto;">
        <table class="kv" aria-label="Relay registrations">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Vault key</th>
              <th>Fee</th>
              <th>Limit / 24h</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="relay-tbody"></tbody>
        </table>
      </div>

      <div class="section-label">Register or update relay</div>
      <p class="hint">Offer relay execution for a Skill Ledger provider id using a vault key above.</p>
      <div class="field">
        <label for="relay-slug">Provider slug</label>
        <input id="relay-slug" type="text" placeholder="newsapi" autocomplete="off" spellcheck="false" />
      </div>
      <div class="field">
        <label for="relay-vault-key">Vault key</label>
        <select id="relay-vault-key"><option value="">— choose vault key —</option></select>
      </div>
      <div class="field">
        <label for="relay-fee">Fee per relay (credits)</label>
        <input id="relay-fee" type="number" min="0" step="1" value="10" />
      </div>
      <div class="field">
        <label for="relay-rate">Max relays / 24h</label>
        <input id="relay-rate" type="number" min="1" step="1" value="100" />
      </div>
      <div class="actions-row">
        <button type="button" class="btn primary" id="relay-save-btn">Save relay</button>
        <span id="relay-msg"></span>
      </div>
    </div>
  </div>

  <script>
    var CREDITS_PER_USD = 10000;
    function $(id) { return document.getElementById(id); }
    function fmtNum(n) {
      return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-US");
    }
    function fmtUsd(n) {
      return (n == null || isNaN(n)) ? "—" : ("$" + Number(n).toFixed(4));
    }
    function asFiniteNumber(v) {
      if (v == null) return null;
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        var n = Number(v);
        return isFinite(n) ? n : null;
      }
      return null;
    }
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/\x3c/g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");
    }
    function setOnline(on, msg) {
      var pill = $("status"), txt = $("status-text");
      if (!pill || !txt) return;
      pill.classList.toggle("offline", !on);
      txt.textContent = msg || (on ? "ok" : "offline");
    }
    function setMsg(el, text, kind) {
      if (!el) return;
      el.textContent = text || "";
      el.classList.remove("ok", "err", "busy");
      if (kind) el.classList.add(kind);
    }

    var vaultMsg = $("vault-msg");
    var relayMsg = $("relay-msg");

    function populateRelayVaultSelect(entries, preferredValue) {
      var sel = $("relay-vault-key");
      if (!sel) return;
      var prev = preferredValue != null ? preferredValue : sel.value;
      sel.innerHTML = '<option value="">— choose vault key —</option>';
      entries.forEach(function (e) {
        var opt = document.createElement("option");
        opt.value = e.key;
        opt.textContent = e.key + (e.has_value ? "" : " (empty)");
        sel.appendChild(opt);
      });
      if (prev && [].some.call(sel.options, function (o) { return o.value === prev; }))
        sel.value = prev;
    }

    function renderRelayLoadError(vaultEntries, msg) {
      var banner = $("relay-banner"), tbody = $("relay-tbody"), emptyHint = $("relay-empty");
      if (banner) banner.textContent = msg || "Relay unavailable.";
      populateRelayVaultSelect(vaultEntries);
      if (tbody) tbody.innerHTML = "";
      if (emptyHint) emptyHint.hidden = false;
    }

    function renderRelayStatus(rs, vaultEntries) {
      var banner = $("relay-banner"), tbody = $("relay-tbody"), emptyHint = $("relay-empty");
      if (!banner || !tbody || !emptyHint) return;

      var subs = Array.isArray(rs.subscriptions) ? rs.subscriptions : [];
      var conn = rs.connected ? "connected" : "disconnected";
      var w = typeof rs.wallet === "string" ? rs.wallet : "—";
      banner.textContent = "";
      var s1 = document.createElement("strong");
      s1.textContent = "Listener";
      banner.appendChild(s1);
      banner.appendChild(document.createTextNode(": " + conn + " · "));
      var s2 = document.createElement("strong");
      s2.textContent = "Wallet";
      banner.appendChild(s2);
      banner.appendChild(document.createTextNode(": " + w + " · "));
      var s3 = document.createElement("strong");
      s3.textContent = "NATS subs";
      banner.appendChild(s3);
      banner.appendChild(document.createTextNode(": " + subs.length));

      populateRelayVaultSelect(vaultEntries);

      tbody.innerHTML = "";
      var nodes = Array.isArray(rs.configured) ? rs.configured : [];
      emptyHint.hidden = nodes.length > 0;
      nodes.forEach(function (n) {
        var tr = document.createElement("tr");
        var tdP = document.createElement("td");
        tdP.innerHTML = "<code>" + escapeHtml(n.provider_slug || "") + "</code>";
        var tdV = document.createElement("td");
        tdV.innerHTML = "<code>" + escapeHtml(n.vault_key_name || "") + "</code>";
        var tdFee = document.createElement("td");
        tdFee.style.fontFamily = "var(--mono)";
        tdFee.textContent = String(n.fee_per_call ?? "—");
        var tdRate = document.createElement("td");
        tdRate.style.fontFamily = "var(--mono)";
        tdRate.textContent = String(n.rate_limit_max ?? "—");
        var tdA = document.createElement("td");
        tdA.style.textAlign = "right";
        var wrap = document.createElement("div");
        wrap.className = "row-actions";
        var btnEd = document.createElement("button");
        btnEd.type = "button";
        btnEd.className = "btn sm";
        btnEd.textContent = "Edit";
        btnEd.addEventListener("click", function () {
          var slugEl = $("relay-slug"), feeEl = $("relay-fee"), rateEl = $("relay-rate");
          if (slugEl) slugEl.value = (n.provider_slug || "").toLowerCase();
          populateRelayVaultSelect(vaultEntries, n.vault_key_name || "");
          if (feeEl) feeEl.value = String(n.fee_per_call != null ? n.fee_per_call : 10);
          if (rateEl) rateEl.value = String(n.rate_limit_max != null ? n.rate_limit_max : 100);
          if (slugEl) slugEl.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        var btnRm = document.createElement("button");
        btnRm.type = "button";
        btnRm.className = "btn sm danger";
        btnRm.textContent = "Remove";
        btnRm.addEventListener("click", async function () {
          if (!confirm('Stop relay for "' + (n.provider_slug || "") + '"?')) return;
          setMsg(relayMsg, "Removing…", "busy");
          try {
            var rd = await fetch("/api/relay/" + encodeURIComponent(n.provider_slug), { method: "DELETE" });
            var js = await rd.json().catch(function () { return {}; });
            if (!rd.ok) throw new Error(js.message || js.error || "delete failed");
            setMsg(relayMsg, "Removed.", "ok");
            await refreshAll();
          } catch (err) {
            setMsg(relayMsg, err.message || String(err), "err");
          }
        });
        wrap.appendChild(btnEd);
        wrap.appendChild(btnRm);
        tdA.appendChild(wrap);
        tr.appendChild(tdP);
        tr.appendChild(tdV);
        tr.appendChild(tdFee);
        tr.appendChild(tdRate);
        tr.appendChild(tdA);
        tbody.appendChild(tr);
      });
    }

    async function refreshAll() {
      var tbody = $("vault-tbody"), emptyHint = $("vault-empty");
      if (!tbody || !emptyHint) return;

      var vaultEntries = [];

      tbody.innerHTML = "";
      try {
        var vr = await fetch("/api/vault", { cache: "no-store" });
        if (!vr.ok) throw new Error("HTTP " + vr.status);
        var vData = await vr.json();
        vaultEntries = Array.isArray(vData.entries) ? vData.entries : [];
        emptyHint.hidden = vaultEntries.length > 0;
        vaultEntries.forEach(function (e) {
          var tr = document.createElement("tr");
          tr.dataset.key = e.key;
          var tdK = document.createElement("td");
          tdK.innerHTML = "<code>" + escapeHtml(e.key) + "</code>";
          var tdV = document.createElement("td");
          tdV.innerHTML = e.has_value
            ? '<span class="masked">••••••••</span> <span style="color:var(--faint);font:11px var(--mono)">saved</span>'
            : '<span style="color:var(--warn);font:12px var(--mono)">empty</span>';
          var tdA = document.createElement("td");
          tdA.style.textAlign = "right";
          var wrap = document.createElement("div");
          wrap.className = "row-actions";
          var btnEd = document.createElement("button");
          btnEd.type = "button"; btnEd.className = "btn sm"; btnEd.textContent = "Edit";
          btnEd.addEventListener("click", function () { openVaultEdit(tr, e.key); });
          var btnRm = document.createElement("button");
          btnRm.type = "button"; btnRm.className = "btn sm danger"; btnRm.textContent = "Remove";
          btnRm.addEventListener("click", async function () {
            if (!confirm('Remove "' + e.key + '"?')) return;
            setMsg(vaultMsg, "Removing…", "busy");
            try {
              var rd = await fetch("/api/vault/" + encodeURIComponent(e.key), { method: "DELETE" });
              var js = await rd.json().catch(function () { return {}; });
              if (!rd.ok) throw new Error(js.message || js.error || "delete failed");
              setMsg(vaultMsg, "Removed.", "ok");
              await refreshAll();
            } catch (err) {
              setMsg(vaultMsg, err.message || String(err), "err");
            }
          });
          wrap.appendChild(btnEd); wrap.appendChild(btnRm); tdA.appendChild(wrap);
          tr.appendChild(tdK); tr.appendChild(tdV); tr.appendChild(tdA);
          tbody.appendChild(tr);
        });
      } catch (err) {
        emptyHint.hidden = false;
        setMsg(vaultMsg, "Vault load failed: " + (err.message || err), "err");
      }

      try {
        var rr = await fetch("/api/relay/status", { cache: "no-store" });
        if (rr.ok) {
          var relayStatus = await rr.json();
          renderRelayStatus(relayStatus, vaultEntries);
        } else {
          renderRelayLoadError(
            vaultEntries,
            "Could not load relay status (HTTP " + rr.status + ").",
          );
        }
      } catch (err) {
        renderRelayLoadError(
          vaultEntries,
          "Relay status failed: " + (err.message || String(err)),
        );
      }
    }

    function openVaultEdit(tr, key) {
      if (tr.querySelector(".vault-edit")) return;
      var editTr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 3;
      td.style.background = "var(--elev2)";
      td.style.padding = "14px";
      td.innerHTML = "";
      var wrap = document.createElement("div");
      wrap.className = "vault-edit";
      var lab = document.createElement("div");
      lab.style.cssText = "font:12px var(--mono);color:var(--dim);margin-bottom:8px;";
      lab.textContent = "New secret for " + key;
      var inp = document.createElement("input");
      inp.type = "password"; inp.placeholder = "Paste secret…";
      inp.style.cssText = "width:100%;max-width:420px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:13px var(--mono);";
      var btns = document.createElement("div");
      btns.style.cssText = "margin-top:10px;display:flex;gap:10px;";
      var bSave = document.createElement("button");
      bSave.type = "button"; bSave.className = "btn primary sm"; bSave.textContent = "Save";
      var bCan = document.createElement("button");
      bCan.type = "button"; bCan.className = "btn sm"; bCan.textContent = "Cancel";
      bCan.addEventListener("click", function () { editTr.remove(); });
      bSave.addEventListener("click", async function () {
        var val = inp.value.trim();
        if (!val) { alert("Enter a secret."); return; }
        setMsg(vaultMsg, "Saving…", "busy");
        try {
          var rd = await fetch("/api/vault/" + encodeURIComponent(key), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: val }),
          });
          var js = await rd.json().catch(function () { return {}; });
          if (!rd.ok) throw new Error(js.message || js.error || "save failed");
          editTr.remove();
          setMsg(vaultMsg, "Saved.", "ok");
          await refreshAll();
        } catch (err) {
          setMsg(vaultMsg, err.message || String(err), "err");
        }
      });
      btns.appendChild(bSave); btns.appendChild(bCan);
      wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(btns);
      td.appendChild(wrap); editTr.appendChild(td);
      tr.parentNode.insertBefore(editTr, tr.nextSibling);
      inp.focus();
    }

    var copyBtn = $("copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async function () {
        var wa = $("wallet-addr");
        var a = wa && wa.textContent && wa.textContent.trim();
        if (!a || a === "—") return;
        try {
          await navigator.clipboard.writeText(a);
          copyBtn.textContent = "Copied";
          setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
        } catch (_) {}
      });
    }

    var addBtn = $("vault-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", async function () {
        var kEl = $("vault-new-key"), vEl = $("vault-new-val");
        var k = kEl && kEl.value.trim(), v = vEl && vEl.value.trim();
        if (!k || !v) { setMsg(vaultMsg, "Key and secret required.", "err"); return; }
        setMsg(vaultMsg, "Saving…", "busy");
        try {
          var rd = await fetch("/api/vault/" + encodeURIComponent(k), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: v }),
          });
          var js = await rd.json().catch(function () { return {}; });
          if (!rd.ok) throw new Error(js.message || js.error || "save failed");
          kEl.value = ""; vEl.value = "";
          setMsg(vaultMsg, "Saved.", "ok");
          await refreshAll();
        } catch (err) {
          setMsg(vaultMsg, err.message || String(err), "err");
        }
      });
    }

    var relaySaveBtn = $("relay-save-btn");
    if (relaySaveBtn) {
      relaySaveBtn.addEventListener("click", async function () {
        var slugEl = $("relay-slug"), vkEl = $("relay-vault-key");
        var feeEl = $("relay-fee"), rateEl = $("relay-rate");
        var slug = slugEl && slugEl.value.trim().toLowerCase();
        var vaultKey = vkEl && vkEl.value.trim();
        var fee = feeEl ? Number(feeEl.value) : NaN;
        var rate = rateEl ? Number(rateEl.value) : NaN;
        if (!slug || !vaultKey) {
          setMsg(relayMsg, "Provider slug and vault key required.", "err");
          return;
        }
        if (!Number.isInteger(fee) || fee < 0 || !Number.isInteger(rate) || rate < 1) {
          setMsg(relayMsg, "Fee must be integer ≥ 0; limit must be integer ≥ 1.", "err");
          return;
        }
        setMsg(relayMsg, "Saving…", "busy");
        try {
          var rd = await fetch("/api/relay/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider_slug: slug,
              vault_key_name: vaultKey,
              fee_per_call: fee,
              rate_limit_max: rate,
            }),
          });
          var js = await rd.json().catch(function () { return {}; });
          if (!rd.ok)
            throw new Error(js.message || js.error || "relay save failed");
          setMsg(relayMsg, "Relay saved; listener reloaded.", "ok");
          await refreshAll();
        } catch (err) {
          setMsg(relayMsg, err.message || String(err), "err");
        }
      });
    }

    async function fetchWalletIdentity() {
      try {
        var ir = await fetch("/api/identity", { cache: "no-store" });
        if (!ir.ok) return;
        var id = await ir.json();
        var wa = $("wallet-addr");
        var w = typeof id.wallet === "string" ? id.wallet.trim() : "";
        if (wa && w) wa.textContent = w;
      } catch (_) {}
    }

    async function tick() {
      try {
        var r = await fetch("/api/status", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        var s = await r.json();
        setOnline(true, s.router_online ? "Router OK" : "Router down");
        var wa = $("wallet-addr");
        if (wa) {
          var w = typeof s.wallet === "string" ? s.wallet.trim() : "";
          if (w) wa.textContent = w;
        }
        var bn = $("balance-num"), sub = $("balance-sub");
        if (!bn || !sub) return;
        var credits = asFiniteNumber(s.credit_balance != null ? s.credit_balance : s.credits);
        var usdVal = asFiniteNumber(s.usd_value);
        if (usdVal == null && credits != null) usdVal = credits / CREDITS_PER_USD;
        var scrapes = asFiniteNumber(s.scrapes_remaining);
        if (credits == null) {
          bn.textContent = "—";
          sub.classList.add("warn");
          sub.textContent = s.balance_error || "Could not load balance";
        } else {
          bn.textContent = fmtNum(credits);
          sub.classList.remove("warn");
          var parts = [];
          if (usdVal != null) parts.push(fmtUsd(usdVal));
          if (scrapes != null) parts.push(fmtNum(scrapes) + " scrapes left");
          sub.textContent = parts.join(" · ") || "—";
        }
      } catch (err) {
        setOnline(false, "Daemon unreachable");
        await fetchWalletIdentity();
        var bn = $("balance-num"), sub = $("balance-sub");
        if (bn) bn.textContent = "—";
        if (sub) {
          sub.classList.add("warn");
          sub.textContent = err.message || String(err);
        }
      }
    }

    function loop() {
      tick().finally(function () { setTimeout(loop, 2000); });
    }

    refreshAll();
    fetchWalletIdentity().finally(function () { loop(); });
  </script>
</body>
</html>
`;
