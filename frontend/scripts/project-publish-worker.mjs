#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, openAsBlob, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProjectForPublishing, sha256File, PROJECT_PUBLISH_RULE_VERSION } from '../lib/project-publish-preflight.ts';
import { applyDeterministicPathRepairs, suggestDeterministicPathRepairs } from '../lib/project-publish-repair.ts';
import { isIgnoredProjectPath, isHtmlFile } from '../lib/html-project-publisher.ts';
import { PROJECT_PUBLISH_BUCKET, PROJECT_PUBLISH_LIMITS, normalizeProjectPath } from '../lib/project-publish-online.ts';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Math.max(500, Number(process.env.PUBLISH_WORKER_POLL_MS) || 2500);
const leaseSeconds = Math.max(60, Math.min(1800, Number(process.env.PUBLISH_WORKER_LEASE_SECONDS) || 900));
const tempRoot = process.env.PUBLISH_WORKER_TMP_DIR || os.tmpdir();
const previewScript = path.resolve('scripts/project-publish-preview.mjs');
const messageOf = (error) => error instanceof Error ? error.message : String(error);

async function updateJob(jobId, values) {
  const { data, error } = await supabase.from('project_publish_jobs')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', jobId).eq('status', 'processing').eq('lease_owner', workerId)
    .select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('WORKER_LEASE_LOST');
}

async function updateProgress(jobId, phase, completed, total) {
  await updateJob(jobId, { progress: { phase, completed, total } });
}

async function renewLease(jobId) {
  const { data, error } = await supabase.from('project_publish_jobs').update({
    lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', jobId).eq('status', 'processing').eq('lease_owner', workerId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('WORKER_LEASE_LOST');
}

function safePath(root, logicalPath) {
  const normalized = normalizeProjectPath(logicalPath);
  if (!normalized) throw new Error('INVALID_PROJECT_PATH');
  const resolved = path.resolve(root, ...normalized.split('/'));
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('INVALID_PROJECT_PATH');
  return resolved;
}

async function getRevision(jobId, revisionId) {
  const { data, error } = await supabase.from('project_publish_revisions').select('*')
    .eq('id', revisionId).eq('job_id', jobId).maybeSingle();
  if (error || !data) throw new Error('REVISION_NOT_FOUND');
  return data;
}

async function downloadManifest(job, revision, root) {
  const manifest = Array.isArray(revision.manifest) ? revision.manifest : [];
  if (!manifest.length || manifest.length > PROJECT_PUBLISH_LIMITS.maxFiles) throw new Error('INVALID_MANIFEST');
  let completed = 0;
  for (const item of manifest) {
    const logicalPath = normalizeProjectPath(item.path);
    if (!logicalPath || isIgnoredProjectPath(logicalPath)
      || typeof item.storagePath !== 'string'
      || !item.storagePath.startsWith(`jobs/${job.id}/revisions/`)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > PROJECT_PUBLISH_LIMITS.maxFileBytes) {
      throw new Error('INVALID_MANIFEST');
    }
    const destination = safePath(root, logicalPath);
    await mkdir(path.dirname(destination), { recursive: true });
    const { data, error } = await supabase.storage.from(PROJECT_PUBLISH_BUCKET).download(item.storagePath);
    if (error || !data) throw new Error(`STAGED_FILE_MISSING:${logicalPath}`);
    if (data.size !== item.size) throw new Error(`STAGED_FILE_SIZE_MISMATCH:${logicalPath}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    await writeFile(destination, bytes, { flag: 'wx' });
    const observedHash = await sha256File(await openAsBlob(destination));
    if (observedHash !== item.sha256) throw new Error(`STAGED_FILE_HASH_MISMATCH:${logicalPath}`);
    completed += 1;
    await updateProgress(job.id, 'download', completed, manifest.length);
  }
  return manifest;
}

async function collectAssets(root) {
  const assets = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const logicalPath = path.relative(root, absolute).split(path.sep).join('/');
      if (isIgnoredProjectPath(logicalPath)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) assets.push({ path: logicalPath, file: await openAsBlob(absolute) });
    }
  }
  await walk(root);
  assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return assets;
}

async function runBrowserAudit(root, entryPath) {
  const child = spawn(process.execPath, [previewScript, root, '--entry', entryPath, '--json'], {
    cwd: path.dirname(previewScript),
    env: { ...process.env, PLAYWRIGHT_CHANNEL: 'chromium', PUBLISH_AUDIT_BLOCK_EXTERNAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  child.stdout.on('data', (chunk) => { stdoutSize += chunk.length; if (stdoutSize <= 16 * 1024 * 1024) stdout.push(chunk); });
  child.stderr.on('data', (chunk) => { stderrSize += chunk.length; if (stderrSize <= 1024 * 1024) stderr.push(chunk); });
  let timer;
  const result = await Promise.race([
    new Promise((resolve, reject) => child.once('error', reject).once('close', (code) => resolve({ code }))),
    new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('BROWSER_AUDIT_TIMEOUT')); }, 10 * 60 * 1000); }),
  ]).finally(() => clearTimeout(timer));
  const output = Buffer.concat(stdout).toString('utf8');
  if (!output.trim() || stdoutSize > 16 * 1024 * 1024) {
    throw new Error(`BROWSER_AUDIT_OUTPUT_INVALID:${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`);
  }
  let audit;
  try { audit = JSON.parse(output); } catch { throw new Error(`BROWSER_AUDIT_OUTPUT_INVALID:${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`); }
  if (audit.kind !== 'polymas-project-browser-audit' || audit.ruleVersion !== PROJECT_PUBLISH_RULE_VERSION
    || audit.entryPath !== entryPath) throw new Error('BROWSER_AUDIT_REPORT_INVALID');
  return { audit, exitCode: result.code };
}

function auditWarnings(preflight, audit) {
  return [...new Set([
    ...preflight.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message),
    ...(audit?.warnings || []),
    ...(audit?.limitations || []),
    ...(preflight.skippedPaths.length ? [`已跳过 ${preflight.skippedPaths.length} 个未被静态引用且非 Web 媒体文件。`] : []),
  ])];
}

async function persistScan(job, revision, preflight, audit, suggestions, error = null) {
  const staticErrors = preflight.diagnostics.filter((item) => item.severity === 'error');
  const browserErrors = audit?.errors || [];
  const passed = !staticErrors.length && !browserErrors.length && audit?.coverage?.complete === true;
  const status = passed ? 'passed' : staticErrors.length && suggestions.length ? 'needs_repair' : 'needs_attention';
  const warnings = auditWarnings(preflight, audit);
  const { data: completed, error: completionError } = await supabase.rpc('complete_project_publish_scan', {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_revision_id: revision.id,
    p_status: status,
    p_fingerprint: preflight.fingerprint,
    p_preflight_report: preflight,
    p_browser_audit: audit,
    p_repair_suggestions: suggestions,
    p_warnings: warnings,
    p_error: error,
  });
  if (completionError) throw completionError;
  if (completed !== true) throw new Error('WORKER_LEASE_LOST');
}

async function scanRevision(job, revision, root) {
  await supabase.from('project_publish_revisions').update({ status: 'processing', error: null }).eq('id', revision.id);
  await updateProgress(job.id, 'static_scan', 0, 1);
  const assets = await collectAssets(root);
  const preflight = await inspectProjectForPublishing(assets, revision.entry_path);
  const suggestions = suggestDeterministicPathRepairs(assets, preflight);
  const blocking = preflight.diagnostics.some((item) => item.severity === 'error');
  let audit = null;
  if (!blocking) {
    await updateProgress(job.id, 'browser_audit', 0, 1);
    const browserResult = await runBrowserAudit(root, revision.entry_path);
    audit = browserResult.audit;
    if (browserResult.exitCode !== 0 && !audit.errors.length) audit.errors.push('浏览器巡检进程异常退出，结果不完整。');
  }
  await persistScan(job, revision, preflight, audit, suggestions);
}

async function applyRepairs(job, oldRevision, root, selectedIds) {
  if (!Array.isArray(selectedIds) || !selectedIds.length) throw new Error('INVALID_REPAIR_SELECTION');
  const suggestions = Array.isArray(oldRevision.repair_suggestions) ? oldRevision.repair_suggestions : [];
  const oldAssets = await collectAssets(root);
  const result = await applyDeterministicPathRepairs(oldAssets, suggestions, selectedIds);
  if (!result.changedPaths.length) throw new Error('NO_REPAIR_APPLIED');

  const revisionId = randomUUID();
  const previous = new Map(oldRevision.manifest.map((item) => [item.path, item]));
  const files = [];
  for (const asset of result.assets) {
    const old = previous.get(asset.path);
    if (!old) throw new Error('REPAIR_CHANGED_MANIFEST_PATH');
    if (!result.changedPaths.includes(asset.path)) { files.push(old); continue; }
    const storagePath = `jobs/${job.id}/revisions/${revisionId}/source/${asset.path}`;
    const bytes = Buffer.from(await asset.file.arrayBuffer());
    const { error } = await supabase.storage.from(PROJECT_PUBLISH_BUCKET).upload(storagePath, bytes, {
      contentType: asset.file.type || old.type || 'application/octet-stream', upsert: false,
    });
    if (error) throw new Error(`REPAIRED_FILE_UPLOAD_FAILED:${asset.path}`);
    files.push({
      path: asset.path, size: bytes.byteLength, type: asset.file.type || old.type || 'application/octet-stream',
      sha256: await sha256File(asset.file), storagePath,
    });
  }
  const repairs = suggestions.filter((item) => selectedIds.includes(item.id));
  const { error: insertError } = await supabase.from('project_publish_revisions').insert({
    id: revisionId, job_id: job.id, parent_revision_id: oldRevision.id, entry_path: oldRevision.entry_path,
    manifest: files, status: 'processing', fingerprint: null, preflight_report: null,
    browser_audit: null, repair_suggestions: [], repairs, warnings: [], error: null,
  });
  if (insertError) throw new Error('REPAIR_REVISION_CREATE_FAILED');
  const { data: activated, error: updateError } = await supabase.from('project_publish_jobs').update({
    current_revision_id: revisionId, status: 'processing', work_type: null, work_payload: {},
    progress: { phase: 'repair_applied', completed: result.changedPaths.length, total: result.changedPaths.length },
  }).eq('id', job.id).eq('status', 'processing').eq('lease_owner', workerId).select('id').maybeSingle();
  if (updateError || !activated) throw new Error('REPAIR_REVISION_ACTIVATE_FAILED');
  return getRevision(job.id, revisionId);
}

async function processJob(job) {
  const workDir = await mkdtemp(path.join(tempRoot, 'project-publish-'));
  let activeRevisionId = job.current_revision_id;
  const heartbeat = setInterval(() => {
    void renewLease(job.id).catch(() => console.error(JSON.stringify({ event: 'project_publish_lease_renew_failed', jobId: job.id })));
  }, 60_000);
  heartbeat.unref?.();
  try {
    let revision = await getRevision(job.id, activeRevisionId);
    const manifest = await downloadManifest(job, revision, workDir);
    if (!isHtmlFile(revision.entry_path) || !manifest.some((item) => item.path === revision.entry_path)) throw new Error('ENTRY_HTML_MISSING');
    if (job.work_type === 'repair') {
      revision = await applyRepairs(job, revision, workDir, job.work_payload?.selectedIds);
      activeRevisionId = revision.id;
      // A repair version has a fresh immutable storage prefix. Refresh its files in
      // the task directory from the new manifest before running either audit.
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      await downloadManifest({ ...job, current_revision_id: revision.id }, revision, workDir);
    }
    await scanRevision(job, revision, workDir);
  } catch (error) {
    const detail = messageOf(error).replace(/[\r\n]+/g, ' ').slice(0, 400);
    const code = detail.split(':', 1)[0].slice(0, 100) || 'WORKER_ERROR';
    console.error(JSON.stringify({ event: 'project_publish_job_failed', jobId: job.id, code }));
    try {
      await updateJob(job.id, { status: 'failed', error: detail || code, work_type: null, work_payload: {}, lease_owner: null, lease_until: null });
      await supabase.from('project_publish_revisions').update({ status: 'failed', error: detail || code }).eq('id', activeRevisionId).eq('job_id', job.id);
    } catch (updateError) {
      const updateCode = messageOf(updateError).split(':', 1)[0].slice(0, 100) || 'STATE_UPDATE_FAILED';
      console.error(JSON.stringify({ event: 'project_publish_failure_state_update_failed', jobId: job.id, code: updateCode }));
    }
  } finally {
    clearInterval(heartbeat);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function cleanupExpired() {
  const { data: expired, error } = await supabase.from('project_publish_jobs').select('id')
    .lt('expires_at', new Date().toISOString()).limit(25);
  if (error || !expired?.length) return;
  for (const job of expired) {
    const { data: revisions } = await supabase.from('project_publish_revisions').select('manifest').eq('job_id', job.id);
    const objectPaths = [...new Set((revisions || []).flatMap((revision) => Array.isArray(revision.manifest)
      ? revision.manifest.map((item) => item?.storagePath).filter((item) => typeof item === 'string') : []))];
    for (let offset = 0; offset < objectPaths.length; offset += 100) {
      await supabase.storage.from(PROJECT_PUBLISH_BUCKET).remove(objectPaths.slice(offset, offset + 100));
    }
    await supabase.from('project_publish_jobs').delete().eq('id', job.id).lt('expires_at', new Date().toISOString());
  }
}

let lastCleanup = 0;
console.log(JSON.stringify({ event: 'project_publish_worker_started', workerId }));
while (true) {
  if (Date.now() - lastCleanup > 60 * 60 * 1000) {
    await cleanupExpired().catch(() => console.error(JSON.stringify({ event: 'project_publish_cleanup_failed' })));
    lastCleanup = Date.now();
  }
  const { data, error } = await supabase.rpc('claim_project_publish_job', {
    p_worker_id: workerId, p_lease_seconds: leaseSeconds,
  });
  if (error) {
    console.error(JSON.stringify({ event: 'project_publish_queue_error' }));
    await delay(pollMs * 2);
    continue;
  }
  const job = Array.isArray(data) ? data[0] : data;
  if (!job) { await delay(pollMs); continue; }
  await processJob(job);
}
