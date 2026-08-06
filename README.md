# Gladys Roborock integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls the **robot vacuums of a Roborock app account**, over the local network
with a cloud fallback.

Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> The same hardware is sold behind two clouds, and which one a robot answers on
> depends only on the app it was paired with. A robot paired in the **Xiaomi Home**
> app is served by its own integration,
> [gladys-xiaomi-home](https://github.com/callemand/gladys-xiaomi-home). A
> household using both apps installs both integrations.

## What it does

- **Links the account with a code, never a password.** Saving the email address
  asks Roborock to send a code; saving that code links the account. No password
  is involved, deliberately: many accounts have none at all (registered with a
  code, or through Google/Apple), and those that do may be guarded by two-step
  validation, where the password is accepted and then refused for want of a
  second factor. One path covers every account.
- **Reconnects silently afterwards.** The long-lived `passToken` returned by the
  QR login is persisted in the integration config, so every later start
  re-authenticates with no interaction at all — which is what makes this work
  unattended in a container.
- **Discovers the robots** of the account with their local key and LAN IP,
  and publishes them as **discovered devices**: the user creates them from the
  Gladys Discovery screen.
- **Talks to each robot over the LAN** (Roborock protocol on TCP 58867) and falls
  back to a cloud RPC over MQTT when the robot is not reachable locally. The
  transport in use is shown as a badge on the device.

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

Two fields, and no button:

1. Fill in your **Roborock account email** and save — Roborock sends you a code.
2. Fill in that **code** and save again. The account is linked.

Clearing the email unlinks the account. The code is single-use and is cleared
from the form once it has served.

Then open the **Discovery** screen and start a scan.

There is **nothing else to configure**: the region, the robots, their local keys
and their IP addresses are all discovered automatically, and the working region
is remembered so a restart does not probe them again.

## Development

```bash
npm install
npm test          # node:test unit tests + an end-to-end test
npm run lint      # ESLint
npm run format    # Prettier
```

`test/e2eRoborock.test.js` boots the real `index.js` against a fake Gladys host
(WebSocket + REST), a fake Roborock cloud and an in-process MQTT broker standing
in for the robot. It exercises the code request, the link, the silent token
login, discovery, polling and commands — including the traps that cost the most
time: a used code must be cleared without asking for another one, and an account
with no robot must still count as linked.

## Protocol notes (learned the hard way, verified against the live API)

- **The region is found by attempting the login on each host.** The documented
  `getUrlByEmail` lookup is deprecated: it answers `200` echoing whichever host
  you queried, with `country: null`.
- **Two answers mean "this region does not host that account"** and must not stop
  the search: `2012 username or password error` and `2008 user not exist`.
  Anything else comes from the region that does host it — even a refusal — and
  must stop it. Both directions were bugs here: the loop once walked past `eu`'s
  `2031 need two-step validate` and let `ru`'s `2012` overwrite it, telling the
  user their password was wrong when it was right; then it stopped at `us`'s
  `2008` and never reached `eu` at all.
- **An API error must be detected from `code` alone.** Requiring a `data` key
  next to it swallowed any error answered without one, turning a precise
  "credentials refused" into a generic "login failed".
- **A code is single-use and short-lived** (`2018 email code error` on a code an
  hour old). It is cleared from the form once used — and clearing it must not
  trigger another request, or the user gets one email per round for ever.
- The IoT API (`rriot.r.a`) needs a **per-request Hawk signature**; the account
  endpoints use the raw token as `Authorization`.
- Only the Roborock **"1.0" protocol family** is implemented. Recent ranges using
  a different encryption (Dyad, Zeo) are not covered.

## Limitations

- The **device layer** (MQTT and local TCP transports, RPC commands) is covered
  by unit and end-to-end tests against fakes, but has **never been exercised
  against a real robot on a Roborock account**. The authentication chain, on the
  other hand, is verified end to end against the live cloud: region discovery,
  `sendEmailCode`, `loginWithCode`, the home id, and the Hawk-signed home data.
- Only the Roborock "1.0" protocol family is implemented.
- Suction-level codes vary across model generations; the table above targets the
  modern codes. If your model reports different values, open an issue with the
  `fan_power` seen in the debug logs.

## License

Apache-2.0
