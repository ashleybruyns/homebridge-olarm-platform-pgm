#!/usr/bin/env python3
"""
Olarm Device ID Retriever

Lists the devices your Olarm API key can access, with the Device ID
needed for the Homebridge config, using the Olarm public API.

Usage:
    python3 get_device_id.py

Get an API key from the Olarm user portal (https://user.olarm.com) under API access.
Only devices with API access enabled are listed.
"""

import getpass
import json
import sys
import urllib.error
import urllib.request

API_BASE_URL = 'https://api.olarm.com/api/v4'


def main():
    print("=" * 60)
    print(" Olarm Device ID Retriever")
    print("=" * 60)

    api_key = getpass.getpass("\nEnter your Olarm API key: ").strip()
    if not api_key:
        print("❌ An API key is required.")
        sys.exit(1)

    request = urllib.request.Request(
        f'{API_BASE_URL}/devices?page=1&pageLength=100&deviceApiAccessOnly=1',
        headers={'Authorization': f'Bearer {api_key}'},
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')
        try:
            message = json.loads(body).get('message', body)
        except json.JSONDecodeError:
            message = body
        print(f"\n❌ HTTP {e.code}: {message}")
        if e.code in (401, 403):
            print("💡 Check the API key is correct and still active in the Olarm user portal.")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"\n❌ Could not reach the Olarm API: {e.reason}")
        sys.exit(1)

    devices = result.get('data', [])
    if not devices:
        print("\nNo devices found. Make sure API access is enabled for your device in the Olarm user portal.")
        sys.exit(1)

    print("\n" + "=" * 60)
    print(" YOUR OLARM DEVICES")
    print("=" * 60)
    for i, device in enumerate(devices, 1):
        print(f"\n📱 DEVICE #{i}: {device.get('deviceName', 'Unnamed Device')}")
        print(f"   Device ID:   {device.get('deviceId', 'N/A')}")

    print("\n" + "=" * 60)
    print("\n✅ Add the Device ID and your API key to your Homebridge config:")
    print('\n   "platforms": [')
    print('     {')
    print('       "platform": "Olarm",')
    print('       "name": "Olarm",')
    print(f'       "deviceId": "{devices[0].get("deviceId", "YOUR_DEVICE_ID")}",')
    print('       "apiKey": "YOUR_API_KEY"')
    print('     }')
    print('   ]')
    print("\nThen restart Homebridge.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
