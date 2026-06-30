"use strict";

const TOKEN_KEY = "ra_token";
const $ = (id) => document.getElementById(id);

const STAGES = [
  ["plan", "Plan"],
  ["research", "Research"],
  ["evaluate", "Evaluate"],
  ["factcheck", "Fact-check"],
  ["synthesize", "Synthesize"],
];

let currentEs = null;

// ---- auth -----------------------------------------------------------------

const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
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
    if (!res.ok) throw new Error("config failed");
    const cfg = await res.json();
    renderConfig(cfg);
    showApp();
    refreshRecent();
  } catch {
    showLogin(true);
  }
}

function showLogin(err = false) {
  $("login").classList.remove("hidden");
  $("loginErr").classList.toggle("hidden", !err);
}
function showApp() {
  $("login").classList.add("hidden");
}

function renderConfig(cfg) {
  const mode = cfg.authMode === "subscription" ? "subscription (OAuth)" : cfg.authMode;
  $("authBadge").innerHTML = `auth: <b>${mode}</b>`;
  const m = cfg.models || {};
  $("modelsHint").textContent = `plan ${m.plan} · research ${m.research} · check ${m.factcheck} · synth ${m.synth} · fan-out ${cfg.fanoutWidth}`;
}

// ---- progress UI ----------------------------------------------------------

const stageEls = {};

function buildStages() {
  const wrap = $("stages");
  wrap.innerHTML = "";
  for (const [key, name] of STAGES) {
    const row = document.createElement("div");
    row.className = "stage";
    row.innerHTML = `<span class="dot"></span><span class="name">${name}</span><span class="detail"></span>`;
    wrap.appendChild(row);
    stageEls[key] = row;
  }
}

function setStage(key, state, detail) {
  const row = stageEls[key];
  if (!row) return;
  const dot = row.querySelector(".dot");
  dot.className = "dot" + (state ? " " + state : "");
  if (detail !== undefined) row.querySelector(".detail").textContent = detail;
}

function resetProgress() {
  buildStages();
  $("statusline").textContent = "";
  $("plan").innerHTML = "";
  $("activity").innerHTML = "";
  $("report").innerHTML = "";
  $("reportCard").classList.add("hidden");
  $("costBadge").textContent = "";
}

function logActivity(html) {
  const el = $("activity");
  const div = document.createElement("div");
  div.className = "ev";
  div.innerHTML = html;
  el.appendChild(div);
  // keep the log bounded
  while (el.childElementCount > 250) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function renderPlan(subtopics) {
  const el = $("plan");
  el.innerHTML =
    `<div class="sub" style="color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.6px;">Plan</div>` +
    subtopics
      .map((s, i) => `<div class="sub"><b>${i + 1}.</b> ${escapeHtml(s.title)} — <span style="color:var(--muted)">${escapeHtml(s.question)}</span></div>`)
      .join("");
}

function handleEvent(ev, es) {
  switch (ev.type) {
    case "stage":
      setStage(ev.stage, ev.state === "done" ? "done" : "run", ev.detail);
      break;
    case "status":
      $("statusline").textContent = ev.message || "";
      break;
    case "plan":
      renderPlan(ev.subtopics || []);
      break;
    case "worker": {
      const tag = `${ev.stage}#${ev.index + 1}`;
      const label = escapeHtml((ev.label || "").slice(0, 70));
      if (ev.state === "start") logActivity(`<span class="tag">▶ ${tag}</span> ${label}`);
      else if (ev.state === "activity") logActivity(`<span style="opacity:.7">&nbsp;&nbsp;${tag}</span> ${escapeHtml(ev.detail || "")}`);
      else if (ev.state === "done") logActivity(`<span class="tag">✓ ${tag}</span> ${label}${ev.detail ? " — " + escapeHtml(ev.detail) : ""}`);
      break;
    }
    case "usage":
      $("costBadge").innerHTML = `est. <b>$${Number(ev.costUsd).toFixed(4)}</b> · ${ev.inputTokens.toLocaleString()} in / ${ev.outputTokens.toLocaleString()} out tok`;
      break;
    case "report":
      $("report").innerHTML = mdToHtml(ev.markdown || "");
      $("reportCard").classList.remove("hidden");
      break;
    case "error":
      $("statusline").innerHTML = `<span style="color:var(--bad)">Error: ${escapeHtml(ev.message || "unknown")}</span>`;
      // mark the running stage as errored
      for (const [key] of STAGES) {
        const dot = stageEls[key]?.querySelector(".dot");
        if (dot && dot.classList.contains("run")) dot.className = "dot err";
      }
      break;
    case "done":
      $("startBtn").disabled = false;
      if (es) es.close();
      refreshRecent();
      break;
  }
}

// ---- run lifecycle --------------------------------------------------------

function connectStream(id) {
  if (currentEs) currentEs.close();
  resetProgress();
  const es = new EventSource(`/research/${encodeURIComponent(id)}/stream?token=${encodeURIComponent(getToken())}`);
  es.onopen = () => resetProgress(); // server replays the full log on each (re)connect
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev, es);
  };
  es.onerror = () => {
    /* EventSource auto-reconnects; we close it explicitly on 'done' */
  };
  currentEs = es;
}

async function startResearch() {
  const goal = $("goal").value.trim();
  $("startErr").classList.add("hidden");
  if (!goal) {
    $("startErr").textContent = "Enter a research goal.";
    $("startErr").classList.remove("hidden");
    return;
  }
  $("startBtn").disabled = true;
  try {
    const res = await authedFetch("/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    if (res.status === 401) {
      clearToken();
      return showLogin(true);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed to start");
    connectStream(data.id);
  } catch (e) {
    $("startBtn").disabled = false;
    $("startErr").textContent = String(e.message || e);
    $("startErr").classList.remove("hidden");
  }
}

async function refreshRecent() {
  try {
    const res = await authedFetch("/api/runs");
    if (!res.ok) return;
    const { runs } = await res.json();
    $("recent").innerHTML =
      runs
        .map((r) => {
          const cost = `$${Number(r.costUsd || 0).toFixed(3)}`;
          const status = r.status === "done" ? "done" : r.status;
          return `<a href="#" data-id="${r.id}"><div>${escapeHtml(r.goal.slice(0, 90))}</div><div class="meta">${status} · ${cost} · ${new Date(r.createdAt).toLocaleString()}</div></a>`;
        })
        .join("") || `<div class="cost">No runs yet.</div>`;
    for (const a of $("recent").querySelectorAll("a")) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        connectStream(a.getAttribute("data-id"));
      });
    }
  } catch {
    /* ignore */
  }
}

// ---- minimal markdown renderer (self-contained, no CDN) -------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function inlineMd(s) {
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

function mdToHtml(md) {
  const lines = escapeHtml(String(md).replace(/\r\n/g, "\n")).split("\n");
  const blockRe = /^(#{1,6})\s|^```|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^(-{3,}|\*{3,}|_{3,})\s*$/;
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (/^```/.test(t)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      html += `<pre><code>${code.join("\n")}</code></pre>`;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      html += "<hr>";
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`;
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      html += `<blockquote>${inlineMd(q.join(" "))}</blockquote>`;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      html += `<ul>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ul>`;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      html += `<ol>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ol>`;
      continue;
    }
    if (t === "") {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== "" && !blockRe.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inlineMd(buf.join(" "))}</p>`;
  }
  return html;
}

// ---- wiring ---------------------------------------------------------------

$("loginBtn").addEventListener("click", () => {
  const t = $("token").value.trim();
  if (!t) return;
  setToken(t);
  tryAuth();
});
$("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("loginBtn").click();
});
$("logoutBtn").addEventListener("click", () => {
  clearToken();
  if (currentEs) currentEs.close();
  showLogin();
});
$("startBtn").addEventListener("click", startResearch);

buildStages();
tryAuth();
