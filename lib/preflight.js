'use strict';

const zlib = require('zlib');
const { PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray } = require('pdf-lib');

/**
 * 独立的 PDF 印前校验（preflight）。
 *
 * 只检查、不产出任何拼版文件。逐页检查：
 *   1. 页面尺寸（介质框 /MediaBox 与多数页是否一致，1pt 取整归组；
 *      同尺寸页面带 90°/270° 旋转造成的宽高互换是有意横排，不算不一致）；
 *   2. 页面旋转角（/Rotate 非 0，拼版虽可适配但印刷前通常需要统一）；
 *   3. 透明度（ExtGState 中的非不透明透明度 / 非 Normal 混合模式 / SMask 软遮罩，
 *      递归进入 Form XObject；RIP 不支持透明拼合时可能出问题）；
 *   4. 可提取文字（内容流中是否存在 Tj/TJ 等文本绘制操作；
 *      扫描件/轮廓字页面无法检索文字；完全空白页不报告）。
 *
 * 问题按 error / warning / info 三级汇总；相邻页的同类问题合并为「区段」，
 * 区段中保留每页的检测值，供前端展示页码范围、检测值与修复建议。
 */

const SEVERITIES = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

// 检查项元数据（顺序即报告中的排列顺序）
const CHECKS = {
  transparency: {
    code: 'transparency',
    label: '页面使用了透明效果',
    severity: SEVERITIES.ERROR,
    advice: '使用 Acrobat「拼合透明度」或在排版软件中拼合透明度后重新导出 PDF（PDF/X-1a 等标准不允许透明）。',
  },
  sizeMismatch: {
    code: 'size-mismatch',
    label: '页面尺寸与多数页不一致',
    severity: SEVERITIES.WARNING,
    advice: '在排版软件中统一页面尺寸（或出血/裁切框）后重新导出；拼版时该页会 1:1 居中放入统一面板，周边可能留白。页面旋转导致的宽高互换不计入此项。',
  },
  noExtractableText: {
    code: 'no-extractable-text',
    label: '页面缺少可提取文字',
    severity: SEVERITIES.WARNING,
    advice: '若为扫描件，请先做 OCR；若文字已转曲/转轮廓，请视印刷需要保留带嵌入字体的可检索版本。',
  },
  rotation: {
    code: 'rotation',
    label: '页面带旋转角（/Rotate 非 0）',
    severity: SEVERITIES.INFO,
    advice: '拼版会按显示方向自动适配；如需彻底统一，可在 Acrobat 中取消页面旋转后重新导出。',
  },
};

const CHECK_ORDER = ['transparency', 'sizeMismatch', 'noExtractableText', 'rotation'];

// 尺寸归组容差：四舍五入到整数 pt（约 0.35mm）以内视为同一尺寸
const SIZE_TOLERANCE_PT = 1;

// 透明来源（detected.sources 元素）的中文说明
const TRANSPARENCY_SOURCE_LABELS = {
  'extgstate-fill-alpha': 'ExtGState 非不透明填充透明度（/ca）',
  'extgstate-stroke-alpha': 'ExtGState 非不透明描边透明度（/CA）',
  'extgstate-blend-mode': 'ExtGState 使用非标准混合模式（/BM）',
  'extgstate-smask': 'ExtGState 引用软遮罩（/SMask）',
  'xobject-smask': '图像/Form XObject 带软遮罩（/SMask）',
};

// ---------- pdf-lib 底层对象工具 ----------

/**
 * 解引用 PDF 间接对象；直接对象原样返回。lookup 失败（对象缺失/损坏）时返回 null。
 */
function deref(context, obj, depth = 0) {
  if (obj === null || obj === undefined || depth > 20) return obj;
  if (obj !== null && typeof obj === 'object' && isRef(obj)) {
    try {
      return context.lookup(obj);
    } catch (_) {
      return null;
    }
  }
  return obj;
}

/**
 * 判断是否为 pdf-lib 间接引用（PDFRef）：1.17 中 objectNumber 是数字属性。
 */
function isRef(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const num = typeof obj.objectNumber === 'function'
    ? obj.objectNumber()
    : obj.objectNumber;
  return typeof num === 'number';
}

function refKey(obj) {
  const num = typeof obj.objectNumber === 'function' ? obj.objectNumber() : obj.objectNumber;
  const gen = typeof obj.generation === 'function' ? obj.generation() : (obj.generation || 0);
  return `ref:${num}:${gen}`;
}

function asNumber(value) {
  if (value instanceof PDFNumber) return value.asNumber();
  if (typeof value === 'number') return value;
  if (value && typeof value.value === 'number') return value.value;
  return NaN;
}

function isDict(obj) {
  return obj instanceof PDFDict;
}

/**
 * 读取 PDFName 的名称字符串（pdf-lib 1.17 使用 encodedName/decodeText）。
 */
function nameOf(pdfName) {
  if (!(pdfName instanceof PDFName)) return null;
  if (typeof pdfName.decodeText === 'function') return pdfName.decodeText();
  return pdfName.encodedName || pdfName.encodedText || null;
}

function isStream(obj) {
  return obj !== null && typeof obj === 'object' && typeof obj.getContents === 'function'
    && typeof obj.dict === 'object';
}

/**
 * 收集页面资源字典；资源可沿页树继承（PDF 规范允许 /Resources 写在父节点上）。
 */
function collectInheritedResources(pageNode, context, maxDepth = 50) {
  let node = pageNode;
  for (let i = 0; i < maxDepth && isDict(node); i += 1) {
    const resources = node.get(PDFName.of('Resources'));
    const resolved = resources ? context.lookup(resources) : null;
    if (isDict(resolved)) return resolved;
    const parent = node.get(PDFName.of('Parent'));
    if (!parent) break;
    node = context.lookup(parent);
  }
  return null;
}

/**
 * 按 /Filter 链解码流内容（raw bytes -> 解码后字符串）。
 * 支持 FlateDecode（含 PNG/ TIFF predictor 反预测）、ASCIIHexDecode、ASCII85Decode；
 * 其余过滤器（DCT/JPX 等）或解码失败返回 null。
 */
function decodePdfStream(stream) {
  try {
    let bytes = Buffer.from(stream.getContents());
    const dict = isDict(stream.dict) ? stream.dict : null;
    const filterValue = dict ? dict.get(PDFName.of('Filter')) : null;
    const filterResolved = filterValue ? dict.context.lookup(filterValue) : null;
    const filters = [];
    if (filterResolved instanceof PDFName) {
      filters.push(nameOf(filterResolved));
    } else if (filterResolved instanceof PDFArray) {
      for (const f of filterResolved.asArray()) {
        const name = f instanceof PDFName ? nameOf(f) : null;
        if (name) filters.push(name);
      }
    }

    const parmsValue = dict ? dict.get(PDFName.of('DecodeParms')) : null;
    const parmsResolved = parmsValue ? dict.context.lookup(parmsValue) : null;

    filters.forEach((filterName, idx) => {
      let parm = null;
      if (parmsResolved instanceof PDFDict) parm = parmsResolved;
      else if (parmsResolved instanceof PDFArray) parm = parmsResolved.lookup(idx);

      switch (filterName) {
        case 'FlateDecode':
        case 'Fl':
          bytes = zlib.inflateSync(bytes);
          bytes = unpredictedFlate(bytes, parm);
          break;
        case 'ASCIIHexDecode':
        case 'AHx':
          bytes = decodeAsciiHex(bytes);
          break;
        case 'ASCII85Decode':
        case 'A85':
          bytes = decodeAscii85(bytes);
          break;
        default:
          // LZWDecode / CCITTFaxDecode / DCTDecode 等：内容不是文本载体，按「无法解码」处理
          throw new Error(`unsupported filter ${filterName}`);
      }
    });
    return bytes.toString('latin1');
  } catch (_) {
    return null;
  }
}

/**
 * FlateDecode 的 PNG（1～15）与 TIFF（2）predictor 反预测。
 */
function unpredictedFlate(bytes, parm) {
  if (!isDict(parm)) return bytes;
  const predictor = asNumber(parm.get(PDFName.of('Predictor'))) || 1;
  if (predictor === 1) return bytes;

  const colors = asNumber(parm.get(PDFName.of('Colors'))) || 1;
  const bitsPerComponent = asNumber(parm.get(PDFName.of('BitsPerComponent'))) || 8;
  const columns = asNumber(parm.get(PDFName.of('Columns'))) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLen = Math.ceil((columns * colors * bitsPerComponent) / 8);

  if (predictor === 2) {
    // TIFF predictor：仅支持每分量 8 位的字节级差分
    if (bitsPerComponent !== 8) return bytes;
    const out = Buffer.from(bytes);
    for (let row = 0; row * rowLen < out.length; row += 1) {
      const start = row * rowLen;
      for (let i = bpp; i < rowLen && start + i < out.length; i += 1) {
        out[start + i] = (out[start + i] + out[start + i - bpp]) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors（10～15）：每行首字节为滤波类型
  const rows = [];
  let offset = 0;
  let prev = Buffer.alloc(rowLen);
  while (offset < bytes.length) {
    const tag = bytes[offset];
    offset += 1;
    const row = bytes.slice(offset, offset + rowLen);
    offset += rowLen;
    const recon = Buffer.alloc(rowLen);
    for (let i = 0; i < rowLen; i += 1) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prev[i] || 0;
      const upLeft = i >= bpp ? prev[i - bpp] || 0 : 0;
      let val = row[i] || 0;
      switch (tag) {
        case 0: break;
        case 1: val = (val + left) & 0xff; break;
        case 2: val = (val + up) & 0xff; break;
        case 3: val = (val + ((left + up) >> 1)) & 0xff; break;
        case 4:
          val = (val + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          // 未知滤波类型：该流不可靠，交给上层按解码失败处理
          throw new Error('unsupported PNG predictor tag');
      }
      recon[i] = val;
    }
    rows.push(recon);
    prev = recon;
  }
  return Buffer.concat(rows);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeAsciiHex(bytes) {
  const cleaned = bytes.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
  const hex = cleaned.endsWith('>') ? cleaned.slice(0, -1) : cleaned;
  const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
  return Buffer.from(padded, 'hex');
}

function decodeAscii85(bytes) {
  let str = bytes.toString('latin1');
  const eod = str.indexOf('~>');
  if (eod >= 0) str = str.slice(0, eod);
  str = str.replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (const ch of str) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 117) throw new Error('bad ASCII85 digit');
    group.push(code - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length) {
    if (group.length === 1) throw new Error('bad ASCII85 tail');
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytesCount = group.length - 1;
    if (bytesCount >= 1) out.push((value >>> 24) & 0xff);
    if (bytesCount >= 2) out.push((value >>> 16) & 0xff);
    if (bytesCount >= 3) out.push((value >>> 8) & 0xff);
  }
  return Buffer.from(out);
}

// ---------- 单页分析 ----------

/**
 * 递归扫描资源字典：ExtGState 透明度、Form XObject 内的资源；返回
 * { sources: Set<string>, fontCount, formStreams: Array, imageCount }。
 */
function scanResources(context, resources, state, depth) {
  if (!isDict(resources) || depth > 30) return;

  const extg = deref(context, resources.get(PDFName.of('ExtGState')), depth + 1);
  if (isDict(extg)) {
    for (const [, rawEntry] of extg.entries()) {
      const entry = deref(context, rawEntry, depth + 1);
      if (!isDict(entry)) continue;
      const caStrokeRaw = deref(context, entry.get(PDFName.of('CA')), depth + 1);
      const caFillRaw = deref(context, entry.get(PDFName.of('ca')), depth + 1);
      if (caFillRaw && asNumber(caFillRaw) < 1 - 1e-9) state.sources.add('extgstate-fill-alpha');
      if (caStrokeRaw && asNumber(caStrokeRaw) < 1 - 1e-9) state.sources.add('extgstate-stroke-alpha');

      const bm = deref(context, entry.get(PDFName.of('BM')), depth + 1);
      let bmName = null;
      if (bm instanceof PDFName) bmName = nameOf(bm);
      else if (bm instanceof PDFArray) {
        // [/BlendMode /Multiply] 形式
        const second = deref(context, bm.lookup(1), depth + 1);
        if (second instanceof PDFName) bmName = nameOf(second);
      }
      const normalNames = ['Normal', 'Compatible'];
      if (bmName && normalNames.indexOf(bmName) === -1) state.sources.add('extgstate-blend-mode');

      const smask = deref(context, entry.get(PDFName.of('SMask')), depth + 1);
      if (smask) state.sources.add('extgstate-smask');
    }
  }

  const fonts = deref(context, resources.get(PDFName.of('Font')), depth + 1);
  if (isDict(fonts)) state.fontCount += fonts.entries().length;

  const xobjects = deref(context, resources.get(PDFName.of('XObject')), depth + 1);
  if (isDict(xobjects)) {
    for (const [, rawXobj] of xobjects.entries()) {
      visitXObject(context, rawXobj, state, depth + 1, resources);
    }
  }
}

function visitXObject(context, rawXobj, state, depth, inheritedResources) {
  if (depth > 30) return;
  // 间接对象按对象号去重（同一 XObject 被引用多次时只扫描一次）
  if (isRef(rawXobj)) {
    const key = refKey(rawXobj);
    if (state.visited.has(key)) return;
    state.visited.add(key);
  }

  const xobj = deref(context, rawXobj, depth);
  if (!isStream(xobj)) return;
  const subtype = xobj.dict.get(PDFName.of('Subtype'));
  const subtypeName = subtype instanceof PDFName ? nameOf(subtype) : null;

  if (subtypeName === 'Form') {
    state.formCount += 1;
    const formSmask = deref(context, xobj.dict.get(PDFName.of('SMask')), depth + 1);
    if (formSmask) state.sources.add('xobject-smask');
    // Form 自带 /Resources，缺省则继承所在页/外层 Form 的资源
    const formResources = deref(context, xobj.dict.get(PDFName.of('Resources')), depth + 1);
    scanResources(context, isDict(formResources) ? formResources : inheritedResources, state, depth + 1);
    state.formStreams.push(xobj);
  } else if (subtypeName === 'Image') {
    state.imageCount += 1;
    const imageSmask = deref(context, xobj.dict.get(PDFName.of('SMask')), depth + 1);
    if (imageSmask) state.sources.add('xobject-smask');
  }
}

/**
 * 文本绘制操作：Tj / TJ / ' / "（均出现在 BT…ET 文本块内）。
 * 使用负向断言避免匹配到前面直接跟字母的片段（如标识符中的 Tj）。
 */
const TEXT_SHOW_RE = /(^|[^A-Za-z])(?:Tj|TJ|'|")/g;

/**
 * 分析单页：尺寸/旋转角/透明来源/文本与内容判定。
 */
function analyzePage(context, page, pageNumber, effective) {
  const node = page.node;
  const state = {
    sources: new Set(),
    fontCount: 0,
    formCount: 0,
    imageCount: 0,
    formStreams: [],
    visited: new Set(),
  };

  const resources = collectInheritedResources(node, context);
  if (resources) scanResources(context, resources, state, 0);

  // 收集页面自身与可达 Form XObject 的全部解码内容流
  const decodedStreams = [];
  const undecodableStreams = [];

  const rawContents = node.get(PDFName.of('Contents'));
  const contentRefs = rawContents
    ? (() => {
        const c = context.lookup(rawContents);
        return c instanceof PDFArray ? c.asArray() : [rawContents];
      })()
    : [];
  for (const ref of contentRefs) {
    const stream = context.lookup(ref);
    if (!isStream(stream)) continue;
    const text = decodePdfStream(stream);
    if (text === null) undecodableStreams.push(stream);
    else decodedStreams.push(text);
  }
  for (const formStream of state.formStreams) {
    const text = decodePdfStream(formStream);
    if (text === null) undecodableStreams.push(formStream);
    else decodedStreams.push(text);
  }

  const combined = decodedStreams.join('\n');
  const textShowPattern = new RegExp(TEXT_SHOW_RE.source, 'g');
  const hasTextOps = textShowPattern.test(combined);
  const hasMarks = combined.replace(/\s+/g, '').length > 0 || state.imageCount > 0;
  const hasFontResource = state.fontCount > 0;

  let textState;
  if (hasTextOps) {
    textState = 'present';
  } else if (!hasMarks && state.imageCount === 0) {
    // 完全空白页：不报告「无文字」
    textState = 'blank';
  } else if (undecodableStreams.length > 0 && decodedStreams.length === 0) {
    // 内容流全部无法解码：无法判定，不轻易误报
    textState = 'unknown';
  } else if (hasFontResource && undecodableStreams.length > 0) {
    // 有字体资源但存在无法解码的流（文字可能藏在其中）：保守起见标记未知
    textState = 'unknown';
  } else {
    textState = 'absent';
  }

  return {
    page: pageNumber,
    width: round1(effective.width),
    height: round1(effective.height),
    mediaWidth: round1(page.getWidth()),
    mediaHeight: round1(page.getHeight()),
    rotation: effective.rotation,
    transparent: state.sources.size > 0,
    transparencySources: [...state.sources],
    textState,
    hasFontResource,
    imageCount: state.imageCount,
    streamCount: contentRefs.length + state.formStreams.length,
    undecodableStreamCount: undecodableStreams.length,
  };
}

/**
 * 以多数票（mode）确定参考尺寸；同票时取最先出现的尺寸。
 */
function referenceSize(pageInfos) {
  const groups = new Map();
  for (const info of pageInfos) {
    const key = `${info.width}x${info.height}`;
    if (!groups.has(key)) {
      groups.set(key, { width: info.width, height: info.height, count: 0, firstPage: info.page });
    }
    groups.get(key).count += 1;
  }
  let winner = null;
  for (const group of groups.values()) {
    if (!winner
      || group.count > winner.count
      || (group.count === winner.count && group.firstPage < winner.firstPage)) {
      winner = group;
    }
  }
  return { width: winner.width, height: winner.height };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * 把逐页问题合并为相邻页区段：同一 code 且同一「合并键」的连续页号归入同一区段
 * （不同 code、或同 code 不同检测形态的区段可以交错，各自独立延伸）。
 * 合并键由 issue.mergeKey 提供；缺省只按 code 合并。
 */
function mergeSegments(perPageIssues) {
  const open = new Map(); // `${code} ${mergeKey}` -> 当前未闭合区段
  const segments = [];

  const flush = (key) => {
    const segment = open.get(key);
    if (segment) {
      segments.push(segment);
      open.delete(key);
    }
  };

  for (let i = 0; i < perPageIssues.length; i += 1) {
    const pageNumber = i + 1;
    const onPage = new Map();
    for (const issue of perPageIssues[i]) {
      onPage.set(issue.code, issue);
    }
    for (const code of CHECK_ORDER) {
      const issue = onPage.get(code);
      const key = issue ? code + ' ' + (issue.mergeKey || '') : null;
      if (issue) {
        if (!open.has(key)) {
          open.set(key, {
            code: CHECKS[code].code,
            internalCode: code,
            mergeKey: issue.mergeKey || null,
            severity: CHECKS[code].severity,
            startPage: pageNumber,
            endPage: pageNumber,
            pageCount: 0,
            pages: [],
          });
        }
        open.get(key).endPage = pageNumber;
      }
      // 该 code 下其他仍打开的键（本页缺失、或检测形态不同）在本页断开
      for (const openKey of [...open.keys()]) {
        if (openKey.startsWith(code + ' ') && openKey !== key) flush(openKey);
      }
    }
  }
  for (const key of [...open.keys()]) flush(key);

  // 回填每页检测值
  for (const segment of segments) {
    for (let p = segment.startPage; p <= segment.endPage; p += 1) {
      const issue = perPageIssues[p - 1].find((item) => CHECKS[item.code].code === segment.code
        && (item.mergeKey || '') === (segment.mergeKey || ''));
      if (issue) segment.pages.push(issue.pageDetail);
    }
    segment.pageCount = segment.pages.length;
  }

  // 排序：起始页优先，同起始页按检查项固定顺序（严重级别自然靠前），
  // 同检查项再按合并键（如不同的透明来源）排序
  segments.sort((a, b) => (a.startPage - b.startPage)
    || (CHECK_ORDER.indexOf(a.internalCode) - CHECK_ORDER.indexOf(b.internalCode))
    || String(a.mergeKey || '').localeCompare(String(b.mergeKey || '')));
  for (const segment of segments) delete segment.internalCode;
  return segments;
}

/**
 * 执行印前校验，返回报告对象（不生成任何拼版文件）。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ fileName?: string }} [options]
 * @returns {Promise<object>} 结构化校验报告
 */
async function preflightPdf(sourceBytes, options = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    doc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密），无法校验');
  }

  const pages = doc.getPages();
  const pageCount = pages.length;
  if (pageCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }

  const context = doc.context;
  // 每页的介质尺寸（未旋转）与旋转后的有效显示尺寸
  const pageSizes = pages.map((page) => {
    const rotation = normalizeRotation(page.getRotation().angle);
    const mediaWidth = page.getWidth();
    const mediaHeight = page.getHeight();
    const swapped = rotation === 90 || rotation === 270;
    return {
      rotation,
      mediaWidth,
      mediaHeight,
      width: swapped ? mediaHeight : mediaWidth,
      height: swapped ? mediaWidth : mediaHeight,
    };
  });

  // 参考尺寸以**介质框**为准：同尺寸页面带 90°/270° 旋转是有意横排，不算尺寸不一致
  const ref = referenceSize(pageSizes.map((size, idx) => ({
    width: round1(size.mediaWidth),
    height: round1(size.mediaHeight),
    page: idx + 1,
  })));

  const pageReports = [];
  const perPageIssues = [];
  let inspectionErrorCount = 0;

  pages.forEach((page, idx) => {
    const pageNumber = idx + 1;
    const sizeInfo = pageSizes[idx];
    let info;
    try {
      info = analyzePage(context, page, pageNumber, sizeInfo);
    } catch (err) {
      inspectionErrorCount += 1;
      info = {
        page: pageNumber,
        width: round1(sizeInfo.width),
        height: round1(sizeInfo.height),
        mediaWidth: round1(sizeInfo.mediaWidth),
        mediaHeight: round1(sizeInfo.mediaHeight),
        rotation: sizeInfo.rotation,
        transparent: false,
        transparencySources: [],
        textState: 'unknown',
        hasFontResource: false,
        imageCount: 0,
        streamCount: 0,
        undecodableStreamCount: 0,
        inspectionError: (err && err.message) || '页面分析失败',
      };
    }
    pageReports.push(info);

    const issues = [];

    // 1. 介质尺寸一致性（1pt 取整归组；旋转导致的宽高互换不计）
    const sameSize = Math.abs(info.mediaWidth - ref.width) < SIZE_TOLERANCE_PT
      && Math.abs(info.mediaHeight - ref.height) < SIZE_TOLERANCE_PT;
    if (!sameSize) {
      issues.push({
        code: 'sizeMismatch',
        pageDetail: {
          page: pageNumber,
          actual: { width: info.mediaWidth, height: info.mediaHeight },
          expected: { width: ref.width, height: ref.height },
        },
      });
    }

    // 2. 旋转角
    if (info.rotation !== 0) {
      issues.push({
        code: 'rotation',
        pageDetail: { page: pageNumber, rotation: info.rotation },
      });
    }

    // 3. 透明度（按透明来源组合细分合并：alpha 与 SMask 是不同的检测形态）
    if (info.transparent) {
      issues.push({
        code: 'transparency',
        mergeKey: [...info.transparencySources].sort().join('+'),
        pageDetail: {
          page: pageNumber,
          sources: info.transparencySources,
          sourceLabels: info.transparencySources.map((s) => TRANSPARENCY_SOURCE_LABELS[s] || s),
        },
      });
    }

    // 4. 可提取文字（空白页不报告；无法可靠判定时不报告）
    if (info.textState === 'absent') {
      issues.push({
        code: 'noExtractableText',
        pageDetail: {
          page: pageNumber,
          reason: info.imageCount > 0 ? 'image-only' : 'no-text-operators',
          hasFontResource: info.hasFontResource,
        },
      });
    }

    perPageIssues.push(issues);
  });

  const segments = mergeSegments(perPageIssues);

  // 按级别 / 按检查项汇总
  const counts = {
    error: 0,
    warning: 0,
    info: 0,
    byCode: {
      transparency: 0,
      'size-mismatch': 0,
      'no-extractable-text': 0,
      rotation: 0,
    },
  };
  for (const segment of segments) {
    counts[segment.severity] += segment.pageCount;
    counts.byCode[segment.code] += segment.pageCount;
  }

  let refOrientation = 'square';
  if (ref.height > ref.width) refOrientation = 'portrait';
  else if (ref.width > ref.height) refOrientation = 'landscape';

  return {
    schemaVersion: '1.0',
    checkedAt: new Date().toISOString(),
    fileName: options.fileName || null,
    summary: {
      pageCount,
      issuesCount: counts.error + counts.warning + counts.info,
      errorCount: counts.error,
      warningCount: counts.warning,
      infoCount: counts.info,
      segmentCount: segments.length,
      inspectionErrorCount,
      status: segments.length === 0 ? 'clean' : 'issues-found',
    },
    checks: CHECK_ORDER.map((key) => ({
      code: CHECKS[key].code,
      label: CHECKS[key].label,
      severity: CHECKS[key].severity,
      advice: CHECKS[key].advice,
      affectedPages: counts.byCode[CHECKS[key].code],
    })),
    reference: {
      width: ref.width,
      height: ref.height,
      widthMm: ptToMm(ref.width),
      heightMm: ptToMm(ref.height),
      orientation: refOrientation,
    },
    segments,
    pages: pageReports,
  };
}

function ptToMm(pt) {
  return Math.round(((pt * 25.4) / 72) * 10) / 10;
}

/**
 * 与 lib/impose.js 保持一致的 /Rotate 规范化（负角、超圈角折算到标准直角）。
 */
function normalizeRotation(angle) {
  const quarterTurns = Math.round((Number(angle) || 0) / 90);
  return (((quarterTurns % 4) + 4) % 4) * 90;
}

module.exports = {
  SEVERITIES,
  CHECKS,
  TRANSPARENCY_SOURCE_LABELS,
  preflightPdf,
  mergeSegments,
  referenceSize,
  normalizeRotation,
  decodePdfStream,
};
