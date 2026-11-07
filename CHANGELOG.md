# Changelog

## Unreleased

### Fixed

- `npm test` 改为 `node --test tests/*.test.mjs`，兼容 Node 18/20/22/26（旧的 `tests/` 目录写法在 Node 26 会失败）。
- 删除不存在的 `tools/bench.mjs` 脚本与 README 中的 `npm run bench` 说明。
- op / 快照限额改用 `Buffer.byteLength(JSON.stringify(...))` 计算 UTF-8 字节，避免多字节字符被低估。
- `room.bytes` 现在同时统计 op 与快照，并在裁剪、快照替换和持久化恢复时保持一致。
- 单人房间的 op 也会通过 `onOpsAccepted` 回调落盘，不再依赖广播触发持久化。
- 持久化恢复时按快照地平线裁剪已覆盖的 op；关闭服务器时清理心跳并彻底释放连接。
- `flushAll()` 等待进行中的落盘任务，避免关闭时忙等。

### Added

- GitHub Actions CI：Node 18/20/22 矩阵运行 `npm run check`。
- 集成测试：UTF-8 字节限额、`room.bytes`、真实 WebSocket 超限拒绝、快照与持久化恢复。
