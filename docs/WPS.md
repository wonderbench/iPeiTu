# WPS 文字加载与验收

本版为 Windows WPS 文字 JS 加载项。图片保存在本机，任务窗格由 `http://127.0.0.1:39831/` 提供；服务运行期间才能打开图库。浏览器可以查看图库，插入操作须在 WPS 内执行。

## 启动与注册

日常使用双击项目目录中的“安装.cmd”，它依次检查 Node.js、安装依赖、调用 `scripts/install-wps.ps1` 注册加载项、在当前用户注册表的自动启动项（`HKCUSoftwareMicrosoftWindowsCurrentVersionRun` 下的 `iPeiTu`）中写入启动命令，并启动服务。服务由 `scripts/service.ps1` 管理：

- 启动：先请求 `/api/health`，已是 iPeiTu 时不再启动；端口被其他程序监听时报告进程名并退出（退出码 2）；否则经 WMI（`Win32_Process.Create`，隐藏窗口）启动 `node server\index.js --port … --data-dir … --log …`，进程与安装窗口及调用方没有句柄继承关系；服务自己把日志追加到 `%LOCALAPPDATA%\iPeiTu\logs\service-端口.log`，健康检查通过后把进程号写入 `service-端口.json`。
- 停止：候选进程来自健康检查和状态文件，只有命令行包含本目录 `server\index.js` 的进程才会结束；其他进程报告“不是本目录启动的 iPeiTu 服务”并保留。
- 卸载（`scripts/remove.ps1`）：停止服务，只删除命令指向本目录 `service.ps1` 的 `iPeiTu` 自动启动项，再调用 `scripts/uninstall-wps.ps1`；图库目录不动。
- 三个脚本都支持 `-ConfigDirectory`、`-StateDirectory`、`-Port`，安装与卸载另支持 `-RunKey`；自动化测试用临时目录、临时端口和临时注册表键运行，不触碰真实配置。

开发时也可以手动启动。在项目目录先安装依赖并启动本地服务：

```powershell
npm ci
npm start
```

保持服务运行，在另一个 PowerShell 窗口注册加载项：

```powershell
npm run wps:install
```

保存正在编辑的文档，关闭并重新打开 WPS 文字。打开一份测试文档，在功能区选择“iPeiTu 配图 → 打开素材库”。导入本地图片、按图片名称检索，再点击图片卡片上的“+”。若选中了文字，图片会插在选区末端，原文字保留。

脚本只注册加载项，不启动或关闭 WPS，也不修改 `oem.ini`。注册位置为 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`，仅更新名为 `iPeiTu` 的 `jspluginonline` 条目。它使用官方 `wpsjs@2.2.3` 调试模式的 `enable="enable_dev"`、`install="null"`、`debug=""` 属性，固定指向本机服务。本版是本地开发部署，不是已完成的公网安装包。

更新前的完整 XML 以 `publish.xml.ipeitu-时间戳.bak` 保存；安装前的 iPeiTu 条目单独记录在同目录的 `ipeitu-install-state.json`。重复注册不会覆盖首次安装前的条目。其他加载项原有内容与后续变化均保留。

卸载本次注册：

```powershell
npm run wps:uninstall
```

卸载只移除本次 iPeiTu 注册并恢复其安装前条目，不用整份备份覆盖其他插件配置，不删除素材。重启 WPS 后生效。用于隔离验证时，两份脚本均支持 `-ConfigDirectory <临时目录>`；正常使用不传这个参数。

## 插图行为

- 点击时读取当前文档与选区，将选区副本折叠到末端再插入。不会使用上一次点击时的光标。
- 调用桌面同步接口 `Range.InlineShapes.AddPicture(path, false, true, range)`，以本地绝对路径插入独立副本，不使用 HTTP、`blob:` 或 `data:` 图片地址。
- 图片按内嵌对象插入，随文档保存。默认自适应模式只缩小不放大；固定宽度使用厘米，可等比放大小图，始终受页面内宽、单元格内宽和可选最大高度限制。
- 可选择独立段落居中、添加普通文字图题。插入时仅增加图片、段落符及图题，不回写原正文；相邻正文段落恢复原样式和段落格式，新增图段落去除继承编号、缩进和固定行距。
- 一次插图及排版组成一个撤销记录；图题不自动编号，不作为 Word/WPS 题注字段。
- 插入后把光标移到图片后，便于继续插图。不自动保存用户文档。
- 无文档、只读或受保护状态会给出提示。若插入已完成而缩放或定位失败，提示明确说明“图片已插入”，避免重复操作。
- v0.1 不自动调整固定行高、分栏、文字框、复杂嵌套表格或段落缩进。此类版式应在插图后人工核对。

## 排版工具

- 功能区新增“标书排版 › 排版工具”，以独立任务窗格打开 `format.html`，窗格 ID 单独记在 `ipeitu_layout_pane_id`，与素材库窗格互不复用。
- 操作集中在 `public/layout-tools.js`，每项操作包在一个 `UndoRecord` 自定义记录中；只读、受保护和非正文位置在开始撤销记录前拒绝。
- 用到的成员均已对照官方文档：`ParagraphFormat.Reset`、`Font.Reset`、`CharacterUnitFirstLineIndent`、`Table.PreferredWidthType`/`PreferredWidth`/`AllowAutoFit`/四边 `Padding`、`Cell` 四边 `Padding`、`Shading`、`Borders.Enable`、`PictureFormat.ColorType`、`Shape.Fill`/`Line` 的 `ForeColor.RGB`、`Document.Range`；表格宽度另用 `PageSetup.TextColumns.Count`、`Cell.Width`/`RowIndex`/`NestingLevel`、`Rows.Alignment`/`LeftIndent`、`Application.CentimetersToPoints`。实际效果待实机核对，清单见 [V03-PLAN.md](V03-PLAN.md) 的排版工具部分。

## 占位框

- 占位图由本机服务按框的尺寸生成，保存在图库目录的 `placeholders` 中，以 `AddPicture` 内嵌插入。
- 插入后解除比例锁定，按磅值分别设定宽和高，再锁定比例；回读宽高，误差超过 0.1 磅即报错。
- 标记写入 `InlineShape.AlternativeText`，格式为 `iPeiTu-box:1:` 加 JSON；写入后回读，不一致时删除新图并报错，不留下无法识别的框。
- 扫描遍历 `Document.InlineShapes`，只认带有效标记的图片；读不出替代文字的对象单独计数报告。
- 定位前重新核对文档、序号、位置与标记，任何一项变化都要求重新扫描，不选中旧位置。
- 文字标记转换：用 `Document.Content.Text` 判断有无标记，逐段读取 `Paragraph.Range.Text` 定位，再用 `Document.Range(start, end)` 核对原文、删除并放框；放框与插入占位框共用同一段逻辑。清除标记把已填框的 `AlternativeText` 置空并回读。
- 填入：只在完整选中一张带标记的内嵌图片时可用。沿用替换的顺序，在原框前插入适配图，解除比例锁定后按原框宽高设定并回读，写入带素材 ID 与适配方式的标记，复制原框字符格式，核对原框位置后只删除原框对象；任一步失败都移除新图并保留原框。替换流程本身未改动。
- 适配图由本机服务按框的尺寸生成（`GET /api/assets/{id}/fit`），保存在图库目录的 `fitted` 中，不依赖 WPS 的图片裁切属性。
- 替代文字在保存、关闭、重开后能否保留，尚未在真实 WPS 验证，见 [V03-PLAN.md](V03-PLAN.md) 的实机待验清单。

## 验收状态与清单

自动化测试使用 WPS 对象替身，覆盖选区保留、连续插图、等比缩小、表格宽度限制、宿主错误和任务窗格复用。它只验证调用契约，不能代替实际 WPS 操作。

2026-11-05，在 Windows WPS `12.1.0.29161` 中已观察到任务窗格和插图成功状态；用户反馈“我测试过了，可以插入”。下列项目分别记录：

- [x] 重启后出现“iPeiTu 配图”功能区并打开素材库
- [x] 在测试文档正文中插入中文文件名图片，界面反馈成功，用户确认可以插入
- [x] 全选测试文字后插入，保存后检查文字逐字相同，图片位于文字之后
- [x] 连续插入两张图片，实际显示顺序正确；光标定位另由模拟测试验证
- [ ] 在普通表格单元格内插入宽图，图片等比缩小且不撑宽表格
- [ ] 只读/受保护文档显示可理解的错误，无文档时不执行插入
- [x] 另存为新的测试 DOCX，关闭文档并停止素材服务后重开，文字与两张图片仍然存在；DOCX 内图片为 embed 关系
- [ ] 卸载并重启后 iPeiTu 条目消失，其他已安装加载项保留

实机测试仅使用新建测试文档，不覆盖用户现有标书。若验收发现宿主差异，应修复后更新测试和此记录。

v0.2 新增排版的逐项自动化与实机结果见 [V02-ACCEPTANCE.md](V02-ACCEPTANCE.md)。

## 一手依据

- [WPS 首个加载项教程](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/generate-the-first-wps-addin)：桌面加载项、功能区、任务窗格与官方工具链。
- [加载项开发及发布说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)：推荐 publish 模式，旧 jsplugins.xml 模式从 12.1.0.16910 开始受限。
- [官方 wpsjs 2.2.3 工具包](https://registry.npmjs.org/wpsjs/-/wpsjs-2.2.3.tgz)：已检查 `src/lib/debug_publish.js` 的 `configPublish`/`GetPublistXmlPath` 以及 `packages/@wps-jsapi/wps/` 模板。此版本模板包含 `index.html`，本实现采用该结构。
- [InlineShapes.AddPicture](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/InlineShapes/member/AddPicture)：位置由 Range 指定；未折叠的区域会被图片覆盖。
- [Range.Collapse](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Range/member/Collapse)：将区域折叠到起点或终点。
- [InlineShape](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/InlineShape/obj)：内嵌图片、比例锁定及以磅为单位的尺寸。
- [Cell](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Cell/obj)：单元格宽度与左右内边距。

这些是 WPS 桌面同步 JSAPI，不能与 WebOffice 在线编辑器的异步接口混用。
