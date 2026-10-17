/* ═══════════════════════════════════════════════════════════════════
   BRAHMA EVO — WEB CORE
   Drives the reactive orb, the HUD wings, chat streaming, history,
   dashboard and theming. Mirrors the desktop MainWindow behavior.
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

const $ = (sel) => document.querySelector(sel);

/* ── Elements ─────────────────────────────────────────────────────── */
const orbFrame = $("#orb");
const statusBadge = $("#statusBadge");
const statusText = $("#statusText");
const feed = $("#feed");
const cmdForm = $("#commandBar");
const cmdInput = $("#cmdInput");
const inlineForm = $("#inlineForm");
const inlineInput = $("#inlineInput");
const rpFooterText = $("#rpFooterText");
const tcState = $("#tcState");
const tcLastOp = $("#tcLastOp");

const ENGINE = "gemini-3.5-flash";

let conversationId = null;
let busy = false;
let msgCount = 0;
let pendingImage = null;
const sessionStart = Date.now();

/* ═══════════════════════════════════════════════════════════════════
   ORB CONTROL — same-origin iframe exposes setBrahmaState /
   setPointerNorm, exactly like the desktop BackgroundWidget.
   ═══════════════════════════════════════════════════════════════════ */
function orbCall(fn, ...args) {
  try {
    const w = orbFrame.contentWindow;
    if (w && typeof w[fn] === "function") w[fn](...args);
  } catch {
    /* orb not booted yet */
  }
}

function setState(state) {
  document.body.dataset.state = state;
  const map = {
    ONLINE: ["st-online", "ONLINE"],
    IDLE: ["st-online", "ONLINE"],
    LISTENING: ["st-speaking", "LISTENING"],
    THINKING: ["st-thinking", "THINKING"],
    SPEAKING: ["st-speaking", "SPEAKING"],
    MUTED: ["st-muted", "MUTED"],
    ERROR: ["st-error", "CORE FAULT"],
  };
  const [cls, label] = map[state] || map.ONLINE;
  statusBadge.className = `status-badge ${cls}`;
  statusText.textContent = label;
  tcState.textContent = label;
  orbCall("setBrahmaState", state);
}

/* Pointer tilt, like the desktop's mouse-tracked background */
window.addEventListener("mousemove", (e) => {
  orbCall("setPointerNorm", e.clientX / window.innerWidth, e.clientY / window.innerHeight);
});

/* ═══════════════════════════════════════════════════════════════════
   STATE MACHINE
   ═══════════════════════════════════════════════════════════════════ */
function idleState() {
  setState(busy ? "THINKING" : "ONLINE");
}

[cmdInput, inlineInput].forEach((inp) => {
  inp.addEventListener("focus", () => { if (!busy) setState("LISTENING"); });
  inp.addEventListener("blur", idleState);
});

/* ═══════════════════════════════════════════════════════════════════
   MESSAGE CARDS (ported from MessageCard)
   ═══════════════════════════════════════════════════════════════════ */
function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addMessage(role, name, text, opts = {}) {
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();

  const card = document.createElement("div");
  card.className = "msg" + (opts.streaming ? " streaming" : "");
  card.dataset.role = role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = (name || role).charAt(0).toUpperCase();

  const body = document.createElement("div");
  body.className = "m-body";

  const top = document.createElement("div");
  top.className = "m-top";
  const nameEl = document.createElement("span");
  nameEl.className = "m-name";
  nameEl.textContent = name;
  const timeEl = document.createElement("span");
  timeEl.className = "m-time";
  timeEl.textContent = opts.stamp || stamp();
  top.append(nameEl, timeEl);

  const textEl = document.createElement("div");
  textEl.className = "m-text";
  textEl.textContent = text;

  body.append(top, textEl);
  card.append(avatar, body);
  feed.appendChild(card);
  feed.scrollTop = feed.scrollHeight;
  return { card, textEl };
}

function showEmptyState() {
  feed.innerHTML = `
    <div class="feed-empty">
      <div class="fe-orb">◉</div>
      <div class="fe-title">BRAHMA EVO · WEB CORE</div>
      <div class="fe-sub">Quantum core resonating. Ask anything — in English, Hindi or Hinglish — and the same brain that runs the desktop app responds here.</div>
    </div>`;
}

function systemNote(text) {
  addMessage("system", "CORE", text);
}

/* ═══════════════════════════════════════════════════════════════════
   OPS WING (ported from BrahmaTelemetryWing)
   ═══════════════════════════════════════════════════════════════════ */
const wingOps = $("#wingOps");
let opsPinned = false;
let fuseTimer = null;

function setSrcRows(rows) {
  $("#opsSources").innerHTML = rows
    .map(([k, v]) => `<div class="src-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");
}

function opsShow(title, step, rows) {
  clearTimeout(fuseTimer);
  wingOps.hidden = false;
  $("#opsTitle").textContent = title;
  $("#opsStep").textContent = step;
  if (rows) setSrcRows(rows);
  $("#fuseFill").style.width = "100%";
  $("#fuseLabel").textContent = "10s";
}

function opsDismiss() {
  clearTimeout(fuseTimer);
  wingOps.hidden = true;
}

$("#opsClose").addEventListener("click", opsDismiss);
$("#opsPin").addEventListener("click", () => {
  opsPinned = !opsPinned;
  $("#opsPin").classList.toggle("pinned", opsPinned);
});

function opsComplete() {
  if (opsPinned) return;
  let remaining = 10;
  fuseTimer = setInterval(() => {
    remaining -= 0.1;
    $("#fuseFill").style.width = `${Math.max(0, (remaining / 10) * 100)}%`;
    $("#fuseLabel").textContent = `${Math.max(0, remaining).toFixed(0)}s`;
    if (remaining <= 0) {
      clearInterval(fuseTimer);
      if (!opsPinned) opsDismiss();
    }
  }, 100);
}

/* ═══════════════════════════════════════════════════════════════════
   COMMAND WING + METRICS
   ═══════════════════════════════════════════════════════════════════ */
function setMetric(id, value, pct) {
  const el = $(id);
  const valEl = el.querySelector(".metric-value");
  const fill = el.querySelector(".metric-fill");
  valEl.textContent = value;
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.classList.toggle("crit", pct > 85);
  el.classList.toggle("warn", pct > 65 && pct <= 85);
}

function tickMetrics() {
  const mins = (Date.now() - sessionStart) / 60000;
  setMetric("#metricSession", mins < 60 ? `${mins.toFixed(0)}m` : `${(mins / 60).toFixed(1)}h`, (mins / 120) * 100);
  setMetric("#metricMessages", String(msgCount), Math.min(100, msgCount * 8));
  $("#dashUptime").textContent = mins < 60 ? `${mins.toFixed(0)}m` : `${(mins / 60).toFixed(1)}h`;
}

setInterval(tickMetrics, 5000);

/* ═══════════════════════════════════════════════════════════════════
   CHAT — SEND + STREAM
   ═══════════════════════════════════════════════════════════════════ */
async function send(rawText) {
  const text = rawText.trim();
  if (busy || (!text && !pendingImage)) return;

  const image = pendingImage;
  pendingImage = null;
  $("#attachBtn").classList.remove("accent");
  busy = true;
  msgCount += 1;
  [cmdInput, inlineInput].forEach((i) => { i.value = ""; });

  // User card
  const userCard = addMessage("user", "You", image && !text ? "(image attached)" : text);
  if (image) {
    const img = document.createElement("img");
    img.className = "m-image";
    img.src = image.dataUrl;
    img.alt = "attachment";
    userCard.textEl.after(img);
  }

  // Command wing mirrors the directive (like the desktop result wing)
  $("#wingCmdTitle").textContent = "DIRECTIVE RECEIVED";
  $("#wingCmdText").textContent = text || "(image attached)";
  tcLastOp.textContent = "processing";

  // Ops wing boots
  setState("THINKING");
  opsShow(
    "LIVE TASK EXECUTION",
    "Routing directive to the reasoning engine...",
    [
      ["ENGINE", ENGINE],
      ["CHANNEL", "AI GATEWAY"],
      ["MODE", image ? "VISION + TEXT" : "TEXT"],
    ]
  );

  const reply = addMessage("assistant", "Brahma Evo", "", { streaming: true });
  const started = performance.now();
  let firstToken = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        message: text,
        imageBase64: image ? image.base64 : undefined,
        imageMime: image ? image.mime : undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Core rejected the request (${res.status})`);
    }

    const convId = Number(res.headers.get("X-Conversation-Id"));
    if (convId) conversationId = convId;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      if (firstToken) {
        firstToken = false;
        const latency = Math.round(performance.now() - started);
        setMetric("#metricLatency", `${latency}ms`, (latency / 2000) * 100);
        $("#opsStep").textContent = "Composing response...";
        $("#opsTitle").textContent = "STREAMING RESPONSE";
        setSrcRows([
          ["ENGINE", ENGINE],
          ["CHANNEL", "AI GATEWAY"],
          ["STREAM", "LIVE"],
        ]);
        setState("SPEAKING");
        tcLastOp.textContent = "streaming";
      }
      acc += chunk;
      reply.textEl.textContent = acc;
      feed.scrollTop = feed.scrollHeight;
    }
  } catch (err) {
    reply.card.dataset.role = "error";
    reply.textEl.textContent = `${err.message || "The core dropped the stream."}`;
    setState("ERROR");
    setTimeout(idleState, 2500);
  } finally {
    reply.card.classList.remove("streaming");
    if (!reply.textEl.textContent) {
      reply.card.dataset.role = "error";
      reply.textEl.textContent = "The core returned silence. Try again.";
    }
    busy = false;
    $("#opsTitle").textContent = "OPERATION COMPLETE";
    $("#opsStep").textContent = "Response delivered to the chat channel.";
    tcLastOp.textContent = "idle";
    opsComplete();
    idleState();
    tickMetrics();
    if (currentTab === "history") loadHistory();
  }
}

cmdForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send(cmdInput.value);
});
inlineForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send(inlineInput.value);
});

/* ═══════════════════════════════════════════════════════════════════
   NEW CHAT
   ═══════════════════════════════════════════════════════════════════ */
$("#newChatBtn").addEventListener("click", () => {
  conversationId = null;
  busy = false;
  showEmptyState();
  switchTab("chat");
  systemNote("New chat session initialized. Memory of this thread stays in History.");
});

/* ═══════════════════════════════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════════════════════════════ */
let currentTab = "chat";
let conversationsCache = [];

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".rp-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab)
  );
  $("#tabChat").classList.toggle("active", tab === "chat");
  $("#tabHistory").classList.toggle("active", tab === "history");
  if (tab === "history") loadHistory();
}

document.querySelectorAll(".rp-tab").forEach((btn) =>
  btn.addEventListener("click", () => switchTab(btn.dataset.tab))
);

function groupLabel(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const day = 86400000;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = midnight - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (diff <= 0) return "TODAY";
  if (diff <= day) return "YESTERDAY";
  if (diff <= 6 * day) return "THIS WEEK";
  return "EARLIER";
}

async function loadHistory() {
  const list = $("#historyList");
  try {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    conversationsCache = data.conversations || [];
  } catch {
    list.innerHTML = `<div class="hist-empty">History channel unreachable.</div>`;
    return;
  }
  renderHistory($("#historySearch").value.trim().toLowerCase());
}

function renderHistory(filter) {
  const list = $("#historyList");
  const items = conversationsCache.filter((c) =>
    !filter || c.title.toLowerCase().includes(filter)
  );
  if (!items.length) {
    list.innerHTML = `<div class="hist-empty">${filter ? "No matching directives." : "No conversations yet. Your threads will appear here."}</div>`;
    return;
  }
  let lastGroup = null;
  list.innerHTML = "";
  for (const c of items) {
    const g = groupLabel(c.updatedAt);
    if (g !== lastGroup) {
      lastGroup = g;
      const gl = document.createElement("div");
      gl.className = "hist-group";
      gl.textContent = g;
      list.appendChild(gl);
    }
    const item = document.createElement("div");
    item.className = "hist-item";
    const when = new Date(c.updatedAt).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    item.innerHTML = `
      <div class="hi-title"></div>
      <div class="hi-meta"><span>${when}</span><span>·</span><span>${c.messageCount} msg</span></div>
      <button class="hi-del" title="Delete conversation">✕</button>`;
    item.querySelector(".hi-title").textContent = c.title;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".hi-del")) return;
      openConversation(c.id);
    });
    item.querySelector(".hi-del").addEventListener("click", async () => {
      await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (conversationId === c.id) {
        conversationId = null;
        showEmptyState();
      }
      loadHistory();
    });
    list.appendChild(item);
  }
}

$("#historySearch").addEventListener("input", (e) =>
  renderHistory(e.target.value.trim().toLowerCase())
);

async function openConversation(id) {
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    conversationId = id;
    feed.innerHTML = "";
    for (const m of data.messages) {
      const isImageNote = m.content.startsWith("[attached image]");
      const card = addMessage(
        m.role === "user" ? "user" : "assistant",
        m.role === "user" ? "You" : "Brahma Evo",
        isImageNote ? m.content.replace("[attached image]", "(image attached)").trim() : m.content,
        { stamp: new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }
      );
      if (m.role !== "user") card.card.dataset.role = "assistant";
    }
    switchTab("chat");
    systemNote(`Loaded thread: ${data.conversation.title}`);
  } catch {
    systemNote("Could not load that thread.");
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ATTACHMENTS
   ═══════════════════════════════════════════════════════════════════ */
const fileInput = $("#fileInput");

$("#attachBtn").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;

  if (file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = {
        dataUrl: reader.result,
        base64: String(reader.result).split(",")[1],
        mime: file.type,
      };
      $("#attachBtn").classList.add("accent");
      systemNote(`Image attached (${(file.size / 1024).toFixed(0)} KB). Add a note if you want, then transmit.`);
    };
    reader.readAsDataURL(file);
  } else {
    file.text().then((content) => {
      const clipped = content.slice(0, 8000);
      const target = document.activeElement === inlineInput ? inlineInput : cmdInput;
      target.value = `${target.value ? target.value + "\n" : ""}File "${file.name}":\n${clipped}`.slice(0, 8000);
      target.focus();
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   VOICE INPUT (Web Speech API)
   ═══════════════════════════════════════════════════════════════════ */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recBtn = null;

function toggleMic(btn, input) {
  if (!SpeechRec) {
    btn.title = "Voice input unavailable in this browser";
    systemNote("Voice channel unavailable in this browser.");
    return;
  }
  if (rec) { rec.stop(); return; }
  recBtn = btn;
  btn.classList.add("listening");
  setState("LISTENING");
  rec = new SpeechRec();
  rec.lang = "en-IN";
  rec.interimResults = true;
  rec.onresult = (e) => {
    input.value = Array.from(e.results).map((r) => r[0].transcript).join("");
  };
  rec.onend = () => {
    rec = null;
    btn.classList.remove("listening");
    idleState();
    input.focus();
  };
  rec.onerror = () => { rec = null; btn.classList.remove("listening"); idleState(); };
  rec.start();
}

$("#cmdMic").addEventListener("click", () => toggleMic($("#cmdMic"), cmdInput));
$("#micBtn").addEventListener("click", () => toggleMic($("#micBtn"), inlineInput));

/* ═══════════════════════════════════════════════════════════════════
   NAVIGATION + PANEL COLLAPSE
   ═══════════════════════════════════════════════════════════════════ */
const isMobile = () => window.matchMedia("(max-width: 920px)").matches;

document.querySelectorAll(".nav-pill").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-pill").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".page").forEach((p) =>
      p.classList.toggle("active", p.id === `page-${btn.dataset.page}`)
    );
    orbCall("setPageCamera", btn.dataset.page === "chat" ? 0 : btn.dataset.page === "dashboard" ? 1 : 2);
    idleState();
  })
);

$("#collapseBtn").addEventListener("click", () => {
  if (isMobile()) {
    $("#rightPanel").classList.remove("mobile-open");
  } else {
    $("#rightPanel").classList.add("collapsed");
    $("#reopenBtn").hidden = false;
  }
});

$("#reopenBtn").addEventListener("click", () => {
  $("#rightPanel").classList.remove("collapsed");
  $("#reopenBtn").hidden = true;
});

/* mobile: tapping a quick action or starting to chat opens the drawer */
document.querySelectorAll(".quick-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const page = document.querySelector('.nav-pill[data-page="chat"]');
    page.click();
    cmdInput.value = btn.dataset.prompt;
    cmdInput.focus();
    setState("LISTENING");
  })
);

/* ═══════════════════════════════════════════════════════════════════
   CLOCK
   ═══════════════════════════════════════════════════════════════════ */
function tickClock() {
  const d = new Date();
  $("#clockTime").textContent = d.toLocaleTimeString([], { hour12: false });
  $("#clockDate").textContent = d.toLocaleDateString([], {
    weekday: "short", day: "numeric", month: "short",
  }).toUpperCase();
}
setInterval(tickClock, 1000);
tickClock();

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD — weather + calendar
   ═══════════════════════════════════════════════════════════════════ */
async function loadWeather() {
  try {
    const geo = await fetch("https://get.geojs.io/v1/ip/geo.json").then((r) => r.json());
    const { latitude, longitude, city } = geo;
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`
    ).then((r) => r.json());
    const c = wx.current;
    const codes = {
      0: "Clear", 1: "Mostly Clear", 2: "Partly Cloudy", 3: "Overcast",
      45: "Fog", 48: "Rime Fog", 51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
      61: "Light Rain", 63: "Rain", 65: "Heavy Rain", 71: "Light Snow", 73: "Snow", 75: "Heavy Snow",
      80: "Showers", 81: "Showers", 82: "Violent Showers", 95: "Thunderstorm",
      96: "Storm + Hail", 99: "Storm + Hail",
    };
    $("#weatherTemp").textContent = `${Math.round(c.temperature_2m)}°C`;
    $("#weatherCond").textContent = codes[c.weather_code] || "—";
    $("#weatherCity").textContent = (city || "Local Station").toUpperCase();
    $("#weatherMeta").textContent = `Humidity: ${c.relative_humidity_2m}% • Wind: ${Math.round(c.wind_speed_10m)} km/h`;
  } catch {
    $("#weatherCond").textContent = "Uplink lost";
  }
}

function renderCalendar() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  $("#calHead").textContent = now.toLocaleDateString([], { month: "long", year: "numeric" }).toUpperCase();
  const grid = $("#calGrid");
  grid.innerHTML = "";
  for (const d of ["S", "M", "T", "W", "T", "F", "S"]) {
    const el = document.createElement("span");
    el.className = "dow";
    el.textContent = d;
    grid.appendChild(el);
  }
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < first; i++) {
    const pad = document.createElement("span");
    pad.className = "day other";
    grid.appendChild(pad);
  }
  for (let day = 1; day <= days; day++) {
    const el = document.createElement("span");
    el.className = "day" + (day === now.getDate() ? " today" : "");
    el.textContent = day;
    grid.appendChild(el);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   THEME — port of C.load_theme (colorsys HLS dim/light logic)
   ═══════════════════════════════════════════════════════════════════ */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, l, s];
}

function hslToHex(h, l, s) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * v).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const THEME_NAMES = { "#007aff": "Blue", "#37ff5f": "Green", "#ff3b30": "Red", "#00e5ff": "Ice", "#ffffff": "Ice White" };

function applyTheme(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const isWhite = hex.toLowerCase() === "#ffffff" || hex.toLowerCase() === "#f4f6f8";
  const [h, l, s] = hexToHsl(hex);
  const dim = hslToHex(h, Math.max(0, l - 0.15), s);
  const light = hslToHex(h, Math.min(1, l + 0.15), s);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const root = document.documentElement.style;
  root.setProperty("--pri", hex);
  root.setProperty("--pri-dim", dim);
  root.setProperty("--pri-gho", `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.setProperty("--acc", isWhite ? "#00e5ff" : hex);
  root.setProperty("--acc2", isWhite ? "#80ffff" : light);
  root.setProperty("--acc-rgb", isWhite ? "0, 229, 255" : `${r}, ${g}, ${b}`);
  root.setProperty("--border", `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.setProperty("--border-b", isWhite ? "rgba(0, 229, 255, 0.35)" : `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.setProperty("--border-a", `rgba(${r}, ${g}, ${b}, 0.18)`);
  document.querySelectorAll(".swatch").forEach((sw) =>
    sw.classList.toggle("active", sw.dataset.theme.toLowerCase() === hex.toLowerCase())
  );
  try { localStorage.setItem("brahma_theme", hex); } catch {}
}

document.querySelectorAll(".swatch").forEach((sw) =>
  sw.addEventListener("click", () => applyTheme(sw.dataset.theme))
);

$("#applyHex").addEventListener("click", () => {
  const hex = $("#customHex").value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    systemNote("Theme channel rejected that hex. Use the #rrggbb form.");
    return;
  }
  applyTheme(hex);
});

/* ═══════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════ */
(function boot() {
  try {
    const saved = localStorage.getItem("brahma_theme");
    if (saved) applyTheme(saved);
  } catch {}
  showEmptyState();
  loadWeather();
  renderCalendar();
  tickMetrics();
  rpFooterText.textContent = `Core Online · ${ENGINE}`;
  orbFrame.addEventListener("load", () => setState("ONLINE"));
  setTimeout(() => setState("ONLINE"), 600);
})();