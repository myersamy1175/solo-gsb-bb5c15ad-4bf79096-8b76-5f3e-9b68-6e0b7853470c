'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const preflightBtn = document.getElementById('preflight-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');
const signatureModeInput = document.getElementById('signature-mode');
const maxSheetsField = document.getElementById('max-sheets-field');
const maxSheetsInput = document.getElementById('max-sheets');
const summaryListEl = document.getElementById('summary-list');
const signatureSummaryEl = document.getElementById('signature-summary');
const reportEl = document.getElementById('preflight-report');
const reportOverviewEl = document.getElementById('preflight-overview');
const reportIssuesEl = document.getElementById('preflight-issues');
const reportEmptyEl = document.getElementById('preflight-empty');
const reportDownloadBtn = document.getElementById('preflight-download-btn');
const filterChips = document.querySelectorAll('#preflight-filters .filter-chip');
const chipCounts = document.querySelectorAll('.chip-count');

const MAX_SHEETS = 20;

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';
let preflightReport = null;
let preflightFilter = 'all';

signatureModeInput.addEventListener('change', () => {
  maxSheetsField.hidden = !signatureModeInput.checked;
});

/**
 * 校验每帖最多纸张数：仅接受 1～20 的整数。
 * @returns {number|null} 合法时返回整数，非法时返回 null（并已设置错误提示）
 */
function readMaxSheets() {
  const raw = maxSheetsInput.value;
  if (!/^\s*\d+\s*$/.test(raw)) {
    setStatus(`请填写每帖最多纸张数（1～${MAX_SHEETS} 的整数）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > MAX_SHEETS) {
    setStatus(`每帖最多纸张数必须在 1～${MAX_SHEETS} 之间`, 'error');
    return null;
  }
  return value;
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
  summaryListEl.innerHTML = '';
  signatureSummaryEl.hidden = true;
  signatureSummaryEl.innerHTML = '';
}

function clearReport() {
  preflightReport = null;
  preflightFilter = 'all';
  reportEl.hidden = true;
  reportIssuesEl.innerHTML = '';
  reportOverviewEl.textContent = '';
  reportEmptyEl.hidden = true;
  setActiveFilterChip('all');
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

function selectFile(file) {
  clearResult();
  clearReport();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    preflightBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  preflightBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB），可先运行印前校验或直接拼版。`, 'info');
}

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const useSignatures = signatureModeInput.checked;
  let maxSheets = null;
  if (useSignatures) {
    maxSheets = readMaxSheets();
    if (maxSheets === null) return;
  }

  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);
  if (useSignatures) {
    form.append('signatureMode', 'on');
    form.append('maxSheetsPerSignature', String(maxSheets));
  }

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ---------- 印前校验 ----------

preflightBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  preflightBtn.disabled = true;
  setStatus('正在执行印前校验，请稍候…', 'info');

  const form = new FormData();
  form.append('pdf', selectedFile);

  try {
    const resp = await fetch('/api/preflight', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    const report = await resp.json();
    preflightReport = report;
    preflightFilter = 'all';
    renderPreflightReport(report);
    const s = report.summary;
    if (s.status === 'clean') {
      setStatus('印前校验完成：未发现问题，可直接拼版。', 'info');
    } else {
      setStatus(
        `印前校验完成：${s.errorCount} 个严重、${s.warningCount} 个警告、${s.infoCount} 个提示（不影响拼版）。`,
        s.errorCount > 0 ? 'error' : 'info',
      );
    }
  } catch (err) {
    setStatus(err.message || '印前校验失败', 'error');
  } finally {
    preflightBtn.disabled = false;
  }
});

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    preflightFilter = chip.dataset.filter;
    setActiveFilterChip(preflightFilter);
    if (preflightReport) renderPreflightIssues(preflightReport);
  });
});

function setActiveFilterChip(filter) {
  filterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  });
}

reportDownloadBtn.addEventListener('click', () => {
  if (!preflightReport) return;
  const blob = new Blob([JSON.stringify(preflightReport, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-印前校验.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

const SEVERITY_LABELS = { error: '严重', warning: '警告', info: '提示' };
const REASON_LABELS = {
  'image-only': '整页为图片（扫描件），无文本绘制操作',
  'no-text-operators': '内容流中没有任何文本绘制操作（可能为转曲文字）',
};

function formatSize(size) {
  return `${size.width.toFixed(1)} × ${size.height.toFixed(1)} pt`
    + `（约 ${ptToMm(size.width)} × ${ptToMm(size.height)} mm）`;
}

function rangeLabel(segment) {
  return segment.startPage === segment.endPage
    ? `第 ${segment.startPage} 页`
    : `第 ${segment.startPage} ～ ${segment.endPage} 页`;
}

function renderPreflightReport(report) {
  const s = report.summary;
  const ref = report.reference;

  chipCounts.forEach((el) => {
    const key = el.dataset.count;
    if (key === 'all') el.textContent = s.issuesCount;
    else el.textContent = s[key === 'error' ? 'errorCount'
      : key === 'warning' ? 'warningCount' : 'infoCount'];
  });

  const orientation = ORIENTATION_LABELS[ref.orientation] || ref.orientation;
  reportOverviewEl.innerHTML = '';
  const overview = document.createElement('span');
  overview.textContent = `共 ${s.pageCount} 页；多数页（参考尺寸）为 ${formatSize(ref)}，${orientation}。`;
  reportOverviewEl.appendChild(overview);
  const resultLine = document.createElement('strong');
  resultLine.className = s.status === 'clean' ? 'result-clean' : 'result-issues';
  resultLine.textContent = s.status === 'clean'
    ? '未发现问题。'
    : `发现 ${s.segmentCount} 组、共 ${s.issuesCount} 页次问题`
      + `（严重 ${s.errorCount} / 警告 ${s.warningCount} / 提示 ${s.infoCount}）。`;
  reportOverviewEl.appendChild(document.createElement('br'));
  reportOverviewEl.appendChild(resultLine);

  setActiveFilterChip(preflightFilter);
  renderPreflightIssues(report);
  reportEl.hidden = false;
}

function renderPreflightIssues(report) {
  reportIssuesEl.innerHTML = '';
  const segments = report.segments.filter((seg) => preflightFilter === 'all'
    || seg.severity === preflightFilter);

  reportEmptyEl.hidden = segments.length !== 0;
  reportEmptyEl.textContent = report.segments.length === 0
    ? '未发现印前问题，可直接拼版。'
    : '当前级别筛选下没有问题。';

  const adviceByCode = new Map(report.checks.map((c) => [c.code, c]));

  for (const segment of segments) {
    const meta = adviceByCode.get(segment.code);
    const li = document.createElement('li');
    li.className = `issue-item sev-${segment.severity}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const badge = document.createElement('span');
    badge.className = `sev-badge ${segment.severity}`;
    badge.textContent = SEVERITY_LABELS[segment.severity] || segment.severity;
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = meta ? meta.label : segment.code;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = `${rangeLabel(segment)} · ${segment.pageCount} 页`;
    head.append(badge, title, range);
    li.appendChild(head);

    const detected = document.createElement('div');
    detected.className = 'issue-detected';
    detected.appendChild(buildDetectedDetail(segment));
    li.appendChild(detected);

    if (meta && meta.advice) {
      const advice = document.createElement('div');
      advice.className = 'issue-advice';
      advice.textContent = `修复建议：${meta.advice}`;
      li.appendChild(advice);
    }
    reportIssuesEl.appendChild(li);
  }
}

function buildDetectedDetail(segment) {
  const frag = document.createDocumentFragment();
  switch (segment.code) {
    case 'size-mismatch': {
      // 相邻页实际尺寸可能各不相同：按检测值再归组展示
      const groups = new Map();
      for (const p of segment.pages) {
        const key = `${p.actual.width}x${p.actual.height}`;
        if (!groups.has(key)) {
          groups.set(key, { actual: p.actual, pages: [] });
        }
        groups.get(key).pages.push(p.page);
      }
      const expected = segment.pages[0].expected;
      const line = document.createElement('div');
      line.textContent = `参考尺寸：${formatSize(expected)}`;
      frag.appendChild(line);
      for (const group of groups.values()) {
        const g = document.createElement('div');
        const pagesLabel = group.pages.length === 1
          ? `第 ${group.pages[0]} 页`
          : `第 ${group.pages[0]} ～ ${group.pages[group.pages.length - 1]} 页（共 ${group.pages.length} 页）`;
        g.textContent = `${pagesLabel}：${formatSize(group.actual)}`;
        frag.appendChild(g);
      }
      break;
    }
    case 'rotation': {
      const line = document.createElement('div');
      const angles = [...new Set(segment.pages.map((p) => p.rotation))];
      line.textContent = angles.length === 1
        ? `检测到：顺时针旋转 ${angles[0]}°（区段内 ${segment.pageCount} 页一致）`
        : `检测到：旋转角 ${angles.join('° / ')}°（区段内角度不一致，见 JSON 报告逐页数据）`;
      frag.appendChild(line);
      break;
    }
    case 'transparency': {
      const sourceSet = new Set();
      for (const p of segment.pages) {
        for (const label of (p.sourceLabels || [])) sourceSet.add(label);
      }
      for (const label of sourceSet) {
        const line = document.createElement('div');
        line.textContent = `检测到：${label}`;
        frag.appendChild(line);
      }
      break;
    }
    case 'no-extractable-text': {
      const reasons = new Set(segment.pages.map((p) => REASON_LABELS[p.reason] || p.reason));
      for (const reason of reasons) {
        const line = document.createElement('div');
        line.textContent = `检测到：${reason}`;
        frag.appendChild(line);
      }
      break;
    }
    default: {
      const line = document.createElement('div');
      line.textContent = '详见 JSON 报告中的逐页数据。';
      frag.appendChild(line);
    }
  }
  return frag;
}

const ORIENTATION_LABELS = {
  portrait: '竖版',
  landscape: '横版',
  square: '方形',
};

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function appendSummaryItem(label, value) {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = value;
  li.append(`${label}：`, strong);
  summaryListEl.appendChild(li);
}

function renderSummary(plan) {
  const sheetCount = plan.signatureMode ? plan.sheetCount : plan.sheets.length;
  appendSummaryItem('原始页数', `${plan.sourceCount} 页`);
  appendSummaryItem('末尾补白', `${plan.paddedCount} 页`);
  if (plan.signatureMode) {
    appendSummaryItem(
      '签帖数量',
      `${plan.signatureCount} 帖（每帖最多 ${plan.maxSheetsPerSignature} 张纸）`,
    );
  }
  appendSummaryItem('用纸数量', `${sheetCount} 张（每张正反 4 页）`);
  if (plan.panel) {
    const { width, height, orientation } = plan.panel;
    appendSummaryItem(
      '统一面板',
      `${width.toFixed(1)} × ${height.toFixed(1)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`,
    );
    appendSummaryItem('页面方向', ORIENTATION_LABELS[orientation] || orientation);
  }

  if (plan.signatureMode) {
    renderSignatureSummary(plan);
  }
  summaryEl.hidden = false;
}

function renderSignatureSummary(plan) {
  const wrap = document.createElement('div');

  const hint = document.createElement('p');
  hint.className = 'signature-hint';
  hint.textContent = `按原页序切分为 ${plan.signatureCount} 帖，各帖仅在帖末补白；`
    + '结果 PDF 按帖号顺序连续输出，下载仍为一个文件。';
  wrap.appendChild(hint);

  const table = document.createElement('table');
  table.className = 'signature-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr>'
    + '<th>帖号</th><th>原始页范围</th><th>原始页数</th>'
    + '<th>帖末补白</th><th>帖内纸张编号</th><th>用纸</th>'
    + '</tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sig of plan.signatures) {
    const tr = document.createElement('tr');
    const range = sig.sourceCount === 1
      ? `第 ${sig.startPage} 页`
      : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
    const sheetNums = sig.sheets.map((s) => s.sheet).join(', ');
    tr.innerHTML = `<td>第 ${sig.signature} 帖</td>`
      + `<td>${range}</td>`
      + `<td>${sig.sourceCount} 页</td>`
      + `<td>${sig.blanks} 页</td>`
      + `<td class="sheet-nums">第 ${sheetNums} 张</td>`
      + `<td>${sig.sheets.length} 张</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  signatureSummaryEl.innerHTML = '';
  signatureSummaryEl.appendChild(wrap);
  signatureSummaryEl.hidden = false;
}

/**
 * 统一遍历方案中的纸张：整册模式直接遍历 plan.sheets；
 * 签帖模式按帖序遍历，并在每帖前插入帖标题分组。
 */
function forEachSheet(plan, callbacks) {
  if (plan.signatureMode) {
    for (const sig of plan.signatures) {
      callbacks.onSignature(sig);
      for (const sheet of sig.sheets) {
        callbacks.onSheet(sheet, sig);
      }
    }
  } else {
    for (const sheet of plan.sheets) {
      callbacks.onSheet(sheet, null);
    }
  }
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();
  // 预览按真实纸张比例渲染：宽 = 2 × 面板宽，高 = 面板高
  const sheetRatio = plan.panel && plan.panel.height > 0
    ? (2 * plan.panel.width) / plan.panel.height
    : 2;

  forEachSheet(plan, {
    onSignature(sig) {
      const group = document.createElement('div');
      group.className = 'signature-group';
      const range = sig.sourceCount === 1
        ? `第 ${sig.startPage} 页`
        : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
      group.textContent = `第 ${sig.signature} 帖 · 原始页 ${range} · 帖末补白 ${sig.blanks} 页`
        + ` · 用纸 ${sig.sheets.length} 张`;
      frag.appendChild(group);
    },
    onSheet(sheet, sig) {
      const card = document.createElement('div');
      card.className = 'sheet';

      const title = document.createElement('div');
      title.className = 'sheet-title';
      if (sig) {
        title.textContent = `第 ${sig.signature} 帖 · 帖内第 ${sheet.sheet} 张纸 / 共 ${sig.sheets.length} 张`;
      } else {
        title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${plan.sheets.length} 张`;
      }
      card.appendChild(title);

      card.appendChild(buildSide('正面', sheet.front, false, sheetRatio));
      card.appendChild(buildSide('背面', sheet.back, true, sheetRatio));

      frag.appendChild(card);
    },
  });
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack, sheetRatio) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.style.aspectRatio = String(sheetRatio);
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}
