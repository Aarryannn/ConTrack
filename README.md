# ConTrac v1.3.0 — Verified Google Auth & Delivery Lab

## Install / update
1. Extract this folder.
2. Open `chrome://extensions`.
3. Find the existing ConTrac installation and use **Load unpacked** only if this is the first install. For an existing unpacked install, replace the contents of its existing folder and click **Reload**.
4. Keep the existing folder, manifest public key, and extension ID. Do not create a second extension installation.

## Google OAuth configuration
This release adds account identity verification. In Google Cloud Console, make sure Calendar API and Tasks API are enabled and the OAuth consent screen / Google Auth Platform includes these scopes in Data Access:
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/tasks`
- `openid`
- `https://www.googleapis.com/auth/userinfo.email`

Keep the existing Chrome Extension OAuth client ID and authorized extension ID. Add the Google account used for testing as a test user if the consent screen is in Testing. After updating the extension, reload it and connect again; Google may ask you to grant the additional identity scope.

## Authentication model
- Uses Chrome Identity API `getAuthToken` with the manifest OAuth client.
- Verifies the token against Google UserInfo and displays the authenticated email in the popup and settings.
- Google API requests have timeouts and actionable error reporting. A 401 clears the cached token and marks the connection as needing reconnection.
- Disconnect first flips ConTrac to a disconnected state and clears Chrome's cached extension tokens. It does **not** sign the user out of Google or revoke the OAuth grant in the user's Google Account.
- To switch accounts, use a different Google account in the Chrome profile/account chooser. If Chrome silently reuses the same identity, use a separate Chrome profile.

## Sync behavior
- Only contests explicitly selected with **Remind me** are synced.
- Calendar creates timed events and configures up to five popup reminder overrides (Google Calendar API limit). Chrome alarms can cover all selected intervals independently.
- Tasks creates or updates a task with the contest date and a link to the timed Calendar event when available. Google Tasks API does not support exact-time reminders; it cannot replace Calendar or Chrome notifications.
- Existing ConTrac-created items are updated on subsequent syncs. Deselecting a contest or disabling a destination removes the corresponding ConTrac-created item when sync is connected.

## New Notification Test Centre
Settings → Delivery Lab runs independent checks for enabled channels:
- Chrome: requests an immediate local notification.
- Calendar: creates a temporary `[ConTrac TEST]` event starting four minutes later with a popup reminder one minute before.
- Tasks: creates a temporary `[ConTrac TEST]` task in the default task list.
- Test results are shown per channel as passed, failed, or skipped. **Clean up test items** deletes the tracked temporary Calendar event and Task. Reconnect the same Google account before cleanup if you disconnected after the test.

A successful Calendar API write confirms the event and reminder configuration were accepted; it cannot guarantee that Google Calendar's device-level notification settings or operating-system notifications are enabled. A successful Tasks API write confirms task creation only.

## Validation performed
- JavaScript syntax checks for background, popup, and settings scripts.
- Manifest and package JSON parse checks.
- ZIP integrity check.

Live OAuth consent, Google API writes, and operating-system notification delivery must still be tested in the user's Chrome profile.
