// ConTrac Manifest V3 service worker.
// Handles scheduled Chrome notifications and Google Calendar / Tasks synchronization.
// v1.3.3 — Cross-browser OAuth (launchWebAuthFlow + PKCE) + corrected IST contest start times.

const CACHE_KEYS = ["cachedCodeforcesContests", "cachedLeetCodeContests"];
const SETTINGS_KEY = "reminderSettings";
const GOOGLE_STATE_KEY = "googleIntegration";
const SYNCED_KEY = "googleSyncedContests";
const SELECTED_KEY = "selectedContestReminders";

// ============================================================
// Google OAuth configuration (Web application client)
// ============================================================
const OAUTH_CLIENT_ID = '<your_client_id>';
const OAUTH_CLIENT_SECRET = '<your_cleint_secret>'; // Google requires this for installed clients
const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks'
].join(' ');

const TOKENS_KEY = "googleOAuthTokens";       // stored in chrome.storage.local
const OAUTH_TEMP_KEY = "googleOAuthTemp";     // stored in chrome.storage.session

const DEFAULT_SETTINGS = {
  intervals: [1440, 60, 10, 30],
  chrome: true,
  calendar: true,
  tasks: true
};

const ALARM_PREFIX = "contrac-reminder:";
const DEMO_ALARM = "contrac-demo-notification";
const DEMO_STATE_KEY = "demoNotificationState";

function storageGet(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.get(keys, result => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(result);
  }));
}
function storageSet(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}
function sessionGet(keys) {
  return new Promise((resolve, reject) => chrome.storage.session.get(keys, result => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(result);
  }));
}
function sessionSet(values) {
  return new Promise((resolve, reject) => chrome.storage.session.set(values, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}
function sessionRemove(keys) {
  return new Promise((resolve, reject) => chrome.storage.session.remove(keys, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}

// ============================================================
// PKCE helpers
// ============================================================
function base64UrlEncode(bytes) {
  let str = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(str) {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
}
function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, len);
}

// ============================================================
// Timezone helpers — India Standard Time (+05:30)
// ============================================================
const IST_OFFSET_MINUTES = 330; // +05:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

// Cached contest.startTime values are stored 5h 30m behind true UTC epoch
// because UTC strings without 'Z' were parsed as local IST when cached.
function getContestStartMs(contest) {
  return Number(contest.startTime) + IST_OFFSET_MS;
}

// Produces a calendar-ready dateTime with explicit +05:30 offset.
function toIndiaISO(ms) {
  const indiaMs = Number(ms) + IST_OFFSET_MS;
  const d = new Date(indiaMs);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `+05:30`
  );
}

// Formats an RFC 3339 date-only due timestamp anchored to the IST calendar day.
function toIndiaTaskDueISO(ms) {
  const indiaMs = Number(ms) + IST_OFFSET_MS;
  const d = new Date(indiaMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00:00.000Z`;
}

// Formats a readable IST timestamp for Google Tasks notes.
function formatIndiaDateTime(ms) {
  return new Date(Number(ms)).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

// Kept for any non-calendar callers that still expect a plain ISO string.
function iso(ms) {
  return new Date(ms).toISOString();
}

// ============================================================
// Token storage & refresh
// ============================================================
async function saveTokens(tokens) {
  const expiresIn = Number(tokens.expires_in) || 3600;
  const expiry = Date.now() + expiresIn * 1000 - 60_000;
  await storageSet({
    [TOKENS_KEY]: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expiry,
      scope: tokens.scope || OAUTH_SCOPES
    }
  });
}
async function getStoredTokens() {
  const data = await storageGet(TOKENS_KEY);
  return data[TOKENS_KEY] || null;
}
async function clearStoredTokens() {
  await storageSet({ [TOKENS_KEY]: null });
}

async function getAuthToken(interactive = false) {
  if (interactive) return await runInteractiveOAuth();

  const t = await getStoredTokens();
  if (!t) throw new Error('Not connected to Google. Click Connect in ConTrac.');
  if (Date.now() < t.expiry) return t.access_token;
  if (!t.refresh_token) {
    await clearStoredTokens();
    throw new Error('Google session expired. Please reconnect.');
  }

  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token'
    })
  }, 15000);

  if (!res.ok) {
    await clearStoredTokens();
    const body = await res.text().catch(() => '');
    throw new Error(`Google token refresh failed (${res.status}). Reconnect. ${body}`.trim());
  }
  const fresh = await res.json();
  await saveTokens({ ...fresh, refresh_token: t.refresh_token });
  return fresh.access_token;
}

async function runInteractiveOAuth() {
  const redirectUri = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
  const state = randomString(32);
  const verifier = randomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  await sessionSet({ [OAUTH_TEMP_KEY]: { state, verifier } });

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: url.toString(), interactive: true },
      resp => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp) return reject(new Error('Google authorization was cancelled.'));
        resolve(resp);
      }
    );
  });

  const params = new URL(responseUrl).searchParams;
  const returnedState = params.get('state');
  const code = params.get('code');
  const errorParam = params.get('error');

  if (errorParam) throw new Error(`Google returned: ${errorParam}`);
  if (!code) throw new Error('Google did not return an authorization code.');

  const temp = (await sessionGet(OAUTH_TEMP_KEY))[OAUTH_TEMP_KEY];
  if (!temp || returnedState !== temp.state) throw new Error('OAuth state mismatch (possible CSRF).');

  const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code,
      code_verifier: temp.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  }, 20000);

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${body}`);
  }

  const tokens = await tokenRes.json();
  await saveTokens(tokens);
  await sessionRemove(OAUTH_TEMP_KEY);
  return tokens.access_token;
}

async function getGoogleAccount(token) {
  const response = await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  }, 10000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.email) throw new Error(body.error?.message || 'Could not verify the Google account email. Check the userinfo.email OAuth scope.');
  return { email: body.email, name: body.name || body.email, picture: body.picture || null };
}
function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function getAllContests() {
  const data = await storageGet(CACHE_KEYS);
  return CACHE_KEYS.flatMap(key => Array.isArray(data[key]?.items) ? data[key].items : [])
    .filter(c => c && c.id && c.name && Number.isFinite(Number(c.startTime)) && getContestStartMs(c) > Date.now());
}
function contestFingerprint(contest) {
  return `${contest.id}|${contest.startTime}`;
}
async function getSelectedContests() {
  const [contests, selection] = await Promise.all([
    getAllContests(),
    storageGet(SELECTED_KEY)
  ]);
  const selected = new Set(Array.isArray(selection[SELECTED_KEY]) ? selection[SELECTED_KEY] : []);
  return contests.filter(contest => selected.has(contestFingerprint(contest)));
}
async function getSettings() {
  const data = await storageGet(SETTINGS_KEY);
  const saved = data[SETTINGS_KEY] || {};
  return {
    intervals: [...new Set((Array.isArray(saved.intervals) ? saved.intervals : DEFAULT_SETTINGS.intervals)
      .map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 40320))].sort((a,b) => b-a),
    chrome: saved.chrome !== false,
    calendar: saved.calendar !== false,
    tasks: saved.tasks !== false
  };
}

function createChromeNotification(id, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(id, options, notificationId => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(notificationId);
    });
  });
}

function alarmName(contestId, minutes) {
  return `${ALARM_PREFIX}${minutes}:${encodeURIComponent(contestId)}`;
}
async function scheduleChromeAlarms() {
  const settings = await getSettings();
  const contests = await getSelectedContests();
  const existing = await chrome.alarms.getAll();
  const wanted = new Set();

  if (settings.chrome) {
    for (const contest of contests) {
      const startMs = getContestStartMs(contest);
      for (const minutes of settings.intervals) {
        const when = startMs - minutes * 60_000;
        if (when <= Date.now() + 1000) continue;
        const name = alarmName(contest.id, minutes);
        wanted.add(name);
        await chrome.alarms.create(name, { when });
      }
    }
  }

  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name);
    }
  }
  await storageSet({
    reminderDiagnostics: {
      scheduledAlarmCount: wanted.size,
      selectedContestCount: contests.length,
      chromeEnabled: settings.chrome,
      checkedAt: Date.now()
    }
  });
}
async function showReminder(contestId, minutes) {
  const settings = await getSettings();
  if (!settings.chrome) return;
  const contests = await getSelectedContests();
  const contest = contests.find(c => String(c.id) === contestId);
  if (!contest) return;

  const timeLabel = minutes >= 1440 ? `${minutes / 1440} day(s)` :
    minutes >= 60 ? `${minutes / 60} hour(s)` : `${minutes} minute(s)`;
  await createChromeNotification(`notification-${contestId}-${minutes}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `${contest.platform} contest reminder`,
    message: `${contest.name} starts in ${timeLabel}.`,
    contextMessage: "ConTrac · Coding Contest Tracker",
    priority: 2
  });
}


const DEMO_GOOGLE_KEY = "demoGoogleArtifacts";
async function removePreviousDemoGoogleArtifacts(token) {
  const data = await storageGet(DEMO_GOOGLE_KEY);
  const old = data[DEMO_GOOGLE_KEY] || {};
  const errors = [];
  if (old.eventId) {
    try { await deleteGoogleResource(`/calendar/v3/calendars/primary/events/${encodeURIComponent(old.eventId)}`, token); }
    catch (error) { errors.push(`Previous demo Calendar cleanup: ${error.message}`); }
  }
  if (old.taskId) {
    try { await deleteGoogleResource(`/tasks/v1/lists/@default/tasks/${encodeURIComponent(old.taskId)}`, token); }
    catch (error) { errors.push(`Previous demo Tasks cleanup: ${error.message}`); }
  }
  await storageSet({ [DEMO_GOOGLE_KEY]: {} });
  return errors;
}
async function runDemoCheck() {
  await chrome.alarms.clear(DEMO_ALARM);
  const settings = await getSettings();
  const state = {
    id: `demo-${Date.now()}`,
    startedAt: Date.now(),
    status: 'running',
    checks: {
      chrome: { enabled: settings.chrome, status: settings.chrome ? 'pending' : 'skipped', detail: settings.chrome ? 'Scheduling a local notification.' : 'Chrome notifications are disabled.' },
      calendar: { enabled: settings.calendar, status: settings.calendar ? 'pending' : 'skipped', detail: settings.calendar ? 'Checking Google Calendar authorization and event creation.' : 'Calendar sync is disabled.' },
      tasks: { enabled: settings.tasks, status: settings.tasks ? 'pending' : 'skipped', detail: settings.tasks ? 'Checking Google Tasks authorization and task creation.' : 'Tasks sync is disabled.' }
    }
  };
  await storageSet({ [DEMO_STATE_KEY]: state });

  let token = null;
  let account = null;
  if (settings.calendar || settings.tasks) {
    try {
      const auth = await storageGet(GOOGLE_STATE_KEY);
      if (!auth[GOOGLE_STATE_KEY]?.connected) throw new Error('Connect Google first from the account section.');
      token = await getAuthToken(false);
      account = await getGoogleAccount(token);
    } catch (error) {
      for (const key of ['calendar','tasks']) if (state.checks[key].enabled) state.checks[key] = { ...state.checks[key], status: 'failed', detail: error.message };
      token = null;
    }
  }

  let cleanupErrors = [];
  if (token) cleanupErrors = await removePreviousDemoGoogleArtifacts(token);
  if (settings.calendar && token) {
    try {
      const startAt = Date.now() + 4 * 60_000;
      const event = await googleRequest('/calendar/v3/calendars/primary/events', token, {
        method: 'POST', body: JSON.stringify({
          summary: '[ConTrac TEST] Calendar reminder verification',
          description: 'Temporary ConTrac diagnostic event. It is safe to delete. This event tests timed Google Calendar popup reminders.',
          start: { dateTime: toIndiaISO(startAt) },
          end:   { dateTime: toIndiaISO(startAt + 15 * 60_000) },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1 }] }
        })
      });
      state.checks.calendar = { enabled: true, status: 'passed', detail: `Test event created for ${new Date(startAt).toLocaleTimeString()}; Google popup alert configured 1 minute before.${cleanupErrors.length ? ` Previous demo cleanup warnings: ${cleanupErrors.join(' | ')}` : ''}`, eventId: event.id, eventUrl: event.htmlLink };
      state.calendarEventId = event.id;
    } catch (error) { state.checks.calendar = { enabled: true, status: 'failed', detail: error.message }; }
  }
  if (settings.tasks && token) {
    try {
      const task = await googleRequest('/tasks/v1/lists/@default/tasks', token, {
        method: 'POST', body: JSON.stringify({
          title: '[ConTrac TEST] Verify Google Tasks sync',
          status: 'needsAction', due: toIndiaTaskDueISO(Date.now()),
          notes: 'Temporary ConTrac diagnostic task. This verifies task-list write access. Google Tasks API supports due dates, not precise timed reminders.'
        })
      });
      state.checks.tasks = { enabled: true, status: 'passed', detail: 'Test task created in the default Google Tasks list. Tasks API does not provide exact-time reminders.', taskId: task.id };
      state.taskId = task.id;
    } catch (error) { state.checks.tasks = { enabled: true, status: 'failed', detail: error.message }; }
  }

  if (settings.chrome) {
    try {
      await createChromeNotification('contrac-demo-immediate', {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'ConTrac · Chrome notification test',
        message: 'Chrome notifications are enabled. Your local reminder channel is working.',
        contextMessage: 'SYSTEM CHECK · LOCAL DELIVERY', priority: 2
      });
      state.checks.chrome = { enabled: true, status: 'passed', detail: 'A Chrome notification was requested immediately.' };
    } catch (error) { state.checks.chrome = { enabled: true, status: 'failed', detail: error.message }; }
  }

  state.completedAt = Date.now();
  const active = Object.values(state.checks).filter(x => x.enabled);
  state.status = active.length === 0 ? 'no-tests' : active.every(x => x.status === 'passed') ? 'passed' : active.some(x => x.status === 'passed') ? 'partial' : 'failed';
  state.accountEmail = account?.email || null;
  await storageSet({
    [DEMO_STATE_KEY]: state,
    [DEMO_GOOGLE_KEY]: { eventId: state.calendarEventId || null, taskId: state.taskId || null, createdAt: Date.now() }
  });
  return { success: true, state };
}
async function cleanupDemoArtifacts() {
  const data = await storageGet([DEMO_GOOGLE_KEY, GOOGLE_STATE_KEY]);
  const artifacts = data[DEMO_GOOGLE_KEY] || {};
  if (!artifacts.eventId && !artifacts.taskId) return { success: true, message: 'There are no tracked demo items to clean up.' };
  if (!data[GOOGLE_STATE_KEY]?.connected) throw new Error('Connect the same Google account that created the demo items before cleaning them up.');
  const token = await getAuthToken(false);
  const errors = [];
  if (artifacts.eventId) try { await deleteGoogleResource(`/calendar/v3/calendars/primary/events/${encodeURIComponent(artifacts.eventId)}`, token); } catch (e) { errors.push(`Calendar: ${e.message}`); }
  if (artifacts.taskId) try { await deleteGoogleResource(`/tasks/v1/lists/@default/tasks/${encodeURIComponent(artifacts.taskId)}`, token); } catch (e) { errors.push(`Tasks: ${e.message}`); }
  if (!errors.length) await storageSet({ [DEMO_GOOGLE_KEY]: {}, [DEMO_STATE_KEY]: null });
  return { success: !errors.length, message: errors.length ? errors.join(' | ') : 'Temporary Calendar event and Google Task deleted.' };
}

async function googleRequest(path, token, options = {}) {
  const response = await fetchWithTimeout(`https://www.googleapis.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  }, 15000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      await clearStoredTokens();
      const auth = await storageGet(GOOGLE_STATE_KEY).catch(() => ({}));
      if (auth[GOOGLE_STATE_KEY]?.connected) await storageSet({
        [GOOGLE_STATE_KEY]: { ...auth[GOOGLE_STATE_KEY], connected: false, authError: 'Google authorization expired. Reconnect your account.' },
        googleSyncStatus: { completedAt: Date.now(), errors: ['Google returned 401 Unauthorized. Reconnect your account.'] }
      });
    }
    throw new Error(body.error?.message || `Google API error (${response.status})`);
  }
  return body;
}

async function createCalendarEvent(contest, token, settings, synced) {
  const fingerprint = contestFingerprint(contest);
  const start = getContestStartMs(contest);
  const end = start + Math.max(30, Number(contest.duration) || 90) * 60_000;
  const overrides = [...new Set(settings.intervals)]
    .filter(minutes => Number.isInteger(minutes) && minutes > 0)
    .sort((a, b) => a - b)
    .slice(0, 5)
    .map(minutes => ({ method: "popup", minutes }));

  const event = {
    summary: `[${contest.platform}] ${contest.name}`,
    description: `Contest tracked by ConTrac.\nPlatform: ${contest.platform}\nContest: ${contest.url || ""}`,
    start: { dateTime: toIndiaISO(start) },
    end:   { dateTime: toIndiaISO(end) },
    reminders: { useDefault: false, overrides }
  };

  const existingId = synced[fingerprint]?.calendarEventId;
  if (existingId) {
    try {
      const updated = await googleRequest(
        `/calendar/v3/calendars/primary/events/${encodeURIComponent(existingId)}`,
        token,
        { method: "PATCH", body: JSON.stringify(event) }
      );
      synced[fingerprint] = {
        ...(synced[fingerprint] || {}),
        calendarEventId: updated.id || existingId,
        calendarEventUrl: updated.htmlLink || synced[fingerprint]?.calendarEventUrl || null
      };
      await storageSet({ [SYNCED_KEY]: synced });
      return false;
    } catch (error) {
      if (!/404|not found/i.test(error.message)) throw error;
      delete synced[fingerprint].calendarEventId;
      delete synced[fingerprint].calendarEventUrl;
    }
  }

  const created = await googleRequest(
    "/calendar/v3/calendars/primary/events",
    token,
    { method: "POST", body: JSON.stringify(event) }
  );
  synced[fingerprint] = {
    ...(synced[fingerprint] || {}),
    calendarEventId: created.id,
    calendarEventUrl: created.htmlLink || null
  };
  await storageSet({ [SYNCED_KEY]: synced });
  return true;
}
async function createGoogleTask(contest, token, synced) {
  const fingerprint = contestFingerprint(contest);
  const start = getContestStartMs(contest);
  const task = {
    title: `[${contest.platform}] ${contest.name}`,
    status: "needsAction",
    notes: `Contest starts at ${formatIndiaDateTime(start)} IST.\nGoogle Tasks does not support time-of-day reminders. Use the timed Calendar event for alerts: ${synced[fingerprint]?.calendarEventUrl || "enable Google Calendar in ConTrac reminder settings"}.\nContest link: ${contest.url || ""}`,
    due: toIndiaTaskDueISO(start)
  };

  const existingId = synced[fingerprint]?.taskId;
  if (existingId) {
    try {
      await googleRequest(
        `/tasks/v1/lists/@default/tasks/${encodeURIComponent(existingId)}`,
        token,
        { method: "PATCH", body: JSON.stringify({ title: task.title, notes: task.notes, due: task.due }) }
      );
      return false;
    } catch (error) {
      if (!/404|not found/i.test(error.message)) throw error;
      delete synced[fingerprint].taskId;
    }
  }

  const created = await googleRequest(
    "/tasks/v1/lists/@default/tasks",
    token,
    { method: "POST", body: JSON.stringify(task) }
  );
  synced[fingerprint] = { ...(synced[fingerprint] || {}), taskId: created.id };
  await storageSet({ [SYNCED_KEY]: synced });
  return true;
}
async function deleteGoogleResource(path, token) {
  const response = await fetch(`https://www.googleapis.com${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 204 || response.status === 200 || response.status === 404 || response.status === 410) return;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Google delete error (${response.status})`);
}

async function syncGoogleInner() {
  const stateData = await storageGet([GOOGLE_STATE_KEY, SYNCED_KEY]);
  if (!stateData[GOOGLE_STATE_KEY]?.connected) return { skipped: true };

  const settings = await getSettings();
  const contests = await getSelectedContests();
  const token = await getAuthToken(false);
  const liveState = await storageGet(GOOGLE_STATE_KEY);
  if (!liveState[GOOGLE_STATE_KEY]?.connected) return { calendarCreated: 0, tasksCreated: 0, errors: [], skipped: true };
  const account = await getGoogleAccount(token);
  if (liveState[GOOGLE_STATE_KEY].accountEmail && liveState[GOOGLE_STATE_KEY].accountEmail.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error('The stored Google token belongs to a different account than the connected account. Disconnect and reconnect the intended account.');
  }
  const selectionData = await storageGet(SELECTED_KEY);
  const selectedKeys = new Set(Array.isArray(selectionData[SELECTED_KEY]) ? selectionData[SELECTED_KEY] : []);
  const synced = stateData[SYNCED_KEY] || {};
  const errors = [];

  for (const [fingerprint, rawRecord] of Object.entries(synced)) {
    const record = rawRecord && typeof rawRecord === "object" ? rawRecord : {};
    synced[fingerprint] = record;
    if ((!selectedKeys.has(fingerprint) || !settings.calendar) && record.calendarEventId) {
      try {
        await deleteGoogleResource(
          `/calendar/v3/calendars/primary/events/${encodeURIComponent(record.calendarEventId)}`,
          token
        );
        delete record.calendarEventId;
        delete record.calendarEventUrl;
      } catch (error) { errors.push(`Calendar cleanup: ${error.message}`); }
    }
    if ((!selectedKeys.has(fingerprint) || !settings.tasks) && record.taskId) {
      try {
        await deleteGoogleResource(
          `/tasks/v1/lists/@default/tasks/${encodeURIComponent(record.taskId)}`,
          token
        );
        delete record.taskId;
      } catch (error) { errors.push(`Tasks cleanup: ${error.message}`); }
    }
    if (!record.calendarEventId && !record.taskId) delete synced[fingerprint];
  }
  await storageSet({ [SYNCED_KEY]: synced });
  if (!settings.calendar && !settings.tasks) {
    return { calendarCreated: 0, tasksCreated: 0, errors };
  }

  let calendarCreated = 0;
  let tasksCreated = 0;

  for (const contest of contests) {
    if (settings.calendar) {
      try {
        if (await createCalendarEvent(contest, token, settings, synced)) calendarCreated++;
      } catch (error) { errors.push(`Calendar: ${error.message}`); }
    }
    if (settings.tasks) {
      try {
        if (await createGoogleTask(contest, token, synced)) tasksCreated++;
      } catch (error) { errors.push(`Tasks: ${error.message}`); }
    }
  }
  await storageSet({ [SYNCED_KEY]: synced });
  return { calendarCreated, tasksCreated, errors };
}


let googleSyncInFlight = null;
function syncGoogle() {
  if (googleSyncInFlight) return googleSyncInFlight;
  googleSyncInFlight = syncGoogleInner()
    .then(async result => {
      await storageSet({ googleSyncStatus: {
        completedAt: Date.now(),
        status: result.errors?.length ? 'attention' : (result.skipped ? 'idle' : 'synced'),
        calendarCreated: result.calendarCreated || 0,
        tasksCreated: result.tasksCreated || 0,
        errors: result.errors || [],
        skipped: Boolean(result.skipped)
      }});
      return result;
    })
    .catch(async error => {
      await storageSet({ googleSyncStatus: {
        completedAt: Date.now(), status: 'error', errors: [error.message]
      }});
      throw error;
    })
    .finally(() => { googleSyncInFlight = null; });
  return googleSyncInFlight;
}

let refreshInFlight = null;
function refreshAll() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    await scheduleChromeAlarms();
    try { await syncGoogle(); } catch (error) { console.warn("Google sync skipped:", error.message); }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function disconnectGoogleAccount() {
  const previous = await storageGet(GOOGLE_STATE_KEY);
  const previousState = previous[GOOGLE_STATE_KEY] || {};
  const tokens = await getStoredTokens();
  await clearStoredTokens();
  await storageSet({
    [GOOGLE_STATE_KEY]: { connected: false, disconnectedAt: Date.now(), accountEmail: null, accountName: null, lastAccountEmail: previousState.accountEmail || previousState.lastAccountEmail || null },
    googleSyncStatus: { completedAt: Date.now(), disconnected: true, errors: [] }
  });
  const warnings = [];
  if (tokens?.access_token) {
    try {
      const res = await fetchWithTimeout(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.access_token)}`, { method: 'POST' }, 5000);
      if (!res.ok) warnings.push(`Google revoke returned ${res.status}`);
    } catch (error) { warnings.push(`Google revoke: ${error.message}`); }
  }
  await storageSet({
    googleSyncStatus: { completedAt: Date.now(), disconnected: true, errors: warnings }
  });
  return warnings;
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const rest = alarm.name.slice(ALARM_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return;
  const minutes = Number(rest.slice(0, separator));
  const contestId = decodeURIComponent(rest.slice(separator + 1));
  showReminder(contestId, minutes).catch(console.error);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (CACHE_KEYS.some(key => key in changes) || SETTINGS_KEY in changes || SELECTED_KEY in changes) {
    refreshAll().catch(console.error);
  }
  if (GOOGLE_STATE_KEY in changes) {
    syncGoogle().catch(console.error);
  }
});

chrome.runtime.onInstalled.addListener(() => refreshAll().catch(console.error));
chrome.runtime.onStartup.addListener(() => refreshAll().catch(console.error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "SCHEDULE_DEMO_NOTIFICATION") return await runDemoCheck();
    if (message?.type === "GET_DEMO_STATUS") {
      const data = await storageGet(DEMO_STATE_KEY);
      return { success: true, state: data[DEMO_STATE_KEY] || null };
    }
    if (message?.type === "CLEANUP_DEMO_ARTIFACTS") return await cleanupDemoArtifacts();
    if (message?.type === "GET_DIAGNOSTICS") {
      const data = await storageGet(["reminderDiagnostics", "googleSyncStatus", GOOGLE_STATE_KEY]);
      const notificationPermission = await new Promise(resolve => {
        try { chrome.notifications.getPermissionLevel(level => resolve(level || "unknown")); }
        catch { resolve("unknown"); }
      });
      return {
        success: true,
        reminders: data.reminderDiagnostics || null,
        googleSync: data.googleSyncStatus || null,
        googleConnected: Boolean(data[GOOGLE_STATE_KEY]?.connected),
        googleAccountEmail: data[GOOGLE_STATE_KEY]?.accountEmail || null,
        notificationPermission
      };
    }
    if (message?.type === "GOOGLE_CONNECT") {
      const existing = await storageGet(GOOGLE_STATE_KEY);
      if (existing[GOOGLE_STATE_KEY]?.connected) await disconnectGoogleAccount();
      const token = await getAuthToken(true);
      const account = await getGoogleAccount(token);
      const previousState = (await storageGet(GOOGLE_STATE_KEY))[GOOGLE_STATE_KEY] || {};
      if (previousState.lastAccountEmail && previousState.lastAccountEmail.toLowerCase() !== account.email.toLowerCase()) {
        await storageSet({ [SYNCED_KEY]: {} });
      }
      await storageSet({
        [GOOGLE_STATE_KEY]: { connected: true, connectedAt: Date.now(), lastAuthCheck: Date.now(), accountEmail: account.email, accountName: account.name, lastAccountEmail: account.email },
        googleSyncStatus: { startedAt: Date.now(), status: 'syncing', errors: [] }
      });
      syncGoogle().catch(error => console.error('ConTrac Google sync failed:', error));
      return { success: true, authenticated: true, account, message: `Connected as ${account.email}. Initial sync started.` };
    }
    if (message?.type === "GOOGLE_DISCONNECT") {
      const warnings = await disconnectGoogleAccount();
      return { success: true, disconnected: true, warnings };
    }
    if (message?.type === "SAVE_REMINDER_SETTINGS") {
      await storageSet({ [SETTINGS_KEY]: message.settings });
      await refreshAll();
      return { success: true };
    }
    if (message?.type === "SELECTIONS_UPDATED") {
      await refreshAll();
      return { success: true };
    }
    if (message?.type === "SYNC_GOOGLE") {
      const result = await syncGoogle();
      return { success: true, result };
    }
    if (message?.type === "CHECK_GOOGLE_AUTH") {
      await getAuthToken(false);
      return { success: true, authenticated: true };
    }
    if (message?.type === "GET_STATUS") {
      const data = await storageGet([GOOGLE_STATE_KEY, SETTINGS_KEY, "googleSyncStatus"]);
      return {
        success: true,
        connected: Boolean(data[GOOGLE_STATE_KEY]?.connected),
        connectedAt: data[GOOGLE_STATE_KEY]?.connectedAt || null,
        accountEmail: data[GOOGLE_STATE_KEY]?.accountEmail || null,
        accountName: data[GOOGLE_STATE_KEY]?.accountName || null,
        syncStatus: data.googleSyncStatus || null,
        settings: await getSettings()
      };
    }
    return { success: false, error: "Unknown message." };
  })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});

refreshAll().catch(console.error);