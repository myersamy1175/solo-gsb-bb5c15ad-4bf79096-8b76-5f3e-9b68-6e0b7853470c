'use strict';

// HTTP 集成测试：不监听固定端口，直接在 ephemeral 端口上启动 app。
const assert = require('assert');
const http = require('http');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { app } = require('../server');

function multipartBody(fields, boundary) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields.text || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of fields.files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
        + `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request(server, method, urlPath, { body, headers } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: headers || {},
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    // 构造 5 页问题 PDF：尺寸不一致 + 无文字页 + 非 4 倍数
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i += 1) {
      const p = src.addPage([595.28, 841.89]);
      p.drawText(`PAGE ${i}`, { x: 80, y: 400, size: 24, font, color: rgb(0, 0, 0) });
    }
    const rotated = src.addPage([595.28, 841.89]);
    rotated.setRotation(degrees(180));
    rotated.drawText('ROTATED', { x: 80, y: 400, size: 24, font });
    const pdfBytes = Buffer.from(await src.save());

    // 1. 健康检查
    const health = await request(server, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body.toString()), { ok: true });

    // 2. 印前校验返回 JSON 报告（不返回 PDF），含 180° 错误也仍为 200
    const boundary = '----test-boundary';
    const body = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const preflightResp = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(preflightResp.status, 200);
    assert.ok(!preflightResp.headers['content-type'].includes('pdf'));
    const report = JSON.parse(preflightResp.body.toString());
    assert.strictEqual(report.pageCount, 5);
    assert.strictEqual(report.summary.passed, false);
    assert.ok(report.issues.some((i) => i.code === 'rotated_180' && i.pageFrom === 5));
    assert.ok(report.issues.some((i) => i.code === 'blank_padding'));

    // 3. 缺少文件 -> 400；非 PDF -> 400；垃圾内容 -> 422
    const empty = multipartBody({}, boundary);
    const missing = await request(server, 'POST', '/api/preflight', {
      body: empty,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': empty.length },
    });
    assert.strictEqual(missing.status, 400);

    const txtBody = multipartBody({
      files: [{ field: 'pdf', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') }],
    }, boundary);
    const badType = await request(server, 'POST', '/api/preflight', {
      body: txtBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': txtBody.length },
    });
    assert.strictEqual(badType.status, 400);

    const garbageBody = multipartBody({
      files: [{ field: 'pdf', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') }],
    }, boundary);
    const garbage = await request(server, 'POST', '/api/preflight', {
      body: garbageBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': garbageBody.length },
    });
    assert.strictEqual(garbage.status, 422);
    assert.match(JSON.parse(garbage.body.toString()).error, /无法校验/);

    // 4. 校验失败/有错误不阻断：同一文件仍可拼版，返回 application/pdf
    const imposeBody = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const imposeResp = await request(server, 'POST', '/api/impose', {
      body: imposeBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': imposeBody.length },
    });
    assert.strictEqual(imposeResp.status, 200);
    assert.ok(imposeResp.headers['content-type'].includes('application/pdf'));
    assert.ok(imposeResp.headers['x-imposition-plan']);
    const imposedPdf = await PDFDocument.load(imposeResp.body);
    // 5 页 -> 补 3 白 -> 8 面板 -> 2 张纸 -> 4 个输出页
    assert.strictEqual(imposedPdf.getPageCount(), 4);

    console.log('✅ HTTP 集成测试通过：preflight 200 返回 JSON（含错误不阻断），缺文件 400，');
    console.log('   非 PDF 400，损坏文件 422；同一份带错误报告的 PDF 仍可成功 /api/impose');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
