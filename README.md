# DSH Remote Host

**Pair an Android phone to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) over your LAN.**

DSH Remote is an installable plugin for a PC running `dsh web`, plus a separate Android APK. From the phone you open Host sessions, send turns, approve tool calls, and review artifacts — without exposing workspace paths.

It is **not** a fork of DeepSeek Harness and **not** an official DeepSeek product. Add the plugin to the stock `web` profile. The Android app is a separate download.

English | [中文](README.zh-CN.md)

This project acknowledges the [LINUX DO](https://linux.do) community.

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-acknowledged-6A8DFF?style=flat-square)](https://linux.do)

<p>
  <img src="docs/phone/sessions.png" width="220" alt="DSH Remote Android session list, grouped by Host project">
  <img src="docs/phone/chat.png" width="220" alt="DSH Remote Android chat with usage, model, and agent preset">
  <img src="docs/phone/create.png" width="220" alt="Create a session on an existing Host workspace or a new folder">
</p>
<p>
  <img src="docs/phone/hosts.png" width="220" alt="Paired Host status on the Android client">
  <img src="docs/phone/artifacts.png" width="220" alt="Host artifacts list on the Android client">
</p>

<p><sub>Real vivo phone, paired over LAN. Host name and LAN address redacted.</sub></p>

## What you get

1. **This plugin** — `@w2112515/dsh-remote-host` on [npm](https://www.npmjs.com/package/@w2112515/dsh-remote-host) or GitHub. Host carrier, Noise pairing, LAN discovery, **Settings → Mobile access**.
2. **One Android APK** from [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases). That repository is the phone client, not a DSH plugin.

## What the phone can do

| On the phone | What actually happens |
| --- | --- |
| Session list | Host directory, grouped by project / workspace **label**. Blank Host sessions stay hidden until this device creates one or the first turn lands. |
| Chat / trajectory / export | Live projection of the open session: messages, tools, usage when the Host serves it, model and agent preset. |
| New session | Bind to an existing Host workspace, or ask the Host to create a folder under an allowed parent. The phone never `mkdir`s and never sees a full path. |
| Approvals | Pending tool approvals for the paired Host. |
| Artifacts | Host-projected file outputs, with a local “reviewed” marker on this device. |
| Hosts | Pair another PC, see online / idle, unpair. |

Pairing is Noise (`XXpsk3` / `IK`): scan the Host QR, confirm the eight-digit code on the PC. LAN advertisement stays **off** until you turn it on in Settings → Mobile access.

## Requirements

- DeepSeek Harness `dsh web` on **Windows x64** (the reviewed Host security platform).
- Same Wi-Fi / LAN as the phone. There is no public relay or tunnel in this release.
- Android phone that can sideload a **debug** APK (`dev.dshremote.gate0c`).

Linux and macOS still show the Mobile access settings page and skip the carrier. iOS is not available.

## Install the Host plugin

Prebuilt npm package, no install scripts:

```powershell
dsh plugin --profile web add @w2112515/dsh-remote-host
dsh --profile web --dump-config
```

Confirm the dump includes `host-remote-control`, `host-remote-command`, `host-remote`, and `ui-settings-remote`. Restart `dsh web`.

Then open **Settings → Mobile access** (not Settings → Plugins). Turn on nearby discovery.

Install via npm today. Community marketplace catalogs may list this plugin after their scanner admits `w2112515/dsh-remote-host`; do not wait on that to use it.

## Then install the APK

1. Download the latest APK from [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases).
2. Sideload it on the phone.
3. Join the same Wi-Fi, scan the Host QR, confirm the eight-digit code on the PC.

## Remove

```powershell
dsh plugin --profile web remove @w2112515/dsh-remote-host
```

The Host identity file `remote-host-security.bin` under DSH home is not deleted automatically.

## FAQ

**What is DSH Remote?**
A LAN remote for DeepSeek Harness: this Host plugin plus the Android APK. The phone talks to the same `dsh web` process on the Remote port, not to the Web UI port.

**Is it official?**
No. It is a third-party plugin for the stock `web` profile.

**Will the phone see my disk paths?**
No. The wire carries workspace ids and labels, session titles, and folder names you type. Absolute paths stay on the Host.

**Can I use it off my home Wi-Fi?**
Not in this release. Same LAN only. A relay / tunnel is future work.

**Why two downloads?**
The phone client is an Android app, not a DSH plugin. Install this Host plugin, then sideload the APK.

**I created a session on the phone and it vanished from the list.**
Current Android builds keep a local row for a session this device just created. Update the APK if you still have to force-quit to see it.

## Related

| Piece | Repository |
| --- | --- |
| Host plugin (this repo) | https://github.com/w2112515/dsh-remote-host |
| Android APK | https://github.com/w2112515/dsh-remote-android |
| DeepSeek Harness | https://github.com/deepseek-ai/deepseek-harness |
| LINUX DO | https://linux.do |

Machine-readable summary: [llms.txt](llms.txt).

## License

MIT. The Windows security prebuild under `native/win32-x64/` is MIT OR Apache-2.0.
