# @w2112515/dsh-remote-host

一个 DSH Remote Host 包。装一次。Cordis 里仍是多行（admissions → control → command → remote → settings），都从这个包导出。

手机是**另装的签名 APK**：[dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases)。

## 能做什么

- Noise 投影（环境变量里的地址和端口，默认 50051）
- 发送 / Stop
- 本机配对（网页「设置 → 手机访问」，或 `npm run invite`）
- Linux x64 的 iroh 旁路在 `native/linux-x64/`（NAT）。这一版没有 Windows iroh。
- 公网 IPv4 Host 不需要 Tailscale

库存 npm `dsh` 0.1.1-rc.2 **不会**把逐次允许/拒绝推到手机。手机「策略」页改的是 Host 会话策略。

电脑继续用官方 `dsh` 网页（本机回环）。这个插件补的是手机通路。不要把 DSH 网页挂到公网域名。

## 安装（Linux x64）

需要官方 `dsh` 0.1.1-rc.2+ 和 Node。有 `npm` 就够。`dsh plugin add` 依赖 pnpm，不是第一条路。

```sh
git clone --branch v0.2.1 https://github.com/w2112515/dsh-remote-host.git
cd dsh-remote-host
npm install --omit=dev
sh scripts/link-dsh-deps.sh    # 嵌套 @deepseek-ai，以及把本包装进 $DSH_HOME/profiles/web
. scripts/env.sh               # 必须在包根目录 source
```

公网单播 IPv4（家里的机器不要绑 `0.0.0.0`）：

```sh
export DSH_REMOTE_BIND_ADDRESS=YOUR_PUBLIC_IP
export DSH_REMOTE_ADVERTISE_ADDRESS=YOUR_PUBLIC_IP
```

先看组成，再在回环上开网页：

```sh
dsh --profile web --patch "$PWD/cordis.patch.yml" --dump-config
dsh --profile web --patch "$PWD/cordis.patch.yml" --host 127.0.0.1 --port 3180 --no-open
```

dump-config 必须出现 `@w2112515/dsh-remote-host/` 的五行，不能是 Remote 的 `file://`。

Windows：`.\scripts\link-dsh-deps.ps1`，再 `. .\scripts\env.ps1`，同样用 `--patch` 启动。局域网或公网 IPv4 直连可以；这一版的 iroh NAT 只在 Linux。

## 配对

配对管理面在 Host 本机回环网页。这个包默认关掉附近发现（`lanDiscovery: false`）。附近发现即使打开也只覆盖局域网，不是公网配对步骤。

在 Host 这台电脑上：打开 `http://127.0.0.1:3180` → **设置 → 手机访问**，或 `node scripts/invite.mjs`。侧载 [签名 APK](https://github.com/w2112515/dsh-remote-android/releases)，扫或粘贴 `dsh-remote://`，在电脑上确认八位比较码。

人在别的机器、Host 在公网 IP 上：先打隧道，再发邀请。

```sh
ssh -L 3180:127.0.0.1:3180 HOST
```

然后同样打开 `http://127.0.0.1:3180`，或对隧道跑 `node scripts/invite.mjs`。邀请 URI 里已经带了 Host 宣告的 IPv4 和端口。配对完成后手机直连那个地址，不必一直开着 SSH。

## 可选：`dsh plugin add`

PATH 上有 pnpm 才用：

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
```

启动前仍要 `scripts/env.sh`（或自己设同样的变量）。没有 pnpm 就走上面的 clone + `--patch`。

## 0.2.1 没有

Firebase 推送。只走蜂窝的验收。库存 0.1.1-rc.2 上的逐次手机审批。市场整合包。npm 源。macOS 预编译。Windows iroh。公网 DSH 网页。
