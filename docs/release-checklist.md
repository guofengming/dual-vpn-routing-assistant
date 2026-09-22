# v0.1.0 发布验证清单

- [x] TypeScript 类型检查
- [x] ESLint
- [x] Vitest 单元/脚本测试
- [x] Electron Playwright 窗口测试（当前 Apple Silicon 开发机）
- [x] Universal DMG 构建与 `arm64 x86_64` 检查
- [x] SHA-256 校验文件与 `hdiutil verify` 镜像完整性检查
- [x] DMG 内 App 与本地打包 App 逐文件一致
- [x] 当前 Apple Silicon 上启动无签名打包 App（窗口 1040×700）
- [ ] 当前 Apple Silicon 企业网络实测：IDLE → ACTIVE → 切网 → 断开 VPN → 暂停/恢复 → 卸载
- [ ] Intel Mac App/daemon 启动与基础修复流程
- [ ] Intel Mac 企业 VPN 实网路径
- [ ] macOS 13 首次安装、启动、暂停/恢复与卸载

在未完成 Intel 企业网络和 macOS 13 实机项之前，只声明构建/运行兼容性，不声明对应环境的企业 VPN 路径已完全验证。
