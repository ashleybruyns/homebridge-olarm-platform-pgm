# Release Notes

## v2.0.0 - 3 October 2026

### Official Olarm API, and gate control

This release moves the plugin to Olarm's public API and official real-time feed, and adds gates: open and close a gate from HomeKit using a zone sensor and a PGM output.

### ⚠️ New package name

This fork is published as **`homebridge-olarm-platform-pgm`** (listed in Homebridge as "Olarm Security System (Gates & PGM)"). If you use the original `homebridge-olarm-platform`, uninstall it before installing this one: both use the same `Olarm` platform, and your existing config block is reused. Accessories are registered again under the new plugin, so check their rooms and HomeKit automations afterwards.

### ⚠️ Action required: configuration change

The plugin no longer logs in with your Olarm email and password. It needs an **API key** instead:

1. Log into the [Olarm user portal](https://user.olarm.com/) and open **API access**
2. Generate an API key, and make sure API access is enabled for your device
3. In the plugin settings, enter it under **Authentication → API Key**
4. Remove the old email/password (`primaryAuth`) settings

If your config already has `fallbackAuth.apiKey`, it keeps working, but the log will ask you to move it to `apiKey`. The old token file `olarm_tokens.json` in the Homebridge storage folder can be deleted.

If you also use Olarm with Home Assistant or another integration on the same account, set **Connection → MQTT Client ID Suffix** to a value no other integration uses. Two connections with the same ID keep disconnecting each other.

### Gates

Each entry under **Gates** creates a Garage Door accessory. The zone reports whether the gate is closed, and the PGM is pulsed to move it. Because a pulse simply toggles the gate, the plugin only sends one when it is safe to:
- the zone's reading is clearly open or closed (not bypassed or unknown), recent, and the panel is online;
- the gate isn't already moving, including after someone used the remote;
- the PGM is enabled and allows pulse control on the panel.

Otherwise the request is refused, and the Home app shows "No Response" instead of the gate moving unexpectedly.

### Other changes
- Real-time updates now come from Olarm's official MQTT feed
- Arm and disarm use Olarm's documented commands
- More panel states are recognised (not ready, stay-arm variants, emergency, fire and medical alarms)
- Startup recovers on its own if Olarm can't be reached when Homebridge starts
- With Homebridge debug mode on, the log explains what the plugin is doing: connection details, which parts of each update arrived, your panel's PGM settings, every command sent and Olarm's response, and why a gate did or didn't move
- The settings page now links to this fork, with credit to Louis Germishuys's original plugin

See [CHANGELOG.md](CHANGELOG.md) for the full list.

---

## v1.0.6 - 14 October 2025

### Critical Bug Fix: MQTT Token Expiration

This release addresses a critical issue where the plugin would enter an infinite reconnection loop when the MQTT access token expired, causing:
- 600+ reconnection attempts per hour
- Log flooding with authentication errors
- Resource consumption
- Complete loss of MQTT connectivity

### What Was Fixed

The root cause was that when Olarm's access tokens expire (they have a limited lifespan), the MQTT client would continue attempting to reconnect using the expired token indefinitely. The plugin's token refresh logic was not integrated with the MQTT reconnection handler.

### How It Works Now

1. **Detection**: MQTT error handler detects "Bad username or password" errors
2. **Prevention**: Auto-reconnect is disabled to stop the spam loop
3. **Refresh**: Access token is refreshed using the cached refresh token
4. **Reconnect**: MQTT reconnects with the new valid token
5. **Fallback**: If refresh fails, the plugin falls back to API polling

### User Impact

**Before v1.0.6:**
- Users would see continuous authentication errors
- MQTT would never recover without manual intervention
- Required deleting token cache and restarting Homebridge

**After v1.0.6:**
- Token expiration handled automatically
- Seamless recovery without user intervention
- Clean logs with informative messages
- Zero downtime when tokens expire

### Who Should Update

**Update immediately if:**
- You see repeated "Bad username or password" MQTT errors
- Your logs show 50+ reconnection attempts per hour
- You've had to manually restart Homebridge to fix connectivity

**Everyone should update:**
This is a preventive fix - all users will eventually experience token expiration. Updating now prevents future issues.

### Migration Notes

No configuration changes required. The fix is fully backward compatible.

---

## Previous Releases

See [CHANGELOG.md](CHANGELOG.md) for complete version history.