// ConTrac popup controller — resilient per-platform loading and popup settings window.
const $ = (id) => document.getElementById(id);
const contestList = $("contestList");
const contestCount = $("contestCount");
const nextCountdown = $("nextCountdown");
const searchInput = $("searchInput");
const refreshBtn = $("refreshBtn");
const filterButtons = [...document.querySelectorAll(".filterBtn")];

const DAY = 86_400_000;
const API = {
  codeforces: "https://codeforces.com/api/contest.list?gym=false",
  leetcode: [
    "https://alfa-leetcode-api.onrender.com/contests/upcoming",
    "https://alfa-leetcode-api.onrender.com/contests"
  ]
};
const CACHE_KEYS = {
  codeforces: "cachedCodeforcesContests",
  leetcode: "cachedLeetCodeContests"
};
const SELECTED_KEY = "selectedContestReminders";
let selectedContests = new Set();
let activeFilter = "all";
let contests = [];
let platformStatus = { codeforces: "Loading", leetcode: "Loading" };

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (result) => resolve(result[key])));
}
function storageSet(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}
function sendMessage(payload) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(payload, (response) => {
    const error = chrome.runtime.lastError;
    if (error) return reject(new Error(error.message));
    if (!response?.success) return reject(new Error(response?.error || "Extension request failed"));
    resolve(response);
  }));
}
async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.status === "error") throw new Error(body.comment || "API returned an error");
  return body;
}
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}
function countdown(timestamp) {
  const remaining = Math.max(0, timestamp - Date.now());
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return days ? `${days}d ${hours}h ${minutes}m` : [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}

async function fetchCodeforces() {
  const data = await fetchJSON(API.codeforces);
  if (data.status !== "OK" || !Array.isArray(data.result)) throw new Error(data.comment || "Unexpected Codeforces response");
  return data.result
    .filter(item => item.phase === "BEFORE" && Number(item.startTimeSeconds) * 1000 > Date.now())
    .map(item => ({
      id: `cf-${item.id}`,
      name: item.name || "Codeforces Contest",
      platform: "Codeforces",
      type: item.name?.match(/Div(?:ision)?\.?\s*[1-4]/i)?.[0] || "Codeforces",
      startTime: Number(item.startTimeSeconds) * 1000,
      duration: Math.max(1, Math.round(Number(item.durationSeconds || 5400) / 60)),
      url: `https://codeforces.com/contest/${item.id}`
    }));
}

function findContestArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  // API versions/wrappers have used several container names.
  for (const key of ["contests", "upcomingContests", "upcoming_contests", "data", "result", "items"]) {
    const found = findContestArray(payload[key]);
    if (found) return found;
  }
  return null;
}
function toTimestamp(raw) {
  if (raw === null || raw === undefined || raw === "") return NaN;
  let value;
  if (typeof raw === "number" || /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    value = Number(raw);
    if (value < 1e12) value *= 1000; // Unix seconds -> milliseconds.
  } else {
    value = Date.parse(raw);
  }
  return Number.isFinite(value) ? value : NaN;
}
function toDurationMinutes(item) {
  const seconds = item.durationSeconds ?? item.duration_seconds;
  if (seconds !== undefined) return Math.max(1, Math.round(Number(seconds) / 60));
  const raw = item.duration ?? item.durationMinutes ?? item.duration_minutes;
  if (typeof raw === "string" && /hour|minute|second/i.test(raw)) {
    const hours = Number(raw.match(/(\d+(?:\.\d+)?)\s*hours?/i)?.[1] || 0);
    const minutes = Number(raw.match(/(\d+(?:\.\d+)?)\s*minutes?/i)?.[1] || 0);
    const secs = Number(raw.match(/(\d+(?:\.\d+)?)\s*seconds?/i)?.[1] || 0);
    return Math.max(1, Math.round(hours * 60 + minutes + secs / 60));
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 90;
  return Math.max(1, Math.round(value > 1000 ? value / 60 : value));
}
function normalizeLeetCode(payload) {
  const items = findContestArray(payload);
  if (!items) throw new Error("LeetCode API returned an unrecognized response format");
  return items.map((item, index) => {
    const startTime = toTimestamp(
      item.startTime ?? item.start_time ?? item.startTimeSeconds ?? item.start_time_seconds ?? item.startDate ?? item.start_date
    );
    const name = item.title ?? item.name ?? item.contestTitle ?? item.titleSlug ?? "LeetCode Contest";
    const slug = item.titleSlug ?? item.title_slug ?? item.slug;
    const id = item.id ?? slug ?? `${name}-${startTime}-${index}`;
    return {
      id: `lc-${id}`,
      name,
      platform: "LeetCode",
      type: /biweekly/i.test(name) ? "Biweekly" : /weekly/i.test(name) ? "Weekly" : "LeetCode",
      startTime,
      duration: toDurationMinutes(item),
      url: item.url || (slug ? `https://leetcode.com/contest/${slug}/` : "https://leetcode.com/contest/")
    };
  }).filter(item => Number.isFinite(item.startTime) && item.startTime > Date.now());
}
async function fetchLeetCode() {
  let lastError;
  for (const endpoint of API.leetcode) {
    try {
      const result = normalizeLeetCode(await fetchJSON(endpoint));
      // Empty upcoming response is valid; don't fall through to a broader endpoint.
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Unable to load LeetCode contests");
}

function contestKey(item) {
  return `${item.id}|${item.startTime}`;
}
async function loadSelectedContests() {
  const saved = await storageGet(SELECTED_KEY);
  selectedContests = new Set(Array.isArray(saved) ? saved : []);
}
async function toggleContestReminder(key) {
  if (selectedContests.has(key)) selectedContests.delete(key);
  else selectedContests.add(key);
  await storageSet({ [SELECTED_KEY]: [...selectedContests] });
  render();
  try {
    await sendMessage({ type: "SELECTIONS_UPDATED" });
  } catch (error) {
    console.warn("Could not update selected contest reminders:", error);
  }
}

function getFilteredContests() {
  const query = searchInput.value.trim().toLowerCase();
  return contests
    .filter(item => Number(item.startTime) > Date.now())
    .filter(item => activeFilter === "all" || item.platform === activeFilter)
    .filter(item => `${item.name} ${item.platform} ${item.type}`.toLowerCase().includes(query))
    .sort((a, b) => a.startTime - b.startTime);
}
function updateStatus() {
  const parts = [];
  if (platformStatus.leetcode !== "Updated") parts.push(`LeetCode: ${platformStatus.leetcode}`);
  if (platformStatus.codeforces !== "Updated") parts.push(`Codeforces: ${platformStatus.codeforces}`);
  $("syncLabel").textContent = parts.length ? parts.join(" · ") : "Schedule up to date";
}
function render() {
  const list = getFilteredContests();
  contestCount.textContent = String(list.length);
  $("scheduleCount").textContent = `${list.length} EVENTS`;
  nextCountdown.textContent = list[0] ? countdown(list[0].startTime) : "--:--:--";

  if (list.length) {
    contestList.innerHTML = list.map(item => `
      <article class="contest-card">
        <div class="card-top"><div>
          <span class="platform-pill ${item.platform === "LeetCode" ? "leetcode" : "codeforces"}">${escapeHTML(item.platform)}</span>
          <h3 class="contest-name">${escapeHTML(item.name)}</h3>
          <div class="contest-meta">${escapeHTML(item.type)} · ${Number(item.duration) || 90} min</div>
        </div><div class="countdown-wrap"><div class="countdown-label">STARTS IN</div>
          <div class="countdown" data-start="${Number(item.startTime)}">${countdown(item.startTime)}</div>
        </div></div>
        <div class="card-bottom"><span class="contest-date">${formatDate(item.startTime)}</span>
          <div class="card-actions">
            <button class="reminder-toggle ${selectedContests.has(contestKey(item)) ? "selected" : ""}" data-reminder-key="${escapeHTML(contestKey(item))}" aria-pressed="${selectedContests.has(contestKey(item))}">
              ${selectedContests.has(contestKey(item)) ? "✓ Reminders on" : "+ Remind me"}
            </button>
            <a class="contest-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener">View ↗</a>
          </div>
        </div>
      </article>`).join("");
    return;
  }

  const leetcodeFailed = platformStatus.leetcode !== "Updated";
  const codeforcesFailed = platformStatus.codeforces !== "Updated";
  const details = leetcodeFailed || codeforcesFailed
    ? `Some contest feeds could not be reached. ${escapeHTML([leetcodeFailed ? `LeetCode: ${platformStatus.leetcode}` : "", codeforcesFailed ? `Codeforces: ${platformStatus.codeforces}` : ""].filter(Boolean).join(" · "))}`
    : "There are no upcoming contests for the selected filter.";
  contestList.innerHTML = `<div class="empty-state">No upcoming contests found.<br><small>${details}</small><br>Try refresh in a moment.</div>`;
}
contestList.addEventListener("click", event => {
  const button = event.target.closest("[data-reminder-key]");
  if (!button) return;
  toggleContestReminder(button.dataset.reminderKey);
});

function setFilter(filter) {
  activeFilter = filter;
  filterButtons.forEach(button => button.classList.toggle("active", button.dataset.filter === filter));
  render();
}
filterButtons.forEach(button => button.addEventListener("click", () => setFilter(button.dataset.filter)));
searchInput.addEventListener("input", render);

async function load() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "…";
  $("syncLabel").textContent = "Updating schedule…";

  // Render cached data immediately while both feeds refresh independently.
  const [cachedCF, cachedLC] = await Promise.all([
    storageGet(CACHE_KEYS.codeforces), storageGet(CACHE_KEYS.leetcode)
  ]);
  await loadSelectedContests();
  let cf = Array.isArray(cachedCF?.items) ? cachedCF.items : [];
  let lc = Array.isArray(cachedLC?.items) ? cachedLC.items : [];
  contests = [...cf, ...lc];
  platformStatus = {
    codeforces: cf.length ? "Using saved data" : "Waiting for feed",
    leetcode: lc.length ? "Using saved data" : "Waiting for feed"
  };
  render();

  const results = await Promise.allSettled([fetchCodeforces(), fetchLeetCode()]);
  if (results[0].status === "fulfilled") {
    cf = results[0].value;
    platformStatus.codeforces = "Updated";
    await storageSet({ [CACHE_KEYS.codeforces]: { items: cf, savedAt: Date.now() } });
  } else {
    platformStatus.codeforces = results[0].reason?.message || "Unavailable";
    console.warn("ConTrac Codeforces feed:", results[0].reason);
  }
  if (results[1].status === "fulfilled") {
    lc = results[1].value;
    platformStatus.leetcode = "Updated";
    await storageSet({ [CACHE_KEYS.leetcode]: { items: lc, savedAt: Date.now() } });
  } else {
    platformStatus.leetcode = results[1].reason?.message || "Unavailable";
    console.warn("ConTrac LeetCode feed:", results[1].reason);
  }
  contests = [...cf, ...lc];
  render();
  updateStatus();
  refreshBtn.disabled = false;
  refreshBtn.textContent = "↻";
}

async function updateGoogleStatus() {
  try {
    const response = await sendMessage({ type: "GET_STATUS" });
    $("googleButtonText").textContent = response.connected ? (response.accountEmail ? `Connected · ${response.accountEmail}` : "Google connected") : "Connect Google";
    if (!response.connected) $("syncLabel").textContent = "Google account not connected";
    else if (response.syncStatus?.errors?.length) $("syncLabel").textContent = `Google sync needs attention: ${response.syncStatus.errors[0]}`;
    else if (response.syncStatus?.status === "synced") $("syncLabel").textContent = "Google sync complete";
    else if (response.syncStatus?.status === "syncing") $("syncLabel").textContent = "Google sync in progress…";
  } catch (error) {
    console.warn("Google status unavailable:", error);
    $("googleButtonText").textContent = "Connect Google";
  }
}
$("googleConnectBtn").addEventListener("click", async () => {
  const button = $("googleConnectBtn");
  const label = $("googleButtonText");
  button.disabled = true;
  label.textContent = "Opening Google…";
  $("syncLabel").textContent = "Waiting for Google authorization…";

  let timeoutId;
  try {
    const response = await Promise.race([
      sendMessage({ type: "GOOGLE_CONNECT" }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(
          "No response from the background service. Open chrome://extensions and inspect the ConTrac service worker for errors."
        )), 65_000);
      })
    ]);
    label.textContent = response.account?.email ? `Connected · ${response.account.email}` : "Google connected";
    $("syncLabel").textContent = `Verified ${response.account?.email || "Google account"}. Sync is running in the background.`;
    button.classList.add("connected");
  } catch (error) {
    label.textContent = "Connect Google";
    $("syncLabel").textContent = error.message;
    console.error("ConTrac Google authentication:", error);
  } finally {
    clearTimeout(timeoutId);
    button.disabled = false;
  }
});

// Open settings in a compact extension-owned popup window (not a full tab).
$("settingsBtn").addEventListener("click", () => {
  if (!chrome.windows?.create) {
    $("syncLabel").textContent = "Could not open settings. Reload the extension.";
    return;
  }
  chrome.windows.create({
    url: chrome.runtime.getURL("settings.html"),
    type: "popup",
    width: 460,
    height: 760,
    focused: true
  }, () => {
    if (chrome.runtime.lastError) {
      $("syncLabel").textContent = chrome.runtime.lastError.message;
    }
  });
});
refreshBtn.addEventListener("click", load);
function tick() {
  document.querySelectorAll(".countdown[data-start]").forEach(element => {
    element.textContent = countdown(Number(element.dataset.start));
  });
  const next = getFilteredContests()[0];
  nextCountdown.textContent = next ? countdown(next.startTime) : "--:--:--";
}

updateGoogleStatus();
load().catch(error => {
  console.error("ConTrac failed to load:", error);
  $("syncLabel").textContent = "Unable to load schedule";
  refreshBtn.disabled = false;
  refreshBtn.textContent = "↻";
});
setInterval(tick, 1000);

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=="local")return;
  if(changes.googleIntegration){updateGoogleStatus();}
  if(changes.googleSyncStatus){
    const status=changes.googleSyncStatus.newValue||{};
    if(status.errors?.length)$("syncLabel").textContent=`Google sync needs attention: ${status.errors[0]}`;
    else if(status.status==="synced")$("syncLabel").textContent="Google sync complete";
    else if(status.disconnected)$("syncLabel").textContent="Google disconnected";
  }
});
