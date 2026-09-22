'use strict';

const assert = require('assert');
const zlib = require('zlib');
const {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  PDFName,
  PDFDict,
  PDFRawStream,
  PDFContext,
} = require('pdf-lib');
const {
  preflightPdf,
  mergeSegments,
  normalizeRotation,
  decodePdfStream,
  TRANSPARENCY_SOURCE_LABELS,
} = require('../lib/preflight');

// ---------- 工具：构造 1×1 RGBA PNG（用于 SMask 软遮罩检测） ----------
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function rgba1x1Png(r, g, b, a) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b, a]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 1. 纯函数单测 ----------
assert.strictEqual(normalizeRotation(-90), 270);
assert.strictEqual(normalizeRotation(450), 90);
assert.strictEqual(normalizeRotation(0), 0);

// 1.1 区段合并：同类相邻页合并；不同 code 可交错、各自独立延伸
function issue(code, page, mergeKey) {
  return { code, mergeKey, pageDetail: { page } };
}
// 无合并键时，同 code 连续页合并，中间断开后另起区段
const merged = mergeSegments([
  [issue('transparency', 1)],
  [issue('transparency', 2), issue('sizeMismatch', 2)],
  [issue('transparency', 3)],
  [],
  [issue('transparency', 5)],
]);
assert.deepStrictEqual(
  merged.map((s) => [s.code, s.startPage, s.endPage, s.pageCount]),
  [['transparency', 1, 3, 3], ['size-mismatch', 2, 2, 1], ['transparency', 5, 5, 1]],
);
// 有合并键时，同 code 不同检测形态（如 alpha / SMask）分别成段：
// a-a 延续；第 3 页形态变为 b 时 a 段断开；第 4 页无此问题；第 5 页 a 为新段
const mergedByKey = mergeSegments([
  [issue('transparency', 1, 'extgstate-fill-alpha')],
  [issue('transparency', 2, 'extgstate-fill-alpha')],
  [issue('transparency', 3, 'xobject-smask')],
  [],
  [issue('transparency', 5, 'extgstate-fill-alpha')],
]);
assert.deepStrictEqual(
  mergedByKey.map((s) => [s.code, s.startPage, s.endPage, s.pageCount, s.mergeKey]),
  [
    ['transparency', 1, 2, 2, 'extgstate-fill-alpha'],
    ['transparency', 3, 3, 1, 'xobject-smask'],
    ['transparency', 5, 5, 1, 'extgstate-fill-alpha'],
  ],
);
// 单页区段与空文档输入
assert.deepStrictEqual(
  mergeSegments([[issue('rotation', 1)]]).map((s) => [s.startPage, s.endPage]),
  [[1, 1]],
);
assert.deepStrictEqual(mergeSegments([[], [], []]), []);
console.log('✅ 区段合并单测通过（相邻同类合并 / 交错独立延伸 / 合并键细分）');

// 1.2 流解码：ASCIIHex / ASCII85
const ctx = PDFContext.create();
function rawStream(filterName, payload) {
  const dict = PDFDict.withContext(ctx);
  if (filterName) dict.set(PDFName.of('Filter'), PDFName.of(filterName));
  return PDFRawStream.of(dict, payload);
}
assert.strictEqual(decodePdfStream(rawStream('ASCIIHexDecode', Buffer.from('48 65 6c 6c 6f >'))), 'Hello');
assert.strictEqual(decodePdfStream(rawStream('ASCII85Decode', Buffer.from('87cURD]i,"Ebo80~>'))), 'Hello World!');
assert.strictEqual(decodePdfStream(rawStream(false, Buffer.from('BT /F1 12 Tf (Hi) Tj ET'))), 'BT /F1 12 Tf (Hi) Tj ET');
// 不支持的过滤器（如 DCTDecode）返回 null 而非抛异常
assert.strictEqual(decodePdfStream(rawStream('DCTDecode', Buffer.from([1, 2, 3]))), null);
console.log('✅ 内容流解码单测通过（ASCIIHex / ASCII85 / 原始流 / 不支持过滤器）');

// ---------- 2. 端到端：干净 PDF ----------
(async () => {
  const cleanDoc = await PDFDocument.create();
  const cleanFont = await cleanDoc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i += 1) {
    const p = cleanDoc.addPage([595.28, 841.89]);
    p.drawText(`PAGE ${i + 1}`, { x: 100, y: 700, size: 24, font: cleanFont });
  }
  const cleanReport = await preflightPdf(await cleanDoc.save(), { fileName: 'clean.pdf' });
  assert.strictEqual(cleanReport.summary.pageCount, 4);
  assert.strictEqual(cleanReport.summary.status, 'clean');
  assert.strictEqual(cleanReport.segments.length, 0);
  assert.strictEqual(cleanReport.summary.errorCount, 0);
  assert.strictEqual(cleanReport.fileName, 'clean.pdf');
  assert.ok(Math.abs(cleanReport.reference.width - 595.3) < 0.01);
  assert.ok(Math.abs(cleanReport.reference.heightMm - 297) < 0.2);
  assert.strictEqual(cleanReport.reference.orientation, 'portrait');
  assert.ok(cleanReport.pages.every((p) => p.textState === 'present'));
  assert.ok(cleanReport.checks.length === 4);
  assert.ok(cleanReport.checkedAt);
  console.log('✅ 干净 PDF：不报告任何问题，参考尺寸与逐页数据正确');

  // ---------- 3. 端到端：四类问题全覆盖 + 区段合并 ----------
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // 8 页：第 1～6、8 页为 A4 竖版；第 7 页为 300×400 小页
  const pages = [];
  for (let i = 0; i < 8; i += 1) {
    pages.push(doc.addPage(i === 6 ? [300, 400] : [595.28, 841.89]));
  }

  // 文字：除第 6、7 页外都写文字（6 完全空白、7 纯图片）
  for (const idx of [0, 1, 2, 3, 4, 7]) {
    pages[idx].drawText(`TEXT ${idx + 1}`, { x: 100, y: 700, size: 24, font });
  }

  // 第 2、3 页带透明填充（error 区段 2-3）
  pages[1].drawText('TRANSPARENT', { x: 100, y: 600, size: 24, font, opacity: 0.5 });
  pages[2].drawText('TRANSPARENT', { x: 100, y: 600, size: 24, font, opacity: 0.3 });

  // 第 4 页放带 alpha 通道的 PNG（SMask 软遮罩）
  const alphaPng = rgba1x1Png(255, 0, 0, 128);
  const img = await doc.embedPng(alphaPng);
  pages[3].drawImage(img, { x: 100, y: 500, width: 40, height: 40 });

  // 第 4、5 页旋转 90°（info 区段 4-5；同尺寸旋转不算尺寸问题）
  pages[3].setRotation(degrees(90));
  pages[4].setRotation(degrees(90));

  // 第 7 页放图片但不写文字（纯图片页，warning：无提取文字）
  pages[6].drawImage(img, { x: 50, y: 300, width: 40, height: 40 });

  const bytes = await doc.save();
  const report = await preflightPdf(bytes);

  // 重新按页号取报告（页面已重排）
  assert.strictEqual(report.summary.pageCount, 8);
  const byCode = Object.fromEntries(report.segments.map((s) => [s.code, s]));

  // 透明：第 2、3 页 alpha -> 合并为区段 2-3；第 4 页 SMask 单独成段
  const transSegments = report.segments.filter((s) => s.code === 'transparency');
  assert.ok(transSegments.length >= 2, `透明区段数 ${transSegments.length}`);
  const alphaSeg = transSegments.find((s) => s.startPage === 2 && s.endPage === 3);
  assert.ok(alphaSeg, '第 2-3 页透明度应合并为同一区段');
  assert.strictEqual(alphaSeg.pageCount, 2);
  assert.deepStrictEqual(alphaSeg.pages.map((p) => p.page), [2, 3]);
  assert.ok(
    alphaSeg.pages[0].sourceLabels.includes(TRANSPARENCY_SOURCE_LABELS['extgstate-fill-alpha']),
    '检测值应标明 /ca 非不透明',
  );
  const smaskSeg = transSegments.find((s) => s.startPage === 4 && s.endPage === 4);
  assert.ok(smaskSeg, '第 4 页 alpha PNG 的 SMask 应单独成段');
  assert.ok(
    smaskSeg.pages[0].sourceLabels.some((l) => l.includes('SMask')),
    '检测值应标明 SMask 软遮罩',
  );

  // 旋转：第 4、5 页合并为 info 区段 4-5
  const rotSeg = byCode.rotation;
  assert.ok(rotSeg, '应存在旋转区段');
  assert.strictEqual(rotSeg.startPage, 4);
  assert.strictEqual(rotSeg.endPage, 5);
  assert.strictEqual(rotSeg.severity, 'info');
  assert.deepStrictEqual(rotSeg.pages.map((p) => p.rotation), [90, 90]);

  // 尺寸：仅第 7 页（300×400）报告，旋转的 A4 页不报告
  const sizeSeg = byCode['size-mismatch'];
  assert.ok(sizeSeg, '应存在尺寸不一致区段');
  assert.strictEqual(sizeSeg.startPage, 7);
  assert.strictEqual(sizeSeg.endPage, 7);
  assert.strictEqual(sizeSeg.severity, 'warning');
  assert.ok(Math.abs(sizeSeg.pages[0].actual.width - 300) < 0.01);
  assert.ok(Math.abs(sizeSeg.pages[0].expected.width - 595.3) < 0.01);

  // 无文字：第 6 页完全空白 -> 不报告；第 7 页纯图片 -> 报告 image-only
  const noTextSeg = byCode['no-extractable-text'];
  assert.ok(noTextSeg, '应存在无文字区段');
  assert.strictEqual(noTextSeg.startPage, 7);
  assert.strictEqual(noTextSeg.pages[0].reason, 'image-only');
  assert.strictEqual(report.pages[5].textState, 'blank', '空白页不应计入无文字');

  // 汇总计数
  const s = report.summary;
  assert.ok(s.errorCount >= 3, `严重页数 ${s.errorCount}`); // 2,3,4（若小页图片也带 alpha 则 3,7）
  assert.ok(s.warningCount >= 2, `警告页数 ${s.warningCount}`);
  assert.strictEqual(s.infoCount, 2);
  assert.strictEqual(s.issuesCount, s.errorCount + s.warningCount + s.infoCount);

  // 每个区段都带页码范围、检测值与修复建议
  for (const segment of report.segments) {
    assert.ok(segment.startPage <= segment.endPage);
    assert.ok(segment.pages.length > 0);
    const meta = report.checks.find((c) => c.code === segment.code);
    assert.ok(meta.advice && meta.advice.length > 0, `缺少 ${segment.code} 修复建议`);
    assert.strictEqual(segment.severity, meta.severity);
  }
  console.log('✅ 复杂 PDF：透明/尺寸/旋转/无文字四类检测与区段合并、计数、建议均正确');

  // ---------- 4. 无法解析的文件应抛错（交接口层返回 422） ----------
  await assert.rejects(
    () => preflightPdf(Buffer.from('not a pdf at all')),
    /不是有效的 PDF/,
  );
  await assert.rejects(
    () => preflightPdf(Buffer.from('%PDF-1.7\nthis is truncated garbage without xref')),
    /不是有效的 PDF/,
  );
  console.log('✅ 损坏文件 / 非 PDF 输入明确报错');

  // ---------- 5. 校验绝不产出拼版：返回值不含 pdfBytes ----------
  const r = await preflightPdf(await cleanDoc.save());
  assert.ok(!r.pdfBytes && !r.plan, '校验只返回报告，不生成拼版数据');
  console.log('✅ 校验过程不生成任何拼版文件/字节');

  console.log('\n全部印前校验测试通过 🎉');
})().catch((err) => {
  console.error('❌ 测试失败：', err);
  process.exit(1);
});
