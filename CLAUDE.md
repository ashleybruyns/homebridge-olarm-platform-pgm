# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Homebridge dynamic-platform plugin (npm package `homebridge-olarm-platform-pgm`, a fork of `vangogh27/homebridge-olarm-platform`; platform alias `Olarm`, shared with the original so both can't be installed together) that exposes an Olarm alarm panel to HomeKit. TypeScript, ESM (`"type": "module"`), so relative imports must use the `.js` extension (e.g. `import { X } from './settings.js'`).

## Commands

```bash
npm run build   # rimraf dist && tsc  (src/ -> dist/)
npm run lint    # eslint with --max-warnings=0 (warnings fail CI)
npm run watch   # build, npm link, then nodemon: recompiles on src/*.ts changes and runs `homebridge -U ./test/hbConfig -D`
```

There is no test suite; "testing" is `npm run lint && npm run build` (also what CI runs, and `prepublishOnly`). For a live run, `test/hbConfig/` is the Homebridge storage dir used by `npm run watch` — it needs a `config.json` with an `Olarm` platform block; that file, `persist/` and `accessories/` are gitignored.

Lint style (eslint.config.js): single quotes, 2-space indent, semicolons, trailing commas on multiline, `curly: all`, max line length 160.

## Architecture

Entry `src/index.ts` registers `OlarmPlatform` (`src/platform.ts`). Everything goes through the **Olarm public API** with a single `apiKey` (legacy `fallbackAuth.apiKey` is still read, with a deprecation warning; the old native-app email/password login was removed). Flow on `didFinishLaunching`:

1. `discoverDevices()` calls `controller.refreshState()` (REST `GET https://api.olarm.com/api/v4/devices/{deviceId}?deviceApiAccessOnly=1`) and builds accessories from it, with deterministic UUIDs: `deviceId` (security system), `${deviceId}-zone-${n}`, `${deviceId}-automation-${id||index}`, `${deviceId}-gate-${id || "z<zone>-p<pgm>"}`. Anything cached but not regenerated is unregistered as stale. Handlers live in `platform.accessoryHandlers`; `updateAllAccessoryStates()` fans state out to them (and is called once at the end of discovery). If the initial fetch fails, discovery retries every 60s.
2. `controller.start()` (`src/services/controller.ts`) calls `GET /devices` to get `userId` and confirm the device is accessible (logs the available devices if not), then connects to the **official public MQTT feed**, the same as Olarm's `olarmflowclient-python`: `wss://mqtt-pubapi.olarm.com:443/mqtt`, username `public-api-user-v1`, password = API key, clientId `<userId>-<mqttClientIdSuffix>` (default `8`; must be unique per account or connections kick each other off).
   - Subscribes to `v4/devices/<deviceId>`. Messages carry partial device data; `deviceState` replaces the state wholesale. The feed only pushes **changes**, so state is resynced over REST after every (re)subscribe, and gates fetch fresh state over REST before acting on a reading older than 90s.
   - The broker rejects bad credentials/client ids by just closing the socket (no CONNACK error), so consecutive closes without a `connect` back off exponentially (10s → 5 min). Explicit auth error codes end the client.
   - While MQTT is down it polls REST every `pollingInterval` seconds.
   - All commands are REST `POST /devices/{deviceId}/actions` `{actionCmd, actionNum}`: HomeKit modes map to `area-arm|area-stay|area-sleep|area-disarm` (area 1), plus `zone-bypass|zone-unbypass` and `pgm-pulse`.
   - `pulsePgm()` refuses unless `deviceProfile.pgmControl[pgm-1]` has `[0]==='1'` (enabled) and `[2]==='1'` (pulse allowed), and throws on failure (unlike `sendCommand`, which logs).
   - Exposes a single `stateUpdate` callback via `on()` (not a real EventEmitter — only one listener).

Reference sources for API behaviour: the Olarm API docs (https://user.olarm.com/#/api/documentation), `olarmtech/olarmflowclient-python` and `olarmtech/hacs-olarm`.

### Device state encoding

`DeviceState` arrays are positional (index 0 = area/zone/pgm 1):
- `areas[i]`: `disarm | notready | arm | stay | stayarm1-4 | sleep | alarm | emergency | fire | medical | countdown | entrydelay` (and part/custom arm modes) — only `areas[0]` drives the HomeKit SecuritySystem (area 1 hard-coded; commands use area 1).
- `zones[i]`: `a` active/open, `c` closed, `b` bypassed (the only values in Olarm's API docs).
- `pgms[i]`, `utility[i]` (AC, battery, tamper, phone line): `a` = active/fault. PGM/utility changes are logged; PGMs are driven (not read) by gate accessories.

### Accessories (`src/accessories/`)
- `securitySystem.ts` — maps HomeKit target states to `stay`/`arm`/`sleep`/`disarm` commands; `StatusFault` is set only when `deviceStatus === 'offline'` (the field isn't documented, so absence counts as online).
- `zoneSensor.ts` — MotionSensor if zone label contains "pir"/"motion", else ContactSensor; `StatusActive=false` when bypassed; optional `Bypass` switch subservice when `addBypassSwitches`.
- `automationSwitch.ts` — stateless switch: bypass listed zones (200ms apart), wait 1s, send `armMode`, reset to off.
- `gateAccessory.ts` — GarageDoorOpener per `gates[]` entry, pairing a `zone` (only source of truth for position: `c` closed, `a` open, anything else unknown) with a `pgm` pulsed via `controller.pulsePgm()` (throws on failure). The PGM is a stateless toggle, so it is safety-critical that it only pulses when the zone reading is known, fresh (<90s, panel not offline), the PGM allows pulsing, and the reading differs from the request, and no movement lockout (`movingTo`, held for `operationTime`, claimed before any await) is active; otherwise it throws `HapStatusError`. Preserve these guards when changing it.

Adding a new accessory type means extending the handler union types in `platform.ts` (`accessoryHandlers`, `getAccessoryHandler`) and dispatching in `updateAllAccessoryStates()`.

### Config
Config shape is `OlarmPlatformConfig` in `src/types.ts`; the Homebridge UI form is `config.schema.json`. Keep both (and the README options table) in sync when adding options. API hosts/MQTT constants and `PLUGIN_NAME` (must equal the package name; cached accessories are registered under it) are in `src/settings.ts`. `.npmignore` keeps local files such as `*.pdf` and `CLAUDE.md` out of the published package; check `npm pack --dry-run` before publishing. `scripts/get_device_id.py` is a standalone (stdlib-only) helper that lists devices for an API key.

Release notes go in `CHANGELOG.md` and `RELEASE_NOTES.md`; bump `version` in `package.json`.
