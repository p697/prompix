# 0.4.7（18）本地发行候选

2026-10-13，从干净的合并提交 `96c39341eda8cddf15e9d12ccb470c2041bde1bc` 生成 iOS Release 归档。使用外接 SSD 上的官方 Xcode 27.1 RC（27A9275）、iPhoneOS 27.1 SDK，最低 iOS 17，设备族 iPhone／iPad。全程没有安装用户手机、上传 App Store Connect 或提交审核。

## 产物

开发机目录：`/Volumes/Lucy-SSD/Prompix-Codex/Releases/0.4.7-18/`。

| 产物 | 文件 | 字节数 | SHA-256 |
|---|---|---:|---|
| 真机开发安装包 | `development-export/Prompix.ipa` | 7,812,198 | `a6944573f4acc9ec6ff6b28812bebdfa398710395b59220ce0fa160895f60dcc` |
| App Store 本地分发包 | `app-store-export/Prompix.ipa` | 8,799,300 | `e210a496c0d2313bb2edbe8bdd8238219959e8aeb0102053cc6c54eb98a7649d` |
| 归档及符号 | `Prompix.xcarchive` | — | 见独立审计中的资源指纹与 Mach-O UUID |

`source.json` 保留源码、工具链及构建开始时的干净状态；归档和两种导出分别保留命令日志。两种导出均使用 `destination=export`，关闭自动版本改写。开发包用于其描述文件授权的真机；商店分发包不能直接替代开发安装包。Apple 的[官方导出流程](https://help.apple.com/xcode/mac/current/en.lproj/dev23ea8b877.html)区分本地导出与上传。

## 可复现的独立核对

仓库的 `scripts/audit-ios-release.py` 对实际归档和 IPA 进行独立核对；报告保存在产物目录，不保存团队身份、证书或设备标识到公开仓库。后续构建可传入新的源码提交、版本和路径，不能沿用旧哈希冒充检查。

本次开发包 **39 项通过**、商店分发包 **42 项通过**，两份报告均无失败项。归档与导出的 27 份非签名资源完全一致；归档、两个 IPA 和 dSYM 的 arm64 UUID 均为 `96A611EB-AC32-3FC3-B615-B729884181E8`。开发包描述文件授权 6 台登记设备，商店分发包无设备列表且调试权限关闭。这里只记录数量，不公开设备标识。

报告为 `development-audit.json` 与 `app-store-audit.json`。审计器另有 16 项针对性测试，覆盖越界／重复 ZIP 路径、通配符授权、资源与版本篡改、测试或私密文件混入，以及失败报告不泄露工具输出；已加入 CI。

```sh
export DEVELOPER_DIR=/Volumes/Lucy-SSD/Prompix-Codex/Toolchains/Xcode-27.1-RC.app/Contents/Developer
PROMPIX_RELEASE_ROOT=/Volumes/Lucy-SSD/Prompix-Codex/Releases/0.4.7-18
python3 scripts/audit-ios-release.py \
  --repo "$PWD" \
  --source-commit 96c39341eda8cddf15e9d12ccb470c2041bde1bc \
  --archive "$PROMPIX_RELEASE_ROOT/Prompix.xcarchive" \
  --export-dir "$PROMPIX_RELEASE_ROOT/app-store-export" \
  --expected-version 0.4.7 --expected-build 18 \
  --method app-store-connect \
  --report "$PROMPIX_RELEASE_ROOT/app-store-audit.json"
```

开发包改用 `development-export`、`--method debugging` 及独立的 `development-audit.json`。命令从仓库根目录运行；不需要暴露团队或任何密钥。

两种方法分别核对签名、描述文件的授权与有效期、调试权限、实际应用标识、归档与导出资源、dSYM 对应关系、九语编译资源及源码隐私／原创目录／网页文件；拒绝测试包、测试视频、调试 dylib 和私密配置混入。开发描述文件可以合法使用末尾通配符，不能套用商店包必须匹配明确标识的判定。

## 验收边界

- 本地归档、导出和独立核对不等于 Apple 服务端上传校验、TestFlight 可用或正式审核通过；工具链目前为 RC。
- [Duo 模拟器证据](iphone-duo.md)来自相同生产源码的模拟器构建，不能宣称是这份 arm64 Release 包在真机上的性能或外部 App 验证。
- 最新用户手机阶段包仍为 0.4.6（17）。不因新 IPA 已生成而反复安装手机；最终真机与外部工具交接在集中验收时完成。
- 未提交拼音候选跨屏结束、其他七语内容积压及完整离线／慢网等剩余关口仍依 [当前目标](next-release.md) 处理。
- 九语商店文案已将版本绑定更新到 0.4.7，原有文案不因此变成新一轮母语审校。最终截图、465 条及后续增量的发行内容复核、隐私问卷、主体与联系人、地区和用户提交授权仍须完成。

原 0.3.2 与 0.4.6 的包及证据保持原样，不重新标注版本；这个候选不结束完整交付目标。
