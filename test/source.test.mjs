import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {startSource} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('布局补齐前先耐久确认测次，重启后不重新索取 run 且补关联为追加修订', async () => {
  const directory = await tempDir('source-durable-');
  const source = await startSource('layout-after-receipt');
  try {
    const first = await collect({
      baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source',
    });
    assert.equal(first.complete, false);
    assert.equal(first.records[0].layoutStatus, 'unresolved');
    assert.ok(first.issues.some(issue => issue.code === 'layout-pending'));
    const afterFirst = source.requests();
    assert.equal(afterFirst.filter(r => r.method === 'POST' && r.path === '/accept/r1').length, 1);

    // 模拟重启：重开归档再采集。仪器对 /run/1 已返回 410，但归档原文可继续解释。
    const second = await collect({
      baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source',
    });
    const all = source.requests();
    assert.equal(all.filter(r => r.method === 'GET' && r.path === '/run/1').length, 1, 'run 原文只索取一次');
    assert.equal(all.filter(r => r.method === 'POST' && r.path === '/accept/r1').length, 1, '确认不重复发送');
    assert.ok(!all.slice(afterFirst.length).some(r => r.path === '/run/1'), '重启后不得重新向仪器要 run');
    assert.equal(second.complete, true);
    assert.equal(second.records[0].layoutStatus, 'resolved');
    assert.equal(second.records[0].sampleId, 's1');

    const snapshot = (await openArchive(directory)).snapshot();
    assert.equal(snapshot.records.length, 2, 'unresolved 与 resolved 作为两条修订并存');
    assert.deepEqual(snapshot.records.map(r => r.layoutStatus), ['unresolved', 'resolved']);
    assert.ok(snapshot.evidence.length >= 4, '原文证据（含确认与两次布局响应）全部留存');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('布局版本不符时全部读数待确认，绝不借用来源当前布局的样本', async () => {
  const directory = await tempDir('source-conflict-');
  const source = await startSource('layout-mismatch');
  try {
    const result = await collect({
      baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source',
    });
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.layoutStatus, 'unresolved');
    assert.equal('sampleId' in record, false);
    assert.equal('well' in record, false);
    assert.equal(record.requestedLayoutVersion, 'v1');
    assert.ok(result.issues.some(issue => issue.code === 'layout-version-conflict'));
    assert.ok(!result.records.some(r => r.sampleId === 'new' && r.value === 2));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('蛇形顺序结合 180 度朝向解释物理孔位，样本孔溢出转 issue 而 QC 孔溢出保留', async () => {
  const directory = await tempDir('source-rotate-');
  const source = await startSource('rotated-serpentine');
  try {
    const result = await collect({
      baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source',
    });
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.well, 'A1');
    assert.equal(record.sampleId, 's1');
    assert.equal(record.quality, 'ok');
    assert.equal(record.value, 0);
    assert.equal(record.channel.kind, 'absorbance');
    assert.equal(record.channel.wavelength, 450);
    const overflow = result.issues.find(issue => issue.code === 'sample-well-overflow');
    assert.ok(overflow, '样本孔溢出必须留下可复核问题');
    assert.equal(overflow.well, 'A2');
    assert.equal(overflow.sampleId, 's2');
    assert.equal(overflow.quality, 'overflow');
    assert.equal(overflow.value, null);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }

  const directory2 = await tempDir('source-snake-');
  const source2 = await startSource('serpentine');
  try {
    const result = await collect({
      baseUrl: source2.baseUrl, archive: await openArchive(directory2), mode: 'source',
    });
    const overflowRecord = result.records.find(r => r.quality === 'overflow');
    assert.ok(overflowRecord, 'blank 孔溢出作为 QC 观测保留在记录中');
    assert.equal(overflowRecord.well, 'B1');
    assert.equal(overflowRecord.role, 'blank');
    assert.equal(overflowRecord.value, null);
    assert.equal(result.records.find(r => r.well === 'B2').sampleId, 'ctrl');
  } finally {
    await source2.close();
    await rm(directory2, {recursive: true, force: true});
  }
});

function localServer(routes) {
  return new Promise(resolve => {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const route = routes[request.method + ' ' + url.pathname];
      if (!route) { response.writeHead(404).end(JSON.stringify({error: 'missing'})); return; }
      response.writeHead(route.status, {'content-type': 'application/json'}).end(JSON.stringify(route.body));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

test('重测标记与荧光通道参数原样保留，未知标记不被解释成业务事实', async () => {
  const directory = await tempDir('source-retest-');
  const source = await localServer({
    'GET /plate': {status: 200, body: {plateId: 'P9', layout: '/layout', runs: ['/run/1']}},
    'GET /layout': {status: 200, body: {
      version: 'v1', rows: 1, columns: 2, orientation: 0,
      wells: {A1: {sampleId: 's1', role: 'sample'}, A2: {sampleId: 's2', role: 'sample'}},
    }},
    'GET /run/1': {status: 200, body: {
      runId: 'r9', layoutVersion: 'v1',
      channel: {kind: 'fluorescence', wavelength: 535, gain: 40, unit: 'RFU'},
      order: 'row-major',
      readings: [
        {ordinal: 0, value: 12.5, quality: 'retest', flags: {retestReason: 'qc-repeat', attempt: 2}},
        {ordinal: 1, value: 3.25, quality: 'ok'},
      ],
    }},
  });
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, true);
    const retest = result.records.find(r => r.quality === 'retest');
    assert.equal(retest.well, 'A1');
    assert.equal(retest.sampleId, 's1');
    assert.deepEqual(retest.flags, {retestReason: 'qc-repeat', attempt: 2});
    assert.equal(retest.channel.kind, 'fluorescence');
    assert.equal(retest.channel.gain, 40);
    assert.equal(retest.channel.unit, 'RFU');
    assert.equal(result.records.find(r => r.well === 'A2').value, 3.25);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('畸形测次被拒绝并留可复核问题，不产生伪造关联', async () => {
  const directory = await tempDir('source-invalid-');
  const source = await localServer({
    'GET /plate': {status: 200, body: {plateId: 'PB', layout: '/layout', runs: ['/run/1']}},
    'GET /layout': {status: 200, body: {
      version: 'v1', rows: 1, columns: 1, orientation: 0,
      wells: {A1: {sampleId: 's1', role: 'sample'}},
    }},
    'GET /run/1': {status: 200, body: {
      runId: 'r-bad', layoutVersion: 'v1', channel: {unit: 'AU'},
      order: 'row-major',
      readings: [{ordinal: 0, value: 1, quality: 'overflow'}],
    }},
  });
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 0);
    assert.ok(result.issues.some(issue => /overflow/.test(issue.message)));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
