# @w2112515/dsh-remote-host

One DSH bundle for Remote. Install it once. Cordis still loads five rows from this package because they inject different Host services.

Android is a **separate signed APK**: [dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases).

## What you get

- Noise gRPC projection (port from env, default 50051)
- Durable command journal and control leases
- Prompt and Stop admissions when stock `dsh` has none
- Host-local pairing (`Settings → Mobile access`, or `npm run invite`)
- Linux x64 iroh sidecar in `native/linux-x64/` (NAT). This release has no Windows iroh binary.

**Authorization:** the phone 策略 tab shows Host session policy. This bundle does **not** claim per-tap phone approval on npm `dsh` 0.1.1-rc.2. Writes follow Host policy.

**Computer vs phone:** the PC already runs official `dsh` web on loopback. This plugin adds the phone path. Do not put DSH web on a public hostname.

## Install (Linux x64)

Needs official `dsh` 0.1.1-rc.2+ and Node. `npm` is enough. `dsh plugin add` is a pnpm footnote at the bottom.

```sh
git clone --branch v0.2.1 https://github.com/w2112515/dsh-remote-host.git
cd dsh-remote-host
npm install --omit=dev
sh scripts/link-dsh-deps.sh    # nested @deepseek-ai + this package into $DSH_HOME/profiles/web
. scripts/env.sh               # from this directory
```

Public unicast IPv4 Host (never `0.0.0.0` on a home machine):

```sh
export DSH_REMOTE_BIND_ADDRESS=YOUR_PUBLIC_IP
export DSH_REMOTE_ADVERTISE_ADDRESS=YOUR_PUBLIC_IP
```

Check the composition, then boot web on loopback:

```sh
dsh --profile web --patch "$PWD/cordis.patch.yml" --dump-config
dsh --profile web --patch "$PWD/cordis.patch.yml" --host 127.0.0.1 --port 3180 --no-open
```

Dump-config must list `@w2112515/dsh-remote-host/admissions`, `control`, `command`, `remote`, and `settings`. It must not list Remote `file://` rows.

`scripts/env.sh` must be sourced from the package root (`. scripts/env.sh`). It points `DSH_REMOTE_SECURITY_ADDON` and `DSH_REMOTE_IROH_BIN` at `native/linux-x64/` when those files exist. The wrapping-key store defaults to `$DSH_HOME/remote-host-security.bin`.

Windows: `.\scripts\link-dsh-deps.ps1` then `. .\scripts\env.ps1`, same `--patch` boot. LAN or a public IPv4 bind works; iroh NAT is Linux-only in this release.

## Pairing

The pairing admin is Host-local loopback web. Nearby discovery is **off** in this bundle (`lanDiscovery: false`) and is LAN-only even when turned on.

On the Host computer:

1. Open `http://127.0.0.1:3180` → **Settings → Mobile access**, or run `node scripts/invite.mjs`.
2. Sideload the [signed APK](https://github.com/w2112515/dsh-remote-android/releases).
3. Scan or paste the `dsh-remote://` URI. Confirm the eight-digit code on the computer.

From another machine to a public-IP Host, tunnel loopback web, then mint the same invitation:

```sh
ssh -L 3180:127.0.0.1:3180 HOST
```

Open `http://127.0.0.1:3180` on that client, or `node scripts/invite.mjs` against the tunnel. The invitation URI already carries the advertised Host IPv4 and port. The phone talks to that address after pairing; it does not keep the SSH tunnel.

## Optional: `dsh plugin add`

Only if `pnpm` is on PATH:

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
```

Then still run `scripts/env.sh` (or set the same variables) before boot. Without pnpm, use the clone + `--patch` path above.

## Not in 0.2.1

Firebase push. Cellular-only acceptance. Per-tap phone approval on stock 0.1.1-rc.2. Marketplace pack. npm registry. macOS natives. Windows iroh. Public DSH web.
