# Release Notes

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