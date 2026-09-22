# 骑马钉小册子 PDF 拼版（Booklet Imposer）

供小型印刷店使用的小册子 PDF 拼版 Web 应用。上传 PDF 后，可先运行**独立的印前校验**（只检查、不生成拼版文件），再按**每张纸容纳 4 页**的骑马钉规则自动重排页码，提供每张纸正反页序预览，并可下载拼版后的 PDF。支持可选的**分册签帖模式**：按纸张容量把长文档切成多个连续签帖分别骑马钉排版。

技术栈：Node.js + Express + 原生 HTML/CSS/JavaScript + [pdf-lib](https://pdf-lib.js.org/)。

## 印前校验报告

上传 PDF 后点击「运行印前校验」即可单独检查文件，**不会生成任何拼版文件，校验结果也不阻断后续拼版**。服务端逐页检查以下项目，并按严重级别汇总：

| 检查项 | 级别 | 说明 |
| --- | --- | --- |
| 透明度 | 严重（error） | 页面（含递归进入的 Form XObject）使用了非不透明 `/CA`、`/ca`、非 Normal 混合模式 `/BM` 或 `/SMask` 软遮罩（如带 Alpha 通道的 PNG）；部分 RIP 不做透明拼合会输出异常 |
| 页面尺寸不一致 | 警告（warning） | 页面介质框（/MediaBox）与多数页参考尺寸不同（1pt 归组容差）；同尺寸页面带 90°/270° 旋转造成的宽高互换不计入 |
| 无可提取文字 | 警告（warning） | 页面内容流中没有 `Tj/TJ` 等文本绘制操作（扫描件、转曲文字）；完全空白页不报告 |
| 页面旋转角 | 提示（info） | 页面 `/Rotate` 非 0；拼版会自动适配，但印刷前通常建议统一 |

报告特性：

- **按级别汇总**：严重 / 警告 / 提示的页次计数，以及参考尺寸（多数页尺寸，含 pt 与 mm、方向）。
- **相邻页同类问题合并为区段**：每条问题给出页码范围（单页时显示单页）、区段页数、逐页检测值（实际尺寸 vs 参考尺寸、旋转角度、透明来源、无文字原因）和**修复建议**；同一检查项但检测形态不同（如填充透明度 vs 软遮罩）会分成不同区段。
- **前端报告列表与按级别筛选**：可在「全部 / 严重 / 警告 / 提示」之间切换。
- **下载 JSON 报告**：含完整逐页数据（`pages`）、区段（`segments`）、检查项元数据（`checks`）与汇总（`summary`），文件名自动加 `-印前校验.json` 后缀。
- 文件本身损坏/加密/非 PDF 时接口返回错误；**只要文件可解析，即使发现问题也返回 HTTP 200 的完整报告**，可继续直接拼版。

## 拼版规则

- 每张纸正反两面共放置 4 个页面（每面左右各一页）。
- 页数不是 4 的倍数时，在**文档末尾补空白页**后再拼版。
- 页码排列（从外向内，逐层递进）：
  - 第 1 张纸 **正面**：`末页 | 首页`
  - 第 1 张纸 **背面**：`第 2 页 | 倒数第 2 页`
  - 第 2 张纸 **正面**：`倒数第 3 页 | 第 3 页`
  - 第 2 张纸 **背面**：`第 4 页 | 倒数第 4 页`
  - ……依次向内递进。
- 输出纸张为横向，尺寸 = `2 × 面板宽` × `面板高`（如 A4 竖版小册子 → A3 横向）；每个原始页按**原页面尺寸 1:1**放置，不缩放。
- **混合尺寸适配**：各页尺寸或旋转方向（/Rotate）不一致时，按每页**旋转后的有效宽高**取全部页面宽高的最大值作为**统一面板尺寸**；每页按其显示方向 1:1 居中放入对应半区，空余区域透明留白。拼版摘要中会显示统一面板尺寸与页面方向（竖版 / 横版 / 方形）。

> 说明：页面尺寸不一致或带旋转的 PDF 会按上述规则自动适配，无需预先统一页面尺寸；页序与末尾补白规则不受影响。

### 分册签帖模式（可选）

当页数较多、整册骑马钉太厚不便折页装订时，可启用「分册签帖」：

1. 设置**每帖最多纸张数**（1～20 的整数，每张纸容纳 4 页，即单帖容量为 `4 × 纸张数`，4～80 页）。
2. 系统按**原页序**把文档切成容量为 `4 × 纸张数` 的连续签帖：前序各帖装满，**最后一帖不足上限时按实际页数所需纸张数收尾**。
3. 每个签帖**仅在该帖自身末尾补白**（0～3 页），并各自独立按骑马钉规则排版；帖内纸张编号独立从 1 开始。
4. 输出 PDF 按**帖号顺序连续**拼接为一个文件；摘要与预览中逐帖标明**帖号、原始页范围、帖末补白数与帖内纸张编号**，下载仍为单个 PDF。

非法上限（0、21、小数、非数字、空值等）会在前端即时拦截，后端同样返回 `400` 拒绝。未勾选启用时完全保持原有整册拼版行为，接口字段与方案结构均向后兼容。

## 一条命令启动（Docker Compose）

需安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up -d --build
```

镜像构建时自动完成 `npm install`，容器启动即服务就绪，无需手动安装依赖。

启动后访问：

```
http://localhost:3000
```

停止：

```bash
docker compose down
```

## 本地运行（不使用 Docker）

要求 Node.js >= 18。

```bash
npm install
npm start
```

然后访问 http://localhost:3000 。

运行测试（拼版 + 印前校验，无需外部依赖）：

```bash
npm test
```

## 配置

通过环境变量配置（在 `docker-compose.yml` 的 `environment` 中修改）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（容器内端口） |
| `MAX_FILE_SIZE_MB` | `50` | 单个上传 PDF 的大小上限（MB） |

如需更换宿主机映射端口，修改 `docker-compose.yml` 中 `ports` 的左侧端口，例如 `"8080:3000"`，然后访问 http://localhost:8080 。

> 每帖纸张数上限固定为 1～20（前端页面上的「每帖最多纸张数」与接口字段 `maxSheetsPerSignature` 均按此范围校验，非法值前后端都会拒绝），无需环境变量配置。

## 使用方式

1. 浏览器打开应用，点击或拖入要拼版的 PDF。
2. （可选）点击「运行印前校验」查看报告：按级别筛选问题、展开页码范围与检测值/修复建议，或下载 JSON 报告。校验**不会**生成拼版文件，也**不会阻断**后续拼版。
3. （可选）勾选「启用分册签帖模式」，填写每帖最多纸张数（1～20）；不勾选则整册拼版。
4. 点击「开始拼版」。
5. 查看拼版摘要（原始页数 / 补白页数 / 用纸张数 / 统一面板尺寸 / 页面方向）与每张纸正反面的页码预览；斜纹块表示补的空白页。
   - 分册签帖模式下，摘要另列出各帖的**帖号、原始页范围、原始页数、帖末补白数与帖内纸张编号**，预览按帖分组并标注「第 N 帖 · 帖内第 M 张纸」。
6. 点击「下载拼版 PDF」保存（分册签帖模式也是单个文件，按帖序连续输出），文件名自动在原文件名后加 `-拼版` 后缀。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/preflight` | multipart 字段 `pdf` 上传 PDF；**只运行印前校验并返回 JSON 报告，不生成拼版文件**。发现问题时仍返回 `200`（报告 `summary.status` 为 `issues-found`/`clean`）；非 PDF 返回 `400`，损坏/加密文件返回 `422`。超大文件返回 `413` |
| `POST` | `/api/impose` | multipart 表单字段 `pdf` 上传 PDF；返回拼版 PDF，页序方案在响应头 `X-Imposition-Plan`（URL 编码的 JSON，含 `panel` 统一面板尺寸与方向）。可选字段：`signatureMode=on` 启用分册签帖，`maxSheetsPerSignature` 为每帖最多纸张数（1～20 整数；启用时必填，非法值返回 `400`） |
| `GET` | `/api/health` | 健康检查，返回 `{ "ok": true }` |

`POST /api/preflight` 返回的报告结构：

```jsonc
{
  "schemaVersion": "1.0",
  "checkedAt": "2026-09-22T08:00:00.000Z",
  "fileName": "demo.pdf",
  "summary": {
    "pageCount": 8,
    "issuesCount": 5,            // 问题页次总数（error+warning+info）
    "errorCount": 3,
    "warningCount": 1,
    "infoCount": 1,
    "segmentCount": 4,
    "inspectionErrorCount": 0,
    "status": "issues-found"     // 无任何问题时为 "clean"
  },
  "checks": [                    // 检查项元数据：对外 code / 中文标签 / 级别 / 修复建议 / 影响页数
    { "code": "transparency", "label": "页面使用了透明效果", "severity": "error", "advice": "…", "affectedPages": 3 }
    // …size-mismatch / no-extractable-text / rotation
  ],
  "reference": { "width": 595.3, "height": 841.9, "widthMm": 210, "heightMm": 297, "orientation": "portrait" },
  "segments": [                  // 相邻同类问题合并后的区段
    {
      "code": "transparency",
      "severity": "error",
      "startPage": 2, "endPage": 3, "pageCount": 2,
      "mergeKey": "extgstate-fill-alpha",
      "pages": [                 // 区段内每页的检测值
        { "page": 2, "sources": ["extgstate-fill-alpha"], "sourceLabels": ["ExtGState 非不透明填充透明度（/ca）"] }
      ]
    }
    // size-mismatch 的 pages 为 { page, actual:{width,height}, expected:{width,height} }；
    // rotation 为 { page, rotation }；no-extractable-text 为 { page, reason, hasFontResource }
  ],
  "pages": [ /* 逐页完整数据：介质/有效尺寸、rotation、transparent、transparencySources、textState 等 */ ]
}
```

`X-Imposition-Plan` 结构：

- 整册模式（未启用签帖）：`{ sheets, sourceCount, paddedCount, totalCount, blanks, panel }`，与旧版完全一致。
- 分册签帖模式：`{ signatureMode: true, signatures: [{ signature, startPage, endPage, sourceCount, blanks, totalCount, sheets: [...] }], sourceCount, paddedCount, sheetCount, signatureCount, maxSheetsPerSignature, panel }`；各 `sheets` 槽位中的 `page` 为全局（整篇文档）页号，`sheet` 为帖内纸张编号。

## 目录结构

```
.
├── server.js             # Express 服务：上传/下载拼版接口与印前校验接口
├── lib/impose.js         # 骑马钉页序计算与 pdf-lib 拼版核心
├── lib/preflight.js      # PDF 印前校验：逐页尺寸/旋转/透明度/可提取文字检查与区段合并
├── public/               # 原生前端（index.html / style.css / app.js，含报告列表/级别筛选/JSON 下载）
├── test/impose.test.js   # 拼版算法与端到端测试
├── test/preflight.test.js# 印前校验单测与端到端测试
├── Dockerfile
├── docker-compose.yml
└── package.json
```
