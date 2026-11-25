# homebridge-sense-matter

Sense Energy Monitor exposed to Apple Home over **Matter**.

Live watts, voltage, current, and cumulative energy appear directly in the Home app’s **Energy** view (iOS 27+). No Eve app required.

## Requirements

- Homebridge **2.2.0+** with Matter enabled on the bridge
- Node.js 20.18+
- Sense account (email + password; MFA supported)

## Install

```bash
npm install -g homebridge-sense-matter
```

## Configuration

Add the **Sense Matter** platform in the Homebridge UI (or manually):

```json
{
  "platforms": [
    {
      "platform": "SenseMatter",
      "username": "you@example.com",
      "password": "your-sense-password",
      "mfaType": "Disabled",
      "mfaSecret": "",
      "monitorId": "",
      "pollingInterval": 30,
      "deviceType": "sensor"
    }
  ]
}
```

- Enable **Matter** on the bridge (child bridge recommended).
- Restart Homebridge and pair using the Matter QR code shown in the UI.
- **deviceType**:
  - `"sensor"` (default) — ElectricalSensor. No room tile. Appears in the Energy / Electricity section (All Home / Power list).
  - `"outlet"` — OnOffOutlet. Gets a room tile that shows live watts. Energy data still appears in the Energy view. (You can later use Home app “Show As” if you want a different icon.)

Detailed per-device usage graphs (total kWh, day/week/month charts, Cleaner/Less Clean) appear when you open Energy → Usages and select the Sense Energy device. This works for both types. Whole-home contribution is always counted.

## MFA / TOTP Setup

If your Sense account has two-factor authentication enabled:

1. In the plugin config, set **Multi-Factor Authentication** to **TOTP**.
2. You need the **base32 secret** that was shown when you originally set up the authenticator app.

### How to get the base32 secret

Sense (and most TOTP setups) shows a secret key during initial MFA enrollment. If you still have it, use that.

If you no longer have the original secret:

1. Log in to the Sense app or web portal.
2. Go to account / security settings and **disable** then **re-enable** MFA / two-factor authentication.
3. During setup, Sense will show a QR code and usually also a manual entry key (a base32 string like `JBSWY3DPEHPK3PXP`).
4. Copy that key and paste it into the plugin’s **MFA Secret (base32)** field.
5. Complete the MFA setup in your authenticator app as normal.

The plugin uses that secret to generate the current TOTP code automatically.

## What you get

- Whole-home power (W)
- Voltage and current
- Cumulative imported energy (Wh) that accumulates while the plugin is running
- Realtime updates via Sense WebSocket + fallback polling
- Energy value persisted across Homebridge restarts

## Notes

- Cumulative energy is tracked locally (Sense does not expose a persistent lifetime counter over the realtime API). It is persisted to disk so it survives restarts.
- Energy cluster updates are throttled to roughly once per minute (power updates remain frequent). This prevents Matter subscription failures.
- Icon: the plugin ships with the orange house + lightning icon.
- After changing `deviceType`, remove the accessory from Home and re-pair the bridge.

## Credits

Sense API / WebSocket / auth logic adapted from [homebridge-sense-energy-monitor](https://github.com/seeloesix/homebridge-sense-energy-monitor).
