# DSH Remote Host

Installable DeepSeek Harness plugin that turns a Windows PC running `dsh web` into a phone-controlled Host.

This is **not** a fork of DeepSeek Harness. Add it to the stock `web` profile. The Android app is a separate download — a marketplace pack cannot install an APK.

English | [中文](README.zh-CN.md)

## What you get

1. **This plugin** (npm, GitHub, or the [DSH Remote pack](https://github.com/w2112515/dsh-remote-pack)) — Host carrier, pairing, LAN discovery, Settings → Mobile access.
2. **One Android APK** from [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases) — the phone client.

Pairing uses Noise (`XXpsk3` / `IK`). LAN advertisement stays off until you enable it in Settings → Mobile access. Paths never leave the Host; the phone only sees workspace labels and folder names.

Windows x64 is the reviewed Host security platform. Linux and macOS keep the Settings page and skip the carrier.

## Install the Host plugin

From npm (prebuilt, no install scripts):

```powershell
dsh plugin --profile web add @w2112515/dsh-remote-host
dsh --profile web --dump-config
```

Restart `dsh web`. Then open **Settings → Mobile access**, turn on nearby discovery, and pair the phone.

Marketplace one-click and the solution pack install the same package from the pinned GitHub commit (`lib/` is committed).

## Then install the APK

Download the latest APK from [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases). Install it on the phone, join the same Wi-Fi, scan the Host QR, confirm the eight-digit code on the PC.

## Remove

```powershell
dsh plugin --profile web remove @w2112515/dsh-remote-host
```

The Host identity file `remote-host-security.bin` under DSH home is not deleted automatically.

## License

MIT. The Windows security prebuild under `native/win32-x64/` is MIT OR Apache-2.0.
