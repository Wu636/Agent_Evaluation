import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
function harness({ chats = [], cards = [], llm, nodes, fetchError, queryError } = {}) {
  const prompts = [], calls = [];
  const steps = nodes || ['a', 'b'].map(stepId => ({ stepId, stepDetailDTO: { nodeType: 'SCRIPT_NODE', stepName: stepId, llmPrompt: 'HIDDEN_ANSWER', description: 'HIDDEN_DESCRIPTION' } }));
  steps.push({ stepId: 'end', stepDetailDTO: { nodeType: 'SCRIPT_END' } });
  const module = { exports: {} };
  const mocks = {
    '@/lib/config': { MODEL_NAME_MAPPING: {} },
    '@/lib/llm/utils': { buildTemperatureCompatiblePayload: x => x },
    '@/lib/training-injector/api': {
      queryScriptSteps: async () => steps,
      queryTrainingTaskConfiguration: async () => ({ trainTaskName: 'test', description: 'HIDDEN_TASK' }),
      getScriptNodes: x => x.filter(n => n.stepDetailDTO.nodeType === 'SCRIPT_NODE'),
      resolveCloudapiRoot: () => 'https://platform.test',
    },
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/queryScriptStepList')) {
      return Response.json(queryError ? { code: 401, success: false, msg: '拒绝访问，未登录!' } : { code: 200, data: steps });
    }
    calls.push({ url, body, signal: init.signal });
    if (url.startsWith('https://llm.test')) {
      prompts.push(body);
      if (llm) return llm(init);
      return Response.json({ choices: [{ message: { content: '研究方案'.repeat(150) } }] });
    }
    if (fetchError && url.endsWith('/chat')) throw new Error('network failure');
    return Response.json({ code: 200, data: url.endsWith('/runCard') ? (cards.shift() || { sessionId: 's', text: '请继续' }) : (chats.shift() || { text: '请补充' }) });
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'fetch', js)(name => { assert.ok(mocks[name], name); return mocks[name]; }, module, module.exports, fetch);
  const run = async (options = {}, signal = new AbortController().signal) => {
    const response = await module.exports.POST({ signal, json: async () => ({ taskId: 't', credentials: { cookie: 'test' }, apiUrl: 'https://llm.test', maxRoundsPerStage: 1, ...options }) });
    const events = (await response.text()).split('\n\n').filter(Boolean).map(x => JSON.parse(x.slice(6)));
    return { events, result: events.at(-1) };
  };
  return { run, prompts, calls, POST: module.exports.POST };
}

test('cross-stage history, explicit materials, 2000 reply and no hidden script/reference leak', async () => {
  const h = harness({ chats: [{ text: '第二阶段', nextStepId: 'b' }, { text: '完成', nextStepId: 'end' }] });
  const { result } = await h.run({ studentContext: '可见材料ABC', maxReplyLength: 2000, useReferenceDialogue: true });
  assert.equal(result.completed, true);
  assert.equal(result.reason, 'script_end');
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1].messages[1].content, /\[a\] 学生: 研究方案/);
  assert.match(h.prompts[1].messages[0].content, /可见材料ABC/);
  assert.doesNotMatch(JSON.stringify(h.prompts), /HIDDEN/);
  assert.equal(result.messages.find(x => x.role === 'user').content.length, 600);
});
test('default 2000 preserves full reply; no positional advancement at stage limit', async () => {
  const h = harness(); const { result } = await h.run();
  assert.equal(result.completed, false); assert.equal(result.reason, 'max_rounds_per_stage');
  assert.equal(result.messages.find(x => x.role === 'user').content.length, 600);
  assert.match(h.prompts[0].messages[0].content, /单次回答最多 2000 字/);
  assert.equal(h.calls.filter(x => x.url.endsWith('/runCard')).length, 1);
});
test('200 through 2000 characters preserve complete formulas in transcript, SSE and chat', async () => {
  const formula = String.raw`\[w=\frac{0.4040}{0.5000}\times100\%=80.80\%\]`;
  for (const length of [200, 201, 600, 1999, 2000]) {
    const content = '计算过程。'.repeat(400).slice(0, length - formula.length) + formula;
    assert.equal(content.length, length);
    const h = harness({ llm: async () => Response.json({ choices: [{ message: { content } }] }) });
    const { events, result } = await h.run();
    assert.equal(result.messages.find(x => x.role === 'user').content, content);
    assert.equal(events.find(x => x.type === 'message' && x.role === 'user').text, content);
    assert.equal(h.calls.find(x => x.url.endsWith('/chat')).body.text, content);
  }
});
test('over-limit replies report an error without partial transcript, SSE or chat submission', async () => {
  for (const options of [{}, { maxReplyLength: 200 }]) {
    const limit = options.maxReplyLength ?? 2000;
    const content = '甲'.repeat(limit + 1);
    const h = harness({ llm: async () => Response.json({ choices: [{ message: { content } }] }) });
    const { events, result } = await h.run(options);
    assert.equal(result.type, 'error');
    assert.equal(result.completed, false);
    assert.equal(result.reason, 'error');
    assert.match(result.message, new RegExp(`${limit + 1} > ${limit}`));
    assert.match(result.message, /未截断或提交该回答/);
    assert.equal(result.messages.filter(x => x.role === 'user').length, 0);
    assert.equal(events.filter(x => x.type === 'message' && x.role === 'user').length, 0);
    assert.equal(h.calls.filter(x => x.url.endsWith('/chat')).length, 0);
  }
});
test('unknown next id is not completion', async () => {
  const { result } = await harness({ chats: [{ nextStepId: 'ghost' }] }).run();
  assert.equal(result.completed, false); assert.equal(result.reason, 'unknown_next_step_id');
});
test('empty card with missing next id stops incomplete', async () => {
  const { result } = await harness({ cards: [{ sessionId: 's', needSkipStep: true }] }).run();
  assert.equal(result.reason, 'missing_next_step_id'); assert.equal(result.completed, false);
});
test('explicit END in card is completion without LLM', async () => {
  const h = harness({ cards: [{ sessionId: 's', text: '完成', nextStepId: 'end' }] });
  assert.equal((await h.run()).result.completed, true); assert.equal(h.prompts.length, 0);
});
test('total budget stops cyclic stage transitions before another card', async () => {
  const h = harness({ chats: [{ nextStepId: 'a' }] });
  const { result } = await h.run({ maxTotalRounds: 1 });
  assert.equal(result.reason, 'max_total_rounds'); assert.equal(result.totalRounds, 1);
  assert.equal(h.calls.filter(x => x.url.endsWith('/runCard')).length, 1);
});
test('zero-chat skip cycles are bounded', async () => {
  const h = harness({ cards: Array.from({ length: 10 }, () => ({ sessionId: 's', nextStepId: 'a', needSkipStep: true })) });
  assert.equal((await h.run({ maxTotalRounds: 1 })).result.reason, 'max_stage_visits');
  assert.equal(h.calls.length, 3);
});
test('platform failure preserves attempted student reply', async () => {
  const { result } = await harness({ fetchError: true }).run();
  assert.equal(result.type, 'error'); assert.equal(result.completed, false);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[1].role, 'user');
});
test('request abort interrupts in-flight LLM and preserves transcript', async () => {
  const abort = new AbortController();
  const h = harness({ llm: init => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true });
    abort.abort();
  }) });
  const { result } = await h.run({}, abort.signal);
  assert.equal(result.reason, 'cancelled'); assert.equal(result.messages.length, 1);
  assert.equal(h.calls.length, 2); assert.equal(h.calls.at(-1).signal.aborted, true);
});
test('invalid reply bound rejected before platform calls', async () => {
  const h = harness(); assert.equal((await h.run({ maxReplyLength: 2001 })).result.type, 'error'); assert.equal(h.calls.length, 0);
});

test('response reader cancellation aborts in-flight fetch', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let fetchSignal;
  const h = harness({ llm: init => new Promise((resolve, reject) => {
    fetchSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true });
    started();
  }) });
  const response = await h.POST({ signal: new AbortController().signal, json: async () => ({ taskId: 't', credentials: { cookie: 'test' }, apiUrl: 'https://llm.test' }) });
  const reader = response.body.getReader();
  await ready;
  await reader.cancel();
  assert.equal(fetchSignal.aborted, true);
});
test('bounded history keeps initial research and latest revision beyond eight messages', async () => {
  const h = harness({ cards: [{ sessionId: 's', text: 'INITIAL_RESEARCH' + '甲'.repeat(22000) }],
    chats: [...Array.from({ length: 10 }, (_, i) => ({ text: `REVISION_${i}` + '乙'.repeat(6000) })), { nextStepId: 'end' }] });
  const { result } = await h.run({ maxRoundsPerStage: 12 });
  assert.equal(result.completed, true);
  const prompt = h.prompts.at(-1).messages[1].content;
  assert.match(prompt, /INITIAL_RESEARCH/); assert.match(prompt, /REVISION_9/);
  assert.match(prompt, /中间历史因长度限制省略/);
  assert.ok(prompt.length < 67000);
  assert.ok(result.messages.map(x => x.content).join('').length > 80000);
});

test('query authentication failure is reported rather than empty stages', async () => {
  const h = harness({ queryError: true });
  const { result } = await h.run();
  assert.equal(result.type, 'error');
  assert.equal(result.message, '拒绝访问，未登录!');
  assert.equal(result.messages.length, 0);
  assert.equal(h.calls.length, 0);
});

test('network error and 503 retry only LLM, with sanitized diagnostics', async () => {
  let attempts = 0;
  const h = harness({ chats: [{ nextStepId: 'end' }], llm: async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed SECRET_TOKEN', { cause: { code: 'ECONNRESET' } });
    if (attempts === 2) return new Response('SECRET_BODY', { status: 503 });
    return Response.json({ choices: [{ message: { content: '研究回答' } }] });
  } });
  const { events, result } = await h.run({ apiUrl: 'https://llm.test/v1/' });
  assert.equal(result.completed, true); assert.equal(attempts, 3);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat')).length, 1);
  assert.equal(h.calls.find(x => x.url.startsWith('https://llm.test')).url, 'https://llm.test/v1/chat/completions');
  const retries = events.filter(x => x.type === 'llm_attempt');
  assert.deepEqual(retries.map(x => x.cause), ['ECONNRESET', 'http_503']);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});
test('429 retries at most twice and explicit gateway URL remains unchanged', async () => {
  const h = harness({ llm: async () => new Response('secret', { status: 429 }) });
  const { events, result } = await h.run({ apiUrl: 'https://llm.test/api/custom' });
  assert.equal(result.type, 'error'); assert.equal(h.prompts.length, 3);
  assert.equal(events.filter(x => x.type === 'llm_attempt').at(-1).retrying, false);
  assert.equal(h.calls.find(x => x.url.startsWith('https://llm.test')).url, 'https://llm.test/api/custom');
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat')).length, 0);
});
test('401 and invalid JSON do not retry', async () => {
  for (const response of [new Response('secret', { status: 401 }), new Response('not json')]) {
    const h = harness({ llm: async () => response });
    assert.equal((await h.run()).result.type, 'error'); assert.equal(h.prompts.length, 1);
  }
});
test('abort during retry delay prevents another attempt', async () => {
  const abort = new AbortController();
  const h = harness({ llm: async () => {
    setTimeout(() => abort.abort(), 20);
    throw new TypeError('fetch failed');
  } });
  const { result } = await h.run({}, abort.signal);
  assert.equal(result.reason, 'cancelled'); assert.equal(h.prompts.length, 1);
});
