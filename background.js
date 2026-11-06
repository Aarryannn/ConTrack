// ConTrac Manifest V3 service worker.
// Handles scheduled Chrome notifications and Google Calendar / Tasks synchronization.

const CACHE_KEYS = ["cachedCodeforcesContests", "cachedLeetCodeContests"];
const SETTINGS_KEY = "reminderSettings";
const GOOGLE_STATE_KEY = "googleIntegration";
const SYNCED_KEY = "googleSyncedContests";
const SELECTED_KEY = "selectedContestReminders";

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
function identityCall(method, options) {
  return new Promise((resolve, reject) => {
    const callback = result => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve(result);
    };
    try {
      if (options === undefined) chrome.identity[method](callback);
      else chrome.identity[method](options, callback);
    } catch (error) { reject(error); }
  });
}
function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Google authorization timed out. Check the OAuth client ID, extension ID, enabled APIs, consent-screen test user, and redirect configuration.'));
    }, interactive ? 90_000 : 20_000);
    try {
      chrome.identity.getAuthToken({ interactive }, token => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!token) reject(new Error('Google returned no access token.'));
        else resolve(token);
      });
    } catch (error) {
      if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
    }
  });
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
    .filter(c => c && c.id && c.name && Number.isFinite(Number(c.startTime)) && Number(c.startTime) > Date.now());
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
      for (const minutes of settings.intervals) {
        const when = Number(contest.startTime) - minutes * 60_000;
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
          start: { dateTime: iso(startAt) }, end: { dateTime: iso(startAt + 15 * 60_000) },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1 }] }
        })
      });
      state.checks.calendar = { enabled: true, status: 'passed', detail: `Test event created for ${new Date(startAt).toLocaleTimeString()}; Google popup alert configured 1 minute before.${cleanupErrors.length ? ` Previous demo cleanup warnings: ${cleanupErrors.join(' | ')}` : ''}`, eventId: event.id, eventUrl: event.htmlLink };
      state.calendarEventId = event.id;
    } catch (error) { state.checks.calendar = { enabled: true, status: 'failed', detail: error.message }; }
  }
  if (settings.tasks && token) {
    try {
      const today = new Date();
      const due = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12));
      const task = await googleRequest('/tasks/v1/lists/@default/tasks', token, {
        method: 'POST', body: JSON.stringify({
          title: '[ConTrac TEST] Verify Google Tasks sync',
          status: 'needsAction', due: due.toISOString(),
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
      try { await identityCall("removeCachedAuthToken", { token }); } catch {}
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
function iso(ms) {
  return new Date(ms).toISOString();
}
async function createCalendarEvent(contest, token, settings, synced) {
  const fingerprint = contestFingerprint(contest);
  const start = Number(contest.startTime);
  const end = start + Math.max(30, Number(contest.duration) || 90) * 60_000;
  // Calendar supports at most five popup overrides. Keep the five closest
  // selected reminders, while Chrome alarms retain every selected interval.
  const overrides = [...new Set(settings.intervals)]
    .filter(minutes => Number.isInteger(minutes) && minutes > 0)
    .sort((a, b) => a - b)
    .slice(0, 5)
    .map(minutes => ({ method: "popup", minutes }));

  const event = {
    summary: `[${contest.platform}] ${contest.name}`,
    description: `Contest tracked by ConTrac.\nPlatform: ${contest.platform}\nContest: ${contest.url || ""}`,
    start: { dateTime: iso(start) },
    end: { dateTime: iso(end) },
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
  // Google Tasks discards the time component of `due`. Use noon UTC on the
  // contest's local calendar date to avoid the date shifting backwards when
  // Google converts midnight in positive-offset time zones to UTC.
  const contestDate = new Date(contest.startTime);
  const due = new Date(Date.UTC(
    contestDate.getFullYear(), contestDate.getMonth(), contestDate.getDate(), 12, 0, 0
  ));
  const task = {
    title: `[${contest.platform}] ${contest.name}`,
    status: "needsAction",
    notes: `Contest starts at ${contestDate.toLocaleString()}.\nGoogle Tasks does not support time-of-day reminders. Use the timed Calendar event for alerts: ${synced[fingerprint]?.calendarEventUrl || "enable Google Calendar in ConTrac reminder settings"}.\nContest link: ${contest.url || ""}`,
    due: due.toISOString()
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
    throw new Error('The cached Google token belongs to a different account than the connected account. Disconnect and reconnect the intended account.');
  }
  const selectionData = await storageGet(SELECTED_KEY);
  const selectedKeys = new Set(Array.isArray(selectionData[SELECTED_KEY]) ? selectionData[SELECTED_KEY] : []);
  const synced = stateData[SYNCED_KEY] || {};
  const errors = [];

  // Remove only Google items whose IDs ConTrac previously created and whose
  // contest the user has explicitly deselected.
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

async function clearCachedGoogleTokens() {
  await identityCall('clearAllCachedAuthTokens');
}
async function disconnectGoogleAccount() {
  // Disconnect is intentionally local and immediate. Google consent is not revoked
  // here; Chrome's cached extension tokens are cleared. The user can revoke the
  // OAuth grant separately in their Google Account security settings.
  const previous = await storageGet(GOOGLE_STATE_KEY);
  const previousState = previous[GOOGLE_STATE_KEY] || {};
  await storageSet({
    [GOOGLE_STATE_KEY]: { connected: false, disconnectedAt: Date.now(), accountEmail: null, accountName: null, lastAccountEmail: previousState.accountEmail || previousState.lastAccountEmail || null },
    googleSyncStatus: { completedAt: Date.now(), disconnected: true, errors: [] }
  });
  const warnings = [];
  try {
    await Promise.race([
      clearCachedGoogleTokens(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome token-cache cleanup timed out.')), 5000))
    ]);
  } catch (error) { warnings.push(error.message); }
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
        // The sync ledger contains Google resource IDs from a different account.
        // Do not send those IDs to the newly authenticated account.
        await storageSet({ [SYNCED_KEY]: {} });
      }
      await storageSet({
        [GOOGLE_STATE_KEY]: { connected: true, connectedAt: Date.now(), lastAuthCheck: Date.now(), accountEmail: account.email, accountName: account.name, lastAccountEmail: account.email },
        googleSyncStatus: { startedAt: Date.now(), status: 'syncing', errors: [] }
      });
      // Respond only after identity verification. Sync is separately tracked and reflected in all views.
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
