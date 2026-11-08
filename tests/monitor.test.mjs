import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateRanking, buildReport } from '../scripts/monitor-deployment.mjs';
const exec = promisify(execFile);
const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40);
const valid = { scores: [{ id: 'score', nickname: '관측 테스트', average: 210, fastest: 190, createdAt: 1000 }], total: 1, best: 210, commitSha: shaB };
const cli = path.resolve('scripts/monitor-deployment.mjs');

test('ranking validation rejects HTTP-200-shaped errors and missing or malformed required fields', () => {
  assert.deepEqual(validateRanking(valid), []);
  for (const body of [null, [], {}, { error: 'DB failed' }, { ...valid, total: undefined }, { ...valid, best: 100 }, { ...valid, scores: [{}] }]) assert.ok(validateRanking(body).length);
});

test('partial monitor logs expose pending requests and trailing gaps without inferring response SHA', () => {
  const config = { url: 'http://127.0.0.1:1/api/scores', mode: 'redeployment', commitSha: shaB, startedAt: '2026-11-08T00:00:00.000Z', postSeconds: 30, gapThresholdMs: 2500 };
  const events = [
    { kind: 'baseline-health', commitSha: shaA },
    { kind: 'request-start', sequence: 1, startedAt: config.startedAt },
    { kind: 'response', sequence: 1, startedAt: config.startedAt, completedAt: '2026-11-08T00:00:00.100Z', success: true, commitSha: null },
    { kind: 'request-start', sequence: 2, startedAt: '2026-11-08T00:00:01.100Z' },
  ];
  const report = buildReport(config, events, null, null, '2026-11-08T00:00:10.000Z');
  assert.equal(report.beforeScoresSha, null);
  assert.equal(report.baselineHealthSha, shaA);
  assert.equal(report.shaUnknown, 1);
  assert.equal(report.pending.length, 1);
  assert.equal(report.maxCompletionGapMs, 9900);
  assert.equal(report.verdict, 'OBSERVATION FAILED OR INCOMPLETE');
});

test('independent process records bad JSON, invalid fields, HTTP errors, timeout, cadence and UTF-8', { timeout: 30000 }, async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, commitSha: shaA })); return; }
    const n = ++requests;
    res.setHeader('Content-Type', 'application/json');
    if (n === 2) { res.end('{bad'); return; }
    if (n === 3) { res.end('{"scores":[]}'); return; }
    if (n === 4) { res.writeHead(503); res.end('{"error":"unavailable"}'); return; }
    if (n === 5) { setTimeout(() => res.end(JSON.stringify(valid)), 500); return; }
    res.end(JSON.stringify({ ...valid, commitSha: n === 1 ? shaA : shaB }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = path.resolve('outputs', `monitor-unit-${crypto.randomUUID()}`);
  const run = (command, ...extra) => exec(process.execPath, [cli, command, '--dir', dir, ...extra], { windowsHide: true });
  try {
    await run('start', '--url', `http://127.0.0.1:${server.address().port}/api/scores`, '--sha', shaB, '--mode', 'redeployment', '--post-seconds', '1', '--request-timeout-ms', '200', '--max-seconds', '20');
    fs.writeFileSync(path.join(dir, 'deployment-started.json'), JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');
    const deadline = Date.now() + 12000;
    while (requests < 6 && Date.now() < deadline) await delay(100);
    assert.ok(requests >= 6);
    await run('finish', '--outcome', 'failure');
    await assert.rejects(run('report'), error => error.code === 1);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    assert.equal(report.failed, 4);
    assert.equal(report.beforeScoresSha, shaA);
    assert.equal(report.afterScoresSha, shaB);
    assert.ok(report.minIdleMs >= 1000);
    assert.ok(report.postObservationMs >= 1000);
    assert.ok(report.lastResponsePostMs >= 1000);
    const log = fs.readFileSync(path.join(dir, 'requests.jsonl'), 'utf8');
    assert.match(log, /관측 테스트/);
    assert.doesNotMatch(log, /\uFFFD/);
    assert.match(log, /response is not valid JSON/);
    assert.match(log, /TimeoutError/);
  } finally {
    if (fs.existsSync(path.join(dir, 'config.json')) && !fs.existsSync(path.join(dir, 'complete.json'))) await run('finish', '--outcome', 'failure').catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
