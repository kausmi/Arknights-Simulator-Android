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
| 0.1.15 | 干员详情页（携带技能 / 模组 / 潜能 / 立绘皮肤）、6 位新干员专属技能实现与图标、皮肤按需解包、自定义干员支持子职业与自绘范围、提取进度条与预计时间、资源版本更新提醒 |
| 0.1.5-beta | 六位新干员（塔露拉 / 冻河 / 国度 / 奥尔佳 / 镜匠 / 行铃）数据与美术适配 |
| 0.1.4 | 版本戳改为内容指纹（改了前端立即生效）；升级不再删掉已提取的美术与自制关卡 |
| 0.1.3 | 修提取以 SIGILL 静默退出、干员表不全 |
| 0.1.2 | 提取产物改存 App 私有目录（不进相册/媒体库）；修 confirm 弹窗失效、UI 过大、干员页布局 |
| 0.1.1 | 修「已授权却扫不出资源」（Android 11 包可见性）、干员立绘提取、计分板可收起 |
| 0.1 | 首个可运行版本 |
