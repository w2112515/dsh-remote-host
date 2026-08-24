# @w2112515/dsh-remote-host

一个 DSH Remote Host 包。把 Android 手机配到 DeepSeek Harness（局域网或公网 Host IPv4）。

手机是**另装的签名 APK**（当前用 **0.2.0**，配这版 Host **0.2.2**）：[dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases)。

电脑继续用官方 `dsh` 网页（本机回环）。这个插件补的是手机通路。不要把 DSH 网页挂到公网域名。

库存 npm `dsh` 0.1.1-rc.2 **不会**把逐次允许/拒绝推到手机。手机「策略」页改的是 Host 会话策略。

## 安装（Linux x64）

需要官方 `dsh` 0.1.1-rc.2+ 和 Node。

```sh
git clone --branch v0.2.2 https://github.com/w2112515/dsh-remote-host.git
cd dsh-remote-host
sh scripts/setup.sh --bind YOUR_PUBLIC_IP    # 只在同一局域网可以不加 --bind
sh scripts/start.sh
node scripts/invite.mjs
```

`setup` 会装依赖、把本包装进 DSH profile、写 `$DSH_HOME/remote-host.env`、检查 dump-config。`start` 在回环打开网页（`127.0.0.1:3180`）并听投影端口（默认 50051）。`invite` 打印 `dsh-remote://` 和终端二维码；输入八位比较码确认。

侧载 APK，扫或粘贴 URI。

不要传 `--bind 0.0.0.0`。家里的机器只绑单播 IPv4，或只走局域网。

Windows：`.\scripts\setup.ps1 --bind YOUR_PUBLIC_IP`，再 `.\scripts\start.ps1`。这一版没有 Windows iroh；局域网或公网 IPv4 直连可以。

## 配对说明

在 **Host 上**跑 `invite`（SSH 进这台机器就够）。配对完成后手机直连宣告的 IPv4，不必一直开着 SSH。

如果想在另一台电脑的浏览器里打开设置页：

```sh
ssh -L 3180:127.0.0.1:3180 HOST
```

然后 `http://127.0.0.1:3180` → **设置 → 手机访问**。附近发现默认关（`lanDiscovery: false`），打开也只覆盖局域网。

## 备份

复制 `$DSH_HOME/remote-host-security.bin`（第一次 start 时生成）。丢了这个文件，已配对的手机都要重新配对。

## 可选：`dsh plugin add`

PATH 上有 pnpm 才用：

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
```

仍要 `sh scripts/setup.sh --skip-npm --bind YOUR_PUBLIC_IP`（原生库和 env 文件），再 `sh scripts/start.sh`。

VPS 示例单元：`contrib/dsh-remote-host.service`。

## 0.2.2 没有

Firebase 推送。只走蜂窝的验收。库存 0.1.1-rc.2 上的逐次手机审批。市场整合包。macOS 预编译。Windows iroh。公网 DSH 网页。新 APK（继续用 0.2.0）。
