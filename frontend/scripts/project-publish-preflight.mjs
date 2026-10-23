#!/usr/bin/env node
import { openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isIgnoredProjectPath } from '../lib/html-project-publisher.ts';
import { inspectProjectForPublishing } from '../lib/project-publish-preflight.ts';

const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function collect(directory, root, assets) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => comparePaths(a.name, b.name))) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (isIgnoredProjectPath(relativePath)) continue;
    if (entry.isDirectory()) {
      await collect(fullPath, root, assets);
    } else if (entry.isFile()) {
      assets.push({ path: relativePath, file: new File([await openAsBlob(fullPath)], entry.name) });
    }
  }
}

let options;
try {
  options = parseArgs({ allowPositionals: true, options: {
    entry: { type: 'string', default: 'index.html' }, json: { type: 'boolean' },
  } });
  if (options.positionals.length !== 1 || !options.values.entry) throw new Error('需要一个项目目录和有效入口。');
} catch (error) {
  process.stderr.write(`${error.message}\n用法：node project-publish-preflight.mjs 项目目录 [--entry index.html] [--json]\n`);
  process.exit(2);
}
const [directory] = options.positionals;
const { entry: entryPath, json } = options.values;

const root = path.resolve(directory);
if (!(await stat(root).catch(() => null))?.isDirectory()) {
  process.stderr.write(`项目目录不存在：${root}\n`);
  process.exit(2);
}

const assets = [];
await collect(root, root, assets);
assets.sort((a, b) => comparePaths(a.path, b.path));
const report = await inspectProjectForPublishing(assets, entryPath);
const errors = report.diagnostics.filter((item) => item.severity === 'error');
const warnings = report.diagnostics.filter((item) => item.severity === 'warning');
if (json) {
  process.stdout.write(`${JSON.stringify({ root, fileCount: assets.length, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`项目：${root}\n`);
  process.stdout.write(`预检：${errors.length} 个阻断问题，${warnings.length} 个提示；模拟替换 ${report.simulatedReplacementCount} 处路径。\n`);
  process.stdout.write(`发布文件：${report.rawAssetPaths.length + report.cssPaths.length + report.scriptPaths.length + report.secondaryHtmlPaths.length + 1}；跳过：${report.skippedPaths.length}。\n`);
  for (const item of report.diagnostics) process.stdout.write(`[${item.severity}] ${item.message}\n`);
}
process.exitCode = errors.length ? 1 : 0;
