# Gladys Roborock integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls **Roborock robot vacuums** paired in the **Xiaomi Home** app, over the
local network (miIO) with a Xiaomi cloud fallback.

Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## What it does

- **Links the Xiaomi account once, with a QR login.** The user clicks
  _Link the Xiaomi account_, opens the returned link (or scans it with the
  Xiaomi Home app) and approves the sign-in. No password is ever typed into
  Gladys, and Xiaomi's captcha / identity-verification steps never come up.
- **Reconnects silently afterwards.** The long-lived `passToken` returned by the
  QR login is persisted in the integration config, so every later start
  re-authenticates with no interaction at all — which is what makes this work
  unattended in a container.
- **Discovers the robots** of the account with their miIO local key and LAN IP,
  and publishes them as **discovered devices**: the user creates them from the
  Gladys Discovery screen.
- **Talks to each robot over the LAN** with the miIO protocol (encrypted UDP on
  port 54321) and falls back to a Xiaomi cloud RPC when the robot is not
  reachable locally. The transport in use is shown as a badge on the device.

Each **robot** exposes these features:

| Feature    | Category / type                 | Mapping                                            |
| ---------- | ------------------------------- | -------------------------------------------------- |
| State      | `vacuum-cleaner` / `state`      | miIO `state` → Gladys state (read-only)            |
| Run mode   | `vacuum-cleaner` / `run-mode`   | Idle / Clean → `app_stop` / `app_start`            |
| Clean mode | `vacuum-cleaner` / `clean-mode` | miIO `fan_power` ↔ Gladys clean mode (table below) |
| Dock       | `vacuum-cleaner` / `dock`       | "Go home" (value 1) → `app_charge`                 |
| Battery    | `battery` / `integer`           | miIO `battery` (%), read-only, history kept        |

### Fan power ↔ clean mode

Gladys exposes a fixed list of clean modes; Roborock exposes suction levels.
The five levels below are **verified on real hardware** (Roborock S6, firmware
`3.5.8_2700`):

| Roborock level | Code | Gladys clean mode |
| -------------- | ---- | ----------------- |
| Silent         | 101  | Quiet             |
| Balanced       | 102  | Auto              |
| Turbo          | 103  | Deep Clean        |
| Max            | 104  | Vacuum            |
| Gentle         | 105  | Low Noise         |

Code `106` ("auto") is **silently ignored** by the S6 — it falls back to 102 —
so it is never written; it is only accepted on read, as an alias of _Auto_, for
the models that report it. The Gladys _Quick_ and _Mop_ clean modes have no
Roborock equivalent and are rejected with an explicit error rather than doing
nothing.

## Configuration

1. Install the integration.
2. Click **Link the Xiaomi account**, open the returned link and approve the
   sign-in (or scan it with the Xiaomi Home app), then click
   **Check the connection**.
3. Open the **Discovery** screen and start a scan.

There is **nothing to configure**: the server region, the robots, their miIO
local keys and their IP addresses are all discovered automatically, and the
working region is remembered so a restart does not probe them again.

## Development

```bash
npm install
npm test          # node:test unit tests + an end-to-end test
npm run lint      # ESLint
npm run format    # Prettier
```

The end-to-end test (`test/e2e.test.js`) boots the real `index.js` against a
fake Gladys host (WebSocket + REST), a fake Xiaomi cloud and a fake miIO device
(UDP), and exercises the silent `passToken` login, discovery, polling and
commands.

## Protocol notes (learned the hard way, verified against the live API)

- The login `nonce` is a **19-digit integer**: `JSON.parse` silently rounds it,
  which breaks the `clientSign` and yields no `serviceToken` — Xiaomi answers
  `ok` with no cookie and no error. It is read as a raw string from the response
  text. The e2e test asserts this by validating the `clientSign` server-side.
- The persisted `deviceId` must stay **stable** across restarts: it carries the
  device trust that keeps Xiaomi from re-triggering a verification.
- A miIO request whose `id` the robot has recently seen is **silently ignored**
  (verified: after a previous session, `id=2` got no reply while `id=100` did),
  so the request-id counter is seeded from the clock instead of restarting at 1.
- The Xiaomi **password** login is gated behind a captcha and an
  identity-verification step; it is not usable from a headless container, which
  is why the QR login is the only supported way to link an account.
- Xiaomi's official **OAuth2** flow is not an option for third parties: its
  `client_id` is locked to Home Assistant's redirect URI and its license
  restricts it to Home Assistant.

## Limitations

- Only the miIO protocol family is implemented (the vast majority of Roborock
  vacuums paired in Xiaomi Home). Robots on a **Roborock** account rather than a
  Xiaomi one are not supported.
- Suction-level codes vary across model generations; the table above targets the
  modern codes. If your model reports different values, open an issue with the
  `fan_power` seen in the debug logs.

## License

Apache-2.0
