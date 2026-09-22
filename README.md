# 骑马钉小册子 PDF 拼版（Booklet Imposer）

供小型印刷店使用的小册子 PDF 拼版 Web 应用。上传 PDF 后，系统按**每张纸容纳 4 页**的骑马钉规则自动重排页码，提供每张纸正反页序预览，并可下载拼版后的 PDF。支持可选的**分册签帖模式**：按纸张容量把长文档切成多个连续签帖分别骑马钉排版。另提供**独立的 PDF 印前校验报告**：上传后可先逐页检查页面尺寸、旋转角、透明度与可提取文字，按严重级别汇总并把相邻同类问题合并为区段，支持按级别筛选与下载 JSON；校验**只检查不拼版，且不阻断后续拼版**。

技术栈：Node.js + Express + 原生 HTML/CSS/JavaScript + [pdf-lib](https://pdf-lib.js.org/)。

## 印前校验报告（独立于拼版）

上传 PDF 后可先点击「运行印前校验」，服务端**仅逐页检查、不生成拼版文件**，返回结构化 JSON 报告。检查项与严重级别：

| 检查项 | 问题代码 | 严重级别 | 判定说明 |
| --- | --- | --- | --- |
| 页面尺寸 | `size_mismatch` | 警告 | 以多数页（主尺寸，容差 1pt）为准，标出物理介质尺寸不一致的页面 |
| 旋转角 90°/270° | `rotated_90_270` | 警告 | 页面带 `/Rotate`，阅读器中呈横向显示 |
| 旋转角 180° | `rotated_180` | 错误 | 内容上下颠倒，拼版后仍为颠倒状态 |
| 透明度 | `transparency` | 警告 | 页面透明图层组、非不透明 Alpha（`/ca`、`/CA`）、`/SMask` 软蒙版、非 Normal 混合模式（含 Form XObject 递归检测） |
| 可提取文字 | `no_extractable_text` | 提示 | 页面无文本绘制操作，或所用字体缺少 `ToUnicode`（扫描图/转曲页常见） |
| 末尾补白 | `blank_padding` | 提示（文档级） | 页数不是 4 的倍数时，提示拼版将补的空白页数 |

- **区段合并**：相邻页面的同类问题（同一代码）自动合并为一个区段，报告给出页码范围（`pageFrom`/`pageTo`/`pages`）、连续页数、逐页检测值（`detected`）与去重后的可读摘要（`values`），并附**修复建议**（`advice`）。
- **结论**：`summary.passed` 仅表示无**错误级**问题；警告/提示仍会列出。页面无法判定（如内容流使用了不支持的过滤器）时该页对应检查项跳过，避免误报。
- **不阻断拼版**：即使报告含错误，也仍可直接点击「开始拼版」；两个接口互不依赖。
- 前端提供：错误/警告/提示数量汇总卡、**按级别筛选**（全部/错误/警告/提示）、问题区段列表（范围 + 检测值 + 修复建议）、可展开的逐页检测明细表，以及「**下载 JSON 报告**」（文件名形如 `原名-印前校验报告.json`）。

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
2. （可选，建议先做）点击「运行印前校验」：查看错误/警告/提示汇总，按级别筛选问题区段，展开逐页明细，需要时下载 JSON 报告。校验不生成拼版文件，也不会阻止后续拼版。
3. （可选）勾选「启用分册签帖模式」，填写每帖最多纸张数（1～20）；不勾选则整册拼版。
4. 点击「开始拼版」（无论校验报告是否有问题都可以执行）。
5. 查看拼版摘要（原始页数 / 补白页数 / 用纸张数 / 统一面板尺寸 / 页面方向）与每张纸正反面的页码预览；斜纹块表示补的空白页。
   - 分册签帖模式下，摘要另列出各帖的**帖号、原始页范围、原始页数、帖末补白数与帖内纸张编号**，预览按帖分组并标注「第 N 帖 · 帖内第 M 张纸」。
6. 点击「下载拼版 PDF」保存（分册签帖模式也是单个文件，按帖序连续输出），文件名自动在原文件名后加 `-拼版` 后缀。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/preflight` | multipart 表单字段 `pdf` 上传 PDF；**只做印前校验，不生成拼版文件**，返回 JSON 报告（HTTP 200，即使报告含错误级问题）。缺字段/非 PDF 返回 `400`；损坏或加密 PDF 返回 `422` |
| `POST` | `/api/impose` | multipart 表单字段 `pdf` 上传 PDF；返回拼版 PDF，页序方案在响应头 `X-Imposition-Plan`（URL 编码的 JSON，含 `panel` 统一面板尺寸与方向）。可选字段：`signatureMode=on` 启用分册签帖，`maxSheetsPerSignature` 为每帖最多纸张数（1～20 整数；启用时必填，非法值返回 `400`） |
| `GET` | `/api/health` | 健康检查，返回 `{ "ok": true }` |

### 印前校验 JSON 报告结构

```jsonc
{
  "schemaVersion": 1,
  "tool": "booklet-imposer",
  "generatedAt": "2026-09-22T16:40:01.471Z",
  "file": { "name": "sample.pdf", "sizeBytes": 12345 },
  "pageCount": 7,
  "referenceSize": { "width": 595.3, "height": 841.9, "widthMm": 210, "heightMm": 297, "pageCount": 6 },
  "summary": {
    "error": 1, "warning": 2, "info": 2,
    "issuesTotal": 5, "pagesWithIssues": 4,
    "passed": false            // 仅当没有错误级问题时为 true
  },
  "issues": [
    {
      "code": "rotated_90_270",
      "severity": "warning",  // error / warning / info
      "title": "页面带 90°/270° 旋转角",
      "pageFrom": 2, "pageTo": 3, "pageCount": 2, "pages": [2, 3],
      "message": "第 2～3 页带 /Rotate 页面旋转（共 2 页）……",
      "values": [{ "label": "旋转角", "value": "90°（第 2～3 页）" }],
      "detected": [{ "page": 2, "detail": "90°" }, { "page": 3, "detail": "90°" }],
      "advice": "如非有意横版，请在源文档中固化/移除页面旋转……"
    }
    // 文档级问题（如 blank_padding）：pageFrom/pageTo/pageCount 为 null，pages 为 []
  ],
  "pages": [
    {
      "page": 1,
      "mediaWidth": 595.3, "mediaHeight": 841.9,
      "effectiveWidth": 595.3, "effectiveHeight": 841.9,
      "widthMm": 210, "heightMm": 297,
      "rotation": 0,
      "transparent": false,
      "textExtractable": true,   // true / false / null（无法判定）
      "issues": [{ "code": "...", "severity": "...", "title": "..." }]
    }
  ]
}
```

问题排序固定为：错误 → 警告 → 提示；同级按起始页码升序，文档级问题排在该级最后。问题代码（`code`）与严重级别语义保持稳定，便于外部脚本消费下载的 JSON。

### 拼版方案头

`X-Imposition-Plan` 结构：

- 整册模式（未启用签帖）：`{ sheets, sourceCount, paddedCount, totalCount, blanks, panel }`，与旧版完全一致。
- 分册签帖模式：`{ signatureMode: true, signatures: [{ signature, startPage, endPage, sourceCount, blanks, totalCount, sheets: [...] }], sourceCount, paddedCount, sheetCount, signatureCount, maxSheetsPerSignature, panel }`；各 `sheets` 槽位中的 `page` 为全局（整篇文档）页号，`sheet` 为帖内纸张编号。

## 目录结构

```
.
├── server.js             # Express 服务：上传、印前校验与拼版接口
├── lib/impose.js         # 骑马钉页序计算与 pdf-lib 拼版核心
├── lib/preflight.js      # 印前校验核心：逐页尺寸/旋转/透明度/文字检查与区段合并
├── public/               # 原生前端（index.html / style.css / app.js）
├── test/                 # 单测与端到端测试（impose / preflight / HTTP API）
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 测试

```bash
npm test
```

依次运行拼版算法单测、印前校验单测/端到端测试（构造含尺寸不一致、90°/180° 旋转、透明度、无文字页的 PDF，校验区段合并与严重级别）以及 HTTP 接口集成测试（验证校验报告含错误时拼版仍可成功，二者互不阻断）。测试不依赖 Docker，也不监听固定端口。
