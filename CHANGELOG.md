# 更新日志

本文件记录每个版本改了什么、改了哪些文件。安卓移植层的改动都在这里；
上游玩法的改动请看原仓库 [WardTrapXFog/Arknights-Simulator](https://github.com/WardTrapXFog/Arknights-Simulator)。

---

## 0.1.16

版本号：`versionCode 18` / `versionName 0.1.16`
APK：`Arknights-Simulator-Android-0.1.16.apk`（140,386,894 字节）
前端包体：`web.zip` 2687 个文件 / 110,411,438 字节

### 一、干员美术：把「诡异色块 / 头朝下 / 红蓝互换」全部修掉

之前提取出来的立绘有一堆毛病：人物倒着、颜色红蓝对调、透明区变成白块。
这次把解包链路整条重写，五个根因逐个确认后才动手：

1. **像素不在 `Texture2D` 本体里**，而在同包 `.resS` 流里。必须按
   `m_StreamData.offset / m_StreamData.size` 从 `.resS` 切出对应字节再解码。
   （`tex.image` 在安卓上直接抛 `ValueError('Unsupported system: Android')`，
   所以走的是 `texture2ddecoder`。）
2. 解码结果要 **`Image.FLIP_TOP_BOTTOM`**，否则人物头朝下。
3. 解码输出是 **BGRA** 不是 RGBA。不转的话红蓝两个通道互换。
   正确写法：`Image.frombytes('RGBA', (w, h), data, 'raw', 'BGRA')`。
4. 42xx 段之后的新干员，立绘贴图多为 `m_TextureFormat = 34`（ETC1，**本身不带 alpha**），
   透明度单独存在同包的 `<贴图名>[alpha]` 灰度贴图里（尺寸常常只有主图一半，要 LANCZOS 放大）。
   不合并的话 alpha 全是 255，透明区就变成不透明白块 —— 也就是「诡异色块」。
5. 立绘默认取 **精一**（`_1`）而不是精二。

结果：

- `public/assets/char/illust/` 全量重导 **202 张**精一立绘（WebP，按 alpha bbox 裁掉透明边）。
- 新增 **269 张**头像（128×128 PNG）。裁切用「顶部 22% 条带的不透明跨度」定位人物中心线，
  而不是整图居中 —— 全身立绘的人物经常偏左或偏右，按整图居中会裁到空气。
- 新增 **269 张**半身立绘（640×640 WebP，`_1` / `_2` 两档），给干员列表的竖版卡用。
- `data/assets.json` 回写 269 条 `portrait` / `portraitE2` 路径。
- 仍缺的只有 5 个（本机 `chararts` 里没有对应 `.ab`，属于正常缺失）：
  `char_002_amiya`、`char_500_noirc`、`char_502_nblade`、`char_503_rang`、`char_1503_talula`。

涉及文件：`.tools` 下新增 `headshot_extract.py`、`portrait_extract.py`；
`illust_extract.py`、`skin_extract.py` 重写解码与 alpha 合并。
仓库里对应 `extract/headshot_extract.py`、`extract/portrait_extract.py`、`extract/illust_extract.py`。

### 二、干员列表改成官方竖版卡

- 列表卡片重做：上半身立绘铺满 **3:4 竖长条**，左上角职业小图标 + 星级，
  左下角圆形等级数字（取 `status.level`），底部深色条放名字，改过数值的挂「已改」角标。
- 顶部新增**职业图标栏**（ALL + 先锋 / 近卫 / 狙击 / 重装 / 医疗 / 术师 / 辅助 / 特种）。
  点某个职业就筛出该职业的干员，并**右侧滑出子职业弹层**；再点同一职业只弹弹层不切筛选。
- 原生的两个 `<select>`（职业 / 子职业）保留但隐藏，表单值照旧同步，不影响已有筛选逻辑与深链。
- 详情页里也加了职业入口按钮，点它直接跳到该职业的列表 + 子职业弹层。
- 官方职业图标在本机资源里**一份都没有**（`Bundles/arts/ui/` 下没有 prof 相关 `.ab`，全盘搜也没有），
  所以画了 8 个线条 SVG 放在 `public/assets/prof/`。

涉及文件：`public/studio/operators.html`（`operators.css?v=22`）、
`public/studio/js/operators.js`、`public/studio/operators.css`、`public/assets/prof/*.svg`（8 个新增）。

顺带修掉：列表卡上的子职业小图标每个都是破图（`data/assets.json` 里登记的
`prof/sub/*.png` 本地一个都没有），已改成不渲染；筛选下拉框在深色主题下是黑底黑字，
已强制白底。

### 三、横屏干员详情页单独做一套版式

竖屏和横屏**有意不一致** —— 横屏的可读性优先：

- 横屏：hero 压到 `42vh`（168–300px），标题与属性块改成「名字 / 属性」左右分栏，
  属性块五列网格、每格「小标签 + 19px 数值」，整块横向铺满。
- 竖屏：沿用原来的左对齐 96° 渐变版式，属性块最大宽度 58%。
- 这套切换写在 JS 里（`applyHeroLayout`），因为 hero 的那些属性是内联 `!important`，
  样式表压不动；同时挂了 `matchMedia` 监听，转屏会重写。

### 四、横屏「编辑数据」拆成独立页

横屏看详情时是**只读**的：输入框、原值、保存条全部隐藏，
原来的参数区变成两列「名称 … 数值」的密集清单。

点 hero 上的「✎ 编辑数据」切到编辑页：hero 压到 `26vh`，所有输入框恢复，
顶部有「← 返回干员详情」。切换只改 `body.ops-editing` 类、**不重建 DOM**，
所以没保存的输入不会丢。切换干员或退出详情会自动退出编辑态。
竖屏保持原来的样子（两个按钮在竖屏下隐藏）。

### 五、战斗内干员面板（点已放置干员弹出的那张）

- 宽度 `560px → min(920px, calc(100vw - 92px))`，高度 `calc(100vh - 96px)`。
  原来在手机横屏（CSS 视口 833×375）下面板只剩一百多像素高，技能描述和天赋全挤成一坨、
  右侧还被裁断。
- 立绘 108→132px，属性格字号抬到 15px，tab 30px/13px，正文 13px/1.72，
  技能图标 44px。
- 生命条改成官方那种**白底**（原来是绿色渐变），标签与数字压深色。
- 竖屏单独一档：面板占满宽度、属性两列、正文 14px。

涉及文件：`public/sandbox/ark-battle.css`（`?v=15`）、`public/sandbox/detail-redesign.css`。

### 六、地图里的红门 / 蓝门终于看得见了

之前门格子的数据、材质、坐标全是对的（`parseStage` 出来的门格 `drawn=true scenery=false dist=0`），
问题在画法：

- 门框画在一个 `blendMode = ADD` 的 Graphics 里，线宽只有 `max(1.2, s*0.028)`。
  **在浅灰地板上，ADD 混合的细线等于看不见。**
- 而且 `_buildBoxes` 里还有一条 `if ((tile.scenery || r > 12) && !penGate) continue;`
  会把行号大于 12 的门直接跳过。

改法：

- 门框改成 `NORMAL` 混合 + **实心填充**（前后面 alpha 0.6~0.92）+ 粗描边，
  正面中心画一个深色圆盘 + 大三角箭头（红门朝上、蓝门朝下）。
- 去掉 `scenery / r > 12` 的跳过条件，门在任意行都画。
- 门辉光 sprite 也不再受 `r >= 13` 限制。

涉及文件：`public/js/render/tiles.js`（`_buildBoxes` / `_buildAnim` / `drawWireBox`）。

### 七、地图编辑器的提示条不再盖住敌人卡片

提示条（「点地图任意格放下一只敌人…」这类）原来被 CSS 固定在 `bottom: calc(u + 84px)` 且水平居中，
`max-width: 92%` 让它变成一条很宽的横带，正好压在抽屉的敌人卡片列表上。
现在改成**右下角小方块**（`right: 12px` + `max-width: min(46vw, 420px)` + 左对齐），
竖屏单独一档（`min(72vw, 380px)`，`bottom` 再抬 18px 避让手牌栏）。

涉及文件：`public/sandbox/ark-battle.css`（末尾「提示条复位」段）。

### 八、干员数值调整页的字看不清

深色详情页里，字段标签、小节标题（「天赋 2 · 药剂扩散」）、「原值 0.3」这些
**用的还是浅色主题的变量**（`--o-ink: #1b1e20` 这类近黑色），深底配深字，等于看不见。
现在在详情作用域内整套重定义成深色主题变量，并把字号抬了一档：

- 字段标签 13px / `#eef3f6`，内部键名 11px / `#9fb0b9`，「原值」12px / `--o-ink-3`
- 小节标题 14.5px 青色，天赋 / 技能 / 模组标题 14.5px 亮色
- 输入框 38px 高 / 15px 字，改过的框琥珀色边框
- 正文 13.5px / 1.75，提示 12.5px / 1.7
- 竖屏再抬一档

### 九、六位新干员的技能全部落地

先说一个**真 bug**：奥尔佳、国度、冻河三位的机制文件写得很完整，
但注册键写成了 `charId` 并挂在「自选干员」表上，而这三名不在自选池里
（`data/backups.json` 的 `diy.ownedPool`），所以**一直没生效**，游戏里走的是通用兜底。
塔露拉更彻底，文件写好了但压根没注册。现在全部改成按**棋子 baseId** 注册：

| 干员 | 棋子 | kit 文件 |
| --- | --- | --- |
| 塔露拉 | `chess_char_5_99_talula_a` | `chess_char_5_99-talula.js` |
| 奥尔佳 | `chess_char_5_24_a` | `chess_char_5_24-alga.js` |
| 镜匠 | `chess_char_5_25_a` | `chess_char_5_25-caledo.js` |
| 国度 | `chess_char_6_22_a` | `chess_char_6_22-dminon.js` |
| 冻河 | `chess_char_6_21_a` | `chess_char_6_21-tocka.js` |
| 行铃 | `chess_char_4_27_a` | `chess_char_4_27-hdbell.js` |

新写的两位：

- **行铃**（4★ 特种·调度者）：天赋「驮兽边界感」未阻挡敌人时攻击力 +8%；
  S1「花椰菜冲击」下次攻击改为驱使驮兽沿前方直线冲出，碰到的目标受 180% 物理伤害并被中等力度推开；
  S2「蔬菜大拼盘」36 秒，攻击间隔 −0.5、攻击力 +30%，驮兽每经过一格伤害额外 +12%（最高 +48%）。
  驮兽用一个 0.5 秒的直线弹道实现，逐帧用线段-矩形相交判定命中。
- **镜匠**（5★ 重装·本源铁卫）：天赋「工匠的素养」处于元素损伤爆发期间每秒回复 2% 最大生命，
  若是狂躁损伤爆发则 3%；S1「无公差切割」下次攻击对**阻挡的全体**造成 220% 物理伤害
  并附 50% 攻击力的狂躁损伤；S2「多面镜」35 秒，攻击力 +70%、生命上限 +60%，
  同时攻击阻挡全体、每次攻击附带 25% 攻击力的狂躁损伤，
  期间受到的物理 / 法术伤害有 30% 按一半折算成自身的狂躁损伤。

验证（在真引擎上跑，不是静态检查）：

- 216 个 kit 全部可调用，无缺失无异常。
- 六名新干员各跑 20 秒战斗，`errs=0`，且默认技能选中的都对
  （`skchr_hdbell_2` / `skchr_caledo_2` / `skchr_alga_2` / `skchr_tocka_3` / `skchr_dminon_3` / `skchr_oxi_3`）。
- 278 条干员逐技能统计机制来源：`skills 368 / kit 262 / generic 38 / none 8`。
  那 38 条 generic 是历史遗留的老干员第二 / 第三技能（红豆、地灵、锡人、崖心、协律、
  见行者、巫恋、耶拉、蜜蜡、瑰盐、录武官、华法琳、魔王、白面鸮、百炼嘉维尔、妮芙），
  不在本次范围内；8 条 none 是 4 个 DIY 占位（「甄选干员」，正常空位）。

### 十、全站 UI 统一到浅色扁平

基准是自由沙盒那套（`#e9ebeb` 底 + 白卡 + `#00a2c8` 青 + 细灰线）。改到的页面：

- **关卡制作器**：顶栏压着「← 返回」、卡片行和「打开 / 复制 / 导出 / 删除」按钮行叠在一起、
  整页根本滚不动。根因是 `html.level-doc` 自己是 `height:100%; overflow:hidden`，
  加上 `.lv-workspace` 是 `position:absolute; top:0`。现在根元素可滚动、
  workspace 改 `static`、卡片与按钮分成两行、按钮压到 30px 高。
- **游玩自制关卡**：`.operation-screen` 是 `position:fixed; inset:0`，
  内容全挤在一屏里永远不滚。改成静态文档流 + 自动填充网格 + 浅色。
- **教程与帮助**：标题被固定顶栏遮住，让位 56px。
- **沙盒设置弹层**：原本是深色扫描线渐变，改白底细线 + 顶部 2px 青色。
- **关卡 / 帮助 / 游玩**三页统一由 `public/studio/pages-light.css` 管。

### 十一、升级后不会再把新立绘换回旧图

`WebInstaller` 的保留路径里 `public/assets/char` 是**整目录替换**：
先 `deleteTree(dst)` 再 `renameTo(dst)`。也就是说用户升级一次，
APK 里新解出来的 202 张 `.webp` 会被旧目录里的 `.png` 整个顶掉。

现在新增 `mergeKeep(old, dst)`：目录型保留路径改成「新包已有的用新包，新包没有的才从旧目录搬」。
同时 `Extractor` 在提取前会清掉旧的 `.png` 产物（保留发行包自带的 `.webp`），
避免新旧两套图混在一起。

### 十二、主界面横屏露黑边

`MainActivity` 里 WebView 底色写的是 `Color.BLACK`，横屏时导航栏那一侧会透出黑边。
改成 `0xFFE9EBEB`（与页面底色一致）；同时给 `home-v2.css` 补了 `html/body` 的最小高度与底色。

### 十三、其它小修

- 存档面板点卡片直接载入（原来要先选中、再点下面的「载入」按钮，手机上像点不动），
  并去掉载入前的 `window.confirm`（WebView 里被拦，表现成点了没反应）。
- `HttpService` 补 `.svg` 的 MIME（`image/svg+xml`），职业图标才能正常发出去。

---

## 文件改动统计

本次版本（相对 0.1.15.1）：

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| `web-patch/public` 修改 | 36 | 已有 patch 文件与工作副本对齐 |
| `web-patch/public` 新增 | 22 | 8 个职业 SVG、4 个样式表、3 个渲染文件、2 个调试页等 |
| `android-src/src` 修改 | 6 | `Extractor` / `HttpService` / `MainActivity` / `OperatorStore` / `ShizukuBridge` / `WebInstaller` |
| `android-src` 其它 | 1 | `AndroidManifest.xml`（版本号） |
| `extract/` 新增 | 3 | `headshot_extract.py` / `portrait_extract.py` / `illust_extract.py` |

工作副本一侧（不进仓库的部分）：

- 前端源码改动 **44 个**文件（不含 `public/assets/char`、`skin` 等产出目录）。
- Android 源码 **10 个 `.java`** 全部有改动。
- 素材产出：立绘 202 张、头像 269 张（另有 538 个同名 `_2` 副本）、半身立绘 269×2 张。

---

## 0.1.15.1

- 全站移动端适配层（横屏 / 竖屏 / 平板 / 大屏四档）
- 修 WebView 视口导致的「整个界面过大」
- 重做「加入手牌」选择器（头像与名字可见、职业筛选横排）
- 修关卡编辑器「试玩」「导出」在应用内点了没反应
- 修编辑器手机档的 grid 列宽失效

## 0.1.15

- 干员详情页（携带技能 / 模组 / 潜能 / 立绘皮肤）
- 6 位新干员数据与图标
- 皮肤按需解包、自定义干员支持子职业与自绘范围
- 提取进度条与预计时间、资源版本更新提醒

## 0.1.5-beta

- 六位新干员（塔露拉 / 冻河 / 国度 / 奥尔佳 / 镜匠 / 行铃）数据与美术适配

## 0.1.4

- 版本戳改为内容指纹（改了前端立即生效）
- 升级不再删掉已提取的美术与自制关卡

## 0.1.3

- 修提取以 SIGILL 静默退出、干员表不全

## 0.1.2

- 提取产物改存 App 私有目录（不进相册 / 媒体库）
- 修 confirm 弹窗失效、UI 过大、干员页布局

## 0.1.1

- 修「已授权却扫不出资源」（Android 11 包可见性）
- 干员立绘提取、计分板可收起

## 0.1

- 首个可运行版本
