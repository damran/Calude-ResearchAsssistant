"use strict";

const TOKEN_KEY = "ra_token";
const $ = (id) => document.getElementById(id);

const STAGES = [
  ["plan",      "Plan"],
  ["research",  "Research"],
  ["evaluate",  "Evaluate"],
  ["factcheck", "Fact-check"],
  ["synthesize","Synthesize"],
];

let currentEs    = null;
let currentRunId = null;
let runDone      = false;   // true once the active run emits "done"

// ── Auth ─────────────────────────────────────────────────────────────────────

const getToken   = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken   = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function authedFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, { "x-app-token": getToken() });
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function tryAuth() {
  if (!getToken()) return showLogin();
  try {
    const res = await authedFetch("/api/config");
    if (res.status === 401) return showLogin(true);
    if (!res.ok) throw new Error("config error");
    const cfg = await res.json();
    applyConfig(cfg);
    hideLogin();
    refreshRunList();
  } catch {
    showLogin(true);
  }
}

function showLogin(err = false) {
  $("loginOverlay").classList.remove("hidden");
  $("loginErr").classList.toggle("hidden", !err);
}
function hideLogin() {
  $("loginOverlay").classList.add("hidden");
}

function applyConfig(cfg) {
  const mode = cfg.authMode === "subscription" ? "subscription" : cfg.authMode;
  $("authBadge").innerHTML = `auth: <b>${mode}</b>`;
  const m = cfg.models || {};
  $("modelHint").textContent =
    `plan ${m.plan} · research ${m.research} · synth ${m.synth} · fan-out ${cfg.fanoutWidth}`;
  $("wsWrap").classList.toggle("hidden", !cfg.workspaceAvailable);
}

// ── Markdown (self-contained, no CDN) ────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

function inlineMd(s) {
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) =>
    `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

function mdToHtml(md) {
  const lines = escHtml(String(md).replace(/\r\n/g, "\n")).split("\n");
  // | added so table rows break out of the paragraph accumulator
  const blockRe = /^(#{1,6})\s|^```|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^(-{3,}|\*{3,}|_{3,})\s*$|^\s*\|/;
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (/^```/.test(t)) {
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      html += `<pre><code>${code.join("\n")}</code></pre>`;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { html += "<hr>"; i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; i++; continue; }
    // Tables: accumulate all pipe lines, first row = header, second = separator
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
      const isSep   = (r) => /^[\s|:\-]+$/.test(r);
      if (rows.length >= 2 && isSep(rows[1])) {
        const hdr  = splitRow(rows[0]);
        const body = rows.slice(2).filter((r) => !isSep(r));
        html += `<table><thead><tr>${hdr.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
        if (body.length)
          html += `<tbody>${body.map((r) => `<tr>${splitRow(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
        html += `</table>`;
      } else {
        // Not a proper table — render each row as a paragraph
        for (const r of rows) html += `<p>${inlineMd(r.trim())}</p>`;
      }
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      html += `<blockquote><p>${inlineMd(q.join(" "))}</p></blockquote>`;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      html += `<ul>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ul>`;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      html += `<ol>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ol>`;
      continue;
    }
    if (t === "") { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== "" && !blockRe.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inlineMd(buf.join(" "))}</p>`;
  }
  return html;
}

// ── Chat helpers ──────────────────────────────────────────────────────────────

function scrollToBottom() {
  const el = $("chatMessages");
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function clearEmptyState() {
  const e = $("emptyState");
  if (e) e.remove();
}

/** Append a user-query bubble and return the wrapper node. */
function appendUserMsg(goal) {
  clearEmptyState();
  const row = document.createElement("div");
  row.className = "msg-row";
  row.innerHTML = `<div class="user-row"><div class="user-bubble">${escHtml(goal)}</div></div>`;
  $("chatMessages").appendChild(row);
  scrollToBottom();
}

/**
 * Create an assistant message element.
 * Returns an object with refs to each sub-element so handleEvent can update
 * it without fighting with IDs (each message has its own private refs).
 */
function appendAsstMsg() {
  clearEmptyState();
  const row = document.createElement("div");
  row.className = "msg-row";

  // Build stages HTML
  const stageRows = STAGES.map(([key, name]) =>
    `<div class="stage-row" data-stage="${key}">` +
    `<span class="sdot"></span>` +
    `<span class="sname">${name}</span>` +
    `<span class="sdetail"></span>` +
    `</div>`
  ).join("");

  row.innerHTML = `
    <div class="asst-row">
      <div class="asst-avatar">R</div>
      <div class="asst-body">
        <div class="stages-box">${stageRows}</div>
        <div class="asst-status"></div>
        <button class="act-toggle hidden">▸ Show activity</button>
        <div class="act-log hidden"></div>
        <div class="report-body hidden"></div>
        <div class="report-footer hidden"></div>
        <div class="artifacts-block hidden"></div>
      </div>
    </div>`;

  const body   = row.querySelector(".asst-body");
  const refs   = {
    stagesBox:    body.querySelector(".stages-box"),
    statusEl:     body.querySelector(".asst-status"),
    actToggle:    body.querySelector(".act-toggle"),
    actLog:       body.querySelector(".act-log"),
    reportEl:     body.querySelector(".report-body"),
    footerEl:     body.querySelector(".report-footer"),
    artifactsEl:  body.querySelector(".artifacts-block"),
    stageRows:    {},
  };

  for (const [key] of STAGES) {
    refs.stageRows[key] = body.querySelector(`.stage-row[data-stage="${key}"]`);
  }

  refs.actToggle.addEventListener("click", () => {
    const open = refs.actLog.classList.toggle("hidden");
    refs.actToggle.textContent = open ? "▸ Show activity" : "▾ Hide activity";
  });

  $("chatMessages").appendChild(row);
  scrollToBottom();
  return refs;
}

// ── Event handler ─────────────────────────────────────────────────────────────

function handleEvent(ev, es, refs) {
  switch (ev.type) {

    case "stage": {
      const row = refs.stageRows[ev.stage];
      if (!row) break;
      const dot = row.querySelector(".sdot");
      dot.className = "sdot " + (ev.state === "done" ? "done" : "run");
      if (ev.detail) row.querySelector(".sdetail").textContent = ev.detail;
      break;
    }

    case "status":
      refs.statusEl.textContent = ev.message || "";
      break;

    case "worker": {
      refs.actToggle.classList.remove("hidden");
      const tag = `${ev.stage}#${ev.index + 1}`;
      const lbl = escHtml((ev.label || "").slice(0, 80));
      const div = document.createElement("div");
      div.className = "ev";
      if (ev.state === "start")
        div.innerHTML = `<span class="ev-tag">▶ ${tag}</span> ${lbl}`;
      else if (ev.state === "activity")
        div.innerHTML = `<span style="opacity:.6">&nbsp;&nbsp;${tag}</span> ${escHtml(ev.detail || "")}`;
      else
        div.innerHTML = `<span class="ev-tag">✓ ${tag}</span> ${lbl}${ev.detail ? " — " + escHtml(ev.detail) : ""}`;
      refs.actLog.appendChild(div);
      while (refs.actLog.childElementCount > 300) refs.actLog.removeChild(refs.actLog.firstChild);
      if (!refs.actLog.classList.contains("hidden")) refs.actLog.scrollTop = refs.actLog.scrollHeight;
      break;
    }

    case "usage": {
      refs.footerEl.classList.remove("hidden");
      const costHtml = `<span class="cost-tag">est. <b>$${Number(ev.costUsd).toFixed(4)}</b> · ${ev.inputTokens.toLocaleString()} in / ${ev.outputTokens.toLocaleString()} out tok</span>`;
      const existing = refs.footerEl.querySelector(".cost-tag");
      if (existing) existing.outerHTML = costHtml;
      else refs.footerEl.insertAdjacentHTML("afterbegin", costHtml);
      break;
    }

    case "report": {
      // Collapse pipeline UI, show the report
      refs.stagesBox.classList.add("hidden");
      refs.statusEl.classList.add("hidden");
      refs.reportEl.innerHTML = mdToHtml(ev.markdown || "");
      refs.reportEl.classList.remove("hidden");
      // Add download links to footer
      refs.footerEl.classList.remove("hidden");
      const t = encodeURIComponent(getToken());
      const id = currentRunId;
      const dlHtml =
        `<a class="dl-link" href="/research/${id}/report.md?token=${t}" download>↓ .md</a>` +
        `<a class="dl-link" href="/research/${id}/report.json?token=${t}" download>↓ .json</a>`;
      const existingDl = refs.footerEl.querySelector(".dl-links");
      if (existingDl) existingDl.innerHTML = dlHtml;
      else refs.footerEl.insertAdjacentHTML("beforeend", `<span class="dl-links">${dlHtml}</span>`);
      scrollToBottom();
      break;
    }

    case "error": {
      refs.statusEl.innerHTML = `<span style="color:var(--bad)">Error: ${escHtml(ev.message || "unknown")}</span>`;
      for (const [key] of STAGES) {
        const dot = refs.stageRows[key]?.querySelector(".sdot");
        if (dot && dot.classList.contains("run")) dot.className = "sdot err";
      }
      break;
    }

    case "done":
      runDone = true;
      $("startBtn").disabled = false;
      updateInputPlaceholder();
      if (es) es.close();
      loadArtifacts(currentRunId, refs);
      refreshRunList();
      break;
  }
}

// ── Stream connection ─────────────────────────────────────────────────────────

function connectStream(id, refs) {
  if (currentEs) { currentEs.close(); currentEs = null; }
  currentRunId = id;
  runDone = false;

  const es = new EventSource(
    `/research/${encodeURIComponent(id)}/stream?token=${encodeURIComponent(getToken())}`
  );
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev, es, refs);
  };
  es.onerror = () => { /* EventSource auto-reconnects; closed explicitly on "done" */ };
  currentEs = es;
}

// ── Run lifecycle ─────────────────────────────────────────────────────────────

function updateInputPlaceholder() {
  $("goal").placeholder = (currentRunId && runDone)
    ? "Ask a follow-up or give feedback on the report…"
    : "Ask a research question…";
}

async function sendMessage() {
  const text = $("goal").value.trim();
  $("startErr").classList.add("hidden");
  if (!text) {
    $("startErr").textContent = "Enter a research question.";
    $("startErr").classList.remove("hidden");
    return;
  }
  $("startBtn").disabled = true;

  appendUserMsg(text);
  const refs = appendAsstMsg();

  try {
    const fd = new FormData();
    const isFollowup = Boolean(currentRunId && runDone);

    if (isFollowup) {
      // Refinement run: goal comes from the parent run, text is feedback
      const parent = await authedFetch(`/research/${currentRunId}`).then(r => r.ok ? r.json() : null);
      fd.append("goal", parent?.goal || text);
      fd.append("parentId", currentRunId);
      fd.append("feedback", text);
    } else {
      fd.append("goal", text);
      fd.append("useWeb",      $("useWeb").checked ? "true" : "false");
      fd.append("workspace",   $("wsWrap").classList.contains("hidden") ? "off" : $("workspace").value);
      for (const f of $("files").files) fd.append("files", f);
    }

    const res = await authedFetch("/research", { method: "POST", body: fd });
    if (res.status === 401) { clearToken(); return showLogin(true); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start.");

    $("goal").value = "";
    autoResize($("goal"));
    updateInputPlaceholder();
    connectStream(data.id, refs);
  } catch (e) {
    $("startBtn").disabled = false;
    $("startErr").textContent = String(e.message || e);
    $("startErr").classList.remove("hidden");
    refs.statusEl.textContent = "Failed to start.";
  }
}

// Load a past run into the chat view
async function openRun(id) {
  if (currentEs) { currentEs.close(); currentEs = null; }
  currentRunId = id;
  runDone = false;

  // Clear chat
  const chat = $("chatMessages");
  chat.innerHTML = "";

  const record = await authedFetch(`/research/${id}`).then(r => r.ok ? r.json() : null);
  if (!record) {
    chat.innerHTML = `<div class="empty-state"><p style="color:var(--bad)">Run not found.</p></div>`;
    return;
  }

  appendUserMsg(record.goal);
  const refs = appendAsstMsg();
  connectStream(id, refs);

  // Mark active in sidebar
  for (const btn of document.querySelectorAll(".run-btn"))
    btn.classList.toggle("active", btn.dataset.id === id);
  updateInputPlaceholder();
}

async function loadArtifacts(id, refs) {
  if (!id || !refs) return;
  try {
    const res = await authedFetch(`/research/${id}/files`);
    if (!res.ok) return;
    const { files } = await res.json();
    if (!files || !files.length) return;
    const t = encodeURIComponent(getToken());
    refs.artifactsEl.innerHTML =
      `<div class="artifact-hdr">Generated files</div>` +
      files.map(f =>
        `<div class="artifact-row"><a href="/research/${id}/files/${encodeURIComponent(f.name)}?token=${t}" download>↓ ${escHtml(f.name)}</a> <span style="color:var(--muted)">(${f.size} bytes)</span></div>`
      ).join("");
    refs.artifactsEl.classList.remove("hidden");
  } catch { /* ignore */ }
}

async function refreshRunList() {
  try {
    const res = await authedFetch("/api/runs");
    if (!res.ok) return;
    const { runs } = await res.json();
    const el = $("runList");
    if (!runs.length) {
      el.innerHTML = `<div style="padding:7px 11px;font-size:12px;color:var(--muted)">No runs yet.</div>`;
      return;
    }
    el.innerHTML = runs.map(r => {
      const prefix = r.parentId ? "↳ " : "";
      const title  = prefix + (r.goal || "").slice(0, 55);
      const cost   = `$${Number(r.costUsd || 0).toFixed(3)}`;
      const active = r.id === currentRunId ? " active" : "";
      return `<button class="run-btn${active}" data-id="${r.id}">
        <div class="run-title">${escHtml(title)}</div>
        <div class="run-meta">${r.status} · ${cost} · ${new Date(r.createdAt).toLocaleString()}</div>
      </button>`;
    }).join("");
    for (const btn of el.querySelectorAll(".run-btn"))
      btn.addEventListener("click", () => openRun(btn.dataset.id));
  } catch { /* ignore */ }
}

// ── Textarea auto-resize ──────────────────────────────────────────────────────

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 170) + "px";
}

// ── Wiring ────────────────────────────────────────────────────────────────────

$("loginBtn").addEventListener("click", () => {
  const t = $("tokenInput").value.trim();
  if (!t) return;
  setToken(t);
  tryAuth();
});
$("tokenInput").addEventListener("keydown", e => { if (e.key === "Enter") $("loginBtn").click(); });

$("logoutBtn").addEventListener("click", () => {
  clearToken();
  if (currentEs) currentEs.close();
  showLogin();
});

$("startBtn").addEventListener("click", sendMessage);
$("goal").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("goal").addEventListener("input", () => autoResize($("goal")));

$("newChatBtn").addEventListener("click", () => {
  if (currentEs) { currentEs.close(); currentEs = null; }
  currentRunId = null;
  runDone = false;
  $("chatMessages").innerHTML = `
    <div class="empty-state" id="emptyState">
      <div class="emo">🔬</div>
      <h2>Research Assistant</h2>
      <p>Type a question below and get a multi-source report with fact-checking.</p>
    </div>`;
  $("goal").value = "";
  autoResize($("goal"));
  updateInputPlaceholder();
  $("goal").focus();
  for (const btn of document.querySelectorAll(".run-btn")) btn.classList.remove("active");
});

tryAuth();
