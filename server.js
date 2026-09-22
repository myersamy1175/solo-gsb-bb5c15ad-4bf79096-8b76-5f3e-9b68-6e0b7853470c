'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { imposePdf, parseMaxSheetsPerSignature } = require('./lib/impose');
const { preflightPdf } = require('./lib/preflight');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024
  || 50 * 1024 * 1024;

// 上传文件仅保留在内存中（拼版后直接返回，不写磁盘）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * 判断上传内容是否为 PDF：以 PDF 文件头魔数为准；部分浏览器以
 * application/octet-stream 上传时，回退校验文件名后缀。
 */
function looksLikePdf(file) {
  if (!file) return false;
  if (file.buffer.slice(0, 5).toString('latin1') === '%PDF-') return true;
  return (!file.mimetype || file.mimetype === 'application/octet-stream')
    && /\.pdf$/i.test(file.originalname || '');
}

function missingFileResponse(res) {
  return res.status(400).json({ error: '请通过字段 pdf 上传一个 PDF 文件' });
}

// 印前校验接口：仅逐页检查并返回 JSON 报告，不生成拼版文件。
// 报告中即便存在错误/警告也以 200 返回（校验结果本身），不阻断后续拼版。
app.post('/api/preflight', upload.single('pdf'), async (req, res) => {
  if (!req.file) return missingFileResponse(res);
  if (!looksLikePdf(req.file)) {
    return res.status(400).json({ error: '仅支持 PDF 文件' });
  }
  try {
    const report = await preflightPdf(req.file.buffer, {
      fileName: req.file.originalname,
      sizeBytes: req.file.size,
    });
    return res.json(report);
  } catch (err) {
    return res.status(422).json({
      error: `无法校验该 PDF：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 拼版接口：上传 PDF，返回拼版后的 PDF；拼版页序方案通过响应头回传
app.post('/api/impose', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return missingFileResponse(res);
    }
    if (!looksLikePdf(req.file)) {
      return res.status(400).json({ error: '仅支持 PDF 文件' });
    }

    // 分册签帖模式：signatureMode=on 时启用；maxSheetsPerSignature 必须为 1～20 的整数
    const options = {};
    if (req.body && req.body.signatureMode === 'on') {
      try {
        options.maxSheetsPerSignature =
          parseMaxSheetsPerSignature(req.body.maxSheetsPerSignature);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    const { pdfBytes, plan } = await imposePdf(req.file.buffer, options);

    // 页序方案为纯 ASCII JSON，放入自定义响应头供前端渲染预览
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="booklet-imposed.pdf"');
    res.setHeader('X-Imposition-Plan', encodeURIComponent(JSON.stringify(plan)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Imposition-Plan');
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    const message = err && err.message ? err.message : '拼版失败';
    // 加密 PDF、损坏文件、超大文件等都返回 422，便于前端提示
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    return res.status(422).json({ error: `无法处理该 PDF：${message}` });
  }
});

// JSON 解析错误等兜底
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

// 直接运行时启动服务；被测试代码 require 时不监听端口
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`小册子拼版应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app };
