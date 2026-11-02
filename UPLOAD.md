# 上传说明

本目录是 `kausmi/Arknights-Simulator-Android` 仓库的内容来源。

- `android-src/`  —— Android 壳与本地服务的 Java 源码（`sh build.sh` 直接构建）
- `web-patch/`    —— 相对原仓库新增/改动的网页前端文件（叠到原仓库同路径即可）
- `extract/`      —— 从本机《明日方舟》提取资源与干员数据的 Python 脚本
- `README.md`     —— 项目说明（安卓专属特性 + 免责声明）

## 构建

```
cd android-src
sh build.sh
# 产物: build/arksim.apk
```

依赖：Android SDK 的 `aapt2`（arm64 版）、`android.jar`、JDK 17+、
`build-tools` 里的 `d8.jar` 与 `apksigner.jar`，以及 `libs/` 下四个 Shizuku jar。

## 版本

| 版本 | 说明 |
|---|---|
| 0.1.2 | 提取产物改存 App 私有目录（不进相册/媒体库）；修 confirm 弹窗失效、UI 过大、干员页布局 |
| 0.1.1 | 修「已授权却扫不出资源」（Android 11 包可见性）、干员立绘提取、计分板可收起 |
| 0.1 | 首个可运行版本 |
