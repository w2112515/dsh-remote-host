# @w2112515/dsh-remote-host

One DSH bundle for Remote. Install it once. Cordis still loads five rows from this package because they inject different Host services.

Android is a **separate signed APK**: [dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases).

## What you get

- Noise gRPC projection (port from env, default 50051)
- Durable command journal and control leases
- Prompt and Stop admissions when stock `dsh` has none
- Host-local pairing (`Settings → Mobile access`, or `npm run invite`)
- iroh sidecar env: `DSH_REMOTE_IROH_BIN` / `DSH_REMOTE_IROH_RELAY_URL`

**Authorization:** the phone 策略 tab shows Host session policy. This bundle does **not** claim per-tap phone approval on npm `dsh` 0.1.1-rc.2. Writes follow Host policy.

## Install

Needs `dsh` 0.1.1-rc.2+ and `pnpm` on PATH for `dsh plugin add`.

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
```

Set bind/advertise before boot if the Host is on a public IPv4:

```sh
export DSH_REMOTE_BIND_ADDRESS=YOUR_PUBLIC_IP
export DSH_REMOTE_ADVERTISE_ADDRESS=YOUR_PUBLIC_IP
export DSH_REMOTE_SECURITY_STORE=/var/lib/dsh/host-security.bin
export DSH_REMOTE_SECURITY_ADDON=/usr/local/lib/dsh_remote_security_core.node
```

Restart `dsh web`. Pair from **Settings → Mobile access** (loopback web), or:

```sh
ssh -L 3180:127.0.0.1:3180 HOST
node scripts/invite.mjs          # prints a dsh-remote:// URI
```

If `dsh plugin add` is missing `pnpm`, apply the patch directly:

```sh
npm install --omit=dev --prefix /path/to/dsh-remote-host
mkdir -p /path/to/dsh-remote-host/node_modules
ln -sfn "$(dirname $(dirname $(readlink -f $(which dsh))))/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai" \
  /path/to/dsh-remote-host/node_modules/@deepseek-ai
dsh --profile web --patch /path/to/dsh-remote-host/cordis.patch.yml --dump-config
```

Dump-config must list `@w2112515/dsh-remote-host/...`, not `file://`.

## Not in 0.2.0

Firebase push. Cellular-only acceptance. Per-tap phone approval on stock 0.1.1-rc.2. Marketplace pack.
