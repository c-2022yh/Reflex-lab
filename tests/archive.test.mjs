import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { archiveLogs, assertArchiveRoot, chooseUploadFailure, findUploadFailure, retentionSummary } from '../scripts/archive-deployment.mjs';

test('verified archive survives source cleanup, preserves UTF-8 and never overwrites an earlier snapshot', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-archive-test-'));
  const workspace = path.join(fixture, '_work', 'repo');
  const source = path.join(workspace, 'outputs', 'deployment-test');
  const root = path.join(fixture, 'durable');
  fs.mkdirSync(source, { recursive: true });
  const content = '실제 배포 기록\n{"commitSha":"' + 'a'.repeat(40) + '"}\n';
  fs.writeFileSync(path.join(source, 'requests.jsonl'), content, 'utf8');
  fs.writeFileSync(path.join(source, 'report.json'), JSON.stringify({ url: 'http://127.0.0.1:3000/api/scores', failed: 0 }), 'utf8');
  fs.writeFileSync(path.join(source, 'summary.md'), '# 실제 관측 Summary\n', 'utf8');
  const options = { source, root, workspace, repository: 'c-2022yh/Reflex-lab', runId: '123', attempt: '1' };
  const first = archiveLogs(options);
  const second = archiveLogs(options);
  assert.notEqual(first.destination, second.destination);
  assert.equal(first.manifest.files.length, 3);
  assert.ok(first.manifest.files.every(file => file.sha256.length === 64 && !file.sourceChangedDuringCopy));
  // Simulate checkout cleaning only this test's source files, without recursive deletion.
  for (const file of fs.readdirSync(source)) fs.unlinkSync(path.join(source, file));
  assert.equal(fs.readFileSync(path.join(first.destination, 'deployment-observation', 'requests.jsonl'), 'utf8'), content);
  assert.equal(fs.readFileSync(path.join(second.destination, 'deployment-observation', 'requests.jsonl'), 'utf8'), content);
  assert.match(fs.readFileSync(path.join(first.destination, 'retained-summary.md'), 'utf8'), /실제 관측 Summary/);
});

test('archive destinations in the workspace or any runner _work directory are rejected', () => {
  assert.throws(() => assertArchiveRoot(path.join(process.cwd(), 'outputs', 'unsafe'), [process.cwd()]), /outside/);
  assert.throws(() => assertArchiveRoot(path.join(os.tmpdir(), '_work', 'unsafe')), /outside/);
});

test('Artifact quota is read from its own annotation, without confusing a deployment error', async () => {
  const annotations = [
    { annotation_level: 'failure', message: 'Deployment health failed' },
    { annotation_level: 'failure', message: 'Failed to CreateArtifact: Artifact storage quota has been hit.' },
  ];
  assert.match(chooseUploadFailure(annotations), /storage quota/);
  const requested = [];
  const result = await findUploadFailure({ token: 'test-token-never-logged', apiUrl: 'https://api.github.com', repository: 'owner/repo', runId: '123', jobName: 'deploy', runnerName: 'reflex-windows', attempts: 1,
    fetchImpl: async url => {
      requested.push(url);
      return { ok: true, json: async () => url.includes('/annotations') ? annotations : { jobs: [{ name: 'deploy', runner_name: 'reflex-windows', html_url: 'https://github.com/owner/repo/actions/runs/123/job/4', check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/4' }] } };
    },
  });
  assert.equal(requested.length, 2);
  assert.match(result.reason, /storage quota/);
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});

test('unavailable error details are reported honestly and do not invent a quota cause', async () => {
  const result = await findUploadFailure({ token: 'test', apiUrl: 'https://api.github.com', repository: 'owner/repo', runId: '123', jobName: 'deploy', attempts: 1,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.match(result.reason, /HTTP 403/);
  assert.match(result.reason, /no quota cause is assumed/);
  assert.equal(result.source, 'unavailable');
});

test('retention summary distinguishes deployment failure, observation failure and upload-only failure', () => {
  const summary = retentionSummary({ archivePath: 'C:\\durable\\run-123', uploadOutcome: 'failure', failure: { reason: 'Artifact storage quota has been hit.', source: 'test annotation' },
    outcomes: { deployment: 'failure', observation: 'failure' }, manifest: { url: 'http://127.0.0.1:3000/api/scores', files: [] } });
  assert.match(summary, /\| deployment \| failure \|/);
  assert.match(summary, /\| observation \| failure \|/);
  assert.match(summary, /Artifact upload \(separate from deployment\/observation\) \| failure/);
  assert.match(summary, /C:\\durable\\run-123/);
  assert.match(summary, /Deployment, monitoring and local preservation failures still fail/);
});

test('upload-only failure returns zero after local preservation, but deployment failure still returns nonzero', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-status-test-'));
  const source = path.join(fixture, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'summary.md'), '# Preserved original\n', 'utf8');
  const { destination } = archiveLogs({ source, root: path.join(fixture, 'durable'), repository: 'owner/repo', runId: '456', attempt: '1' });
  const reasonFile = path.join(fixture, 'upload-failure.txt');
  fs.writeFileSync(reasonFile, 'Artifact storage quota has been hit.', 'utf8');
  const env = { ...process.env, DEPLOYMENT_OUTCOME: 'success', MONITOR_START_OUTCOME: 'success', MONITOR_FINISH_OUTCOME: 'success', OBSERVATION_OUTCOME: 'success', GITHUB_STEP_SUMMARY: path.join(fixture, 'job-summary.md') };
  const args = [path.resolve('scripts/archive-deployment.mjs'), 'status', '--archive', destination, '--upload-outcome', 'failure', '--reason-file', reasonFile];
  const uploadOnly = spawnSync(process.execPath, args, { env, encoding: 'utf8', windowsHide: true });
  assert.equal(uploadOnly.status, 0, uploadOnly.stderr);
  assert.match(fs.readFileSync(path.join(destination, 'preservation-summary.md'), 'utf8'), /storage quota/);
  const deploymentFailure = spawnSync(process.execPath, args, { env: { ...env, DEPLOYMENT_OUTCOME: 'failure' }, encoding: 'utf8', windowsHide: true });
  assert.equal(deploymentFailure.status, 1);
  assert.match(deploymentFailure.stderr, /must not hide that failure/);
  assert.ok(fs.existsSync(path.join(destination, 'combined-summary.md')));
});
