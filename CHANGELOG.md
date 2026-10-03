# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-03

### Breaking
- Published as a new package, `homebridge-olarm-platform-pgm` (a fork of `homebridge-olarm-platform`). Uninstall the original first; both register the `Olarm` platform. Accessories are registered again under the new plugin
- Uses the Olarm public API with a single API key. The email/password ("native app") login has been removed
- New required `apiKey` setting. `fallbackAuth.apiKey` is still read but logs a deprecation warning; `primaryAuth` is ignored with a warning
- The token cache file (`olarm_tokens.json`) is no longer used and can be deleted

### Added
- Gates: a zone and a PGM combined into a HomeKit Garage Door accessory (`gates` config). Safety rules:
  - The PGM is only pulsed when the zone reads exactly closed (`c`) or open (`a`), the reading is under 90 seconds old (otherwise a fresh one is fetched), the panel is not offline, and the requested state differs from the current one
  - A lockout for `operationTime` blocks further pulses after each pulse, including after a failed or timed-out pulse and after an opening started from a remote
  - Repeated identical requests are ignored; opposite requests during movement are refused as busy
  - Requests that can't be carried out safely are refused, and the Home app shows "No Response"
- PGM check: a gate's PGM must be enabled and allow pulse control in the panel profile (`pgmControl`); checked at startup and before every pulse
- `mqttClientIdSuffix` setting (default `8`) so the plugin can share an account with other Olarm integrations such as Home Assistant
- Area states `notready`, `stayarm1-4`, `emergency`, `fire` and `medical` mapped to HomeKit; the entry delay keeps the current armed state
- Startup lists the devices the API key can access when `deviceId` doesn't match
- Debug logging (Homebridge debug mode) for diagnosing connections and gates: the MQTT client ID and topic, the fields in each MQTT message, the panel's `deviceStatus` and `pgmControl` settings, every API command with its HTTP status, and each gate's zone readings, request reasoning and movement lock

### Changed
- Real-time updates use Olarm's official public MQTT feed (`mqtt-pubapi.olarm.com`, as used by Olarm's own client library)
- API requests use the documented base URL `https://api.olarm.com/api/v4`, with a 4 second timeout
- Full device state is read over the API at startup and after every MQTT reconnect, since the feed only sends changes
- Arm/disarm use the documented `area-arm`, `area-stay`, `area-sleep` and `area-disarm` commands
- Zone `c` is logged as "Closed"
- Security system `StatusFault` is set only when the panel reports `offline`
- `scripts/get_device_id.py` uses the API key and only needs Python 3
- Settings page header and footer link to this fork (`ashleybruyns/homebridge-olarm-platform-pgm`), crediting the original plugin by Louis Germishuys

### Fixed
- Accessory setup retries every 60 seconds if the initial state can't be fetched, instead of giving up
- Accessories receive the initial state as soon as they are set up (previously they waited for the next update)
- A rejected MQTT connection backs off from 10 seconds up to 5 minutes instead of reconnecting every 10 seconds

### Removed
- `fs-extra` and `node-fetch` dependencies

## [1.0.6] - 2025-10-14

### Fixed
- **Critical:** Fixed MQTT reconnection storm when access token expires (was reconnecting 600+ times/hour)
- **Critical:** Fixed MQTT authentication loop - now properly refreshes token and reconnects automatically
- Added authentication error detection in MQTT error handler
- Disabled auto-reconnect when authentication fails to prevent log spam
- Added debounced token refresh to prevent multiple simultaneous refresh attempts

### Changed
- Improved MQTT error handling with automatic token refresh
- Enhanced reconnection logic to detect excessive reconnection attempts (>50/hour triggers token refresh)
- MQTT now gracefully recovers from token expiration without manual intervention

### Improved
- Better logging for authentication failures and token refresh events
- Automatic fallback to API polling if token refresh fails

## [1.0.5] - 2025-10-04

### Fixed
- Fixed `pluginAlias` registration causing platform to appear as "ExampleHomebridgePlugin" in Homebridge UI
- Removed default `armMode` value that was auto-creating empty automation entries

### Changed
- Hidden `platform` field in UI since it's a constant value ("Olarm")

## [1.0.4] - 2025-10-03

### Fixed
- Added missing `platform` property to config schema
- Fixed config schema validation for `includedZones` array (changed from `integer` to `number`)
- Fixed config schema validation for automation `zones` array (changed from `integer` to `number`)
- Improved array input UI in Homebridge config interface
- Made all automation fields optional (validation handled in code instead)

### Changed
- Updated config schema to use `number` type instead of `integer` for better UI compatibility
- Added `uniqueItems: true` to zone arrays to prevent duplicates
- Improved layout structure for zone configuration in UI

## [1.0.2] - 2025-10-03

### Added
- Initial public release
- Real-time MQTT connectivity with Olarm native app protocol
- Automatic zone discovery from device profile
- Token caching with automatic refresh
- API fallback polling when MQTT unavailable
- Security system accessory with all arm modes (Stay, Away, Night, Disarm)
- Contact and motion sensor support for zones
- Optional bypass switches for individual zones
- Custom automation switches for bypass-and-arm sequences
- Detailed emoji-enhanced logging for all state changes
- Graceful shutdown handling
- Reconnection tracking and monitoring
- Full TypeScript implementation with ESM modules
- Config schema for Homebridge UI
- Comprehensive documentation
- Python script to retrieve device IDs

### Security
- Tokens stored securely in Homebridge storage directory
- Passwords never logged
- Automatic token refresh to prevent expiration

---

[2.0.0]: https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/releases/tag/v2.0.0
[1.0.6]: https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/releases/tag/v1.0.6
[1.0.5]: https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/releases/tag/v1.0.5
[1.0.4]: https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/releases/tag/v1.0.4
[1.0.2]: https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/releases/tag/v1.0.2