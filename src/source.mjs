import {createTransport} from './transport.mjs';
import {digest} from './archive.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const WELL_PATTERN = /^[A-Z]+[1-9][0-9]*$/;

// 行号转孔位行标签：0→A，25→Z，26→AA。
export function rowLabel(index) {
  let label = '';
  let value = index;
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

// 读数序号到仪器坐标：row-major逐行顺序，serpentine奇数行反向。越界返回null。
export function instrumentCoordinate(ordinal, order, rows, columns) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= rows * columns) return null;
  const row = Math.floor(ordinal / columns);
  const offset = ordinal % columns;
  const column = order === 'serpentine' && row % 2 === 1 ? columns - 1 - offset : offset;
  return {row, column};
}

// 仪器坐标按板朝向（0/180）映射到物理孔位。
export function physicalWell(coordinate, layout) {
  const row = layout.orientation === 180 ? layout.rows - 1 - coordinate.row : coordinate.row;
  const column = layout.orientation === 180 ? layout.columns - 1 - coordinate.column : coordinate.column;
  return rowLabel(row) + String(column + 1);
}

export function validatePlate(document) {
  if (!isObject(document)) throw new Error('板资料原文不是对象');
  if (typeof document.plateId !== 'string' || !document.plateId) throw new Error('板资料缺少标识');
  if (typeof document.layout !== 'string' || !document.layout) throw new Error('板资料缺少布局链接');
  if (!Array.isArray(document.runs) || document.runs.some(href => typeof href !== 'string' || !href)) {
    throw new Error('板资料测次链接无效');
  }
  return {plateId: document.plateId, layoutHref: document.layout, runHrefs: [...new Set(document.runs)]};
}

export function validateRun(document) {
  if (!isObject(document)) throw new Error('测次原文不是对象');
  if (typeof document.runId !== 'string' || !document.runId) throw new Error('测次缺少标识');
  if (typeof document.layoutVersion !== 'string' || !document.layoutVersion) throw new Error('测次缺少布局版本');
  if (document.order !== 'row-major' && document.order !== 'serpentine') throw new Error('测次扫描顺序无效');
  if (!isObject(document.channel)) throw new Error('测次缺少通道参数');
  const channel = {};
  for (const key of ['kind', 'wavelength', 'gain', 'unit']) {
    if (document.channel[key] !== undefined) channel[key] = document.channel[key];
  }
  if (!Array.isArray(document.readings)) throw new Error('测次缺少读数');
  const seen = new Set();
  const readings = document.readings.map((reading, index) => {
    if (!isObject(reading)) throw new Error(`测次读数${index}不是对象`);
    if (!Number.isInteger(reading.ordinal) || reading.ordinal < 0) throw new Error(`测次读数${index}序号无效`);
    if (seen.has(reading.ordinal)) throw new Error(`测次读数序号${reading.ordinal}重复`);
    seen.add(reading.ordinal);
    if (typeof reading.quality !== 'string' || !reading.quality) throw new Error(`测次读数${index}缺少质量标记`);
    if (!('value' in reading) || (reading.value !== null && typeof reading.value !== 'number')) {
      throw new Error(`测次读数${index}数值无效`);
    }
    return {ordinal: reading.ordinal, value: reading.value, quality: reading.quality};
  });
  const receipt = document.receipt === undefined ? null : document.receipt;
  if (receipt !== null && (typeof receipt !== 'string' || !receipt)) throw new Error('测次回执链接无效');
  const layout = document.layout === undefined ? null : document.layout;
  if (layout !== null && (typeof layout !== 'string' || !layout)) throw new Error('测次布局链接无效');
  return {runId: document.runId, layoutVersion: document.layoutVersion, order: document.order, channel, readings, receipt, layout};
}

export function validateLayout(document) {
  if (!isObject(document)) throw new Error('布局原文不是对象');
  if (typeof document.version !== 'string' || !document.version) throw new Error('布局缺少版本号');
  if (!Number.isInteger(document.rows) || document.rows <= 0) throw new Error('布局行数无效');
  if (!Number.isInteger(document.columns) || document.columns <= 0) throw new Error('布局列数无效');
  if (document.orientation !== 0 && document.orientation !== 180) throw new Error('布局朝向无效');
  if (!isObject(document.wells)) throw new Error('布局缺少孔位表');
  const wells = {};
  for (const [well, assignment] of Object.entries(document.wells)) {
    if (!WELL_PATTERN.test(well)) throw new Error(`布局孔位${well}不是A1格式`);
    if (!isObject(assignment) || typeof assignment.sampleId !== 'string' || !assignment.sampleId
        || typeof assignment.role !== 'string' || !assignment.role) {
      throw new Error(`布局孔位${well}缺少样本或角色`);
    }
    wells[well] = {sampleId: assignment.sampleId, role: assignment.role};
  }
  return {
    version: document.version, rows: document.rows, columns: document.columns,
    orientation: document.orientation, wells
  };
}

function runRecord(plate, entry, extra = {}) {
  return {
    id: `plate/${plate.plateId}/run/${entry.run.runId}`,
    kind: 'run',
    plateId: plate.plateId,
    runId: entry.run.runId,
    runHref: entry.href,
    layoutHref: entry.run.layout ?? plate.layoutHref,
    layoutVersion: entry.run.layoutVersion,
    order: entry.run.order,
    channel: structuredClone(entry.run.channel),
    sourceHash: entry.sourceHash,
    receiptHref: entry.receiptHref,
    receiptPosted: entry.receiptPosted,
    ...extra
  };
}

export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];
  const records = [];
  let complete = true;
  const gap = (where, problem, context = {}) => {
    issues.push({where, problem, ...context});
    complete = false;
  };

  const plateResponse = await transport.request('/plate');
  if (!plateResponse.ok) throw new Error(`板资料领取失败：${plateResponse.status}`);
  const plate = validatePlate(plateResponse.json());

  // 已耐久接收的测次：重启后从归档原文继续关联，不再向仪器索取。
  const latest = new Map();
  for (const record of archive.snapshot().records) latest.set(record.id, record);
  const received = new Map();
  for (const record of latest.values()) {
    if (record.kind === 'run' && record.plateId === plate.plateId && typeof record.runHref === 'string'
        && typeof record.sourceHash === 'string') {
      received.set(record.runHref, record);
    }
  }

  const runs = [];
  for (const runHref of plate.runHrefs) {
    const marker = received.get(runHref);
    if (marker) {
      try {
        const run = validateRun(JSON.parse((await archive.raw(marker.sourceHash)).toString('utf8')));
        runs.push({
          href: runHref, run, fresh: false, sourceHash: marker.sourceHash,
          receiptHref: marker.receiptHref ?? run.receipt, receiptPosted: marker.receiptPosted === true
        });
      } catch (error) {
        gap(runHref, `已归档测次原文无法解释：${error.message}`, {plateId: plate.plateId});
      }
      continue;
    }
    let response;
    try {
      response = await transport.request(runHref);
    } catch (error) {
      gap(runHref, `测次领取失败：${error.message}`, {plateId: plate.plateId});
      continue;
    }
    if (!response.ok) {
      gap(runHref, `测次领取状态${response.status}`, {plateId: plate.plateId});
      continue;
    }
    let run;
    try {
      run = validateRun(response.json());
    } catch (error) {
      gap(runHref, `测次原文无效：${error.message}`, {plateId: plate.plateId});
      continue;
    }
    runs.push({
      href: runHref, run, fresh: true, sourceHash: digest(response.bytes),
      receiptHref: run.receipt, receiptPosted: false
    });
  }

  // 新收测次先耐久落库，再确认回执；确认后仪器可清空本地缓存。
  const fresh = runs.filter(entry => entry.fresh);
  if (fresh.length) {
    await archive.commit({records: fresh.map(entry => runRecord(plate, entry)), exchanges: transport.exchanges});
  }
  for (const entry of runs) {
    if (!entry.receiptHref || entry.receiptPosted) continue;
    let response;
    try {
      response = await transport.request(entry.receiptHref, {method: 'POST'});
    } catch (error) {
      gap(entry.receiptHref, `测次${entry.run.runId}回执确认失败：${error.message}`,
        {plateId: plate.plateId, runId: entry.run.runId});
      continue;
    }
    if (response.status >= 200 && response.status < 300) entry.receiptPosted = true;
    else {
      gap(entry.receiptHref, `测次${entry.run.runId}回执确认状态${response.status}`,
        {plateId: plate.plateId, runId: entry.run.runId});
    }
  }

  // 布局按测次申报的确切版本关联；接口异常时只能沿用归档中同版本的布局原文。
  const layoutOutcomes = new Map();
  async function fetchLayout(href) {
    if (!layoutOutcomes.has(href)) {
      let outcome;
      try {
        const response = await transport.request(href);
        if (response.ok) {
          try { outcome = {layout: validateLayout(response.json())}; }
          catch (error) { outcome = {status: response.status, error: `布局原文无效：${error.message}`}; }
        } else {
          outcome = {status: response.status};
        }
      } catch (error) {
        outcome = {status: 0, error: error.message};
      }
      layoutOutcomes.set(href, outcome);
    }
    return layoutOutcomes.get(href);
  }

  async function archivedLayout(href, version) {
    const absolute = new URL(href, transport.origin).href;
    const evidence = archive.snapshot().evidence;
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      const item = evidence[index];
      if (item.method !== 'GET' || item.status !== 200 || item.url !== absolute) continue;
      try {
        const layout = validateLayout(JSON.parse((await archive.raw(item.hash)).toString('utf8')));
        if (layout.version === version) return layout;
      } catch { /* 历史原文损坏或无效时继续向前找 */ }
    }
    return null;
  }

  for (const entry of runs) {
    const layoutHref = entry.run.layout ?? plate.layoutHref;
    const outcome = await fetchLayout(layoutHref);
    let layout = null;
    if (outcome.layout && outcome.layout.version === entry.run.layoutVersion) {
      layout = outcome.layout;
    } else if (outcome.layout) {
      layout = await archivedLayout(layoutHref, entry.run.layoutVersion);
      gap(layoutHref, layout
        ? `布局当前版本${outcome.layout.version}与测次${entry.run.runId}所需${entry.run.layoutVersion}不符，沿用归档的同版本布局原文`
        : `布局当前版本${outcome.layout.version}与测次${entry.run.runId}所需${entry.run.layoutVersion}不符`,
        {plateId: plate.plateId, runId: entry.run.runId});
    } else if (outcome.status === 404) {
      gap(layoutHref, `测次${entry.run.runId}所需布局版本${entry.run.layoutVersion}尚未发布`,
        {plateId: plate.plateId, runId: entry.run.runId});
    } else {
      layout = await archivedLayout(layoutHref, entry.run.layoutVersion);
      gap(layoutHref, layout
        ? `布局领取失败（${outcome.error ?? `状态${outcome.status}`}），沿用归档的同版本布局原文`
        : `布局领取失败：${outcome.error ?? `状态${outcome.status}`}`,
        {plateId: plate.plateId, runId: entry.run.runId});
    }
    if (!layout) {
      records.push(runRecord(plate, entry, {layoutStatus: 'unresolved'}));
      continue;
    }
    const wells = [];
    for (const reading of entry.run.readings) {
      const coordinate = instrumentCoordinate(reading.ordinal, entry.run.order, layout.rows, layout.columns);
      if (!coordinate) {
        gap(entry.href, `测次${entry.run.runId}读数序号${reading.ordinal}超出布局${layout.rows}行${layout.columns}列范围`,
          {plateId: plate.plateId, runId: entry.run.runId});
        continue;
      }
      const well = physicalWell(coordinate, layout);
      const assignment = layout.wells[well] ?? null;
      if (!assignment) {
        gap(layoutHref, `布局版本${layout.version}缺少孔位${well}的样本指派`,
          {plateId: plate.plateId, runId: entry.run.runId});
      }
      wells.push({
        id: `plate/${plate.plateId}/run/${entry.run.runId}/well/${well}`,
        kind: 'reading',
        plateId: plate.plateId,
        runId: entry.run.runId,
        well,
        ordinal: reading.ordinal,
        sampleId: assignment ? assignment.sampleId : null,
        role: assignment ? assignment.role : null,
        channel: structuredClone(entry.run.channel),
        value: reading.value,
        quality: reading.quality,
        layoutVersion: layout.version,
        layoutStatus: 'resolved'
      });
    }
    records.push(...wells, runRecord(plate, entry, {layoutStatus: 'resolved', readingCount: wells.length}));
  }

  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}
