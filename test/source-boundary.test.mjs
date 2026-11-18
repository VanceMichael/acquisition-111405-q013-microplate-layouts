import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {instrumentCoordinate, physicalWell} from '../src/source.mjs';

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'boundary-'));
}

test('确认后的测次重启后从耐久原文继续关联，不再向仪器索取', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('layout-after-receipt');
  try {
    const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(first.complete, false, '布局未发布时不得声明完整');
    assert.ok(first.records.some(record => record.runId === 'r1' && record.layoutStatus === 'unresolved'));
    assert.ok(first.issues.length > 0, '缺口必须可复核');
    const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(second.complete, true);
    const reading = second.records.find(record => record.kind === 'reading' && record.well === 'A1');
    assert.equal(reading.sampleId, 's1');
    assert.equal(reading.value, 0);
    assert.equal(
      source.requests().filter(request => request.method === 'GET' && request.path === '/run/1').length,
      1, '测次原文只能向仪器领取一次');
    assert.equal(
      source.requests().filter(request => request.method === 'POST' && request.path === '/accept/r1').length,
      1, '回执只确认一次');
    const persisted = await openArchive(directory);
    assert.ok(persisted.snapshot().evidence.some(item => item.url.endsWith('/run/1')), '测次原文已耐久归档');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('布局修正产生新的关联修订而不改写已发布历史', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('layout-correction');
  try {
    const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.ok(first.records.some(record => record.well === 'A1' && record.sampleId === 's1'));
    const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.ok(second.records.some(record => record.well === 'A1' && record.sampleId === 's9'));
    assert.ok(!second.records.some(record => record.sampleId === 's1'), '当前结果只反映最新布局');
    const persisted = await openArchive(directory);
    const revisions = persisted.snapshot().records.filter(record => record.id === 'plate/P6/run/r1/well/A1');
    assert.equal(revisions.length, 2, '两次关联都作为修订保留');
    assert.ok(revisions.some(record => record.sampleId === 's1'), '修正前的关联仍在历史中');
    assert.ok(revisions.some(record => record.sampleId === 's9'), '修正后的关联作为新修订加入');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('缺失确切版本布局的测次明确待确认，不借用同板其他版本样本', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('two-runs-one-pending');
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    const resolved = result.records.find(record => record.runId === 'r1' && record.kind === 'reading');
    assert.equal(resolved.sampleId, 's1');
    const pending = result.records.filter(record => record.runId === 'r2');
    assert.ok(pending.length > 0);
    for (const record of pending) {
      assert.equal(record.layoutStatus, 'unresolved');
      assert.ok(!('sampleId' in record), '待确认测次不得出现样本');
      assert.ok(!('value' in record), '待确认测次不得出现读数值');
    }
    assert.ok(result.issues.some(issue => issue.runId === 'r2'));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('布局接口故障时沿用归档的同版本布局并标记不完整', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('layout-outage');
  try {
    const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(first.complete, true);
    const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(second.complete, false, '布局接口故障必须留下缺口');
    const reading = second.records.find(record => record.kind === 'reading' && record.well === 'A1');
    assert.equal(reading.sampleId, 's1', '已归档的同版本布局仍可支撑关联');
    assert.equal(reading.value, 4);
    assert.ok(second.issues.some(issue => issue.problem.includes('归档')));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('蛇形扫描顺序与板朝向共同决定物理孔位', () => {
  assert.deepEqual(instrumentCoordinate(0, 'row-major', 2, 2), {row: 0, column: 0});
  assert.deepEqual(instrumentCoordinate(2, 'serpentine', 2, 2), {row: 1, column: 1}, '蛇形奇数行反向');
  assert.deepEqual(instrumentCoordinate(3, 'serpentine', 2, 2), {row: 1, column:0});
  assert.equal(instrumentCoordinate(4, 'row-major', 2, 2), null, '越界序号不得映射');
  assert.equal(physicalWell({row: 1, column: 1}, {rows: 2, columns: 2, orientation: 0}), 'B2');
  assert.equal(physicalWell({row: 1, column: 1}, {rows: 2, columns: 2, orientation: 180}), 'A1');
  assert.equal(physicalWell({row: 1, column: 0}, {rows: 2, columns: 2, orientation: 180}), 'A2');
  assert.equal(physicalWell({row: 0, column: 0}, {rows: 2, columns: 2, orientation: 180}), 'B2');
});

test('通道参数与重测、溢出标记原样保留，溢出值保持null', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('fluorescence-retest');
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, true);
    const retest = result.records.find(record => record.quality === 'retest');
    assert.equal(retest.value, 9.75);
    assert.deepEqual(retest.channel, {kind: 'fluorescence', wavelength: 485, gain: 40, unit: 'RFU'});
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
  const overflowDirectory = await temporaryDirectory();
  const overflowSource = await startSource('serpentine');
  try {
    const result = await collect({baseUrl: overflowSource.baseUrl, archive: await openArchive(overflowDirectory), mode: 'source'});
    const overflow = result.records.find(record => record.quality === 'overflow');
    assert.equal(overflow.value, null, '溢出读数值必须保持null而不是0');
    assert.equal(overflow.well, 'B1');
    const normal = result.records.find(record => record.well === 'B2');
    assert.equal(normal.value, 0, '正常的0值不得被改成null');
  } finally {
    await overflowSource.close();
    await rm(overflowDirectory, {recursive: true, force: true});
  }
});

test('布局缺少孔位指派时明确标空并保持不完整', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('missing-well');
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    const missing = result.records.find(record => record.well === 'A2');
    assert.equal(missing.sampleId, null);
    assert.equal(missing.role, null);
    assert.equal(missing.value, 2);
    assert.ok(result.issues.some(issue => issue.problem.includes('A2')));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('重复领取不产生重复修订，结果保持幂等', async () => {
  const directory = await temporaryDirectory();
  const source = await startSource('serpentine');
  try {
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const firstSize = (await openArchive(directory)).snapshot().records.length;
    const again = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const persisted = await openArchive(directory);
    assert.equal(persisted.snapshot().records.length, firstSize, '相同内容不得追加新修订');
    assert.ok(again.records.some(record => record.well === 'B2' && record.sampleId === 'ctrl'));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
