# @w2112515/dsh-remote-host

One DSH bundle for Remote. Pair an Android phone to DeepSeek Harness over LAN or a public Host IPv4.

Android is a **separate signed APK** (use **0.2.0** with this Host **0.2.2**): [dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases).

The PC already runs official `dsh` web on loopback. This plugin adds the phone path. Do not put DSH web on a public hostname.

**Authorization:** the phone 策略 tab shows Host session policy. This bundle does **not** claim per-tap phone approval on npm `dsh` 0.1.1-rc.2.

## Install (Linux x64)

Needs official `dsh` 0.1.1-rc.2+ and Node.

```sh
git clone --branch v0.2.2 https://github.com/w2112515/dsh-remote-host.git
cd dsh-remote-host
sh scripts/setup.sh --bind YOUR_PUBLIC_IP    # same LAN only: omit --bind
sh scripts/start.sh
node scripts/invite.mjs
```

`setup` installs deps, links this package into the DSH profile, writes `$DSH_HOME/remote-host.env`, and checks dump-config. `start` boots loopback web (`127.0.0.1:3180`) plus the projection port (default 50051). `invite` prints a `dsh-remote://` URI and a terminal QR; type the eight-digit code to confirm.

Sideload the APK, scan or paste the URI.

Never pass `--bind 0.0.0.0`. Home machines bind a unicast IPv4 or stay on LAN.

Windows: `.\scripts\setup.ps1 --bind YOUR_PUBLIC_IP` then `.\scripts\start.ps1`. This release has no Windows iroh binary; LAN or a public IPv4 bind still works.

## Pairing notes

Run `invite` **on the Host** (SSH into the machine is enough). The phone talks to the advertised IPv4 after pairing; it does not keep SSH open.

Want the browser Settings page from another computer?

```sh
ssh -L 3180:127.0.0.1:3180 HOST
```

Then `http://127.0.0.1:3180` → **Settings → Mobile access**. Nearby discovery is off (`lanDiscovery: false`) and is LAN-only even when enabled.

## Backup

Copy `$DSH_HOME/remote-host-security.bin` (created on first start). Losing it means every phone must pair again.

## Optional: `dsh plugin add`

Only if `pnpm` is on PATH:

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
# or, after npm publish: dsh plugin --profile web add @w2112515/dsh-remote-host
```

Still run `sh scripts/setup.sh --skip-npm --bind YOUR_PUBLIC_IP` so natives and the env file exist, then `sh scripts/start.sh`.

VPS: see `contrib/dsh-remote-host.service`.

## Not in 0.2.2

Firebase push. Cellular-only acceptance. Per-tap phone approval on stock 0.1.1-rc.2. Marketplace pack. macOS natives. Windows iroh. Public DSH web. New Android APK (0.2.0 is current).
