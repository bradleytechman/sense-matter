# homebridge-sense-matter

Sense Energy Monitor exposed to Apple Home over **Matter**.

Live watts, voltage, current, and cumulative energy appear directly in the Home app’s **Energy** view (iOS 27+). No Eve app required.

## Requirements

- Homebridge **2.2.0+** with Matter enabled on the bridge
- Node.js 20.18+
- Sense account (email + password; MFA supported)

## Install

From GitHub (recommended while this is new):

```bash
npm install -g github:bradleytechman/sense-matter
```

Or clone, build, and install:

```bash
git clone https://github.com/bradleytechman/sense-matter.git
cd sense-matter
npm install
npm run build
# then in Homebridge UI search for the local path or publish yourself
```

## Configuration

```json
{
  "platforms": [
    {
      "platform": "SenseMatter",
      "name": "Sense Matter",
      "username": "you@example.com",
      "password": "your-sense-password",
      "mfaEnabled": false,
      "mfaSecret": "",
      "monitorId": "",
      "pollingInterval": 30
    }
  ]
}
```

- Enable **Matter** on the bridge (child bridge recommended).
- Restart Homebridge and pair using the Matter QR code shown in the UI.
- In the Home app the accessory appears as an outlet. Live wattage shows on the tile (iOS 27+); energy history is under the Energy view.

## What you get

- Whole-home power (W)
- Voltage and current
- Cumulative imported energy (Wh) that accumulates while the plugin is running
- Realtime updates via Sense WebSocket + fallback polling

## Notes

- Cumulative energy is tracked locally from the moment the plugin starts (Sense does not expose a persistent lifetime counter over the realtime API).
- MFA: enable `mfaEnabled` and provide the base32 `mfaSecret` if your Sense account uses TOTP.
- Icon: the plugin ships with the orange house + lightning icon you provided.

## Credits

Sense API / WebSocket / auth logic adapted from [homebridge-sense-energy-monitor](https://github.com/seeloesix/homebridge-sense-energy-monitor).
