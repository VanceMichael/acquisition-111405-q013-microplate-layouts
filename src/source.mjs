import {createTransport} from './transport.mjs';

// 新来源（仪器板资料入口）。
// 设计要点：
// - 先耐久接收原始测次（原文进入内容寻址归档），再向仪器确认，确认后仪器可释放 run。
// - 布局按 run 声明的确切 layoutVersion 关联；版本不符或布局未发布一律 unresolved，
//   绝不借同名板或其他版本的布局填空。
// - 重新运行时优先复用归档中的耐久原文，不向仪器重新索取已确认的 run。
// - 蛇形扫描与板朝向仅用于仪器坐标 -> 物理孔位的解释。
// - 关联以追加修订落库，不覆盖既有历史。

const QUALITY_VALUES = new Set(['ok', 'overflow', 'retest']);
const ORDERS = new Set(['row-major', 'serpentine']);
const ORIENTATIONS = new Set([0, 180]);

function fail(message, location, extra = {}) {
  return {code: 'source-invalid', message, location, ...extra};
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findEvidence(snapshot, method, url) {
  return snapshot.evidence.find(item => item.method === method && item.url === url);
}

// 只复用成功接收（2xx）的原文作为业务依据；错误响应仅作证据保留。
async function loadPersisted(archive, snapshot, method, url) {
  const item = findEvidence(snapshot, method, url);
  if (!item || item.status < 200 || item.status >= 300) return null;
  const bytes = await archive.raw(item.hash);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function validatePlate(payload) {
  if (!isPlainObject(payload)) return {errors: [fail('plate 响应不是对象', 'GET /plate')]};
  const errors = [];
  if (typeof payload.plateId !== 'string' || !payload.plateId) {
    errors.push(fail('plate 缺少有效 plateId', 'GET /plate'));
  }
  if (typeof payload.layout !== 'string' || !payload.layout.startsWith('/')) {
    errors.push(fail('plate 缺少相对 layout 链接', 'GET /plate'));
  }
  if (!Array.isArray(payload.runs) || payload.runs.some(run => typeof run !== 'string' || !run.startsWith('/'))) {
    errors.push(fail('plate 的 runs 必须是相对链接数组', 'GET /plate'));
  }
  return {errors, plate: errors.length ? null : payload};
}

function validateLayout(payload, href) {
  if (!isPlainObject(payload)) return {errors: [fail('布局响应不是对象', `GET ${href}`)]};
  const errors = [];
  if (typeof payload.version !== 'string' || !payload.version) {
    errors.push(fail('布局缺少 version', `GET ${href}`));
  }
  if (!Number.isInteger(payload.rows) || payload.rows <= 0) {
    errors.push(fail('布局 rows 必须为正整数', `GET ${href}`, {version: payload.version}));
  }
  if (!Number.isInteger(payload.columns) || payload.columns <= 0) {
    errors.push(fail('布局 columns 必须为正整数', `GET ${href}`, {version: payload.version}));
  }
  if (!ORIENTATIONS.has(payload.orientation)) {
    errors.push(fail('布局 orientation 仅支持 0/180', `GET ${href}`, {version: payload.version}));
  }
  if (!isPlainObject(payload.wells)) {
    errors.push(fail('布局 wells 必须是对象', `GET ${href}`, {version: payload.version}));
  } else {
    const expected = payload.rows * payload.columns;
    if (Number.isInteger(payload.rows) && Number.isInteger(payload.columns) && Object.keys(payload.wells).length !== expected) {
      errors.push(fail('布局孔数与 rows/columns 不一致', `GET ${href}`, {
        version: payload.version, declared: expected, actual: Object.keys(payload.wells).length,
      }));
    }
  }
  return {errors, layout: errors.length ? null : payload};
}

function validateRun(payload, href) {
  if (!isPlainObject(payload)) return {errors: [fail('测次响应不是对象', `GET ${href}`)]};
  const errors = [];
  if (typeof payload.runId !== 'string' || !payload.runId) {
    errors.push(fail('测次缺少 runId', `GET ${href}`));
  }
  if (typeof payload.layoutVersion !== 'string' || !payload.layoutVersion) {
    errors.push(fail('测次缺少 layoutVersion', `GET ${href}`, {runId: payload.runId}));
  }
  if (!isPlainObject(payload.channel)) {
    errors.push(fail('测次缺少 channel 参数', `GET ${href}`, {runId: payload.runId}));
  }
  if (!ORDERS.has(payload.order)) {
    errors.push(fail(`测次 order 不被支持：${payload.order}`, `GET ${href}`, {runId: payload.runId}));
  }
  if (!Array.isArray(payload.readings)) {
    errors.push(fail('测次 readings 必须是数组', `GET ${href}`, {runId: payload.runId}));
  } else {
    const ordinals = new Set();
    for (const [index, reading] of payload.readings.entries()) {
      const where = `GET ${href}#readings[${index}]`;
      if (!isPlainObject(reading)) { errors.push(fail('读数不是对象', where)); continue; }
      if (!Number.isInteger(reading.ordinal) || reading.ordinal < 0) {
        errors.push(fail('读数 ordinal 必须为非负整数', where));
      } else if (ordinals.has(reading.ordinal)) {
        errors.push(fail('读数 ordinal 重复', where, {ordinal: reading.ordinal}));
      } else {
        ordinals.add(reading.ordinal);
      }
      if (!QUALITY_VALUES.has(reading.quality)) {
        errors.push(fail(`读数 quality 不被支持：${reading.quality}`, where, {ordinal: reading.ordinal}));
      }
      if (reading.quality === 'overflow' && reading.value !== null) {
        errors.push(fail('overflow 读数的 value 必须为 null', where, {ordinal: reading.ordinal}));
      }
      if (reading.quality !== 'overflow' && reading.value !== null && typeof reading.value !== 'number') {
        errors.push(fail('读数 value 必须是数值或 null', where, {ordinal: reading.ordinal}));
      }
    }
  }
  if (payload.receipt !== undefined && (typeof payload.receipt !== 'string' || !payload.receipt.startsWith('/'))) {
    errors.push(fail('receipt 必须是相对链接', `GET ${href}`, {runId: payload.runId}));
  }
  return {errors, run: errors.length ? null : payload};
}

// 仪器坐标 ordinal -> 物理孔位 [row, column]（0 基）。
// row-major 直接按行展开；serpentine 奇数行反向；orientation 在蛇形解释之后做整体朝向映射。
function ordinalToPosition(ordinal, layout, order) {
  const {rows, columns, orientation} = layout;
  let row = Math.floor(ordinal / columns);
  let column = ordinal % columns;
  if (order === 'serpentine' && row % 2 === 1) column = columns - 1 - column;
  if (orientation === 180) {
    row = rows - 1 - row;
    column = columns - 1 - column;
  }
  return [row, column];
}

function wellName(row, column) {
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

function readingMarks(reading) {
  // 原样保留仪器给出的附加标记（如重测标志），不解释未声明字段的业务含义。
  return reading.flags ? {flags: structuredClone(reading.flags)} : {};
}

function buildRecords({plate, run, layout, issues}) {
  const records = [];
  const runRef = {plateId: plate.plateId, runId: run.runId};

  // 版本必须与测次声明的确切布局版本一致，否则全部读数保持待确认。
  if (!layout || layout.version !== run.layoutVersion) {
    for (const reading of run.readings) {
      records.push({
        id: `${plate.plateId}/${run.runId}/ordinal/${reading.ordinal}`,
        ...runRef,
        ordinal: reading.ordinal,
        channel: structuredClone(run.channel),
        order: run.order,
        requestedLayoutVersion: run.layoutVersion,
        quality: reading.quality,
        value: reading.value,
        ...readingMarks(reading),
        layoutStatus: 'unresolved',
      });
    }
    return records;
  }

  for (const reading of run.readings) {
    const [row, column] = ordinalToPosition(reading.ordinal, layout, run.order);
    const well = wellName(row, column);
    const cell = layout.wells[well];
    const shared = {
      ...runRef,
      well,
      channel: structuredClone(run.channel),
      layoutVersion: layout.version,
      ordinal: reading.ordinal,
      quality: reading.quality,
      value: reading.value,
      ...readingMarks(reading),
    };
    if (!cell) {
      // 物理孔位在该版布局中没有声明，宁可留缺口也不猜测样本。
      records.push({
        id: `${plate.plateId}/${run.runId}/ordinal/${reading.ordinal}`,
        ...shared,
        layoutStatus: 'unresolved',
      });
      issues.push({
        code: 'well-undeclared',
        message: `物理孔位 ${well} 未在布局 ${layout.version} 中声明`,
        location: `GET /run/${run.runId}#readings`,
        ...runRef,
        well,
        ordinal: reading.ordinal,
      });
      continue;
    }
    const record = {
      id: `${plate.plateId}/${run.runId}/well/${well}`,
      ...shared,
      sampleId: cell.sampleId,
      role: cell.role,
      layoutStatus: 'resolved',
    };
    // 溢出落在样本孔：该样本的本次测量已失效，不发布为关联记录，
    // 完整读数与溢出标记转入可复核 issue；QC 孔（blank/control）的溢出保留为观测记录。
    if (reading.quality === 'overflow' && cell.role === 'sample') {
      issues.push({
        code: 'sample-well-overflow',
        message: `样本孔 ${well}（${cell.sampleId}）读数溢出，测量值未发布`,
        location: `GET /run/${run.runId}#readings`,
        ...shared,
        sampleId: cell.sampleId,
        role: cell.role,
      });
      continue;
    }
    records.push(record);
  }
  return records;
}

export async function collectFromSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];
  let snapshot = archive.snapshot();
  const evidenceBefore = snapshot.evidence.length;
  let hasGap = false;

  // 1. plate 清单：优先使用归档中已耐久接收的版本。
  const plateHref = new URL('/plate', transport.origin).href;
  let plate = await loadPersisted(archive, snapshot, 'GET', plateHref);
  if (!plate) {
    const response = await transport.request('/plate');
    await archive.commit({exchanges: transport.exchanges});
    snapshot = archive.snapshot();
    if (!response.ok) throw new Error(`plate 领取失败：${response.status}`);
    try { plate = response.json(); }
    catch { throw new Error('plate 响应不是有效 JSON'); }
  }
  const plateCheck = validatePlate(plate);
  if (plateCheck.errors.length) {
    await archive.commit({issues: plateCheck.errors});
    return {
      records: [], complete: false,
      issues: [...archive.snapshot().issues],
      evidenceCount: archive.snapshot().evidence.length - evidenceBefore,
    };
  }
  plate = plateCheck.plate;
  const layoutHref = new URL(plate.layout, transport.origin).href;

  const allRecords = [];

  for (const runPath of plate.runs) {
    const runHref = new URL(runPath, transport.origin).href;

    // 2. 测次原文：归档里已有成功接收的副本时直接复用，重新运行不再向仪器索取。
    let run = await loadPersisted(archive, snapshot, 'GET', runHref);
    if (!run) {
      const response = await transport.request(runPath);
      // 先把原文（含错误状态）耐久落库，再判断业务可用性。
      await archive.commit({exchanges: transport.exchanges});
      snapshot = archive.snapshot();
      if (!response.ok) {
        issues.push(fail(`测次领取失败：HTTP ${response.status}`, `GET ${runPath}`, {status: response.status}));
        hasGap = true;
        await archive.commit({issues});
        issues.length = 0;
        continue;
      }
      try {
        run = response.json();
      } catch (error) {
        issues.push(fail(`测次不是有效 JSON：${error.message}`, `GET ${runPath}`));
        hasGap = true;
        await archive.commit({issues});
        issues.length = 0;
        continue;
      }
    }

    const runCheck = validateRun(run, runPath);
    if (runCheck.errors.length) {
      await archive.commit({issues: runCheck.errors});
      issues.push(...runCheck.errors);
      hasGap = true;
      continue;
    }
    run = runCheck.run;

    // 3. 原始测次已耐久，才向仪器确认；确认动作本身也留证、可重试且不重复确认。
    const receiptHref = run.receipt ? new URL(run.receipt, transport.origin).href : null;
    if (receiptHref && !findEvidence(snapshot, 'POST', receiptHref)) {
      const response = await transport.request(run.receipt, {method: 'POST', body: {runId: run.runId}});
      await archive.commit({exchanges: transport.exchanges});
      snapshot = archive.snapshot();
      if (!response.ok) {
        issues.push(fail(`测次确认失败：HTTP ${response.status}`, `POST ${run.receipt}`, {runId: run.runId, status: response.status}));
        hasGap = true;
      }
    }

    // 4. 按 run 声明的确切布局版本取得解释依据；404 表示尚未发布，保持 unresolved。
    // 只有此前成功接收且通过结构校验的布局才复用；错误或非法响应只留证据，下次仍可重试。
    let validatedLayout = null;
    const persistedLayout = await loadPersisted(archive, snapshot, 'GET', layoutHref);
    if (persistedLayout) {
      const cached = validateLayout(persistedLayout, plate.layout);
      if (cached.errors.length) {
        issues.push(...cached.errors);
        hasGap = true;
      } else {
        validatedLayout = cached.layout;
      }
    } else {
      const response = await transport.request(plate.layout);
      await archive.commit({exchanges: transport.exchanges});
      snapshot = archive.snapshot();
      if (response.ok) {
        try {
          const fetched = validateLayout(response.json(), plate.layout);
          if (fetched.errors.length) {
            issues.push(...fetched.errors);
            hasGap = true;
          } else {
            validatedLayout = fetched.layout;
          }
        } catch (error) {
          issues.push(fail(`布局不是有效 JSON：${error.message}`, `GET ${plate.layout}`));
          hasGap = true;
        }
      } else if (response.status === 404) {
        issues.push({
          code: 'layout-pending',
          message: `布局版本 ${run.layoutVersion} 尚未发布，测次保持待确认`,
          location: `GET ${plate.layout}`,
          plateId: plate.plateId,
          runId: run.runId,
          requestedLayoutVersion: run.layoutVersion,
        });
        hasGap = true;
      } else {
        issues.push(fail(`布局领取失败：HTTP ${response.status}`, `GET ${plate.layout}`, {
          runId: run.runId, requestedLayoutVersion: run.layoutVersion, status: response.status,
        }));
        hasGap = true;
      }
    }
    if (validatedLayout && validatedLayout.version !== run.layoutVersion) {
      issues.push({
        code: 'layout-version-conflict',
        message: `测次需要布局 ${run.layoutVersion}，来源当前提供 ${validatedLayout.version}，不得跨版本关联`,
        location: `GET ${plate.layout}`,
        plateId: plate.plateId,
        runId: run.runId,
        requestedLayoutVersion: run.layoutVersion,
        availableLayoutVersion: validatedLayout.version,
      });
      hasGap = true;
      validatedLayout = null;
    }

    // 5. 解释读数并落库为追加修订；同一 id 的新内容会形成新修订，历史不被覆盖。
    const records = buildRecords({plate, run, layout: validatedLayout, issues});
    if (records.some(record => record.layoutStatus !== 'resolved')) hasGap = true;
    if (issues.some(issue => issue.code === 'sample-well-overflow')) hasGap = true;
    allRecords.push(...records);
    await archive.commit({records, issues});
    issues.length = 0;
    snapshot = archive.snapshot();
  }

  const finalSnapshot = archive.snapshot();
  return {
    records: allRecords,
    complete: !hasGap,
    issues: finalSnapshot.issues,
    evidenceCount: finalSnapshot.evidence.length - evidenceBefore,
  };
}
