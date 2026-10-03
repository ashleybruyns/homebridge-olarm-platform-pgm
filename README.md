# Homebridge Olarm Platform (Gates & PGM)

A Homebridge plugin for Olarm security systems, using the official Olarm API: real-time MQTT updates, automatic zone discovery, and gate control through PGM outputs.

Published on npm as **`homebridge-olarm-platform-pgm`**. It is a fork of [homebridge-olarm-platform](https://github.com/vangogh27/homebridge-olarm-platform) by Louis Germishuys.

## Features

- **Real-time MQTT Updates** - Instant state changes via Olarm's official public MQTT feed
- **Automatic Zone Discovery** - Automatically creates sensors for all configured zones
- **Zone Bypass Support** - Optional switches to bypass individual zones
- **Automation Switches** - Create custom bypass-and-arm sequences
- **Gates** - Combine a zone and a PGM into a HomeKit Garage Door for gates
- **Single API Key** - Uses the Olarm public API; no account password needed
- **API Fallback** - Automatic polling when MQTT unavailable
- **Detailed Logging** - Emoji-enhanced logs for all state changes

## Installation

### Via Homebridge UI (Recommended)

1. Search for `homebridge-olarm-platform-pgm` in the Homebridge UI plugin search (listed as "Olarm Security System (Gates & PGM)")
2. Click **Install**
3. Configure the plugin using the settings UI

### Via Command Line

```bash
npm install -g homebridge-olarm-platform-pgm
```

### Switching from homebridge-olarm-platform

Both plugins register the same `Olarm` platform, so only one can be installed at a time:

1. Note your device ID, and get an API key (see [Getting Your API Key](#getting-your-api-key))
2. Uninstall `homebridge-olarm-platform`
3. Install `homebridge-olarm-platform-pgm`
4. Your existing `Olarm` config block is reused. Add `apiKey` and remove `primaryAuth` (see [Upgrading from email/password login](#upgrading-from-emailpassword-login))
5. Restart Homebridge

The accessories are registered again under the new plugin. Check their rooms and any HomeKit automations afterwards, as these may need setting up again.

## Configuration

### Minimum Configuration

```json
{
  "platforms": [
    {
      "platform": "Olarm",
      "name": "Olarm",
      "deviceId": "YOUR_DEVICE_ID",
      "apiKey": "YOUR_API_KEY"
    }
  ]
}
```

### Full Configuration

```json
{
  "platforms": [
    {
      "platform": "Olarm",
      "name": "Olarm",
      "deviceId": "YOUR_DEVICE_ID",
      "deviceName": "Home Security",
      "apiKey": "YOUR_API_KEY",
      "mqttClientIdSuffix": "8",
      "includedZones": [1, 2, 3, 4, 5],
      "addBypassSwitches": true,
      "pollingInterval": 300,
      "automations": [
        {
          "id": "sleep-mode",
          "name": "Sleep Mode",
          "zones": [3, 4],
          "armMode": "sleep"
        },
        {
          "id": "away-mode",
          "name": "Away with Garage Open",
          "zones": [5],
          "armMode": "arm"
        }
      ],
      "gates": [
        {
          "id": "driveway-gate",
          "name": "Driveway Gate",
          "zone": 6,
          "pgm": 1,
          "operationTime": 20
        }
      ]
    }
  ]
}
```

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `platform` | string | ✅ | Must be `Olarm` |
| `name` | string | ✅ | Platform name for Homebridge |
| `deviceId` | string | ✅ | Your Olarm device ID |
| `deviceName` | string | ❌ | Display name for security system (default: "Olarm Security") |
| `apiKey` | string | ✅ | Olarm API key (see [Getting Your API Key](#getting-your-api-key)) |
| `mqttClientIdSuffix` | string | ❌ | Suffix for the MQTT client ID (default: `8`). Must differ from any other Olarm integration using the same account, e.g. Home Assistant |
| `includedZones` | array | ❌ | Zone numbers to include (empty = all zones) |
| `addBypassSwitches` | boolean | ❌ | Add bypass switches for each zone (default: false) |
| `pollingInterval` | number | ❌ | Seconds between API polls while MQTT is down (default: 300) |
| `automations` | array | ❌ | Custom automation switches (see below) |
| `gates` | array | ❌ | Gates built from a zone + PGM (see below) |

### Automation Configuration

Each automation creates a stateless switch that bypasses specific zones and then arms the system:

```json
{
  "id": "unique-identifier",
  "name": "Display Name",
  "zones": [1, 2, 3],
  "armMode": "arm"
}
```

- `id`: Unique identifier (optional, auto-generated if omitted)
- `name`: Name shown in HomeKit
- `zones`: Array of zone numbers to bypass before arming
- `armMode`: `arm` (Away), `stay` (Stay), or `sleep` (Night)

### Gate Configuration

Each gate is exposed to HomeKit as a Garage Door accessory, combining a zone (for open/closed state) with a PGM (to trigger the gate motor):

```json
{
  "id": "unique-identifier",
  "name": "Driveway Gate",
  "zone": 6,
  "pgm": 1,
  "operationTime": 20
}
```

- `id`: Unique identifier (optional; defaults to the zone and PGM numbers)
- `name`: Name shown in HomeKit
- `zone`: Olarm zone number whose sensor is closed only when the gate is fully closed
- `pgm`: Olarm PGM number that is pulsed to trigger the gate motor. It must be enabled and allow pulse control on the panel; the plugin checks this and refuses to use any other PGM
- `operationTime`: Seconds the gate takes to fully open/close (default: 20). Further open/close requests are blocked for this long after each pulse

This assumes the PGM is wired to the gate motor the way a remote button typically is: a single pulse toggles the gate, and a pulse while it is moving stops or reverses it. Because the PGM holds no state, the zone is the only source of truth, and the plugin pulses the PGM only when all of these hold:

- The zone reads exactly closed (`c`) or open (`a`). While it is bypassed (`b`) or reports anything else, the gate's position is unknown and control is disabled.
- The reading is recent (under 90 seconds old) and the panel is not offline. If not, the plugin fetches a fresh reading from the API first. The MQTT feed only sends changes, so after a quiet spell this costs one quick API request.
- No movement is in progress, including an opening started from a remote or keypad (detected when the zone goes from closed to open). Repeating the same request (a double tap, or a scene running again) is ignored; the opposite request is refused until `operationTime` has passed.
- The PGM is enabled and allows pulse control (from the panel profile's `pgmControl` settings).
- The requested state differs from the zone's current state.

Otherwise the request is refused and the Home app shows "No Response", rather than the gate moving unexpectedly. If sending a pulse fails or times out, requests are still blocked for `operationTime`, since the pulse may have reached the panel.

## Getting Your Device ID

The quickest way: set `deviceId` to any value and start Homebridge. If it doesn't match, the log lists every device your API key can access, with its ID.

Alternatively, run the included script, which only needs Python 3:

```bash
python3 scripts/get_device_id.py
```

Or call the API directly:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" "https://api.olarm.com/api/v4/devices"
```

Only devices with API access enabled in the Olarm user portal are returned.

## Getting Your API Key

1. Log into the [Olarm user portal](https://user.olarm.com/)
2. Go to **API access** (https://user.olarm.com/#/api)
3. Generate a new API key, and make sure API access is enabled for your device
4. Add it to `apiKey` in the config

## How It Works

The plugin uses the [Olarm public API](https://user.olarm.com/#/api/documentation) with your API key:

### Real-time Updates

- Connects to Olarm's official MQTT feed over WebSockets (`mqtt-pubapi.olarm.com`), the same feed used by Olarm's own [client library](https://github.com/olarmtech/olarmflowclient-python) and Home Assistant integration
- Subscribes to your device; state changes arrive instantly
- Reconnects automatically, backing off if the broker keeps refusing the connection

### State and Commands

- The full device state is read from the REST API (`https://api.olarm.com/api/v4`) at startup and after every MQTT reconnect, since the feed only sends changes
- Arm/disarm, zone bypass and PGM commands are sent through the REST API

### Fallback Polling

If the MQTT connection is down:
- The plugin polls the REST API every `pollingInterval` seconds
- Polling stops again once MQTT reconnects

## Accessories Created

### Security System

Main security panel with states:
- **Disarmed**
- **Armed Stay**
- **Armed Away**
- **Armed Night**
- **Alarm Triggered**

### Zone Sensors

Automatically created for each zone:
- **Contact Sensors** - For doors, windows, etc.
- **Motion Sensors** - For zones with "PIR" or "motion" in name
- Shows bypassed state via StatusActive

### Bypass Switches (Optional)

When `addBypassSwitches: true`:
- Individual switches for each zone
- Turn on to bypass zone
- Turn off to unbypass zone

### Automation Switches

Stateless switches that execute sequences:
1. Bypass specified zones (with delays)
2. Wait 1 second
3. Arm system in specified mode
4. Switch returns to off

### Gates (Optional)

Created from the `gates` config array, one Garage Door accessory per entry:
- **Current state** - Reflects the configured zone (open/closed); "Stopped" while the position is unknown
- **Target state** - Setting it in the Home app pulses the configured PGM, subject to the safety checks above
- Shows "Opening" until `operationTime` has passed, and "Closing" until the zone confirms closed
- Reports "Stopped" if the zone doesn't confirm the new state within `operationTime`

## Logging

The plugin provides detailed, emoji-enhanced logging:

```
🔒 Area 1: Disarmed → Armed Away
🚪 Front Door: Closed → Active (Open)
🚶 Lounge PIR: Closed → Active (Open)
⏭️ Garage Door: Closed → Bypassed
⚡ PGM 1: Activated
🟢 AC Power: OK
🔴 Battery Low: FAULT
```

### Debug Logging

Turn on Homebridge debug mode (`-D`, or **Homebridge Debug Mode** in the Homebridge UI settings) to also log:
- The MQTT client ID and topic used, and the fields in each MQTT message
- The panel's `deviceStatus` and PGM settings (`pgmControl`) read at startup, and `deviceStatus` on every API read
- Every command sent to Olarm and the HTTP status it returned
- For each gate: every zone reading, the reasoning behind each open/close request (reading, its age, panel status, movement lock), and when the movement lock is released

## Troubleshooting

### Plugin won't start

- Check `apiKey` is set and still active in the Olarm user portal
- Verify `deviceId` matches your Olarm device; the log lists the available devices if it doesn't
- Check Homebridge logs for error messages

### Upgrading from email/password login

Earlier versions logged in with your Olarm email and password. These are no longer used:
- Move the API key from `fallbackAuth.apiKey` to `apiKey` (the old location still works, with a warning)
- Remove `primaryAuth`
- The old token cache file `olarm_tokens.json` in the Homebridge storage folder can be deleted

### MQTT won't connect or keeps disconnecting

- Check the API key is valid
- If another Olarm integration (such as Home Assistant) uses the same account, give this plugin a different `mqttClientIdSuffix`. Two connections with the same client ID keep disconnecting each other
- Check network stability; the plugin logs how many times it disconnected in the last hour
- Fallback polling activates automatically while MQTT is down

### Zones not appearing

- Check zone has a name in Olarm app
- Verify zone number if using `includedZones`
- Check Homebridge logs for "Device profile exists" messages

### Bypass not working

- Check API key is valid in Olarm portal
- Verify zone number is correct

### Gate refuses to operate

- Check the log for the reason: an unknown or out-of-date zone reading, a movement still in progress, or a PGM that isn't enabled for pulse control
- In the Olarm app, check the gate's PGM is enabled and set up for pulse control

## Development

### Setup

```bash
git clone https://github.com/ashleybruyns/homebridge-olarm-platform-pgm.git
cd homebridge-olarm-platform-pgm
npm install
npm run build
```

### Watch Mode

```bash
npm run watch
```

This will:
- Compile TypeScript on file changes
- Link plugin globally
- Restart Homebridge automatically

### Testing

```bash
npm run lint
npm run build
```

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint` and `npm run build`
5. Submit a pull request

## Support

- **Issues**: [GitHub Issues](https://github.com/ashleybruyns/homebridge-olarm-platform-pgm/issues)

## License

Apache-2.0 License - see [LICENSE](LICENSE) file for details.

## Credits

- Forked from [homebridge-olarm-platform](https://github.com/vangogh27/homebridge-olarm-platform), created by Louis Germishuys
- Built with [Homebridge Plugin Template](https://github.com/homebridge/homebridge-plugin-template)
- Uses Olarm's public API and official MQTT feed for real-time updates

## Disclaimer

This plugin is not affiliated with or endorsed by Olarm. Use at your own risk.