import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const shaPattern = /^[0-9a-f]{40}$/;
let diagnosticDirectory = null;
const now = () => new Date().toISOString();
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function writeJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}
function append(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flush: true });
}

// Business validation and version evidence are deliberately separate: the first
// rollout from the old API can have valid ranking responses with no SHA field.
export function validateRanking(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['JSON must be an object'];
  if (!Array.isArray(body.scores) || body.scores.length > 10) errors.push('scores must be an array of at most 10 rows');
  if (!Number.isSafeInteger(body.total) || body.total < 0) errors.push('total must be a nonnegative integer');
  if (body.best !== null && (!Number.isInteger(body.best) || body.best < 80 || body.best > 5000)) errors.push('best must be null or a valid reaction time');
  if (Array.isArray(body.scores)) {
    if (body.total < body.scores.length || (body.total > 0 && !body.scores.length) || (body.total === 0 && body.best !== null)) errors.push('ranking totals are inconsistent');
    for (const [index, score] of body.scores.entries()) {
      if (!score || typeof score.id !== 'string' || !score.id || typeof score.nickname !== 'string' || !score.nickname ||
          !Number.isInteger(score.average) || score.average < 80 || score.average > 5000 ||
          !Number.isInteger(score.fastest) || score.fastest < 80 || score.fastest > score.average ||
          !Number.isSafeInteger(score.createdAt) || score.createdAt < 0) errors.push(`scores[${index}] has missing/invalid fields`);
    }
    if (body.scores.length && body.best !== body.scores[0]?.average) errors.push('best does not match the leading score');
  }
  return errors;
}

function readRecords(file) {
  if (!fs.existsSync(file)) return { records: [], brokenLines: 0 };
  const records = []; let brokenLines = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch { brokenLines++; }
  }
  return { records, brokenLines };
}

export function buildReport(config, events, completion, finish, reportAt = now()) {
  const responses = events.filter(e => e.kind === 'response');
  const starts = events.filter(e => e.kind === 'request-start');
  const completed = new Set(responses.map(e => e.sequence));
  const pending = starts.filter(e => !completed.has(e.sequence));
  const successful = responses.filter(e => e.success);
  const failures = responses.filter(e => !e.success && !e.expectedInitialUnavailable);
  const post = successful.filter(e => finish && Date.parse(e.startedAt) >= Date.parse(finish.finishedAt));
  const before = successful.find(e => !events.some(s => s.kind === 'deployment-started' && Date.parse(s.at) <= Date.parse(e.startedAt)));
  const gaps = responses.filter(e => e.completionGapMs > config.gapThresholdMs).map(e => ({
    from: e.previousCompletedAt || config.startedAt, to: e.completedAt, durationMs: e.completionGapMs,
    idleMs: e.idleSincePreviousEndMs, requestMs: e.durationMs,
  }));
  const endAt = completion?.endedAt || reportAt;
  const tailGapMs = responses.length ? Math.max(0, Date.parse(endAt) - Date.parse(responses.at(-1).completedAt)) : Math.max(0, Date.parse(endAt) - Date.parse(config.startedAt));
  if (tailGapMs > config.gapThresholdMs) gaps.push({ from: responses.at(-1)?.completedAt || config.startedAt, to: endAt, durationMs: tailGapMs, reason: 'no completed record before observation ended' });
  const max = (key, rows = responses) => Math.max(0, ...rows.map(e => e[key] || 0));
  const baseline = events.find(e => e.kind === 'baseline-health');
  const versions = [...new Set(successful.map(e => e.commitSha).filter(Boolean))];
  const tailMs = finish ? Math.max(0, Date.parse(endAt) - Date.parse(finish.finishedAt)) : 0;
  const lastResponsePostMs = finish && responses.length ? Date.parse(responses.at(-1).completedAt) - Date.parse(finish.finishedAt) : null;
  const issues = [];
  if (failures.length) issues.push(`${failures.length} observed ranking requests failed validation`);
  if (pending.length) issues.push(`${pending.length} requests have no completion record`);
  if (gaps.length) issues.push(`${gaps.length} completed-record gaps exceeded ${config.gapThresholdMs} ms`);
  if (!completion || completion.reason !== 'post-window-complete') issues.push('monitor did not complete its post-deployment observation window');
  if (!finish || tailMs < config.postSeconds * 1000) issues.push('post-deployment time coverage is incomplete');
  if (lastResponsePostMs === null || lastResponsePostMs < config.postSeconds * 1000) issues.push('no completed ranking request reaches the end of the required post-deployment window');
  if (finish?.outcome === 'success' && post.at(-1)?.commitSha !== config.commitSha) issues.push('the last valid post-deployment ranking response did not report the target SHA');
  if (!successful.length) issues.push('no valid ranking responses were observed');
  return {
    url: config.url, mode: config.mode, targetSha: config.commitSha,
    startedAt: config.startedAt, firstRequestAt: starts[0]?.startedAt || null, endedAt: endAt,
    deploymentStartedAt: events.find(e => e.kind === 'deployment-started')?.at || null,
    deploymentFinishedAt: finish?.finishedAt || null, deploymentOutcome: finish?.outcome || 'unknown',
    postObservationMs: tailMs, configuredPostSeconds: config.postSeconds,
    lastCompletedAt: responses.at(-1)?.completedAt || null, lastResponsePostMs,
    monitorCompletionReason: completion?.reason || 'missing', monitorError: completion?.error || null,
    baselineHealthSha: baseline?.commitSha || null,
    beforeScoresSha: before?.commitSha || null, afterScoresSha: post.at(-1)?.commitSha || null,
    versions, total: responses.length, successful: successful.length, failed: failures.length,
    expectedInitialUnavailable: responses.filter(e => e.expectedInitialUnavailable).length,
    shaUnknown: successful.filter(e => !e.commitSha).length,
    maxDurationMs: max('durationMs'), maxStartIntervalMs: max('startIntervalMs'),
    minIdleMs: responses.length > 1 ? Math.min(...responses.slice(1).map(e => e.idleSincePreviousEndMs)) : null,
    maxIdleMs: max('idleSincePreviousEndMs'), maxCompletionGapMs: Math.max(max('completionGapMs'), tailGapMs),
    gapThresholdMs: config.gapThresholdMs, gaps, pending,
    beforeResponse: before || responses[0] || null, afterResponse: post.at(-1) || responses.at(-1) || null,
    failureResponse: failures[0] || null,
    phases: Object.fromEntries(['before-deployment', 'deploying', 'post-deployment'].map(phase => [phase, {
      completed: responses.filter(e => e.phase === phase).length,
      successful: successful.filter(e => e.phase === phase).length,
      failed: failures.filter(e => e.phase === phase).length,
      initialUnavailable: responses.filter(e => e.phase === phase && e.expectedInitialUnavailable).length,
    }])),
    issues, verdict: issues.length ? 'OBSERVATION FAILED OR INCOMPLETE' : 'NO FAILURE IN OBSERVED REQUESTS',
    limitation: 'Only sampled requests were observed. The one-second idle periods, outstanding requests and log gaps cannot establish continuous availability. Missing response SHAs are unknown, not inferred from health.',
  };
}

export function renderSummary(report) {
  const representative = response => {
    if (!response) return 'No response';
    let body = response.responseBody;
    try { body = JSON.parse(body); } catch { /* Keep non-JSON failure bodies visible. */ }
    return JSON.stringify({ startedAt: response.startedAt, completedAt: response.completedAt, durationMs: response.durationMs == null ? null : Number(response.durationMs.toFixed(3)),
      status: response.httpStatus, success: response.success, commitSha: response.commitSha, errors: response.errors, body }, null, 2);
  };
  return [
    '## Ranking API deployment observation', '',
    `- Verdict: **${report.verdict}**`,
    `- URL: ${report.url}`,
    `- Mode: ${report.mode}; deployment outcome: ${report.deploymentOutcome}`,
    `- UTC observation: ${report.startedAt} → ${report.endedAt}`,
    `- Deployment: ${report.deploymentStartedAt || 'not started'} → ${report.deploymentFinishedAt || 'unknown'}`,
    `- Post-deployment coverage: ${(report.postObservationMs / 1000).toFixed(3)} s (required ${report.configuredPostSeconds} s)`,
    `- Last completed ranking response: ${report.lastCompletedAt || 'none'}; after completion: ${report.lastResponsePostMs === null ? 'N/A' : (report.lastResponsePostMs / 1000).toFixed(3) + ' s'}`,
    `- Monitor completion: ${report.monitorCompletionReason}${report.monitorError ? `; ${report.monitorError}` : ''}`,
    `- Before SHA (scores response): ${report.beforeScoresSha || 'UNKNOWN / not present'}`,
    `- Baseline SHA (separate health request): ${report.baselineHealthSha || 'UNKNOWN / no service'}`,
    `- After SHA (scores response): ${report.afterScoresSha || 'UNKNOWN'}`,
    `- Target SHA: ${report.targetSha}`,
    '', '| Completed requests | Successful | Failed | Initial service not yet available | SHA unknown among successes |',
    '|---:|---:|---:|---:|---:|',
    `| ${report.total} | ${report.successful} | ${report.failed} | ${report.expectedInitialUnavailable} | ${report.shaUnknown} |`, '',
    '| Request-start phase | Completed | Successful | Failed | Initial unavailable |', '|---|---:|---:|---:|---:|',
    ...Object.entries(report.phases).map(([phase, counts]) => `| ${phase} | ${counts.completed} | ${counts.successful} | ${counts.failed} | ${counts.initialUnavailable} |`), '',
    '| Timing metric | Observed ms |', '|---|---:|',
    `| Maximum response time | ${report.maxDurationMs.toFixed(3)} |`,
    `| Maximum start-to-start interval | ${report.maxStartIntervalMs.toFixed(3)} |`,
    `| Minimum / maximum idle after previous response | ${report.minIdleMs?.toFixed(3) ?? 'N/A'} / ${report.maxIdleMs.toFixed(3)} |`,
    `| Maximum completed-record gap (including trailing gap) | ${report.maxCompletionGapMs.toFixed(3)} |`,
    `| Gap display threshold | ${report.gapThresholdMs} |`, '',
    'Requests are sequential. The next request starts at least 1 second after the previous response finishes; slow responses increase the start-to-start interval.', '',
    ...report.gaps.map(g => `- Record gap: ${g.from} → ${g.to}; ${g.durationMs.toFixed(3)} ms; idle=${g.idleMs?.toFixed(3) ?? 'unknown'} ms, request=${g.requestMs?.toFixed(3) ?? 'unknown'} ms`),
    ...report.issues.map(issue => `- Issue: ${issue}`), '',
    '### Representative response before deployment', '```json', representative(report.beforeResponse).replace(/```/g, '\\u0060\\u0060\\u0060'), '```',
    '### Representative response after deployment', '```json', representative(report.afterResponse).replace(/```/g, '\\u0060\\u0060\\u0060'), '```', '',
    ...(report.failureResponse ? ['### Representative failed response', '```json', representative(report.failureResponse).replace(/```/g, '\\u0060\\u0060\\u0060'), '```', ''] : []),
    `**Observation limit:** ${report.limitation}`, '',
  ].join('\n');
}

async function watch(dir) {
  const config = readJson(path.join(dir, 'config.json'));
  const eventFile = path.join(dir, 'events.jsonl');
  const origin = performance.now();
  let previous = null, sequence = 0, everValid = false, baselineSha = null, startLogged = false, stopAt = null;
  let reason = 'monitor-error', error = null;
  try {
    // This is separate evidence. Never assign this SHA to a scores response.
    try {
      const response = await fetch(new URL('/api/health', config.url), { signal: AbortSignal.timeout(config.timeoutMs), cache: 'no-store' });
      const body = await response.json();
      baselineSha = response.ok && shaPattern.test(body.commitSha) ? body.commitSha : null;
      append(eventFile, { kind: 'baseline-health', at: now(), httpStatus: response.status, commitSha: baselineSha, body });
    } catch (error) { append(eventFile, { kind: 'baseline-health', at: now(), commitSha: null, error: String(error) }); }
    while (true) {
      const deploymentStart = readJson(path.join(dir, 'deployment-started.json'));
      if (deploymentStart && !startLogged) { append(eventFile, { kind: 'deployment-started', at: deploymentStart.startedAt }); startLogged = true; }
      const finish = readJson(path.join(dir, 'deployment-finished.json'));
      if (finish && stopAt === null) stopAt = performance.now() + Math.max(0, Date.parse(finish.finishedAt) + config.postSeconds * 1000 - Date.now());
      if (stopAt !== null && previous && previous.monotonicEndMs >= stopAt) { reason = 'post-window-complete'; break; }
      if (readJson(path.join(dir, 'stop.json'))) { reason = 'forced-stop'; break; }
      if (performance.now() - origin > config.maxSeconds * 1000) { reason = 'monitor-safety-timeout'; break; }
      const phase = finish ? 'post-deployment' : deploymentStart ? 'deploying' : 'before-deployment';
      const start = performance.now();
      const startedAt = now();
      const record = {
        kind: 'response', sequence: ++sequence, phase, startedAt,
        startIntervalMs: previous ? start - previous.monotonicStartMs : null,
        idleSincePreviousEndMs: previous ? start - previous.monotonicEndMs : null,
        previousCompletedAt: previous?.completedAt || null,
        monotonicStartMs: start,
      };
      append(eventFile, { ...record, kind: 'request-start' });
      let responseBody = null, status = null, commitSha = null, errors = [], transportError = null;
      try {
        const response = await fetch(config.url, { signal: AbortSignal.timeout(config.timeoutMs), cache: 'no-store', headers: { Connection: 'close' } });
        status = response.status;
        responseBody = await response.text();
        if (status !== 200) errors.push(`HTTP ${status}`);
        let body;
        try { body = JSON.parse(responseBody); } catch { errors.push('response is not valid JSON'); }
        if (body !== undefined) {
          errors.push(...validateRanking(body));
          if (body && Object.hasOwn(body, 'commitSha')) {
            if (!shaPattern.test(body.commitSha)) errors.push('invalid commitSha');
            else {
              commitSha = body.commitSha;
              if (baselineSha && ![baselineSha, config.commitSha].includes(commitSha)) errors.push(`unexpected SHA ${commitSha}`);
            }
          }
        }
      } catch (error) {
        transportError = error.cause?.code || error.name;
        errors.push(`${error.name}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
      }
      const end = performance.now();
      const success = errors.length === 0;
      const expectedInitialUnavailable = config.mode === 'initial-deployment' && !everValid && !finish && status === null && transportError === 'ECONNREFUSED';
      const completedAt = now();
      const row = { ...record, completedAt, monotonicEndMs: end, durationMs: end - start,
        completionGapMs: previous ? end - previous.monotonicEndMs : Math.max(0, Date.parse(completedAt) - Date.parse(config.startedAt)),
        httpStatus: status, success, commitSha, shaEvidence: commitSha ? 'response' : 'unknown',
        expectedInitialUnavailable, errors, responseBody };
      append(eventFile, row);
      append(path.join(dir, 'requests.jsonl'), row);
      if (success) everValid = true;
      if (!fs.existsSync(path.join(dir, 'ready.json'))) writeJson(path.join(dir, 'ready.json'), { pid: process.pid, at: row.completedAt, firstResponse: row });
      previous = row;
      // Include a completed request at/after the 30-second boundary, not just
      // an idle monitor process that happened to stay alive for 30 seconds.
      if (stopAt !== null && end >= stopAt) { reason = 'post-window-complete'; break; }
      // Wait only after completion and durable logging, never on a fixed-rate timer.
      const nextStart = end + 1000;
      while (performance.now() < nextStart) await delay(Math.ceil(nextStart - performance.now()));
    }
  } catch (caught) { error = String(caught.stack || caught); }
  finally {
    writeJson(path.join(dir, 'complete.json'), { endedAt: now(), reason, error });
  }
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: Object.fromEntries([
    'dir', 'url', 'sha', 'mode', 'deployment-name', 'context', 'post-seconds', 'request-timeout-ms', 'gap-threshold-ms', 'max-seconds', 'outcome',
  ].map(key => [key, { type: 'string' }])) });
  if (!values.dir) throw new Error('--dir is required');
  const dir = path.resolve(values.dir);
  fs.mkdirSync(dir, { recursive: true });
  diagnosticDirectory = dir;
  if (command === 'watch') return watch(dir);
  if (command === 'start') {
    if (fs.existsSync(path.join(dir, 'config.json'))) throw new Error('Refusing to overwrite an existing monitor run');
    if (!shaPattern.test(values.sha)) throw new Error('--sha must be a full commit SHA');
    const url = new URL(values.url || 'http://127.0.0.1:3000/api/scores');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/api/scores' || url.username || url.password || url.search || url.hash) throw new Error('Use the loopback /api/scores endpoint');
    let mode = values.mode || 'auto';
    if (mode === 'auto') {
      const name = values['deployment-name'] || 'reflex-lab';
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Invalid deployment name');
      const inspected = spawnSync('docker', ['--context', values.context || 'desktop-linux', 'container', 'ls', '-a', '--filter', `name=^/${name}-gateway$`, '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (inspected.status !== 0) throw new Error(`Cannot identify deployment mode: ${inspected.stderr || inspected.error}`);
      mode = inspected.stdout.trim() ? 'redeployment' : 'initial-deployment';
    }
    if (!['redeployment', 'initial-deployment'].includes(mode)) throw new Error('Invalid mode');
    const config = { url: url.href, mode, commitSha: values.sha, startedAt: now(), postSeconds: Number(values['post-seconds'] ?? 30), timeoutMs: Number(values['request-timeout-ms'] ?? 5000), gapThresholdMs: Number(values['gap-threshold-ms'] ?? 2500), maxSeconds: Number(values['max-seconds'] ?? 1200) };
    if (![config.postSeconds, config.timeoutMs, config.gapThresholdMs, config.maxSeconds].every(Number.isFinite) || config.postSeconds < 1 || config.timeoutMs < 100 || config.timeoutMs > 30000 || config.gapThresholdMs < 1000 || config.maxSeconds < 10) throw new Error('Invalid timing options');
    writeJson(path.join(dir, 'config.json'), config);
    const stdout = fs.openSync(path.join(dir, 'monitor.stdout.log'), 'a');
    const stderr = fs.openSync(path.join(dir, 'monitor.stderr.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--dir', dir], { detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
    child.unref(); fs.closeSync(stdout); fs.closeSync(stderr);
    writeJson(path.join(dir, 'process.json'), { pid: child.pid, startedAt: now() });
    const deadline = Date.now() + config.timeoutMs * 2 + 10000;
    while (!readJson(path.join(dir, 'ready.json'))) {
      if (readJson(path.join(dir, 'complete.json')) || Date.now() > deadline) throw new Error('Independent monitor did not complete its first request; deployment must not start');
      await delay(100);
    }
    console.log(`Independent monitor ready: ${config.url}; mode=${mode}; logs=${dir}`);
    return;
  }
  const config = readJson(path.join(dir, 'config.json'));
  if (command === 'finish') {
    if (!fs.existsSync(path.join(dir, 'deployment-finished.json'))) writeJson(path.join(dir, 'deployment-finished.json'), { finishedAt: now(), outcome: values.outcome || 'unknown' });
    if (config) {
      const deadline = Date.now() + config.postSeconds * 1000 + config.timeoutMs + 10000;
      while (!readJson(path.join(dir, 'complete.json')) && Date.now() < deadline) await delay(200);
      if (!readJson(path.join(dir, 'complete.json'))) {
        writeJson(path.join(dir, 'stop.json'), { at: now() });
        const stopDeadline = Date.now() + config.timeoutMs + 1500;
        while (!readJson(path.join(dir, 'complete.json')) && Date.now() < stopDeadline) await delay(200);
        throw new Error('Monitor did not finish normally; report will mark coverage incomplete');
      }
    }
    return;
  }
  if (command === 'report') {
    if (!config) {
      const summary = '## Ranking API deployment observation\n\n**NOT OBSERVED:** monitor configuration is missing. No availability conclusion is possible.\n';
      fs.writeFileSync(path.join(dir, 'summary.md'), summary, 'utf8');
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
      process.exitCode = 1; return;
    }
    const { records, brokenLines } = readRecords(path.join(dir, 'events.jsonl'));
    const report = buildReport(config, records, readJson(path.join(dir, 'complete.json')), readJson(path.join(dir, 'deployment-finished.json')));
    if (brokenLines) { report.issues.push(`${brokenLines} unreadable log lines`); report.verdict = 'OBSERVATION FAILED OR INCOMPLETE'; }
    writeJson(path.join(dir, 'report.json'), report);
    const summary = renderSummary(report);
    fs.writeFileSync(path.join(dir, 'summary.md'), summary, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
    console.log(summary);
    process.exitCode = report.issues.length ? 1 : 0;
    return;
  }
  throw new Error('Expected start, watch, finish or report');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const detail = error.stack || String(error);
    if (diagnosticDirectory) {
      try { fs.appendFileSync(path.join(diagnosticDirectory, 'control-errors.log'), `${now()}\n${detail}\n`, 'utf8'); } catch { /* The runner console remains a fallback if the disk is unavailable. */ }
    }
    console.error(detail); process.exitCode = 1;
  });
}
