import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { collectProjectAssets, findJavaScriptReferences, rewriteJavaScriptReferences, injectRuntimeAssetResolver, isIgnoredProjectPath } from './html-project-publisher.ts';
import { inspectProjectForPublishing, executeProjectPublish, buildFlatProjectPreview, browserAuditMatches, isBrowserAuditReport, PROJECT_PUBLISH_RULE_VERSION, sha256File } from './project-publish-preflight.ts';
import { reuseOrUploadProjectFile, projectUploadKey } from './project-upload-cache.ts';
import { collectZipProjectAssets } from './project-publish-input.ts';
import { zipSync } from 'fflate';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const asset = (name, text, type = '') => ({ path: name, file: new File([text], name.split('/').pop(), { type }) });
const errors = (report) => report.diagnostics.filter((item) => item.severity === 'error');
const inspect = (assets) => inspectProjectForPublishing(assets, 'index.html');
function selected(assets) {
  return assets.map((item) => {
    const file = new File([item.file], item.file.name, { type: item.file.type });
    Object.defineProperty(file, 'webkitRelativePath', { value: `项目/${item.path}` });
    return file;
  });
}
function auditFor(report) {
  return {
    kind: 'polymas-project-browser-audit', ruleVersion: PROJECT_PUBLISH_RULE_VERSION,
    entryPath: report.entryPath, fingerprint: report.fingerprint, expectedPages: report.secondaryHtmlPaths.length + 1,
    pages: [report.entryPath, ...report.secondaryHtmlPaths].map((logicalPath) => ({ logicalPath, completed: true, errors: [] })),
    flows: report.requiredFlows.map((flow) => ({ ...flow, completed: true, errors: [], steps: Array.from({ length: flow.steps }, () => ({ status: 'passed', errors: [] })) })),
    coverage: { complete: true, mode: report.requiredFlows.length ? 'pages-and-flows' : 'pages-only' },
    errors: [], warnings: [], createdAt: new Date().toISOString(),
  };
}
function memoryCache() {
  const records = new Map();
  return { records, find: async (key) => records.get(key) || null,
    remember: async (key, name, ossUrl, fileId = '') => { records.set(key, { key, path: name, ossUrl, fileId, uploadedAt: Date.now() }); return true; },
    forget: async (key) => { records.delete(key); },
  };
}

test('单 HTML 文件及忽略文件：网页与 CLI 指纹一致', async () => {
  const source = [asset('index.html', '<h1>项目</h1>')];
  const all = [...source, asset('Thumbs.db', 'cache'), asset('.env.local', 'placeholder'), asset('polymas-publish-audit.json', '{}')];
  const collected = collectProjectAssets(selected(all));
  assert.deepEqual(collected.assets.map((item) => item.path), ['index.html']);
  assert.equal((await inspect(collected.assets)).fingerprint, (await inspect(all)).fingerprint);
  for (const name of ['.env', 'cert.pem', 'node_modules/lib/x.js', '.git/config', 'Thumbs.db']) assert.equal(isIgnoredProjectPath(name), true);
});

test('ZIP 项目包可直接读取，剔除顶层目录和 macOS 附带文件', async () => {
  const bytes = zipSync({
    '项目/index.html': new TextEncoder().encode('<img src="assets/a.png">'),
    '项目/assets/a.png': new Uint8Array([1, 2, 3]),
    '__MACOSX/项目/._index.html': new Uint8Array([4]),
  });
  const collected = await collectZipProjectAssets(new File([bytes], '项目.zip'));
  assert.deepEqual(collected.assets.map((item) => item.path), ['assets/a.png', 'index.html']);
  assert.deepEqual(errors(await inspect(collected.assets)), []);
  const unsafe = zipSync({ '../outside.html': new TextEncoder().encode('bad') });
  await assert.rejects(() => collectZipProjectAssets(new File([unsafe], 'bad.zip')), /不安全的文件路径/);
});

test('文件顺序不影响指纹或发布内容，文件变更会失效', async () => {
  const source = [asset('index.html', '<img src="a.png">'), asset('a.png', 'image'), asset('README.md', '说明')];
  assert.equal((await inspect(source)).fingerprint, (await inspect([...source].reverse())).fingerprint);
  assert.notEqual((await inspect(source)).fingerprint, (await inspect([source[0], asset('a.png', 'new'), source[2]])).fingerprint);
});

test('缺文件、大小写冲突和模糊匹配阻断，不忽略真实冲突', async () => {
  const cases = [
    [[asset('index.html', '<img src="missing.png">')], 'MISSING_RESOURCE'],
    [[asset('index.html', '<img src="A.png">'), asset('a.png', 'x')], 'PATH_CASE_MISMATCH'],
    [[asset('index.html', '<h1>标题</h1>'), asset('A.png', 'x'), asset('a.png', 'y')], 'DUPLICATE_PATH'],
    [[asset('index.html', '<img src="icon.png">'), asset('a/icon.png', 'x'), asset('b/icon.png', 'y')], 'MISSING_RESOURCE'],
    [[asset('index.html', '<script>fetch("data.json")</script>'), asset('data.json', '{}')], 'UNSUPPORTED_RUNTIME_FILE'],
  ];
  for (const [assets, code] of cases) assert.ok(errors(await inspect(collectProjectAssets(selected(assets)).assets)).some((item) => item.code === code), code);
});

test('注释和未引用的开发脚本不误报，运行 SVG 内的缺失资源阻断', async () => {
  const source = [asset('index.html', '<!-- <img src="missing.png"> --><script>// "missing.mp4"\nconst ok = true;</script>'), asset('dev.js', 'fetch("missing.json")')];
  const report = await inspect(source);
  assert.equal(errors(report).length, 0);
  assert.deepEqual(report.skippedPaths, ['dev.js']);
  assert.ok(errors(await inspect([...source, asset('dynamic.svg', '<svg><image href="missing.png"/></svg>')])).some((item) => item.code === 'MISSING_RESOURCE'));
});

test('3D 模型进入发布清单，动态拼接的模型路径在上传前报错', async () => {
  const model = asset('assets/models/packaging.glb', 'model-bytes', 'model/gltf-binary');
  const source = [
    asset('index.html', '<script type="module" src="packaging-model.js"></script>'),
    asset('packaging-model.js', "const model = new URL('assets/models/packaging.glb', import.meta.url);"),
    model,
  ];
  const report = await inspect(source);
  assert.deepEqual(errors(report), []);
  assert.ok(!report.diagnostics.some((item) => item.code === 'UNVERIFIED_UPLOAD_TYPE'));
  assert.ok(report.rawAssetPaths.includes(model.path));
  assert.ok(!report.skippedPaths.includes(model.path));
  const preview = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  const scriptUrl = preview.logicalUrls['packaging-model.js'];
  const emitted = new TextDecoder().decode(preview.files.find((file) => file.pathname === new URL(scriptUrl).pathname).bytes);
  assert.ok(emitted.includes(preview.logicalUrls[model.path]));

  const dynamic = await inspect([
    source[0],
    asset('packaging-model.js', 'const name = "packaging.glb"; new URL(`./assets/models/${name}`, import.meta.url);'),
    model,
  ]);
  assert.ok(errors(dynamic).some((item) => item.code === 'DYNAMIC_IMPORT_META_URL'));
  const computed = await inspect([
    source[0],
    asset('packaging-model.js', 'const key = "packaging"; loader.loadAsync(`./assets/models/${key}.glb`);'),
    model,
  ]);
  assert.ok(errors(computed).some((item) => item.code === 'DYNAMIC_MODEL_PATH'));
  const sourceLabel = await inspect([
    source[0],
    asset('packaging-model.js', "const name = '原始模型'; host.dataset.modelSource = `${name}.glb`; loader.loadAsync('assets/models/packaging.glb');"),
    model,
  ]);
  assert.deepEqual(errors(sourceLabel), []);
});

test('动态模板页面跳转通过运行时资源映射', async () => {
  const source = [
    asset('index.html', '<button id="go">进入模块</button><script>const module=1;document.querySelector("#go").onclick=()=>{window.location.href=`./modules/module-${module}.html`;};</script>'),
    asset('modules/module-1.html', '<h1>模块一</h1>'),
  ];
  const report = await inspect(source);
  assert.deepEqual(errors(report), []);
  const preview = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  const emitted = new TextDecoder().decode(preview.files.find((file) => file.pathname === new URL(preview.entryUrl).pathname).bytes);
  assert.match(emitted, /window\.location\.href=window\.__polymasAssetUrl\(`\.\/modules\/module-\$\{module\}\.html`\)/);
  assert.ok(emitted.includes(preview.logicalUrls['modules/module-1.html']));
});

test('CSS、SVG 和脚本循环引用均在上传前阻断', async () => {
  for (const [extension, first, second, entry] of [
    ['css', '@import "b.css";', '@import "a.css";', '<link href="a.css" rel="stylesheet">'],
    ['svg', '<svg><use href="b.svg#x"/></svg>', '<svg><use href="a.svg#x"/></svg>', '<img src="a.svg">'],
    ['js', 'import "./b.js";', 'import "./a.js";', '<script type="module" src="a.js"></script>'],
  ]) {
    const report = await inspect([asset('index.html', entry), asset(`a.${extension}`, first), asset(`b.${extension}`, second)]);
    assert.ok(errors(report).some((item) => item.code === 'CYCLIC_REFERENCE'), extension);
    await assert.rejects(executeProjectPublish([], report, async () => { throw new Error('不得上传'); }), /预检未通过/);
  }
});

test('映射键及来源自引用不构成依赖，预览保留其原文', async () => {
  const js = `const manifest = window.__POLYMAS_ASSET_MANIFEST__;
    const own = manifest['assets/core.js'];
    const registry = { 'assets/core.js': 'registry-key' };
    const info = { sourceRecovery: { sourcePath: 'assets/core.js', sourceBanner: 'example/missing.js', sourceSha256: 'hash' } };
    if (window.__POLYMAS_PROJECT_PATH__ === 'index.html') window.home = true;
    window.photo = 'assets/p.svg';`;
  const references = findJavaScriptReferences(js);
  assert.ok(!references.includes('assets/core.js'));
  assert.ok(!references.includes('example/missing.js'));
  assert.ok(!references.includes('index.html'));
  assert.ok(references.includes('assets/p.svg'));
  const source = [asset('index.html', '<script src="assets/core.js"></script>'), asset('assets/core.js', js), asset('assets/p.svg', '<svg/>')];
  const report = await inspect(source);
  assert.equal(errors(report).length, 0, JSON.stringify(report.diagnostics));
  const preview = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  const emitted = new TextDecoder().decode(preview.files.find((file) => file.pathname === new URL(preview.logicalUrls['assets/core.js']).pathname).bytes);
  assert.match(emitted, /manifest\['assets\/core\.js'\]/);
  assert.match(emitted, /sourcePath: 'assets\/core\.js'/);
  assert.match(emitted, /=== 'index\.html'/);
  assert.ok(emitted.includes(preview.logicalUrls['assets/p.svg']));
});

test('真实自导入及互相加载仍阻断，普通资源列表不是映射查询', async () => {
  for (const js of ['import "./self.js";', 'import("./self.js");', 'const s = document.createElement("script"); s.src = "./self.js";']) {
    const report = await inspect([asset('index.html', '<script src="self.js"></script>'), asset('self.js', js)]);
    assert.ok(errors(report).some((item) => item.code === 'CYCLIC_REFERENCE'), js);
  }
  assert.ok(findJavaScriptReferences('const list = ["assets/a.js", "assets/b.js"];').includes('assets/a.js'));
  assert.ok(findJavaScriptReferences('const settings = {sourcePath: "assets/a.js"};').includes('assets/a.js'));
  assert.ok(findJavaScriptReferences('const settings = {sourceRecovery: {src: "assets/a.js"}};').includes('assets/a.js'));
});

test('注释和正则不参与改写，转义字面量保留有效语法', () => {
  const js = String.raw`// "missing/a.js"
const matcher = /https?:\/\/example\.com\/"x.js"/;
const escaped = "assets\/p.svg";
const list = [\`assets/q.svg\`];`.replace(/\\`/g, '`');
  const found = findJavaScriptReferences(js);
  assert.deepEqual(found, ['assets/p.svg', 'assets/q.svg']);
  const replaced = rewriteJavaScriptReferences(js, (ref) => ref.startsWith('assets/') ? 'https://example.test/a.svg' : ref);
  assert.ok(replaced.includes('// "missing/a.js"'));
  assert.ok(replaced.includes('const matcher = /https?'));
  assert.doesNotThrow(() => findJavaScriptReferences(replaced));
  assert.throws(() => findJavaScriptReferences('const = "a.js"'), /语法无法解析/);
});

test('JSON 数据块保留对象键与来源元数据，仅替换运行资源值', () => {
  const data = JSON.stringify({ 'assets/key.js': { src: 'assets/p.svg' }, sourceRecovery: { sourcePath: 'assets/self.js' } });
  const rewritten = JSON.parse(rewriteJavaScriptReferences(data, (ref) => ref.startsWith('assets/') ? `https://example.test/${ref}` : ref));
  assert.equal(rewritten['assets/key.js'].src, 'https://example.test/assets/p.svg');
  assert.equal(rewritten.sourceRecovery.sourcePath, 'assets/self.js');
});

test('预览与上传逐字节共用改写，SVG 跨类型依赖先于自身发布', async () => {
  const source = [asset('index.html', '<img src="a.svg"><link href="a.css"><script src="app.js"></script>'),
    asset('a.svg', '<svg><style>@import "z.css";</style><image href="z.svg"/></svg>'),
    asset('z.svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="p.png"/></svg>'),
    asset('a.css', '@import "z.css";'), asset('z.css', 'body { background:url(p.png) }'), asset('p.png', 'bytes'),
    asset('app.js', 'import "./z.js";'), asset('z.js', 'window.loaded=true;')];
  const report = await inspect(source);
  assert.equal(errors(report).length, 0, JSON.stringify(report.diagnostics));
  const preview = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  const second = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  assert.notEqual(preview.entryUrl, second.entryUrl);
  const emitted = [];
  await executeProjectPublish(source, report, async (item, file) => {
    emitted.push(item.path);
    const url = preview.logicalUrls[item.path];
    const original = preview.files.find((part) => part.pathname === new URL(url).pathname);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original.bytes, item.path);
    return url;
  });
  assert.ok(emitted.indexOf('z.css') < emitted.indexOf('a.svg'));
  assert.ok(emitted.indexOf('z.svg') < emitted.indexOf('a.svg'));
  assert.ok(emitted.indexOf('z.js') < emitted.indexOf('app.js'));
  assert.equal(emitted.at(-1), 'index.html');
});

test('纯 HTML 项目仍注入导航解析器且多页面使用相同会话键', async () => {
  const source = [asset('index.html', '<a href="detail.html">详情</a>'), asset('detail.html', '<script>location.href="index.html";</script>')];
  const report = await inspect(source);
  const preview = await buildFlatProjectPreview(source, report, 'http://127.0.0.1:1234');
  for (const file of preview.files) assert.ok(new TextDecoder().decode(file.bytes).includes(report.fingerprint));
  assert.match(injectRuntimeAssetResolver('<h1>单页面</h1>', new Map(), 'index.html'), /__polymasAssetUrl/);
});

test('报告门禁：过期、未来、规则变更、缺页、重复页及任意错误均拒绝', async () => {
  const report = await inspect([asset('index.html', '首页'), asset('detail.html', '详情')]);
  const paths = ['index.html', 'detail.html'];
  const valid = auditFor(report);
  assert.equal(browserAuditMatches(valid, report, paths), true);
  const changes = [
    { createdAt: new Date(Date.now() - 86400000).toISOString() }, { createdAt: new Date(Date.now() + 600000).toISOString() },
    { ruleVersion: 'old' }, { fingerprint: 'changed' }, { entryPath: 'detail.html' }, { errors: ['failed'] },
    { pages: [valid.pages[0]] }, { pages: [valid.pages[0], valid.pages[0]] },
    { pages: [valid.pages[0], { ...valid.pages[1], completed: false }] }, { coverage: { complete: false, mode: 'pages-only' } },
  ];
  for (const change of changes) assert.equal(browserAuditMatches({ ...valid, ...change }, report, paths), false, JSON.stringify(change));
  assert.equal(isBrowserAuditReport({ ...valid, warnings: [{}] }), false);
});

test('关键流程进入指纹，配置流程不能被遗漏或跳过', async () => {
  const source = [asset('index.html', '首页'), asset('polymas-publish-flows.json', JSON.stringify({ flows: [{ name: '启动', steps: [{ click: '#start' }] }] }))];
  const report = await inspect(source);
  const valid = auditFor(report);
  assert.equal(browserAuditMatches(valid, report, ['index.html']), true);
  assert.equal(browserAuditMatches({ ...valid, flows: [] }, report, ['index.html']), false);
  valid.flows[0].steps[0].status = 'skipped';
  assert.equal(browserAuditMatches(valid, report, ['index.html']), false);
  assert.notEqual(report.fingerprint, (await inspect([source[0]])).fingerprint);
});

test('原文件哈希可复用，大文件分块摘要稳定且能发现末尾变化', async () => {
  const data = new Uint8Array(4 * 1024 * 1024 + 1);
  const file = new File([data], 'video.mp4');
  const hash = await sha256File(file);
  assert.equal(await projectUploadKey(file, hash), await projectUploadKey(file));
  data[data.length - 1] = 1;
  assert.notEqual(hash, await sha256File(new File([data], 'video.mp4')));
});

test('首次上传、重复复用、失效重传与网络暂不可用不重传', async () => {
  const cache = memoryCache();
  let uploads = 0;
  let state = 'valid';
  const options = { file: asset('a.png', 'image').file, path: 'a.png', cache,
    verify: async () => state, upload: async () => ({ ossUrl: `https://example.test/${++uploads}`, fileId: `${uploads}` }) };
  assert.equal((await reuseOrUploadProjectFile(options)).reused, false);
  assert.equal((await reuseOrUploadProjectFile(options)).reused, true);
  state = 'unavailable';
  await assert.rejects(reuseOrUploadProjectFile(options), /记录已保留/);
  assert.equal(uploads, 1);
  state = 'invalid';
  await assert.rejects(reuseOrUploadProjectFile(options), /记录已保存/);
  assert.equal(uploads, 2);
  state = 'valid';
  assert.equal((await reuseOrUploadProjectFile(options)).reused, true);
  assert.equal(uploads, 2);
});

test('上传成功后验证超时仍保存记录，存储不可用明确提示', async () => {
  const cache = memoryCache();
  let uploads = 0;
  const options = { file: asset('a.png', 'image').file, path: 'a.png', cache,
    verify: async () => 'unavailable', upload: async () => ({ ossUrl: `https://example.test/${++uploads}` }) };
  await assert.rejects(reuseOrUploadProjectFile(options), /记录已保存/);
  assert.equal(cache.records.size, 1);
  assert.equal((await reuseOrUploadProjectFile({ ...options, verify: async () => 'valid' })).reused, true);
  assert.equal(uploads, 1);
  const result = await reuseOrUploadProjectFile({ ...options, cache: { ...memoryCache(), remember: async () => false }, verify: async () => 'valid' });
  assert.equal(result.persisted, false);
});

test('修改一张图片：其他原图复用，引用文件重新上传；中断后继续', async () => {
  const source = [asset('index.html', '<img src="a.png"><img src="b.png"><link href="style.css">'),
    asset('a.png', 'a'), asset('b.png', 'b'), asset('style.css', 'body{background:url(a.png)}')];
  const cache = memoryCache();
  let count = 0;
  let uploaded = [];
  const run = async (assets, failAt) => {
    const report = await inspect(assets);
    return executeProjectPublish(assets, report, async (item, file) => (await reuseOrUploadProjectFile({ file, path: item.path, cache,
      sourceHash: file === item.file ? report.fileHashes[item.path] : undefined, verify: async () => 'valid',
      upload: async () => { if (item.path === failAt) throw new Error('模拟中断'); uploaded.push(item.path); return { ossUrl: `https://example.test/${++count}` }; },
    })).ossUrl);
  };
  await assert.rejects(run(source, 'style.css'), /模拟中断/);
  assert.deepEqual(uploaded, ['a.png', 'b.png']);
  uploaded = [];
  await run(source);
  assert.deepEqual(uploaded, ['style.css', 'index.html']);
  uploaded = [];
  await run([...source].reverse());
  assert.deepEqual(uploaded, []);
  await run([source[0], asset('a.png', 'changed'), source[2], source[3]]);
  assert.deepEqual(uploaded, ['a.png', 'style.css', 'index.html']);
});

test('OSS 验证路由：域名边界、超时、缺文件、大小错误、下载型 HTML', async (t) => {
  // 在内存中转换路由，所有 fetch 均被 mock，不访问真实 OSS。
  const ts = await import('typescript');
  const route = await readFile(path.join(frontend, 'app/api/resource-upload/verify/route.ts'), 'utf8');
  const js = ts.transpileModule(route, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace('"next/server"', JSON.stringify(pathToFileURL(path.join(frontend, 'node_modules/next/server.js')).href));
  const { GET } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  let responseFactory = () => new Response('data', { status: 206, headers: { 'content-range': 'bytes 0-3/4', 'content-type': 'text/html' } });
  let called = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { called++; assert.equal(options.redirect, 'manual'); return responseFactory(); });
  const verify = async (url = 'https://prod-polymas-oss.polymas.com/test.html', extra = '') => (await GET({ nextUrl: new URL(`http://localhost/verify?url=${encodeURIComponent(url)}${extra}`) })).json();
  for (const url of ['http://prod-polymas-oss.polymas.com/x', 'https://prod-polymas-oss.polymas.com.evil.test/x', 'https://localhost/x', 'https://user@prod-polymas-oss.polymas.com/x']) assert.equal((await verify(url)).ok, false);
  assert.equal(called, 0);
  assert.equal((await verify(undefined, '&size=4&html=1')).ok, true);
  assert.equal((await verify(undefined, '&size=5')).invalid, true);
  responseFactory = () => new Response('data', { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment' } });
  assert.equal((await verify(undefined, '&html=1')).invalid, true);
  responseFactory = () => new Response('<Error><Code>NoSuchKey</Code></Error>', { headers: { 'content-type': 'application/xml' } });
  assert.equal((await verify()).invalid, true);
  responseFactory = () => new Response('', { status: 404 });
  assert.equal((await verify()).invalid, true);
  responseFactory = () => { throw new Error('timeout'); };
  assert.equal((await verify()).ok, false);
});

test('重定向不算目标页通过，真实交互到达后才计入覆盖', { timeout: 120000 }, async () => {
  const root = path.join(frontend, '.next/publish-regression', `redirect-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<html><body><button id="go" onclick="sessionStorage.setItem(\'started\',\'yes\');location.href=\'locked.html\'">开始</button></body></html>');
  await writeFile(path.join(root, 'locked.html'), '<html><head><script>if (!sessionStorage.getItem("started")) location.replace("index.html");</script></head><body><h1>目标页</h1></body></html>');
  const cli = path.join(frontend, 'scripts/project-publish-preview.mjs');
  let failed;
  try { await exec(process.execPath, [cli, root, '--json'], { timeout: 45000 }); assert.fail('重定向后不应放行'); }
  catch (error) { assert.equal(error.code, 1); failed = JSON.parse(error.stdout); }
  assert.equal(failed.coverage.complete, false);
  assert.equal(failed.pages.find((item) => item.logicalPath === 'locked.html').completed, false);
  await writeFile(path.join(root, 'polymas-publish-flows.json'), JSON.stringify({ flows: [{ name: '正常进入', steps: [{ click: '#go', expectPage: 'locked.html', waitFor: 'h1' }] }] }));
  const { stdout } = await exec(process.execPath, [cli, root, '--json'], { timeout: 45000 });
  const passed = JSON.parse(stdout);
  assert.equal(passed.coverage.complete, true, stdout);
  assert.equal(passed.pages.find((item) => item.logicalPath === 'locked.html').inspectedViaFlow, '正常进入');
});

test('真实 Chrome 巡检：目录/报告指纹一致、多页面往返、动态图片及失败流程', { timeout: 120000 }, async () => {
  const root = path.join(frontend, '.next/publish-regression', `project-${Date.now()}`);
  await mkdir(path.join(root, 'pages'), { recursive: true });
  const source = [
    asset('index.html', '<!doctype html><html><head><title>发布回归首页</title><script src="core.js"></script></head><body><h1>HTML 发布回归项目</h1><button id="detail" onclick="location.href=\'pages/detail.html\'">打开详情</button><button id="show" onclick="document.querySelector(\'#photo\').src=\'p.svg\'">加载图片</button><img id="photo"></body></html>'),
    asset('pages/detail.html', '<!doctype html><html><head><title>详情</title></head><body><h1>详情</h1><button id="back" onclick="location.href=\'../index.html\'">返回首页</button></body></html>'),
    asset('core.js', `const key = window.__POLYMAS_ASSET_MANIFEST__['core.js']; if (!key) throw new Error('manifest key rewritten'); const meta = {sourceRecovery: {sourcePath: 'core.js'}}; if (meta.sourceRecovery.sourcePath !== 'core.js') throw new Error('metadata rewritten');`),
    asset('p.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="green"/></svg>'),
    asset('polymas-publish-flows.json', JSON.stringify({ flows: [{ name: '往返与图片', steps: [{ click: '#show', expectImage: '#photo' }, { click: '#detail', expectPage: 'pages/detail.html' }, { click: '#back', expectPage: 'index.html' }] }] })),
  ];
  for (const item of source) await writeFile(path.join(root, item.path), await item.file.text());
  await writeFile(path.join(root, 'Thumbs.db'), 'ignored');
  const cli = path.join(frontend, 'scripts/project-publish-preview.mjs');
  const result = await exec(process.execPath, [cli, root, '--report', '--json'], { timeout: 60000 });
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.coverage.complete, true, result.stdout);
  assert.equal(audit.coverage.passedFlows, 1);
  assert.equal(browserAuditMatches(audit, await inspect(collectProjectAssets(selected(source)).assets), ['index.html', 'pages/detail.html']), true);
  const disk = JSON.parse(await readFile(path.join(root, 'polymas-publish-audit.json'), 'utf8'));
  assert.equal(disk.fingerprint, audit.fingerprint);
  // 保留通过的原夹用于界面验收；失败项目单独生成，不污染有效报告。
  const failedRoot = `${root}-failed`;
  await mkdir(failedRoot);
  await writeFile(path.join(failedRoot, 'index.html'), '<html><body><button id="broken" onclick="throw new Error(\'flow failed\')">故障</button></body></html>');
  await writeFile(path.join(failedRoot, 'polymas-publish-flows.json'), JSON.stringify({ flows: [{ name: '失败流程', steps: [{ click: '#broken' }] }] }));
  let failed;
  try { await exec(process.execPath, [cli, failedRoot, '--report', '--json'], { timeout: 60000 }); assert.fail('失败流程必须非零退出'); }
  catch (error) { assert.equal(error.code, 1); failed = JSON.parse(error.stdout); }
  assert.equal(failed.coverage.complete, false);
  assert.ok(failed.errors.some((message) => message.includes('flow failed')));
  process.stdout.write(`浏览器测试通过项目：${root}\n`);
});
