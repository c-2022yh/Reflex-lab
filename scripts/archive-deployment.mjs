import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const hash = data => createHash('sha256').update(data).digest('hex');
const json = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : null;
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const inside = (candidate, parent) => {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function canonical(file) {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  return path.join(canonical(path.dirname(file)), path.basename(file));
}
export function assertArchiveRoot(root, forbidden = []) {
  const resolved = canonical(path.resolve(root));
  if (resolved.split(/[\\/]/).some(segment => segment.toLowerCase() === '_work')) throw new Error('Archive root must be outside the runner _work tree');
  for (const folder of forbidden.filter(Boolean)) {
    if (inside(resolved, canonical(path.resolve(folder)))) throw new Error(`Archive root must be outside ${folder}`);
  }
  return resolved;
}

export function archiveLogs({ source, root, repository, runId, attempt, workspace = process.cwd(), runnerTemp, coreOutcomes = {} }) {
  source = path.resolve(source);
  const safeRoot = assertArchiveRoot(root, [source, workspace, process.env.GITHUB_WORKSPACE, runnerTemp ? path.dirname(runnerTemp) : null]);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('Invalid archive identity');
  const snapshot = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const destination = path.join(safeRoot, repository.replace('/', '-'), `run-${runId}-attempt-${attempt}`, snapshot);
  fs.mkdirSync(destination, { recursive: true });
  const payload = path.join(destination, 'deployment-observation');
  fs.mkdirSync(payload);
  const files = [];
  function copy(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const from = path.join(directory, entry.name), name = path.join(relative, entry.name), to = path.join(payload, name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing a symbolic link in deployment logs: ${name}`);
      if (entry.isDirectory()) { fs.mkdirSync(to); copy(from, name); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported log entry: ${name}`);
      const before = fs.statSync(from);
      const bytes = fs.readFileSync(from);
      fs.writeFileSync(to, bytes, { flag: 'wx' });
      const digest = hash(bytes);
      if (hash(fs.readFileSync(to)) !== digest) throw new Error(`Archive verification failed: ${name}`);
      const after = fs.statSync(from);
      files.push({ file: name.replaceAll(path.sep, '/'), bytes: bytes.length, sha256: digest,
        sourceChangedDuringCopy: before.size !== after.size || before.mtimeMs !== after.mtimeMs });
    }
  }
  const sourceMissing = !fs.existsSync(source);
  if (!sourceMissing) copy(source);
  const report = json(path.join(payload, 'report.json'));
  const config = json(path.join(payload, 'config.json'));
  const metadata = {
    archivedAt: new Date().toISOString(), source, destination, repository, runId, attempt,
    execution: process.env.GITHUB_ACTIONS === 'true' ? 'GitHub Actions' : 'local/manual',
    url: report?.url || config?.url || null,
    coreOutcomes, sourceMissing, files,
    note: 'Byte-preserving local snapshot. No source, old archive or GitHub Artifact was deleted.',
  };
  writeJson(path.join(destination, 'archive-manifest.json'), metadata);
  const deploymentLog = path.join(payload, 'deployment.log');
  const deploymentSummary = fs.existsSync(deploymentLog) ? fs.readFileSync(deploymentLog, 'utf8').match(/^## Reflex Lab deployment\r?\n(?:- .*?(?:\r?\n|$))+/m)?.[0] : null;
  if (deploymentSummary) fs.writeFileSync(path.join(destination, 'deployment-summary-reconstructed.md'), '<!-- Reconstructed from deployment.log; original monitor summary remains in deployment-observation/summary.md. -->\n' + deploymentSummary, 'utf8');
  const observationFile = path.join(payload, 'summary.md');
  const observationSummary = fs.existsSync(observationFile) ? fs.readFileSync(observationFile, 'utf8') : 'No observation summary was produced.\n';
  const retainedSummary = `# Retained deployment evidence\n\n- Run: ${repository} / ${runId} / attempt ${attempt}\n- Endpoint: ${metadata.url || 'not observed'}\n- Local archive: ${destination}\n- Source missing: ${sourceMissing}\n- Verified payload files: ${files.length}\n\n${deploymentSummary || ''}\n${observationSummary}`;
  fs.writeFileSync(path.join(destination, 'retained-summary.md'), retainedSummary, 'utf8');
  return { destination, manifest: metadata };
}

export function chooseUploadFailure(annotations) {
  return annotations.filter(annotation => annotation.annotation_level === 'failure' && /artifact|upload|storage quota/i.test(annotation.message || '')).at(-1)?.message || null;
}

export async function findUploadFailure({ token, apiUrl, repository, runId, jobName, runnerName, fetchImpl = fetch, attempts = 4 }) {
  if (!token) return { reason: 'Exact upload error unavailable: no read token. See the upload step log.', source: 'unavailable' };
  let lookupError = 'upload annotation has not appeared yet', jobUrl = null;
  const get = async url => {
    if (new URL(url).origin !== new URL(apiUrl).origin) throw new Error('Untrusted annotation API URL');
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`GitHub read API HTTP ${response.status}`);
    return response.json();
  };
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await get(`${apiUrl}/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
      const job = result.jobs.find(item => item.name === jobName && (!runnerName || item.runner_name === runnerName));
      jobUrl = job?.html_url || jobUrl;
      if (job?.check_run_url) {
        const annotations = await get(`${job.check_run_url}/annotations?per_page=100`);
        const reason = chooseUploadFailure(annotations);
        if (reason) return { reason, source: 'GitHub check-run failure annotation', jobUrl };
      }
    } catch (error) { lookupError = error.message; }
    if (i + 1 < attempts) await delay(2000);
  }
  return { reason: `Artifact upload failed; exact reason could not be read (${lookupError}). Inspect the upload step log; no quota cause is assumed.`, source: 'unavailable', jobUrl };
}

export function retentionSummary({ archivePath, uploadOutcome, failure, outcomes, manifest }) {
  const rows = Object.entries(outcomes).map(([name, outcome]) => `| ${name} | ${outcome || 'unknown'} |`).join('\n');
  const escapedReason = String(failure?.reason || (uploadOutcome === 'success' ? 'none' : 'Upload did not run; check preceding step results.')).replace(/```/g, '\\u0060\\u0060\\u0060');
  return [
    '## Deployment results and log retention', '',
    '| Operation | Outcome |', '|---|---|', rows,
    `| Artifact upload (separate from deployment/observation) | ${uploadOutcome || 'unknown'} |`, '',
    `- Durable local originals: **${archivePath || 'NOT PRESERVED: archive step failed; inspect its log'}**`,
    `- Endpoint: ${manifest?.url || 'not observed'}`,
    `- Byte-verified files: ${manifest?.files?.length ?? 'unknown'}`,
    `- Original logs directory missing: ${manifest?.sourceMissing ?? 'unknown'}; files changing during snapshot: ${manifest?.files?.filter(file => file.sourceChangedDuringCopy).length ?? 'unknown'}`,
    `- Evidence source for upload failure: ${failure?.source || 'step outcome'}`,
    failure?.jobUrl ? `- Upload step log: ${failure.jobUrl}` : '',
    '', 'Upload failure reason:', '```text', escapedReason, '```', '',
    'An upload-only failure is a log-storage warning when the verified local archive exists. Deployment, monitoring and local preservation failures still fail the job. No old Artifacts or billing settings were changed.', '',
  ].join('\n');
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: Object.fromEntries(['dir', 'root', 'repository', 'run-id', 'attempt', 'archive', 'upload-outcome', 'reason-file'].map(name => [name, { type: 'string' }])) });
  const outcomes = {
    deployment: process.env.DEPLOYMENT_OUTCOME || 'unknown',
    monitorStart: process.env.MONITOR_START_OUTCOME || 'unknown',
    monitorFinish: process.env.MONITOR_FINISH_OUTCOME || 'unknown',
    observation: process.env.OBSERVATION_OUTCOME || 'unknown',
  };
  if (command === 'save') {
    if (!values.dir) throw new Error('--dir is required');
    const { destination, manifest } = archiveLogs({
      source: values.dir, root: values.root || process.env.REFLEX_DEPLOY_ARCHIVE_ROOT || path.join(os.homedir(), 'Reflex-lab-deployment-logs'),
      repository: values.repository || process.env.GITHUB_REPOSITORY || 'c-2022yh/Reflex-lab',
      runId: values['run-id'] || process.env.GITHUB_RUN_ID || `manual-${Date.now()}`,
      attempt: values.attempt || process.env.GITHUB_RUN_ATTEMPT || '1', runnerTemp: process.env.RUNNER_TEMP, coreOutcomes: outcomes,
    });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${destination}\n`, 'utf8');
    console.log(`Verified durable log archive: ${destination}`);
    if (manifest.sourceMissing || manifest.files.some(file => file.sourceChangedDuringCopy)) throw new Error('Local evidence snapshot is incomplete: source logs are missing or still changing.');
    return;
  }
  if (command === 'status') {
    const archivePath = values.archive || process.env.DEPLOY_ARCHIVE_PATH || '';
    const uploadOutcome = values['upload-outcome'] || process.env.ARTIFACT_UPLOAD_OUTCOME || 'unknown';
    const manifest = archivePath ? json(path.join(archivePath, 'archive-manifest.json')) : null;
    let failure = null;
    if (uploadOutcome === 'failure') {
      failure = values['reason-file'] ? { reason: fs.readFileSync(values['reason-file'], 'utf8'), source: 'supplied recovered upload log' } : await findUploadFailure({
        token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
        repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
        jobName: process.env.GITHUB_JOB, runnerName: process.env.RUNNER_NAME,
      });
      console.log('::warning::Artifact upload failed. Deployment/observation outcomes are recorded separately; see the local archive and retention summary.');
    }
    const summary = retentionSummary({ archivePath, uploadOutcome, failure, outcomes, manifest });
    if (archivePath && manifest) {
      writeJson(path.join(archivePath, 'artifact-upload-status.json'), { recordedAt: new Date().toISOString(), uploadOutcome, failure, outcomes });
      fs.writeFileSync(path.join(archivePath, 'preservation-summary.md'), summary, 'utf8');
      const retained = fs.readFileSync(path.join(archivePath, 'retained-summary.md'), 'utf8');
      fs.writeFileSync(path.join(archivePath, 'combined-summary.md'), retained + '\n' + summary, 'utf8');
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
    console.log(summary);
    if (!manifest) throw new Error('Durable local archive is missing. Log preservation failure is not ignored.');
    if (manifest.sourceMissing || manifest.files.some(file => file.sourceChangedDuringCopy)) throw new Error('Durable local evidence snapshot is incomplete.');
    if (Object.values(outcomes).some(outcome => ['failure', 'cancelled'].includes(outcome))) throw new Error('Deployment or monitoring failed; an upload warning must not hide that failure.');
    return;
  }
  throw new Error('Expected save or status');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
