# 双 VPN 分流助手

一个面向 macOS 的完整窗口应用，用来让中移 ZYZXVPN 与度管家稳定共存：中移专用业务继续走当前 `utun`，百度办公网和度管家流量走当前物理网络。切换 Wi‑Fi、有线网络、睡眠唤醒或 VPN 重连后，后台服务会清理旧配置并重新检测。

![macOS](https://img.shields.io/badge/macOS-13%2B-0a84ff) ![Electron](https://img.shields.io/badge/Electron-44-56d7ff) ![Release](https://img.shields.io/badge/release-unsigned-f4b860)

## 能做什么

- 自动维护办公网 `10.0.0.0/9`、`10.128.0.0/9` 到当前物理网关。
- 将中移 DNS `10.57.0.96`、`10.57.0.196` 固定到实时存在的中移 `utun`。
- 为 `baidu.com`、`baidu-int.com`、`internal.baidu.com` 配置受控的补充 DNS。
- 网络变化时先撤销旧配置，等待稳定后再应用，避免旧网关或旧 `utun` 残留。
- 支持暂停、恢复、立即检测修复、随系统自动启用、结构化诊断和安全卸载。

本应用不会启动、关闭、登录或自动操作 ZYZXVPN、度管家、AccessClient、VMware Horizon；这些应用始终由用户自己控制。

## 下载与安装

仓库已公开，无需登录 GitHub。请从 [最新 Release](https://github.com/guofengming/dual-vpn-routing-assistant/releases/latest) 下载 `双-VPN-分流助手-<版本>-universal.dmg` 和 `SHA256SUMS.txt`。安装、首次启用、切网处理、升级和卸载步骤见 [完整使用说明](docs/installation.md)。

首版为无签名、未公证构建，第一次打开需在“系统设置 → 隐私与安全性”中确认。第一次安装后台服务和卸载服务时会请求管理员密码；日常自动恢复不再请求密码。

## 开发

要求 Node.js 24 与 pnpm 11.25：

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run test:e2e
scripts/create-icon.sh
pnpm run dist:mac
```

后台守护由 macOS `zsh` 脚本实现，不依赖 Node、Codex 或网络服务。Electron 渲染器开启 `contextIsolation` 与 sandbox、禁用 Node 集成，只能通过固定 IPC 白名单操作本机服务。

## 当前验证范围

- 本机与 CI 可验证 UI、请求边界、路由/DNS 事务、网络切换状态机和 Universal 包结构。
- Intel 企业 VPN 实网路径仍需在获授权的 Intel Mac 上确认。
- macOS 13 的首次安装/卸载仍需在实体或授权测试机上做运行验证；构建产物已声明最低版本 13.0。

## 隐私

不包含遥测，不采集网络内容、浏览器数据、VPN 凭据。诊断导出只包含结构化状态，并替换用户名和用户目录。
