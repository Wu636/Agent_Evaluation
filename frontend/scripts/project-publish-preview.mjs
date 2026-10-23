#!/usr/bin/env node
import { createServer } from 'node:http';
import { openAsBlob } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isHtmlFile, isIgnoredProjectPath } from '../lib/html-project-publisher.ts';
import { inspectProjectForPublishing, buildFlatProjectPreview, PROJECT_PUBLISH_RULE_VERSION } from '../lib/project-publish-preflight.ts';

const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const messageOf = (error) => error instanceof Error ? error.message : String(error);
const addUnique = (list, value) => { if (!list.includes(value)) list.push(value); };
async function collect(directory, root, assets) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => comparePaths(a.name, b.name))) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    if (isIgnoredProjectPath(relativePath)) continue;
    if (entry.isDirectory()) await collect(fullPath, root, assets);
    else if (entry.isFile()) assets.push({ path: relativePath, file: new File([await openAsBlob(fullPath)], entry.name) });
  }
}
async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

let options;
try {
  const args = process.argv.slice(2);
  options = parseArgs({
    args: args.map((arg, index) => arg === '--report' && (!args[index + 1] || args[index + 1].startsWith('--')) ? '--report=' : arg),
    allowPositionals: true,
    options: { entry: { type: 'string', default: 'index.html' }, flows: { type: 'string' }, report: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (options.positionals.length !== 1 || !options.values.entry || options.values.flows === '') throw new Error('需要一个项目目录和有效参数。');
} catch (error) {
  process.stderr.write(`${messageOf(error)}\n用法：node project-publish-preview.mjs 项目目录 [--entry index.html] [--flows 流程.json] [--report [报告.json]] [--json]\n`);
  process.exit(2);
}
const { entry: entryPath, json } = options.values;
const root = path.resolve(options.positionals[0]);
if (!(await stat(root).catch(() => null))?.isDirectory()) {
  process.stderr.write(`项目目录不存在：${root}\n`);
  process.exit(2);
}
const assets = [];
await collect(root, root, assets);
assets.sort((a, b) => comparePaths(a.path, b.path));
const report = await inspectProjectForPublishing(assets, entryPath);
const errors = report.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
const warnings = report.diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message);
const expectedPaths = [report.entryPath, ...report.secondaryHtmlPaths].filter(isHtmlFile).sort(comparePaths);
const pages = [];
let configuredFlows = [];
let flowSource = null;
try {
  const filename = options.values.flows ? path.resolve(options.values.flows) : path.join(root, 'polymas-publish-flows.json');
  const relativePath = path.relative(root, filename).split(path.sep).join('/');
  const asset = assets.find((item) => item.path === relativePath);
  let content;
  try { content = asset ? await asset.file.text() : await readFile(filename, 'utf8'); }
  catch (error) { if (options.values.flows || error.code !== 'ENOENT') throw error; }
  if (content !== undefined) {
    flowSource = relativePath;
    if (!asset) errors.push('流程文件未纳入项目指纹，请移入项目根目录 polymas-publish-flows.json 后重跑。');
    const config = JSON.parse(content);
    if (!Array.isArray(config?.flows)) throw new Error('流程 JSON 必须包含 flows 数组。');
    for (const flow of config.flows) {
      if (!flow || typeof flow.name !== 'string' || !flow.name.trim() || !Array.isArray(flow.steps) || !flow.steps.length) {
        throw new Error('每个流程必须包含非空 name 和非空 steps 数组。');
      }
      if (flow.start !== undefined && (typeof flow.start !== 'string' || !flow.start)) throw new Error(`流程 ${flow.name} 的 start 必须是 HTML 逻辑路径。`);
    }
    if (new Set(config.flows.map((flow) => flow.name)).size !== config.flows.length) throw new Error('流程 name 不能重复。');
    configuredFlows = config.flows;
  }
} catch (error) { errors.push(`流程配置错误：${messageOf(error)}`); }
if (!configuredFlows.length) warnings.push('未配置关键流程：本次仅逐页检查，不代表关键交互已验证。');
const flows = configuredFlows.map((flow) => ({
  name: flow.name, start: flow.start || report.entryPath, completed: false, errors: [], warnings: [],
  steps: flow.steps.map((step, index) => ({ index: index + 1, action: step, status: 'skipped', errors: [], warnings: [] })),
}));
const limitations = ['子页面在同一标签页先打开入口后检查；未验证独立子页面直达。', '本地模拟不保证线上网络、权限、响应头或未覆盖交互完全正常。'];
let preview;
let origin;
const server = createServer((request, response) => {
  const file = preview?.files.find((item) => item.pathname === new URL(request.url || '/', 'http://localhost').pathname);
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  response.writeHead(200, { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' });
  response.end(Buffer.from(file.bytes));
});
let browser;
const channel = process.env.PLAYWRIGHT_CHANNEL?.trim() || 'chrome';
const executablePath = process.env.CHROME_PATH?.trim();
function logicalUrl(logicalPath) {
  if (typeof logicalPath !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(logicalPath)) throw new Error('需要项目内 HTML 逻辑路径。');
  const input = logicalPath.replace(/\\/g, '/');
  const [pathname] = input.split(/[?#]/, 1);
  const normalized = path.posix.normalize(pathname.replace(/^\//, ''));
  const url = preview.logicalUrls[normalized];
  if (!isHtmlFile(normalized) || !url) throw new Error(`找不到 HTML 页面：${logicalPath}`);
  return new URL(`${url}${input.slice(pathname.length)}`);
}
async function withPage(record, work) {
  const label = record.logicalPath || record.name;
  let currentStep;
  let context;
  const pending = new Set();
  record.verifiedPages = [];
  const emit = (message, warning = false) => {
    const key = warning ? 'warnings' : 'errors';
    addUnique(record[key], message);
    if (currentStep) addUnique(currentStep[key], message);
    addUnique(warning ? warnings : errors, `${label}：${message}`);
  };
  const resourceIssue = (url, message) => {
      const external = /^https?:/i.test(url) && new URL(url).origin !== origin;
      emit(`${external ? '外部资源：' : ''}${message}：${url}`, external);
  };
  const routeRequest = async (route) => {
      const rawUrl = route.request().url();
      let requested;
      try { requested = new URL(rawUrl); } catch { return route.abort('blockedbyclient'); }
      const host = requested.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const privateAddress = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
        || host === '::1' || host === '::' || host === '0.0.0.0'
        || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
        || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
      if (requested.origin === origin) return route.continue();
      if (privateAddress || process.env.PUBLISH_AUDIT_BLOCK_EXTERNAL === '1') {
        resourceIssue(rawUrl, '隔离巡检已拦截站外或内网请求');
        return route.abort('blockedbyclient');
      }
      return route.continue();
  };
  const routeWebSocket = (socket) => {
        resourceIssue(socket.url(), '隔离巡检已拦截 WebSocket 请求');
        void socket.close({ code: 1008, reason: 'blocked by isolated preflight' });
  };
  const ready = async (page) => {
    const initialUrl = page.url();
    const errorsBefore = record.errors.length;
    try { await page.waitForLoadState('load', { timeout: 15000 }); }
    catch (error) { emit(`页面加载未完成：${messageOf(error)}`); }
    try { await page.waitForLoadState('networkidle', { timeout: 30000 }); }
    catch (error) { emit(`请求未在等待期限内稳定，检查不完整：${messageOf(error)}`); }
    try {
      await page.waitForFunction(() => !document.querySelector('[data-load-state="loading"], [aria-busy="true"]'), null, { timeout: 30000 });
      const failedAssets = await page.locator('[data-load-state="error"]').count();
      if (failedAssets) emit(`页面有 ${failedAssets} 个运行资源载入失败。`);
    } catch (error) { emit(`页面运行资源未完成载入：${messageOf(error)}`); }
    try {
      const state = await deadline(page.evaluate(() => document.readyState), 5000, '读取页面加载状态超时');
      if (state !== 'complete') emit(`页面尚未完成加载：${state}`);
      const broken = await deadline(page.locator('img').evaluateAll(async (images) => Promise.all(images.map(async (image) => {
        if (!image.hasAttribute('src') && !image.hasAttribute('srcset')) return null;
        const source = image.currentSrc || image.src || image.getAttribute('srcset') || '(空图片地址)';
        let timer;
        try {
          await Promise.race([image.decode(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('图片解码等待超时')), 5000);
          })]);
          if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error('图片未完成加载或尺寸为零');
          return null;
        } catch (error) { return { source, reason: error.message }; }
        finally { clearTimeout(timer); }
      }))), 7000, '图片检查超时');
      for (const image of broken.filter(Boolean)) resourceIssue(image.source, `图片加载/解码失败（${image.reason}）`);
    } catch (error) { emit(`页面/图片检查失败：${messageOf(error)}`); }
    const current = page.url();
    if (record.errors.length === errorsBefore && current === initialUrl) {
      const logicalPath = expectedPaths.find((item) => new URL(preview.logicalUrls[item]).pathname === new URL(current).pathname
        && new URL(current).origin === origin);
      if (logicalPath) addUnique(record.verifiedPages, logicalPath);
    }
  };
  record.startedAt = new Date().toISOString();
  try {
    context = await browser.newContext();
    await context.route('**/*', routeRequest);
    if (process.env.PUBLISH_AUDIT_BLOCK_EXTERNAL === '1' && typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', routeWebSocket);
    }
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(15000);
    context.on('page', (page) => page.on('pageerror', (error) => emit(`脚本异常：${error.message}`)));
    context.on('request', (request) => pending.add(request));
    context.on('requestfinished', (request) => pending.delete(request));
    context.on('requestfailed', (request) => {
      pending.delete(request);
      const failure = request.failure()?.errorText || '未知原因';
      // Chromium reports cancelled superseded requests during normal page transitions.
      // A genuine load failure is still caught by HTTP errors or the page's error state.
      if (failure === 'net::ERR_ABORTED') return;
      resourceIssue(request.url(), `请求失败（${failure}）`);
    });
    context.on('response', (response) => {
      if (response.status() >= 400) resourceIssue(response.url(), `HTTP ${response.status()}`);
    });
    const page = await context.newPage();
    const target = logicalUrl(record.logicalPath || record.start);
    record.primedFromEntry = target.pathname !== new URL(preview.entryUrl).pathname;
    if (record.primedFromEntry) {
      await page.goto(preview.entryUrl, { waitUntil: 'domcontentloaded' });
      await ready(page);
    }
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await work(page, ready, emit, (step) => { currentStep = step; }, context);
    record.openedUrl = page.url();
    record.completed = !record.logicalPath || record.verifiedPages.includes(record.logicalPath);
    if (record.logicalPath && !record.completed) {
      record.redirectedTo = record.openedUrl;
      emit('页面检查期间发生跳转，目标页面尚未覆盖；需由关键流程实际到达并完成检查。', true);
    }
  } catch (error) { emit(`检查失败：${messageOf(error)}`); }
  finally {
    for (const request of pending) resourceIssue(request.url(), '检查结束时请求仍未完成');
    try { await context?.close(); } catch (error) { emit(`关闭检查上下文失败：${messageOf(error)}`); }
    record.finishedAt = new Date().toISOString();
  }
}
try {
  if (!errors.length) {
    let playwright;
    try { playwright = await import('playwright'); }
    catch (error) { throw new Error(`无法加载项目 Playwright 依赖，请在 frontend 执行 npm ci（包含 devDependencies）。${messageOf(error)}`); }
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 30000,
        ...(executablePath ? { executablePath } : channel === 'chromium' ? {} : { channel }),
      });
    } catch (error) {
      throw new Error(`无法启动浏览器（${executablePath ? 'CHROME_PATH' : channel}）。默认需要本机 Google Chrome；可设置 CHROME_PATH，或先在 frontend 执行 npx playwright install chromium 再设置 PLAYWRIGHT_CHANNEL=chromium；也支持其他已安装的 PLAYWRIGHT_CHANNEL。${messageOf(error)}`);
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    preview = await buildFlatProjectPreview(assets, report, origin);
    for (const logicalPath of expectedPaths) {
      const result = { logicalPath, completed: false, errors: [], warnings: [] };
      pages.push(result);
      await withPage(result, async () => {});
    }
    for (const flow of flows) {
      await withPage(flow, async (page, ready, emit, setStep, context) => {
        if (flow.errors.length) throw new Error('流程起始页面未通过检查，后续步骤已跳过。');
        for (const detail of flow.steps) {
          setStep(detail);
          detail.status = 'running';
          detail.startedAt = new Date().toISOString();
          try {
            const step = detail.action;
            const selectors = ['click', 'select', 'fill', 'waitFor', 'expectPage', 'expectUrl', 'expectImage'];
            if (!step || typeof step !== 'object' || Array.isArray(step)
              || !selectors.some((key) => Object.hasOwn(step, key))
              || Object.keys(step).some((key) => ![...selectors, 'value'].includes(key))) throw new Error('流程步骤为空或包含不支持的字段。');
            for (const key of selectors) if (Object.hasOwn(step, key) && (typeof step[key] !== 'string' || !step[key])) throw new Error(`${key} 必须是非空字符串。`);
            if (step.fill && typeof step.value !== 'string') throw new Error('fill 需要字符串 value。');
            if (step.select && typeof step.value !== 'string' && !(Array.isArray(step.value) && step.value.every((item) => typeof item === 'string'))) throw new Error('select 需要字符串或字符串数组 value。');
            if (Object.hasOwn(step, 'value') && !step.fill && !step.select) throw new Error('value 只能用于 fill 或 select。');
            if (step.click) await page.locator(step.click).click();
            if (step.select) await page.locator(step.select).selectOption(step.value);
            if (step.fill) await page.locator(step.fill).fill(step.value);
            if (step.waitFor) await page.locator(step.waitFor).waitFor();
            if (step.expectPage) {
              const expected = logicalUrl(step.expectPage);
              await page.waitForURL((url) => url.origin === expected.origin && url.pathname === expected.pathname
                && (!step.expectPage.includes('?') || url.search === expected.search)
                && (!step.expectPage.includes('#') || url.hash === expected.hash), { waitUntil: 'domcontentloaded' });
            }
            if (step.expectUrl) await page.waitForURL((url) => url.href.includes(step.expectUrl), { waitUntil: 'domcontentloaded' });
            for (const activePage of context.pages()) await ready(activePage);
            if (step.expectImage) {
              const image = page.locator(step.expectImage).first();
              await image.waitFor({ state: 'attached' });
              const loaded = await deadline(image.evaluate(async (element) => {
                if (!(element instanceof HTMLImageElement)) return false;
                await element.decode();
                return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
              }), 7000, `指定图片解码等待超时：${step.expectImage}`);
              if (!loaded) throw new Error(`指定图片未加载：${step.expectImage}`);
            }
          } catch (error) { emit(`步骤 ${detail.index} 失败：${messageOf(error)}`); }
          detail.openedUrl = page.url();
          detail.finishedAt = new Date().toISOString();
          detail.status = detail.errors.length ? 'failed' : 'passed';
          setStep(undefined);
          if (detail.errors.length) break;
        }
      });
    }
  }
} catch (error) { errors.push(`浏览器巡检失败：${messageOf(error)}`); }
finally {
  try { await browser?.close(); } catch (error) { errors.push(`关闭浏览器失败：${messageOf(error)}`); }
  if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
try {
  const currentAssets = [];
  await collect(root, root, currentAssets);
  currentAssets.sort((a, b) => comparePaths(a.path, b.path));
  const current = await inspectProjectForPublishing(currentAssets, report.entryPath);
  if (current.fingerprint !== report.fingerprint) errors.push('巡检期间项目文件发生变化，报告已失效，请重跑。');
} catch (error) { errors.push(`无法复核巡检后指纹：${messageOf(error)}`); }

for (const page of pages.filter((item) => !item.completed && !item.errors.length)) {
  const flow = flows.find((item) => item.completed && !item.errors.length && item.steps.every((step) => step.status === 'passed')
    && item.verifiedPages?.includes(page.logicalPath));
  if (flow) {
    page.completed = true;
    page.inspectedViaFlow = flow.name;
  } else {
    const message = `未实际完成目标页面检查：${page.logicalPath}；请补充到达该页面的关键流程。`;
    page.errors.push(message);
    addUnique(errors, message);
  }
}
const steps = flows.flatMap((flow) => flow.steps);
const coverage = {
  mode: flows.length ? 'pages-and-flows' : 'pages-only',
  expectedPages: expectedPaths.length, checkedPages: pages.filter((page) => page.completed).length,
  passedPages: pages.filter((page) => page.completed && !page.errors.length).length,
  expectedFlows: flows.length, executedFlows: flows.filter((flow) => flow.startedAt).length,
  passedFlows: flows.filter((flow) => flow.completed && !flow.errors.length && flow.steps.every((step) => step.status === 'passed')).length,
  expectedSteps: steps.length, executedSteps: steps.filter((step) => step.status !== 'skipped').length,
  passedSteps: steps.filter((step) => step.status === 'passed').length,
  independentSecondaryPages: false,
  complete: !errors.length && pages.length === expectedPaths.length && pages.every((page) => page.completed)
    && flows.every((flow) => flow.completed && flow.steps.every((step) => step.status === 'passed')),
};
if (!coverage.complete && !errors.length) errors.push('巡检覆盖不完整，不能作为通过报告。');
const audit = {
  kind: 'polymas-project-browser-audit', ruleVersion: PROJECT_PUBLISH_RULE_VERSION,
  entryPath: report.entryPath, fingerprint: report.fingerprint, expectedPages: expectedPaths.length,
  pages, flows, flowSource, coverage, limitations, errors, warnings: [...new Set(warnings)],
  browser: { channel: executablePath ? 'custom' : channel }, createdAt: new Date().toISOString(),
};
if (options.values.report !== undefined) {
  const destination = options.values.report ? path.resolve(options.values.report) : path.join(root, 'polymas-publish-audit.json');
  try {
    const relative = path.relative(root, destination).split(path.sep).join('/');
    if (!relative.startsWith('../') && !path.isAbsolute(relative)
      && !['polymas-publish-audit.json', '.polymas-publish-audit.json'].includes(relative)) throw new Error('项目内报告必须位于根目录，使用 polymas-publish-audit.json 或 .polymas-publish-audit.json，避免覆盖源文件或改变指纹。');
    await writeFile(destination, `${JSON.stringify(audit, null, 2)}\n`);
    if (!json) process.stdout.write(`巡检报告：${destination}\n`);
  } catch (error) {
    errors.push(`报告写入失败：${messageOf(error)}`);
    coverage.complete = false;
  }
}
if (json) process.stdout.write(`${JSON.stringify({ root, ...audit }, null, 2)}\n`);
else {
  process.stdout.write(`本地平铺发布巡检：${coverage.checkedPages}/${coverage.expectedPages} 个页面，${coverage.executedFlows}/${coverage.expectedFlows} 个流程，${errors.length} 个阻断问题。\n`);
  for (const limitation of limitations) process.stdout.write(`[scope] ${limitation}\n`);
  for (const error of errors) process.stdout.write(`[error] ${error}\n`);
  for (const warning of audit.warnings) process.stdout.write(`[warning] ${warning}\n`);
}
process.exitCode = errors.length ? 1 : 0;
