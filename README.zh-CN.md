# DSH Remote Host

可安装的 DeepSeek Harness 插件：让正在运行 `dsh web` 的 Windows 电脑成为手机可控的 Host。

这不是 DeepSeek Harness 的 fork。把它加进官方 `web` profile 即可。Android 应用是另一次下载——整合包装不了 APK。

[English](README.md) | 中文

## 你拿到什么

1. **这个插件**（npm、GitHub，或 [DSH Remote 整合包](https://github.com/w2112515/dsh-remote-pack)）——Host 载体、配对、局域网发现、「设置 → 手机访问」。
2. **一个 Android APK**，来自 [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases)——手机客户端。

配对走 Noise（`XXpsk3` / `IK`）。局域网广播默认关闭，在「设置 → 手机访问」打开。完整路径不离开 Host；手机只看到项目标签和文件夹名。

已审查的 Host 安全平台是 Windows x64。Linux / macOS 保留设置页，不绑定载体。

## 安装 Host 插件

npm（预编译，不跑安装脚本）：

```powershell
dsh plugin --profile web add @w2112515/dsh-remote-host
dsh --profile web --dump-config
```

重启 `dsh web`。打开 **设置 → 手机访问**，打开附近发现，再配对手机。

市场一键安装和整合包装的是同一份 GitHub pinned commit（`lib/` 已提交）。

## 然后装 APK

从 [dsh-remote-android releases](https://github.com/w2112515/dsh-remote-android/releases) 下载最新 APK，装到手机上，连同一 Wi-Fi，扫 Host 二维码，在电脑上确认八位比较码。

## 卸载

```powershell
dsh plugin --profile web remove @w2112515/dsh-remote-host
```

DSH home 下的 Host 身份文件 `remote-host-security.bin` 不会自动删除。

## 许可

MIT。`native/win32-x64/` 下的 Windows 安全预编译为 MIT OR Apache-2.0。
