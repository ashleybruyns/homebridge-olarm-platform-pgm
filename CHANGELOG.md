# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.6]: https://github.com/vangogh27/homebridge-olarm-platform/releases/tag/v1.0.6
[1.0.5]: https://github.com/vangogh27/homebridge-olarm-platform/releases/tag/v1.0.5
[1.0.4]: https://github.com/vangogh27/homebridge-olarm-platform/releases/tag/v1.0.4
[1.0.2]: https://github.com/vangogh27/homebridge-olarm-platform/releases/tag/v1.0.2