# @w2112515/dsh-remote-host

一个 DSH Remote Host 包。装一次。Cordis 里仍是多行（admissions → control → command → remote → settings），都从这个包导出。

手机是**另装的签名 APK**：[dsh-remote-android](https://github.com/w2112515/dsh-remote-android/releases)。

## 能做什么

- Noise 投影（环境变量里的地址和端口，默认 50051）
- 发送 / Stop
- 本机配对（网页「设置 → 手机访问」，或 `npm run invite`）
- 公网 IPv4 Host 不需要 Tailscale

库存 npm `dsh` 0.1.1-rc.2 **不会**把逐次允许/拒绝推到手机。手机「策略」页改的是 Host 会话策略。

## 安装

```sh
dsh plugin --profile web add github:w2112515/dsh-remote-host
```

公网 Host 先设 `DSH_REMOTE_BIND_ADDRESS` / `DSH_REMOTE_ADVERTISE_ADDRESS`，再重启 `dsh web`。
