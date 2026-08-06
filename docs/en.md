# Roborock

Control the robot vacuums of your Roborock account from Gladys Assistant.

This integration targets robots **paired in the Roborock app**. It talks to them
**directly over your local network**, with an automatic fallback to the Roborock
cloud when a robot is not reachable.

> If your robot is paired in the **Xiaomi Home (Mi Home)** app, it answers on an
> entirely different service: the **Xiaomi Home** integration is the one you need.
> Both can be installed at once if you use both apps.

## Features

For every robot of your account:

- **State** — the operational state of the robot (cleaning, paused, returning to
  the dock, charging, docked, error…).
- **Run mode** — start or stop a cleaning cycle.
- **Clean mode** — the suction level (silent, balanced, turbo, max, gentle).
- **Dock** — send the robot back to its charging dock.
- **Battery** — the current battery level, in percent.

## Configuration

Two fields, no button:

1. Fill in the **email of your Roborock account** and save. Roborock sends you a
   code.
2. Fill in that **code** and save again. The account is linked.

Clearing the email unlinks the account. The code is single-use and disappears
from the form once it has served.

Then open the **Discovery** screen and start a scan: your robots appear and can be
added to Gladys.

> **No password is ever asked for**, deliberately: many Roborock accounts have
> none at all (registered with a code, or through Google/Apple), and those that do
> may be guarded by two-step validation — the password is then accepted and
> refused for want of a second factor. The code covers every case.

There is **nothing else to configure**: the region, your robots, their local keys
and their IP addresses are all discovered automatically.

## How it works

The integration discovers your robots through the Roborock cloud, along with their
local encryption key and IP address. Commands and state readings then go through
the **local network** first (TCP), falling back to the cloud (MQTT) when a robot
is unreachable. The transport in use is shown as a badge on the device.

## Limitations

- The **device layer** (MQTT and local TCP transports, commands) has never been
  exercised against a real robot on a Roborock account. The authentication, on the
  other hand, is verified end to end against the live cloud. If that is your
  setup, your feedback and debug logs are very welcome.
- Only the Roborock "1.0" protocol family is supported. Recent ranges using a
  different encryption (Dyad, Zeo) are not covered.
- Suction-level codes vary across model generations. If your model behaves
  differently, open an issue with the `fan_power` value visible in the debug logs.
