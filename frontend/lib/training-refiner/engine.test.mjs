import { beforeEach, mock, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';

// 从仓库根目录运行：node --test frontend/lib/training-refiner/engine.test.mjs
// 只在内存中转译当前源码，不产出构建文件，不加载 Next 启动器或任何 .env。
const frontend = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const nativeRequire = createRequire(import.meta.url);
const enginePath = 'lib/training-refiner/engine.ts';
const utilsPath = 'lib/llm/utils.ts';
const errorsPath = 'lib/llm/error-utils.ts';
const componentPath = 'components/TrainingRefineInterface.tsx';
const routePath = 'app/api/training-refine/route.ts';
const imageProxyRoutePath = 'app/api/training-refine/image/route.ts';
const test = (name, fn) => nodeTest(name, { concurrency: false, timeout: 5000 }, fn);

function sourceText(relativePath) {
  const filename = resolve(frontend, relativePath);
  assert.ok(filename.startsWith(frontend + sep), '只允许读取 frontend 内的源码');
  assert.match(filename, /\.(?:ts|tsx)$/);
  return readFileSync(filename, 'utf8');
}

function compile(source, filename, require, globals = {}) {
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  // 共用当前 realm，确保源码抛出的 Error 与测试的 instanceof 检查一致。
  const names = ['require', 'module', 'exports', '__filename', '__dirname', ...Object.keys(globals)];
  const execute = new Script(`(function(${names.join(',')}) {\n${result.outputText}\n})`, { filename })
    .runInThisContext();
  return module => execute(require, module, module.exports, filename, dirname(filename), ...Object.values(globals));
}

function sourceLoader({ mocks = {}, globals = {} } = {}) {
  const cache = new Map();
  function load(relativePath) {
    const filename = resolve(frontend, relativePath);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const require = specifier => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (specifier === 'jsonrepair') return nativeRequire(specifier);
      assert.ok(specifier.startsWith('@/') || specifier.startsWith('.'), `未 mock 的依赖：${specifier}`);
      const base = specifier.startsWith('@/')
        ? resolve(frontend, specifier.slice(2)) : resolve(dirname(filename), specifier);
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]
        .find(candidate => /\.tsx?$/.test(candidate) && statSync(candidate, { throwIfNoEntry: false })?.isFile());
      assert.ok(found, `无法解析源码依赖：${specifier}`);
      return load(found);
    };
    try {
      compile(sourceText(filename), filename, require, globals)(module);
    } catch (error) {
      cache.delete(filename);
      throw error;
    }
    return module.exports;
  }
  return load;
}

// 用 AST 提取完整函数声明（含全部嵌套函数），不复制或改写被测实现。
function sourceFunctions(relativePath, names, globals = {}) {
  const text = sourceText(relativePath);
  const ast = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declarations = names.map(name => {
    const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `源码函数必须唯一：${name}`);
    return matches[0].getText(ast);
  });
  const module = { exports: {} };
  compile(`${declarations.join('\n')}\nmodule.exports = { ${names.join(',')} };`,
    resolve(frontend, relativePath), id => assert.fail(`提取函数不应导入 ${id}`), globals)(module);
  return module.exports;
}

// 导入源码期间也禁止真实网络；每项测试结束会恢复到此拒绝式 mock。
mock.method(globalThis, 'fetch', async () => assert.fail('禁止真实网络请求'));
const load = sourceLoader();
const engine = load(enginePath);
const utils = load(utilsPath);
const errorUtils = load(errorsPath);
const { cloneDetail } = sourceFunctions('lib/training-refiner/injector.ts',
  ['text', 'generateId', 'remapResources', 'cloneDetail']);
const { readOptimizationStream } = sourceFunctions(componentPath, ['readOptimizationStream']);

beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('禁止未声明的真实网络请求'));
  for (const level of ['log', 'info', 'warn', 'error']) t.mock.method(console, level, () => {});
});

function mockFetch(t, responder) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return responder(call, calls.length);
  });
  return calls;
}

function sseResponse(text, { bytewise = false, open = false } = {}) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  const state = { cancelled: 0, pulls: 0 };
  const response = new Response(new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (index < bytes.length) {
        const end = bytewise ? index + 1 : bytes.length;
        controller.enqueue(bytes.slice(index, end));
        index = end;
      } else if (!open) controller.close();
    },
    cancel() { state.cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, state };
}

const data = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = content => ({ choices: [{ delta: { content }, finish_reason: null }] });
const stop = reason => ({ choices: [{ delta: {}, finish_reason: reason }] });
const modelText = (text, ending = 'data: [DONE]') => data(delta(text)) + ending;
const goodPrompt = '你是教学导师。每轮仅问一个问题，结合学生回答进行追问，不可直接泄露答案；先分析资料，再判断证据，达到目标后仅输出跳转关键词。'.repeat(3);
const patch = () => ({
  taskName: '优化后的中文训练', description: '保留原图谱与附件，仅修改首卡开场白。',
  summary: '增加引导式追问', architectureRationale: '保持双分支汇合结构。',
  nodePatches: [{ action: 'update', id: 'a', sourceStepId: 'a', fields: { prologue: '请先描述你的判断依据。' } }],
  changes: [{ type: 'update', target: '首卡', reason: '教师要求引导式提问' }],
});
const success = value => sseResponse(modelText(JSON.stringify(value ?? patch()))).response;
const gatewayHtml = '<!DOCTYPE html><html><body><h1>504 Gateway Timeout</h1><p>nginx private upstream</p></body></html>';
const httpError = (status = 504) => new Response(status === 504 ? gatewayHtml : '{"error":{"message":"invalid api key"}}', { status });

function fixture() {
  const resource = {
    fileId: 'file-original', fileName: '中文材料.pdf', fileUrl: 'https://files.invalid/material.pdf',
    scriptStepResourceId: 'resource-original', scriptStepId: 'b', trainTaskId: 'source-task',
    type: 'resource', category: '阅读资料', resourceTypeNid: 'reading', isRequired: true,
    description: '完整附件说明', customMetadata: { untouched: true },
  };
  const business = (id, detail = {}) => ({
    stepId: id,
    stepDetailDTO: {
      nodeType: 'SCRIPT_NODE', stepName: `卡片${id}`, description: `描述${id}`,
      trainerName: '导师', prologue: '请介绍你的思路。', llmPrompt: goodPrompt,
      interactiveRounds: 5, modelId: 'original-model', agentId: 'original-agent', avatarNid: 'avatar',
      ...detail,
    },
  });
  const edge = (id, from, to, isDefault = true) => ({
    flowId: id, scriptStepStartId: from, scriptStepEndId: to, isDefault,
    flowCondition: `条件${id}`, transitionPrompt: `转场${id}`, transitionHistoryNum: 3,
    flowConfiguration: { relation: 'and', conditions: [{ text: '保留完整配置' }] },
  });
  return {
    sourceName: '教师源训练', sourceDescription: '包含分支和附件', teacherFeedback: '首卡增加一次引导式追问，不要直接告知答案。',
    steps: [
      { stepId: 'start-id', stepDetailDTO: { nodeType: 'SCRIPT_START' } },
      business('a', { llmPrompt: `${goodPrompt.repeat(60)}原文末尾必须保留` }),
      business('b', {
        llmPrompt: `锁定正文不可传模型${goodPrompt.repeat(30)}`, scriptStepResourceList: [resource],
        stepExtProperty: { resources: [{ nid: 'reading', category: '阅读资料', list: [structuredClone(resource)] }], voice: { enabled: true } },
        scriptStepCover: { fileUrl: 'https://files.invalid/cover.png', fileId: 'cover-original' },
        knowledgeBase: { ids: ['knowledge-original'] }, whiteboard: true,
      }),
      business('c'),
      { stepId: 'end-id', stepDetailDTO: { nodeType: 'SCRIPT_END' } },
    ],
    flows: [edge('f0', 'start-id', 'a'), edge('f1', 'a', 'b'), edge('f2', 'a', 'c', false), edge('f3', 'b', 'end-id'), edge('f4', 'c', 'end-id')],
    scoreItems: [{ itemId: 'score-original', itemName: '分析依据', score: 100, description: '评分原文', requireDetail: '锁定评分详情：给出完整论证与证据，不能省略过程。' }],
    taskConfiguration: { trainTaskCover: { fileId: 'cover' }, extConfig: { keep: true } },
    selectedNodeIds: ['a'], optimizeScoring: false,
    llmSettings: { apiKey: 'test-key-not-real', apiUrl: 'https://model.invalid/v1/', model: 'gpt-5.4' },
  };
}

function snapshot(params) {
  return engine.buildTrainingGraphSnapshot({ ...params, taskName: params.sourceName, description: params.sourceDescription,
    trainTaskId: 'source-task', sourceUrl: 'https://source.invalid/training' });
}

async function collect(options = {}, config = {}) {
  let result = '';
  for await (const chunk of utils.callLLMStream('测试输入', {
    baseUrl: 'https://model.invalid/v1', apiKey: 'test-key-not-real', model: 'gpt-4.1', ...config,
  }, 0.1, '测试系统消息', { requireComplete: true, ...options })) result += chunk;
  return result;
}

function promptGraph(prompt) {
  const section = prompt.split('<source_training>\n')[1].split('\n</source_training>')[0];
  return JSON.parse(section.slice(section.indexOf('\n') + 1));
}

for (const [name, ending] of [
  ['DONE 尾部无换行', 'data: [DONE]'],
  ['stop 尾部无换行', `data: ${JSON.stringify(stop('stop'))}`],
  ['CRLF 完整终止帧', data(stop('stop'))],
]) {
  test(`源码流式成功：逐字节拆分中文/CRLF/${name}`, async t => {
    const raw = patch();
    const text = JSON.stringify(raw);
    const middle = Math.floor(text.length / 2);
    const stream = sseResponse(': heartbeat\r\n\r\n' + data(delta(text.slice(0, middle)))
      + data(delta(text.slice(middle))) + ending, { bytewise: true });
    const calls = mockFetch(t, () => stream.response);
    const result = await engine.generateTrainingRefinementPlan(fixture());
    assert.equal(calls.length, 1);
    assert.equal(result.plan.taskName, raw.taskName);
    assert.equal(result.plan.nodes.find(n => n.id === 'a').prologue, raw.nodePatches[0].fields.prologue);
    assert.deepEqual(result.validation.errors, []);
    assert.equal(stream.response.body.locked, false);
  });
}

test('源码加载器缓存保证相对路径与别名共享 HTTP 错误类', async t => {
  assert.strictEqual(load(errorsPath), errorUtils);
  assert.strictEqual(load(enginePath), engine);
  mockFetch(t, () => httpError(401));
  await assert.rejects(collect(), error => error instanceof errorUtils.LlmHttpError && error.status === 401 && !error.retryable);
});

for (const [input, expected] of [
  ['https://model.invalid/v1/', 'https://model.invalid/v1/chat/completions'],
  ['https://model.invalid/v1/chat/completions', 'https://model.invalid/v1/chat/completions'],
  ['https://model.invalid/v1/chat/completions?version=1', 'https://model.invalid/v1/chat/completions?version=1'],
  ['https://llm-service.polymas.com/api/openai/v1/', 'https://llm-service.polymas.com/api/openai/v1/chat/completions/stream'],
  ['https://llm-service.polymas.com/api/openai/v1/chat/completions/stream/', 'https://llm-service.polymas.com/api/openai/v1/chat/completions/stream'],
  ['https://llm-service.polymas.com.invalid/v1', 'https://llm-service.polymas.com.invalid/v1/chat/completions'],
]) {
  test(`地址规范化且不降级 HTTPS：${input}`, async t => {
    const calls = mockFetch(t, () => success());
    const params = fixture();
    params.llmSettings.apiUrl = input;
    await engine.generateTrainingRefinementPlan(params);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, expected);
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key-not-real');
    assert.equal(calls[0].init.headers['api-key'], 'test-key-not-real');
  });
}

for (const [model, polymas, low, expectedTokens, expectedLow, expectedTemperature] of [
  ['gpt-4.1', false, true, { max_tokens: 321 }, false, true],
  ['gpt-5.4', false, true, { max_completion_tokens: 321 }, true, false],
  ['gpt-5.4', false, false, { max_completion_tokens: 321 }, false, false],
  ['gpt-6.1-sol', false, true, { max_completion_tokens: 321 }, true, false],
  ['o3', false, true, { max_completion_tokens: 321 }, true, false],
  ['gpt-5-chat-latest', false, true, { max_tokens: 321 }, false, false],
  ['claude-sonnet-4-6', false, true, { max_tokens: 321 }, false, true],
  ['gpt-5.4', true, true, { maxTokens: 321, max_completion_tokens: 321 }, true, false],
  ['gpt-6.1-sol', true, true, { maxTokens: 321, max_completion_tokens: 321 }, true, false],
  ['gpt-4.1', true, true, { maxTokens: 321, max_tokens: 321 }, false, true],
  ['claude-opus-5', true, false, { maxTokens: 321 }, false, true],
  ['claude-opus-4-8', true, false, { maxTokens: 321 }, false, true],
  ['Claude Opus 4', true, false, { maxTokens: 321 }, false, true],
  ['claude-opus-5', false, false, { max_tokens: 321 }, false, true],
]) {
  test(`token 字段与按需低推理：${model}/平台=${polymas}/低推理=${low}`, async t => {
    const calls = mockFetch(t, () => sseResponse(modelText('完成')).response);
    assert.equal(await collect({ maxTokens: 321, lowReasoningEffort: low }, {
      model, baseUrl: polymas ? 'https://llm-service.polymas.com/api/openai/v1' : 'https://model.invalid/v1',
    }), '完成');
    const body = calls[0].body;
    const tokens = Object.fromEntries(['maxTokens', 'max_tokens', 'max_completion_tokens'].filter(k => k in body).map(k => [k, body[k]]));
    assert.deepEqual(tokens, expectedTokens);
    assert.equal(body.reasoning_effort, expectedLow ? 'low' : undefined);
    assert.equal(body.temperature, expectedTemperature ? 0.1 : undefined);
  });
}

test('GPT-6.1 平台流式请求使用上游接受的额度参数', async t => {
  const calls = mockFetch(t, ({ body }) => {
    if (Object.hasOwn(body, 'max_tokens')) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }), { status: 500 });
    }
    return sseResponse(modelText('生成完成')).response;
  });
  assert.equal(await collect({}, {
    model: 'gpt-6.1-sol',
    baseUrl: 'https://llm-service.polymas.com/api/openai/v1',
  }), '生成完成');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_completion_tokens, 16000);
  assert.equal(Object.hasOwn(calls[0].body, 'temperature'), false);
});

test('低推理必须显式请求，默认输出额度兼容原调用方', async t => {
  const calls = mockFetch(t, () => sseResponse(modelText('完成')).response);
  await collect({}, { model: 'gpt-5.4' });
  assert.equal(calls[0].body.max_completion_tokens, 16000);
  assert.equal(Object.hasOwn(calls[0].body, 'reasoning_effort'), false);
});

test('HTTP 401 立即失败且不压缩重试', async t => {
  const calls = mockFetch(t, () => httpError(401));
  const progress = [];
  await assert.rejects(engine.generateTrainingRefinementPlan({ ...fixture(), onProgress: message => progress.push(message) }), error => {
    assert.ok(error instanceof engine.RefinerRequestError);
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
    assert.match(error.message, /API Key/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(progress.some(message => message.includes('重试')), false);
});

test('504 后压缩成功：缩短实际输入、减少额度、保留图谱与锁定原文', async t => {
  const params = fixture();
  const before = structuredClone(params);
  const calls = mockFetch(t, (_, attempt) => attempt === 1 ? httpError() : success());
  const progress = [];
  const result = await engine.generateTrainingRefinementPlan({ ...params, onProgress: message => progress.push(message) });
  assert.equal(calls.length, 2);
  const prompts = calls.map(call => call.body.messages[1].content);
  assert.ok(prompts[1].length < prompts[0].length);
  assert.deepEqual(calls.map(call => call.body.max_completion_tokens), [12000, 8000]);
  assert.ok(calls.every(call => call.body.stream && !Object.hasOwn(call.body, 'reasoning_effort')));
  const [first, second] = prompts.map(promptGraph);
  assert.ok(second.nodes.find(n => n.id === 'a').llmPrompt.length < first.nodes.find(n => n.id === 'a').llmPrompt.length);
  for (const graph of [first, second]) {
    assert.deepEqual(graph.nodes.find(n => n.id === 'b'), { id: 'b', stepName: '卡片b', optimizationScope: 'locked_inherit' });
    assert.equal(graph.flows.length, params.flows.length);
    assert.deepEqual(graph.flows.map(flow => [flow.from, flow.to]), [['START', 'a'], ['a', 'b'], ['a', 'c'], ['b', 'END'], ['c', 'END']]);
  }
  for (const prompt of prompts) assert.doesNotMatch(prompt, /锁定正文不可传模型|锁定评分详情|nginx|<!DOCTYPE|<html/i);
  assert.equal(result.inputChars, prompts[1].length);
  assert.deepEqual(result.plan.scoreItems, params.scoreItems);
  assert.deepEqual(result.validation.errors, []);
  assert.deepEqual(params, before, '压缩不能修改原始 DTO 或附件');
  const locked = result.plan.nodes.find(n => n.id === 'b');
  assert.equal(locked.sourceStepId, 'b');
  assert.equal(locked.llmPrompt, params.steps[2].stepDetailDTO.llmPrompt);
  assert.match(progress.join('\n'), /压缩.*重试/);
});

test('连续 504 仅两次请求，最终错误和进度友好且不泄漏 HTML', async t => {
  const calls = mockFetch(t, () => httpError());
  const progress = [];
  await assert.rejects(engine.generateTrainingRefinementPlan({ ...fixture(), onProgress: m => progress.push(m) }), error => {
    assert.ok(error instanceof engine.RefinerRequestError);
    assert.equal(error.status, 504);
    assert.equal(error.retryable, true);
    assert.match(error.message, /HTTP 504/);
    assert.match(error.message, /压缩图谱/);
    assert.match(error.message, /缩小.*范围/);
    assert.doesNotMatch(error.message, /<!DOCTYPE|<html|<body|nginx|private upstream/i);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(progress.join('\n'), /<!DOCTYPE|<html|<body|nginx/i);
});

for (const [status, retryable] of [[400, false], [401, false], [403, false], [408, true], [429, true], [500, true], [502, true], [503, true], [504, true]]) {
  test(`HTTP 错误重试分类：${status}`, () => {
    const error = new errorUtils.LlmHttpError(status, gatewayHtml);
    assert.equal(error.retryable, retryable);
    assert.equal(error.status, status);
    if ([502, 503, 504].includes(status)) assert.doesNotMatch(error.message, /<|nginx/);
  });
}

for (const [name, response, expected, attempts] of [
  ['SSE 中途 504 error', () => sseResponse(modelText(JSON.stringify(patch()), data({ error: { status: 504, message: gatewayHtml } }))).response, /504/, 2],
  ['SSE 中途 401 error', () => sseResponse(modelText(JSON.stringify(patch()), data({ error: { status: 401, message: 'unauthorized' } }))).response, /API Key/, 1],
  ['完整 JSON 后异常 EOF', () => sseResponse(modelText(JSON.stringify(patch()), '')).response, /提前结束|完成标记/, 2],
  ['完整 JSON 后 finish_reason:length', () => sseResponse(modelText(JSON.stringify(patch()), data(stop('length')))).response, /额度上限|不完整/, 2],
  ['畸形 SSE JSON', () => sseResponse(modelText(JSON.stringify(patch()), 'data: {broken}\n\n')).response, /请求失败/, 2],
  ['JSON 兼容响应 length', () => Response.json({ choices: [{ message: { content: JSON.stringify(patch()) }, finish_reason: 'length' }] }), /额度上限|不完整/, 2],
]) {
  test(`不能将半成品接受为成功：${name}`, async t => {
    const calls = mockFetch(t, response);
    await assert.rejects(engine.generateTrainingRefinementPlan(fixture()), expected);
    assert.equal(calls.length, attempts);
  });
}

test('兼容非 SSE 的完整 JSON 响应', async t => {
  mockFetch(t, () => Response.json({ choices: [{ message: { content: JSON.stringify(patch()) }, finish_reason: 'stop' }] }));
  const result = await engine.generateTrainingRefinementPlan(fixture());
  assert.equal(result.plan.taskName, patch().taskName);
});

for (const [name, response, code] of [
  ['SSE content_filter', () => sseResponse(data(stop('content_filter'))).response, 'content_filter'],
  ['JSON content_filter', () => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), 'content_filter'],
  ['refusal', () => Response.json({ choices: [{ message: { content: '', refusal: 'Upstream refusal' }, finish_reason: 'stop' }] }), 'refusal'],
  ['空SSE', () => sseResponse('data: [DONE]\n\n').response, 'empty_response'],
  ['空JSON', () => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), 'empty_response'],
]) {
  test(`上游没有有效正文应保留真实结束原因：${name}`, async t => {
    const calls = mockFetch(t, response);
    await assert.rejects(collect(), error => error instanceof errorUtils.LlmOutputError && error.code === code);
    assert.equal(calls.length, 1);
  });
}

test('优化模型content_filter不作为可重试网络失败', async t => {
  const calls = mockFetch(t, () => sseResponse(data(stop('content_filter'))).response);
  await assert.rejects(engine.generateTrainingRefinementPlan(fixture()), /content_filter/);
  assert.equal(calls.length, 1);
});

test('最终正文和 stop 共处无换行尾帧时不丢失中文数据', async t => {
  const text = JSON.stringify(patch());
  const middle = Math.floor(text.length / 2);
  const ending = { choices: [{ delta: { content: text.slice(middle) }, finish_reason: 'stop' }] };
  const calls = mockFetch(t, () => sseResponse(data(delta(text.slice(0, middle)))
    + `data: ${JSON.stringify(ending)}`, { bytewise: true }).response);
  const result = await engine.generateTrainingRefinementPlan(fixture());
  assert.equal(result.plan.taskName, patch().taskName);
  assert.deepEqual(result.validation.errors, []);
  assert.equal(calls.length, 1);
});

test('reader.read 抛出连接中断异常时不得接受此前完整 JSON', async t => {
  const calls = mockFetch(t, () => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(c) {
        if (sent) c.error(new Error('模拟读取中连接中断'));
        else { sent = true; c.enqueue(new TextEncoder().encode(data(delta(JSON.stringify(patch()))))); }
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await assert.rejects(engine.generateTrainingRefinementPlan(fixture()), /读取中连接中断/);
  assert.equal(calls.length, 2);
});

test('SSE 多行 data 与数组正文直接执行共享解析器', async t => {
  const frame = 'data: {"choices":[\r\ndata: {"delta":{"content":[{"text":"中文"},{"content":"完成"}]},"finish_reason":null}]}\r\n\r\ndata: [DONE]';
  mockFetch(t, () => sseResponse(frame, { bytewise: true }).response);
  assert.equal(await collect(), '中文完成');
});

for (const customReason of [false, true]) {
  test(`请求前 AbortSignal 取消不发请求、不重试：自定义原因=${customReason}`, async t => {
    const controller = new AbortController();
    if (customReason) controller.abort(new Error('教师取消优化')); else controller.abort();
    const calls = mockFetch(t, () => success());
    await assert.rejects(engine.generateTrainingRefinementPlan({ ...fixture(), signal: controller.signal }), error => error === controller.signal.reason);
    assert.equal(calls.length, 0);
  });
}

test('读取中 AbortSignal 取消：传递给 fetch、取消 reader 且不重试', async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const waiting = Promise.withResolvers();
  let bodyController;
  let pulls = 0;
  let response;
  const calls = mockFetch(t, call => {
    call.init.signal.addEventListener('abort', () => bodyController.error(call.init.signal.reason), { once: true });
    response = new Response(new ReadableStream({
      start(c) { bodyController = c; },
      pull(c) {
        if (pulls++ === 0) c.enqueue(new TextEncoder().encode(data(delta('{"taskName":"中文未完成'))));
        else waiting.resolve();
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
    return response;
  });
  const operation = engine.generateTrainingRefinementPlan({ ...fixture(), signal: controller.signal });
  const rejected = assert.rejects(operation, error => error === controller.signal.reason);
  await waiting.promise;
  controller.abort(new Error('读取中主动取消'));
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(response.body.locked, false);
});

test('图谱快照识别 START/END、分支、评分及附件，不改变源数据', () => {
  const params = fixture();
  const before = structuredClone(params);
  const graph = snapshot(params);
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.flowCount, 5);
  assert.equal(graph.resourceCount, 1);
  assert.equal(graph.scoreTotal, 100);
  assert.deepEqual(graph.entryNodeIds, ['a']);
  assert.deepEqual(graph.exitNodeIds, ['b', 'c']);
  assert.deepEqual(graph.branchNodeIds, ['a']);
  assert.deepEqual(graph.unreachableNodeIds, []);
  assert.deepEqual(graph.deadEndNodeIds, []);
  assert.equal(graph.hasCycle, false);
  assert.deepEqual(graph.warnings, []);
  assert.ok(graph.configurationInventory.nodeFieldNames.includes('scriptStepResourceList'));
  assert.deepEqual(params, before);
});

test('锁定卡片及附件的纯 DTO 克隆：保留原文、文件和扩展配置，仅重映射归属', async t => {
  const params = fixture();
  const calls = mockFetch(t, () => success());
  const { plan } = await engine.generateTrainingRefinementPlan(params);
  const original = params.steps[2].stepDetailDTO;
  const before = structuredClone(original);
  const cloned = cloneDetail({ sourceDetail: original, targetTaskId: 'new-task', newStepId: 'new-b',
    isNewNode: false, refinedNode: plan.nodes.find(n => n.id === 'b') });
  assert.notStrictEqual(cloned, original);
  for (const key of ['llmPrompt', 'prologue', 'trainerName', 'interactiveRounds', 'knowledgeBase', 'whiteboard', 'scriptStepCover']) {
    assert.deepEqual(cloned[key], original[key]);
  }
  assert.deepEqual(cloned.stepExtProperty.voice, original.stepExtProperty.voice);
  const attachment = cloned.scriptStepResourceList[0];
  for (const key of ['fileId', 'fileUrl', 'fileName', 'description', 'isRequired', 'customMetadata']) {
    assert.deepEqual(attachment[key], original.scriptStepResourceList[0][key]);
  }
  assert.equal(attachment.trainTaskId, 'new-task');
  assert.equal(attachment.scriptStepId, 'new-b');
  assert.equal(Object.hasOwn(attachment, 'scriptStepResourceId'), false);
  const grouped = cloned.stepExtProperty.resources[0].list[0];
  assert.equal(grouped.fileId, attachment.fileId);
  assert.equal(grouped.trainTaskId, 'new-task');
  assert.equal(grouped.scriptStepId, 'new-b');
  assert.notEqual(grouped.scriptStepResourceId, 'resource-original');
  assert.deepEqual(original, before);
  const newCard = cloneDetail({ sourceDetail: original, targetTaskId: 'new-task', newStepId: 'new-card',
    isNewNode: true, refinedNode: plan.nodes[0] });
  assert.deepEqual(newCard.scriptStepResourceList, []);
  assert.deepEqual(newCard.stepExtProperty.resources, []);
  assert.equal(calls.length, 1, '纯克隆函数不能调用平台接口');
});

test('新背景只替换背景字段并保留附件分组；关闭背景会明确清空源图', async t => {
  const params = fixture();
  const calls = mockFetch(t, () => success());
  const { plan } = await engine.generateTrainingRefinementPlan(params);
  const original = params.steps[2].stepDetailDTO;
  const replacement = {
    fileId: 'background-new',
    fileUrl: 'https://files.invalid/background-new.png',
    contextKey: 'context-new',
  };
  const replaced = cloneDetail({
    sourceDetail: original,
    targetTaskId: 'new-task',
    newStepId: 'new-b',
    isNewNode: false,
    refinedNode: plan.nodes.find(n => n.id === 'b'),
    backgroundImage: replacement,
  });
  assert.deepEqual(replaced.scriptStepCover, {
    fileId: replacement.fileId,
    fileUrl: replacement.fileUrl,
  });
  assert.equal(replaced.backgroundTheme, replacement.fileId);
  assert.equal(replaced.scriptBackgroundType, 'image');
  assert.equal(replaced.stepExtProperty.voice.enabled, true);
  assert.equal(replaced.stepExtProperty.resources[0].list[0].fileId, 'file-original');
  assert.equal(replaced.stepExtProperty.resources[0].list[0].trainTaskId, 'new-task');
  assert.notEqual(replaced.stepExtProperty.resources[0].list[0].scriptStepResourceId, 'resource-original');

  const cleared = cloneDetail({
    sourceDetail: original,
    targetTaskId: 'new-task',
    newStepId: 'new-b',
    isNewNode: false,
    refinedNode: plan.nodes.find(n => n.id === 'b'),
    backgroundImage: null,
  });
  assert.deepEqual(cleared.scriptStepCover, {});
  assert.equal(cleared.backgroundTheme, null);
  assert.equal(cleared.scriptBackgroundType, 'image');
  assert.equal(calls.length, 1);
});

for (const action of ['update', 'remove']) {
  test(`拒绝模型越权${action}锁定卡片`, async t => {
    const raw = patch();
    raw.nodePatches.push({ action, id: 'b', fields: { prologue: '越权修改' } });
    const params = fixture();
    const before = structuredClone(params);
    const calls = mockFetch(t, () => success(raw));
    await assert.rejects(engine.generateTrainingRefinementPlan(params), /未勾选卡片.*b/);
    assert.equal(calls.length, 2);
    assert.deepEqual(params, before);
  });
}

test('局部优化拒绝全量 nodes 绕过锁定范围', async t => {
  const raw = { ...patch(), nodes: [] };
  delete raw.nodePatches;
  const calls = mockFetch(t, () => success(raw));
  await assert.rejects(engine.generateTrainingRefinementPlan(fixture()), /全量 nodes/);
  assert.equal(calls.length, 2);
});

test('结构校验失败后带校验原因压缩修复，再次执行真实校验', async t => {
  const broken = { ...patch(), flows: [{ id: 'bad', from: 'START', to: 'missing', isDefault: true }] };
  const calls = mockFetch(t, (_, attempt) => success(attempt === 1 ? broken : patch()));
  const result = await engine.generateTrainingRefinementPlan(fixture());
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[1].content, /previous_validation_errors/);
  assert.match(calls[1].body.messages[1].content, /终点不存在/);
  assert.deepEqual(result.validation.errors, []);
});

for (const [name, mutate, expected] of [
  ['悬空终点', p => { p.flows[1].to = 'missing'; }, /终点不存在/],
  ['缺少 START', p => { p.flows = p.flows.filter(f => f.from !== 'START'); }, /缺少 START|无法从 START/],
  ['缺少 END', p => { p.flows = p.flows.filter(f => f.to !== 'END'); }, /缺少末卡|无法流向 END/],
  ['双默认边', p => { p.flows.filter(f => f.from === 'a').forEach(f => { f.isDefault = true; }); }, /默认边/],
  ['无默认边', p => { p.flows.filter(f => f.from === 'a').forEach(f => { f.isDefault = false; }); }, /默认边/],
  ['重复节点', p => { p.nodes.push(structuredClone(p.nodes[0])); }, /重复/],
  ['自连', p => { p.flows[1].to = p.flows[1].from; }, /方向不合法/],
]) {
  test(`图谱结构不能放行：${name}`, async t => {
    const params = fixture();
    mockFetch(t, () => success());
    const { plan } = await engine.generateTrainingRefinementPlan(params);
    mutate(plan);
    const result = engine.validateRefinementPlan(plan, params.steps, params.flows, params.scoreItems,
      { editableNodeIds: new Set(['a']), optimizeScoring: false });
    assert.match(result.errors.join('\n'), expected);
  });
}

// 前端流解析：完整函数来自组件 AST，不加载 React 或复刻解析逻辑。
const frontendResult = { ok: true, action: 'optimize', plan: { taskName: '中文结果' } };
const resultFrame = () => ({ type: 'result', result: frontendResult });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail('异步操作未在预期的事件循环轮次内到达同步点');
}

for (const ending of ['无换行', 'CRLF']) {
  test(`前端 parser：逐字节中文、多行 data、心跳、尾部${ending}`, async () => {
    const progress = [];
    const wire = ': heartbeat\r\n\r\nevent: progress\r\nid: 1\r\n'
      + 'data: {"type":"progress",\r\ndata: "message":"正在优化中文卡片"}\r\n\r\n'
      + `data: ${JSON.stringify(resultFrame())}` + (ending === 'CRLF' ? '\r\n\r\n' : '');
    const { response } = sseResponse(wire, { bytewise: true });
    const result = await readOptimizationStream(response, new AbortController().signal, m => progress.push(m));
    assert.deepEqual(result, frontendResult);
    assert.deepEqual(progress, ['正在优化中文卡片']);
    assert.equal(response.body.locked, false);
  });
}

test('前端 parser：收到 result 立即终止，不等待 EOF 且取消底层流', async () => {
  const { response, state } = sseResponse(data(resultFrame()), { open: true });
  assert.deepEqual(await readOptimizationStream(response, new AbortController().signal, () => {}), frontendResult);
  assert.equal(state.cancelled, 1);
  assert.equal(state.pulls, 1);
  assert.equal(response.body.locked, false);
});

for (const [name, wire, expected] of [
  ['空流 EOF', '', /提前结束/],
  ['只有进度 EOF', data({ type: 'progress', message: '尚未完成' }), /提前结束/],
  ['中途 error', data({ type: 'progress', message: '处理中' }) + data({ type: 'error', message: '网关超时，停止优化' }), /网关超时/],
  ['JSON 语法错误', 'data: {"type":\n\n', /格式异常|不完整/],
  ['未知事件', data({ type: 'unexpected' }), /无法识别/],
  ['缺失 result', data({ type: 'result' }), /结果格式异常/],
  ['错误 action', data({ type: 'result', result: { ok: true, action: 'import' } }), /结果格式异常/],
  ['ok 非布尔', data({ type: 'result', result: { ok: 'true', action: 'optimize' } }), /结果格式异常/],
]) {
  test(`前端 parser 拒绝异常：${name}`, async () => {
    const { response } = sseResponse(wire);
    await assert.rejects(readOptimizationStream(response, new AbortController().signal, () => {}), expected);
    assert.equal(response.body.locked, false);
  });
}

test('前端 parser：reader.cancel 失败不覆盖成功结果或原始错误', async () => {
  for (const [event, expected] of [[resultFrame(), null], [{ type: 'error', message: '原始错误' }, /原始错误/]]) {
    const response = new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(data(event))); },
      cancel() { throw new Error('取消时次要错误'); },
    }));
    const operation = readOptimizationStream(response, new AbortController().signal, () => {});
    if (expected) await assert.rejects(operation, expected);
    else assert.deepEqual(await operation, frontendResult);
    assert.equal(response.body.locked, false);
  }
  await turn();
});

for (const name of ['模型流', '前端流']) {
  test(`${name}拒绝尾部截断的 UTF-8 字节`, async t => {
    const prefix = name === '模型流' ? data(delta(JSON.stringify(patch()))) : data({ type: 'progress', message: '中文' });
    const bytes = new Uint8Array([...new TextEncoder().encode(prefix), 0xe4, 0xb8]);
    const response = () => new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } });
    if (name === '模型流') {
      const calls = mockFetch(t, response);
      await assert.rejects(engine.generateTrainingRefinementPlan(fixture()), /encoding|UTF-8|encoded/i);
      assert.equal(calls.length, 2);
    } else {
      await assert.rejects(readOptimizationStream(response(), new AbortController().signal, () => {}), /encoding|UTF-8|encoded/i);
    }
  });
}

for (const phase of ['请求前', '跨块读取中']) {
  test(`前端 parser：${phase}取消释放 reader`, async () => {
    const controller = new AbortController();
    const { response, state } = sseResponse(data({ type: 'progress', message: '取消同步点' }) + data(resultFrame()),
      { open: true, bytewise: true });
    if (phase === '请求前') controller.abort(new Error('请求前取消'));
    await assert.rejects(readOptimizationStream(response, controller.signal, () => controller.abort(new Error('读取中取消'))),
      error => error === controller.signal.reason);
    assert.equal(response.body.locked, false);
    assert.equal(state.cancelled, 1);
  });
}

test('前端 parser：同一网络块中进度回调取消后不得接受 result', async t => {
  // 保留真实失败断言，既不跳过，也不将已取消时返回结果视为正确行为。
  const controller = new AbortController();
  const { response, state } = sseResponse(data({ type: 'progress', message: '取消同步点' }) + data(resultFrame()), { open: true });
  t.after(() => {
    assert.equal(controller.signal.aborted, true);
    assert.equal(response.body.locked, false);
    assert.equal(state.cancelled, 1);
  });
  await assert.rejects(readOptimizationStream(response, controller.signal, () => controller.abort(new Error('同块取消'))),
    error => error === controller.signal.reason);
});

// 仅给 route 注入可手动推进的时钟，不改变业务代码或等待真实的 285 秒。
function manualClock() {
  let now = 10_000;
  let id = 0;
  const timers = new Map();
  const add = (callback, ms, interval) => {
    timers.set(++id, { callback, ms, interval });
    return id;
  };
  return {
    timers,
    advance(ms) { now += ms; },
    fire(ms) {
      const entries = [...timers].filter(([, timer]) => timer.ms === ms);
      assert.ok(entries.length, `没有 ${ms}ms 定时器`);
      for (const [key, timer] of entries) {
        if (!timer.interval) timers.delete(key);
        timer.callback();
      }
    },
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: key => timers.delete(key),
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: key => timers.delete(key),
    },
  };
}

function routeHarness(t, { sourceGate, generate } = {}) {
  const params = fixture();
  const clock = manualClock();
  const generated = [];
  const completed = { plan: { taskName: 'route 优化结果' }, validation: { errors: [], warnings: [] }, modelUsed: 'test-model', inputChars: 123 };
  const calls = mockFetch(t, async ({ url }) => {
    const action = new URL(url).pathname.split('/').pop();
    assert.ok(['queryScriptStepList', 'queryScriptStepFlowList'].includes(action), '不允许平台写操作或真实模型请求');
    if (sourceGate) await sourceGate.promise;
    return Response.json({ code: 200, data: action === 'queryScriptStepList' ? params.steps : params.flows });
  });
  const route = sourceLoader({
    globals: clock.globals,
    mocks: {
      'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
      '@/lib/training-injector/api': {
        parsePolymasUrl: () => ({ trainTaskId: 'source-task', courseId: 'test-course' }),
        queryTrainingTaskConfiguration: async () => ({ trainTaskName: params.sourceName, description: params.sourceDescription, raw: params.taskConfiguration }),
      },
      '@/lib/training-refiner/engine': {
        RefinerRequestError: engine.RefinerRequestError,
        buildTrainingGraphSnapshot: engine.buildTrainingGraphSnapshot,
        validateRefinementPlan: () => assert.fail('优化请求不应进入注入校验分支'),
        generateTrainingRefinementPlan: async input => {
          generated.push(input);
          return generate ? generate(input, completed) : completed;
        },
      },
      '@/lib/training-refiner/template-rewriter': {
        diagnoseTemplateRewrite: async () => assert.fail('模板重构分析不应进入普通优化测试'),
        rewriteTrainingByTemplate: async () => assert.fail('模板重构不应进入普通优化测试'),
      },
      '@/lib/training-refiner/injector': {
        queryTrainingScoreItems: async () => params.scoreItems,
        buildRefinementDryRun: () => assert.fail('不能执行平台预检'),
        injectRefinedTraining: () => assert.fail('不能执行平台注入'),
      },
    },
  })(routePath);
  const controller = new AbortController();
  const body = { action: 'optimize', sourceUrl: 'https://source.invalid/training',
    credentials: { authorization: 'fake-auth', cookie: 'fake-cookie' }, teacherFeedback: params.teacherFeedback,
    selectedNodeIds: ['a'], optimizeScoring: false, llmSettings: params.llmSettings };
  const request = (accept = 'text/event-stream') => new Request('https://local.invalid/api/training-refine', {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify(body),
  });
  t.after(() => { controller.abort(); sourceGate?.resolve(); });
  return { route, clock, generated, completed, calls, controller, request };
}

function imageRouteHarness(t, { importMode = false } = {}) {
  const generated = { cover: [], background: [] };
  let injected = false;
  const params = fixture();
  const route = sourceLoader({
    mocks: {
      'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
      '@/lib/training-injector/api': {
        parsePolymasUrl: raw => ({
          trainTaskId: String(raw).includes('target') ? 'target-task' : 'source-task',
          courseId: 'test-course',
        }),
        queryTrainingTaskConfiguration: async ({ trainTaskId }) => ({
          trainTaskName: trainTaskId === 'target-task' ? '目标训练' : params.sourceName,
          description: params.sourceDescription,
          raw: params.taskConfiguration,
        }),
        generateCourseCoverImageSource: async input => {
          generated.cover.push(input);
          return { fileUrl: 'https://generated.invalid/cover.png' };
        },
        uploadCoverImageFromUrl: async fileUrl => ({
          fileId: 'uploaded-cover',
          fileUrl,
        }),
        generateBackgroundImage: async input => {
          generated.background.push(input);
          return { fileId: 'generated-background', fileUrl: 'https://files.invalid/background.png' };
        },
      },
      '@/lib/training-refiner/engine': {
        RefinerRequestError: engine.RefinerRequestError,
        buildTrainingGraphSnapshot: () => ({ nodeCount: 1 }),
        validateRefinementPlan: () => ({ errors: [], warnings: [] }),
        generateTrainingRefinementPlan: async () => assert.fail('图片请求不应调用模型'),
      },
      '@/lib/training-refiner/injector': {
        queryTrainingScoreItems: async () => params.scoreItems,
        buildRefinementDryRun: () => '',
        injectRefinedTraining: async () => { injected = true; return { logs: '' }; },
      },
      '@/lib/training-refiner/template-rewriter': {
        diagnoseTemplateRewrite: async () => assert.fail('图片测试不应调用模板分析'),
        rewriteTrainingByTemplate: async () => assert.fail('图片测试不应调用模板重构'),
      },
    },
  })(routePath);
  if (importMode) {
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const action = new URL(url).pathname.split('/').pop();
      if (action === 'queryScriptStepList') {
        return Response.json({ code: 200, data: params.steps });
      }
      if (action === 'queryScriptStepFlowList') {
        return Response.json({ code: 200, data: params.flows });
      }
      assert.fail(`不应调用平台写接口：${action} ${init.method || ''}`);
    });
  }
  const plan = {
    taskName: '优化后的训练',
    description: '优化描述',
    summary: '摘要',
    architectureRationale: '架构',
    changes: [],
    nodes: [{
      id: 'node-a', stepName: '新卡片', description: '新卡片描述', trainerName: '导师',
      prologue: '开始', llmPrompt: goodPrompt, interactiveRounds: 3,
    }],
    flows: [],
    scoreItems: params.scoreItems,
    warnings: [],
  };
  const request = body => new Request('https://local.invalid/api/training-refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { route, generated, plan, request, get injected() { return injected; } };
}

function templateRouteHarness(t) {
  const params = fixture();
  const plan = {
    taskName: '模板重构训练', description: '重构描述', summary: '按模板重构',
    architectureRationale: '混合模板', changes: [],
    nodes: [{ id: 'template_node_1', sourceStepId: 'a', stepName: '模拟咨询', description: '描述', trainerName: '客户', prologue: '你好', llmPrompt: 'Role\n'.padEnd(180, 'x'), interactiveRounds: 3, templateMode: 'roleplay', resourcePolicy: 'inherit' }],
    flows: [{ id: 'template_flow_start', from: 'START', to: 'template_node_1', condition: 'NEXT_TO_STAGE1', transitionPrompt: '', isDefault: true }, { id: 'template_flow_end', from: 'template_node_1', to: 'END', condition: 'TASK_COMPLETE', transitionPrompt: '', isDefault: true }],
    scoreItems: params.scoreItems, warnings: [], strategy: 'template-rebuild',
  };
  const diagnosis = {
    overallMode: 'roleplay', confidence: 0.9, reasons: ['角色型互动'], currentProblems: [], flowType: 'linear',
    modules: [{ id: 'module_1', title: '模拟咨询', recommendedMode: 'roleplay', sourceStepIds: ['a'], objective: '完成咨询', reason: '需要被动披露信息', suggestedRounds: 3 }],
  };
  const modulePlan = { taskName: '模板重构训练', audience: '学生', overallObjective: '完成咨询', recommendedMode: 'roleplay', flowType: 'linear', modules: [{ id: 'module_1', sourceStepIds: ['a'], title: '模拟咨询', moduleType: 'roleplay', objective: '完成咨询', description: '描述', keyPoints: ['要点一', '要点二'], interactionStyle: '问一答一', transitionGoal: '结束', suggestedRounds: 3 }], edges: [], notes: [] };
  const calls = mockFetch(t, async ({ url }) => {
    const action = new URL(url).pathname.split('/').pop();
    assert.ok(['queryScriptStepList', 'queryScriptStepFlowList'].includes(action));
    return Response.json({ code: 200, data: action === 'queryScriptStepList' ? params.steps : params.flows });
  });
  const route = sourceLoader({
    mocks: {
      'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
      '@/lib/training-injector/api': {
        parsePolymasUrl: () => ({ trainTaskId: 'source-task', courseId: 'test-course' }),
        queryTrainingTaskConfiguration: async () => ({ trainTaskName: params.sourceName, description: params.sourceDescription, raw: params.taskConfiguration }),
      },
      '@/lib/training-refiner/engine': {
        RefinerRequestError: engine.RefinerRequestError,
        buildTrainingGraphSnapshot: engine.buildTrainingGraphSnapshot,
        validateRefinementPlan: engine.validateRefinementPlan,
        generateTrainingRefinementPlan: async () => assert.fail('模板分析不应调用增量优化'),
      },
      '@/lib/training-refiner/injector': {
        queryTrainingScoreItems: async () => params.scoreItems,
        buildRefinementDryRun: () => assert.fail('模板分析不应执行 dry-run'),
        injectRefinedTraining: () => assert.fail('模板分析不应执行注入'),
      },
      '@/lib/training-refiner/template-rewriter': {
        diagnoseTemplateRewrite: async () => ({ diagnosis, modulePlan, inputChars: 123 }),
        rewriteTrainingByTemplate: async () => ({ diagnosis, modulePlan, plan, validation: { errors: [], warnings: [] }, modelUsed: 'test-model', inputChars: 456 }),
      },
    },
  })(routePath);
  const request = body => new Request('https://local.invalid/api/training-refine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { route, plan, diagnosis, modulePlan, request, calls };
}

const routeEvents = wire => wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const terminals = events => events.filter(event => ['error', 'result'].includes(event.type));

test('route：模板分析只返回诊断和模块规划，不写入平台', async t => {
  const h = templateRouteHarness(t);
  const response = await h.route.POST(h.request({
    action: 'analyze-template', sourceUrl: 'https://source.invalid/training',
    credentials: { authorization: 'fake-auth', cookie: 'fake-cookie' },
    teacherFeedback: '请判断现有训练适合哪种模板', templateMode: 'auto',
    llmSettings: { model: 'test-model', apiUrl: 'https://model.invalid/v1', apiKey: 'key' },
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'analyze-template');
  assert.equal(result.diagnosis.overallMode, 'roleplay');
  assert.equal(result.templateModulePlan.modules[0].sourceStepIds[0], 'a');
  assert.equal(h.calls.length, 2);
});

test('route：模板重构返回完整方案且不提前注入', async t => {
  const h = templateRouteHarness(t);
  const response = await h.route.POST(h.request({
    action: 'rewrite-template', sourceUrl: 'https://source.invalid/training',
    credentials: { authorization: 'fake-auth', cookie: 'fake-cookie' },
    templateMode: 'roleplay', templateDiagnosis: h.diagnosis,
    templateModulePlan: h.modulePlan, rewriteScoring: false,
    llmSettings: { model: 'test-model', apiUrl: 'https://model.invalid/v1', apiKey: 'key' },
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'rewrite-template');
  assert.equal(result.plan.strategy, 'template-rebuild');
  assert.equal(result.plan.nodes[0].templateMode, 'roleplay');
});

test('模板重构：非线性剧本补齐 START 和各末端 END，同时保留分支', async () => {
  const params = fixture();
  const prompt = goodPrompt;
  const stage = (number, name) => [
    `### 阶段${number}: ${name}`,
    `**虚拟训练官名字**: 导师${number}`,
    `**阶段描述**: ${name}的训练目标`,
    '**互动轮次**: 3',
    `**开场白**: 请开始${name}。`,
    '**提示词**:',
    '```markdown', prompt, '```',
  ].join('\n');
  const graphEdges = [
    { from: '阶段1', to: '阶段2', condition: 'TO_A', isDefault: 1 },
    { from: '阶段1', to: '阶段3', condition: 'TO_B', isDefault: 0 },
    { from: '阶段2', to: 'END', condition: 'DONE_A', isDefault: 1 },
    { from: '阶段3', to: 'END', condition: 'DONE_B', isDefault: 1 },
  ];
  const scriptForEdges = edges => [
    '## 📋 基础配置',
    '**任务名称**: 分支训练',
    '**任务描述**: 三阶段分支训练',
    stage(1, '导入'), stage(2, '线路甲'), stage(3, '线路乙'),
    '## 🔀 非线性跳转关系',
    '```json',
    JSON.stringify({ flowType: 'graph', edges }),
    '```',
  ].join('\n\n');
  const modulePlan = {
    taskName: '分支训练', audience: '学生', overallObjective: '完成分支任务',
    recommendedMode: 'sequential', flowType: 'graph', edges: [], notes: [],
    modules: ['导入', '线路甲', '线路乙'].map((title, index) => ({
      id: `module_${index + 1}`, title, moduleType: 'sequential',
      sourceStepIds: [['a'], ['b'], ['c']][index],
      objective: title, description: title, keyPoints: ['判断', '复盘'],
      interactionStyle: '逐步练习', transitionGoal: '结束', suggestedRounds: 3,
    })),
  };
  const diagnosis = {
    overallMode: 'sequential', confidence: 0.9, reasons: [], currentProblems: [],
    flowType: 'graph', modules: modulePlan.modules.map(module => ({
      id: module.id, title: module.title, recommendedMode: 'sequential',
      sourceStepIds: module.sourceStepIds, objective: module.objective,
      reason: '按分支训练', suggestedRounds: 3,
    })),
  };
  const rewrite = (script, plannedModules = modulePlan, chosenDiagnosis = diagnosis) => sourceLoader({ mocks: {
    '@/lib/training-generator/generator': {
      generateTrainingScriptStream: async function* () { yield script; },
      repairTrainingScriptStructure: async () => assert.fail('完整剧本不应触发修复'),
    },
  } })('lib/training-refiner/template-rewriter.ts').rewriteTrainingByTemplate({
    taskName: params.sourceName, description: params.sourceDescription,
    steps: params.steps, flows: params.flows, scoreItems: params.scoreItems,
    llmSettings: params.llmSettings, diagnosis: chosenDiagnosis, modulePlan: plannedModules,
  });
  const result = await rewrite(scriptForEdges(graphEdges));
  assert.deepEqual(result.validation.errors, []);
  assert.deepEqual(result.plan.flows.map(flow => [flow.from, flow.to]), [
    ['START', 'template_node_1'],
    ['template_node_1', 'template_node_2'],
    ['template_node_1', 'template_node_3'],
    ['template_node_2', 'END'],
    ['template_node_3', 'END'],
  ]);
  assert.deepEqual(engine.validateRefinementPlan(
    result.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
  const withoutEnd = await rewrite(scriptForEdges(graphEdges.slice(0, 2)));
  assert.deepEqual(withoutEnd.plan.flows.map(flow => [flow.from, flow.to]), [
    ['START', 'template_node_1'],
    ['template_node_1', 'template_node_2'],
    ['template_node_1', 'template_node_3'],
    ['template_node_2', 'END'],
    ['template_node_3', 'END'],
  ]);
  assert.deepEqual(engine.validateRefinementPlan(
    withoutEnd.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
  const plannedEnds = await rewrite(scriptForEdges(graphEdges.slice(0, 2)), {
    ...modulePlan,
    edges: [
      { fromModuleId: 'module_2', toModuleId: '__END__', condition: 'PLANNED_DONE_A', isDefault: 1 },
      { fromModuleId: 'module_3', toModuleId: '__END__', condition: 'PLANNED_DONE_B', isDefault: 1 },
    ],
  });
  assert.deepEqual(plannedEnds.plan.flows.filter(flow => flow.to === 'END').map(flow => flow.condition),
    ['PLANNED_DONE_A', 'PLANNED_DONE_B']);
  const plannedMiddle = await rewrite(scriptForEdges([
    { from: '阶段1', to: '阶段2', condition: 'TO_A', isDefault: 1 },
    { from: '阶段3', to: 'END', condition: 'DONE_B', isDefault: 1 },
  ]), {
    ...modulePlan,
    edges: [
      { fromModuleId: 'module_1', toModuleId: 'module_2', condition: 'TO_A', isDefault: 1 },
      { fromModuleId: 'module_2', toModuleId: 'module_3', condition: 'PLANNED_TO_3', isDefault: 1 },
      { fromModuleId: 'module_3', toModuleId: '__END__', condition: 'DONE_B', isDefault: 1 },
    ],
  });
  assert.deepEqual(plannedMiddle.plan.flows.map(flow => [flow.from, flow.to]), [
    ['START', 'template_node_1'],
    ['template_node_1', 'template_node_2'],
    ['template_node_3', 'END'],
    ['template_node_2', 'template_node_3'],
  ]);
  assert.equal(plannedMiddle.plan.flows.find(flow => flow.from === 'template_node_2')?.condition, 'PLANNED_TO_3');
  assert.match(plannedMiddle.plan.warnings[0], /已按模块规划补齐/);
  assert.deepEqual(engine.validateRefinementPlan(
    plannedMiddle.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
  const plannedOnly = await rewrite(scriptForEdges([]), {
    ...modulePlan,
    edges: [
      { fromModuleId: 'module_1', toModuleId: 'module_2', condition: 'PLANNED_TO_2', isDefault: 1 },
      { fromModuleId: 'module_2', toModuleId: 'module_3', condition: 'PLANNED_TO_3', isDefault: 1 },
      { fromModuleId: 'module_3', toModuleId: '__END__', condition: 'PLANNED_DONE', isDefault: 1 },
    ],
  });
  assert.deepEqual(engine.validateRefinementPlan(
    plannedOnly.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
  const conflictingDefaults = await rewrite(scriptForEdges([
    ...graphEdges.slice(0, 2).map(edge => ({ ...edge, isDefault: 1 })),
    ...graphEdges.slice(2),
  ]), {
    ...modulePlan,
    edges: [
      { fromModuleId: 'module_1', toModuleId: 'module_2', condition: 'TO_A', isDefault: 0 },
      { fromModuleId: 'module_1', toModuleId: 'module_3', condition: 'TO_B', isDefault: 1 },
    ],
  });
  assert.deepEqual(conflictingDefaults.plan.flows.filter(flow => flow.from === 'template_node_1')
    .map(flow => [flow.to, flow.isDefault]), [
      ['template_node_2', false], ['template_node_3', true],
    ]);
  assert.deepEqual(engine.validateRefinementPlan(
    conflictingDefaults.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
  const sixteenModules = Array.from({ length: 16 }, (_, index) => ({
    ...modulePlan.modules[0], id: `module_${index + 1}`,
    title: `阶段${index + 1}`, objective: `阶段${index + 1}`,
    sourceStepIds: index < 3 ? [['a'], ['b'], ['c']][index] : [],
  }));
  const sixteenEdges = [
    ...Array.from({ length: 13 }, (_, index) => ({
      fromModuleId: `module_${index + 1}`, toModuleId: `module_${index + 2}`,
      condition: `NEXT_TO_STAGE${index + 2}`, isDefault: 1,
    })),
    { fromModuleId: 'module_14', toModuleId: 'module_15', condition: 'TO_15', isDefault: 1 },
    { fromModuleId: 'module_14', toModuleId: 'module_16', condition: 'TO_16', isDefault: 0 },
    { fromModuleId: 'module_15', toModuleId: '__END__', condition: 'DONE_15', isDefault: 1 },
    { fromModuleId: 'module_16', toModuleId: '__END__', condition: 'DONE_16', isDefault: 1 },
  ];
  const longPlan = { ...modulePlan, modules: sixteenModules, edges: sixteenEdges };
  const longDiagnosis = { ...diagnosis, modules: sixteenModules.map(module => ({
    id: module.id, title: module.title, recommendedMode: 'sequential',
    sourceStepIds: module.sourceStepIds, objective: module.objective,
    reason: '按规划执行', suggestedRounds: 3,
  })) };
  const longScript = [
    '## 📋 基础配置', '**任务名称**: 十六阶段分支训练',
    '**任务描述**: 十六阶段分支训练',
    ...sixteenModules.map((module, index) => stage(index + 1, module.title)),
    '## 🔀 非线性跳转关系', '```json',
    JSON.stringify({ flowType: 'graph', edges: sixteenEdges
      .filter(edge => edge.fromModuleId !== 'module_11' && edge.toModuleId !== '__END__')
      .map(edge => ({
        from: `阶段${edge.fromModuleId.slice(7)}`,
        to: `阶段${edge.toModuleId.slice(7)}`,
        condition: edge.condition,
        isDefault: edge.isDefault,
      })) }),
    '```',
  ].join('\n\n');
  const longResult = await rewrite(longScript, longPlan, longDiagnosis);
  assert.equal(longResult.plan.nodes.length, 16);
  assert.ok(longResult.plan.flows.some(flow => flow.from === 'template_node_11' && flow.to === 'template_node_12'));
  assert.equal(longResult.plan.flows.filter(flow => flow.to === 'END').length, 2);
  assert.deepEqual(engine.validateRefinementPlan(
    longResult.plan, params.steps, params.flows, params.scoreItems,
    { optimizeScoring: false },
  ).errors, []);
});

test('image proxy：带凭据读取远端图片并返回图片内容', async t => {
  const route = sourceLoader({
    mocks: {
      'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    },
  })(imageProxyRoutePath);
  const bytes = new Uint8Array([137, 80, 78, 71]);
  let call;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    call = { url: String(url), init };
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const response = await route.POST(new Request('https://local.invalid/api/training-refine/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileUrl: 'https://files.invalid/generated.png',
      credentials: { authorization: 'Bearer fixture', cookie: 'sid=fixture' },
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(call.url, 'https://files.invalid/generated.png');
  assert.equal(call.init.headers.Authorization, 'Bearer fixture');
  assert.equal(call.init.headers.Cookie, 'sid=fixture');
});

test('route：generate-image 生成封面并上传素材，不读取源图或写入目标', async t => {
  const h = imageRouteHarness(t);
  const response = await h.route.POST(h.request({
    action: 'generate-image',
    sourceUrl: 'https://source.invalid/training',
    credentials: { authorization: 'fake-auth', cookie: 'fake-cookie' },
    plan: h.plan,
    injectScript: true,
    injectMode: 'replace',
    imageKind: 'cover',
    imageOptions: { generateCover: true, generateBackgrounds: true, stylePrompt: '统一冷色调' },
    llmSettings: { apiKey: 'image-key', apiUrl: 'https://image.invalid/v1', imageModel: 'image-model' },
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'generate-image');
  assert.equal(result.imageKind, 'cover');
  assert.equal(result.image.fileId, 'uploaded-cover');
  assert.equal(result.image.fileUrl, 'https://generated.invalid/cover.png');
  assert.equal(typeof result.image.contextKey, 'string');
  assert.equal(h.generated.cover.length, 1);
  assert.equal(h.generated.cover[0].coverStylePrompt, '统一冷色调');
  assert.equal(h.generated.background.length, 0);
  assert.equal(h.injected, false);
});

test('route：导入前拒绝缺失或过期背景，平台写接口保持未调用', async t => {
  const h = imageRouteHarness(t, { importMode: true });
  const response = await h.route.POST(h.request({
    action: 'import',
    sourceUrl: 'https://source.invalid/training',
    targetUrl: 'https://target.invalid/training',
    credentials: { authorization: 'fake-auth', cookie: 'fake-cookie' },
    plan: h.plan,
    selectedNodeIds: ['node-a'],
    injectScript: true,
    injectRubric: false,
    injectMode: 'replace',
    confirmImport: true,
    imageOptions: { generateCover: false, generateBackgrounds: true, stylePrompt: '' },
    imageAssets: { backgrounds: {} },
    llmSettings: { imageModel: 'image-model' },
  }));
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.match(result.error, /新背景尚未生成/);
  assert.equal(h.injected, false);
});

test('route：首个进度在源图完成前返回，心跳可用，成功只发送一个终止事件', async t => {
  const sourceGate = Promise.withResolvers();
  const h = routeHarness(t, { sourceGate });
  const response = await h.route.POST(h.request('application/json, TEXT/EVENT-STREAM; charset=utf-8'));
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/);
  assert.equal(response.headers.get('Cache-Control'), 'no-cache, no-transform');
  assert.equal(response.headers.get('X-Accel-Buffering'), 'no');
  const reader = response.body.getReader();
  let wire = new TextDecoder().decode((await reader.read()).value);
  assert.match(wire, /请求已接收/);
  assert.equal(h.generated.length, 0);
  h.clock.fire(15_000);
  sourceGate.resolve();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    wire += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  assert.match(wire, /: heartbeat/);
  const terminal = terminals(routeEvents(wire));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'result');
  assert.equal(terminal[0].result.ok, true);
  assert.deepEqual(terminal[0].result.plan, h.completed.plan);
  assert.equal(h.generated.length, 1);
  assert.deepEqual(h.generated[0].selectedNodeIds, ['a']);
  assert.equal(h.generated[0].optimizeScoring, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.clock.timers.size, 0, '成功后清理心跳和总预算定时器');
});

test('route：模型失败发 error 而非 result，并清理生命周期定时器', async t => {
  const h = routeHarness(t, { generate: async () => { throw new errorUtils.LlmHttpError(504, gatewayHtml); } });
  const response = await h.route.POST(h.request());
  const wire = await response.text();
  const terminal = terminals(routeEvents(wire));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'error');
  assert.match(terminal[0].message, /504/);
  assert.doesNotMatch(wire, /<html|nginx/i);
  assert.equal(h.clock.timers.size, 0);
});

for (const mode of ['断连', '取消响应', '超时后迟到成功', '超时后迟到失败']) {
  test(`route：读取源训练期间${mode}，不得继续调用模型`, async t => {
    const sourceGate = Promise.withResolvers();
    const h = routeHarness(t, { sourceGate });
    const response = await h.route.POST(h.request());
    await until(() => h.calls.length === 2);
    const text = mode === '取消响应' ? null : response.text();
    if (mode === '断连') h.controller.abort();
    else if (mode === '取消响应') await response.body.cancel();
    else { h.clock.advance(285_000); h.clock.fire(285_000); }
    if (text) {
      const wire = await text;
      if (mode.startsWith('超时')) {
        const terminal = terminals(routeEvents(wire));
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].type, 'error');
        assert.match(terminal[0].message, /285 秒总预算/);
      } else assert.equal(terminals(routeEvents(wire)).length, 0);
    }
    await until(() => h.clock.timers.size === 0);
    if (mode.endsWith('失败')) sourceGate.reject(new Error('迟到的平台失败'));
    else sourceGate.resolve();
    await turn();
    assert.equal(h.generated.length, 0);
    assert.equal(h.clock.timers.size, 0);
    // node:test 会将未观察的迟到 Promise 拒绝判为失败，不安装吞错处理器。
  });
}

for (const streaming of [true, false]) {
  test(`route：请求前已取消，流式=${streaming}，不读取源图`, async t => {
    const h = routeHarness(t);
    h.controller.abort();
    const response = await h.route.POST(h.request(streaming ? 'text/event-stream' : 'application/json'));
    if (streaming) assert.equal(await response.text(), '');
    else assert.equal((await response.json()).ok, false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.generated.length, 0);
    assert.equal(h.clock.timers.size, 0);
  });
}

test('route：285 秒预算包含请求体读取时间，不会重新给予完整预算', async t => {
  const h = routeHarness(t);
  const request = h.request();
  const readJson = request.json.bind(request);
  request.json = async () => { const body = await readJson(); h.clock.advance(285_001); return body; };
  const response = await h.route.POST(request);
  const terminal = terminals(routeEvents(await response.text()));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'error');
  assert.match(terminal[0].message, /285 秒总预算/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.generated.length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test('route：生成中断连向模型传递 AbortSignal，迟到方案不能发送 result', async t => {
  const generation = Promise.withResolvers();
  const h = routeHarness(t, { generate: () => generation.promise });
  const response = await h.route.POST(h.request());
  const text = response.text();
  await until(() => h.generated.length === 1);
  h.controller.abort();
  const wire = await text;
  assert.equal(h.generated[0].signal.aborted, true);
  generation.resolve(h.completed);
  await turn();
  assert.equal(terminals(routeEvents(wire)).length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test('route：JSON 客户端保留上游 504 状态，不误报为用户参数错误', async t => {
  const h = routeHarness(t, { generate: async () => { throw new engine.RefinerRequestError('模型网关超时', true, 504); } });
  const response = await h.route.POST(h.request('application/json'));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).ok, false);
  assert.equal(h.clock.timers.size, 0);
});

for (const delay of [90_000, 150_000]) {
  test(`模型等待 ${delay}ms 到期后取消首轮并压缩重试，清理定时器`, async t => {
    const clock = manualClock();
    const timedEngine = sourceLoader({ globals: clock.globals })(enginePath);
    const progress = [];
    const calls = mockFetch(t, ({ init }, index) => {
      if (index > 1) return success();
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
          if (delay === 150_000) controller.enqueue(new TextEncoder().encode(data(delta('{'))));
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const pending = timedEngine.generateTrainingRefinementPlan({ ...fixture(), onProgress: message => progress.push(message) });
    await until(() => calls.length === 1 && (delay === 90_000 || progress.some(message => message.includes('已接收'))));
    clock.advance(delay);
    clock.fire(delay);
    const result = await pending;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.signal.aborted, true);
    assert.deepEqual(result.validation.errors, []);
    assert.equal(clock.timers.size, 0);
  });
}

test('route：JSON 客户端兼容成功路径，并清理预算定时器', async t => {
  const h = routeHarness(t);
  const response = await h.route.POST(h.request('application/json'));
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.action, 'optimize');
  assert.deepEqual(result.plan, h.completed.plan);
  assert.equal(h.generated.length, 1);
  assert.equal(h.clock.timers.size, 0);
});
