import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';
import { guardTrainingStream, TrainingStreamTimeoutError } from './stream-control.ts';

const frontend = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const nativeRequire = createRequire(import.meta.url);

// 转译真实源码并解析项目别名；测试不加载 Next 服务器、环境文件或真实模型服务。
function sourceLoader(mocks = {}) {
    const cache = new Map();
    function load(relative) {
        const filename = resolve(frontend, relative);
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const require = (id) => {
            if (Object.hasOwn(mocks, id)) return mocks[id];
            if (!id.startsWith('.') && !id.startsWith('@/')) return nativeRequire(id);
            const base = id.startsWith('@/') ? resolve(frontend, id.slice(2)) : resolve(dirname(filename), id);
            const target = [base, `${base}.ts`, `${base}.tsx`].find((path) => /\.tsx?$/.test(path) && statSync(path, { throwIfNoEntry: false })?.isFile());
            assert.ok(target, `未解析的源码依赖 ${id}`);
            return load(target);
        };
        const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
            fileName: filename,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        new Script(`(function(require,module,exports){${compiled}\n})`, { filename }).runInThisContext()(require, module, module.exports);
        return module.exports;
    }
    return load;
}

const load = sourceLoader();
const tools = load('lib/training-generator/script-tools.ts');
const parser = load('lib/training-injector/parser.ts');
const marker = tools.TRAINING_SCRIPT_COMPLETE_MARKER;
const teacherDoc = '教师文档原始开头：四选一角色锁定。\n' + '教学业务信息与分支考核要求。\n'.repeat(120) + '教师文档原始结尾：保持所选线路直到结束。';

function planFixture() {
    const roles = ['主管接诊医师', '检验医师', '流行病学调查员', '临床药师'];
    const modules = Array.from({ length: 17 }, (_, index) => ({
        id: `m${index + 1}`, title: index === 0 ? '案情摘要与角色锁定' : `${roles[Math.floor((index - 1) / 4)]}线路：环节${(index - 1) % 4 + 1}`,
        moduleType: 'roleplay', objective: `完成模块${index + 1}的专业分析`, description: `探索引导者带领学生完成模块${index + 1}`,
        keyPoints: [`模块${index + 1}的关键业务要求`, '完整解释分析依据并保持路线锁定'], interactionStyle: '被动应答，循证追问', transitionGoal: '完成本模块要求后按规划路线推进', suggestedRounds: 4,
    }));
    const edges = [];
    for (const first of [2, 6, 10, 14]) {
        edges.push({ id: `select${first}`, fromModuleId: 'm1', toModuleId: `m${first}`, condition: `CHOOSE_${first}`, conditionDescription: `学生选择${modules[first - 1].title}所属角色`, transitionPrompt: `进入${modules[first - 1].title}`, isDefault: first === 6 ? 1 : 0 });
        for (let number = first; number <= first + 3; number++) edges.push({
            id: `edge${number}`, fromModuleId: `m${number}`, toModuleId: number === first + 3 ? '__END__' : `m${number + 1}`,
            condition: `FINISH_${number}`, conditionDescription: `完成${modules[number - 1].title}全部考核并保持已锁定角色`, transitionPrompt: `本线路环节${number}结束`, isDefault: 1,
        });
    }
    return { taskName: '四条角色分支', audience: '学生', overallObjective: '完成所选角色线路的训练', recommendedMode: 'roleplay', flowType: 'graph', modules, edges, notes: ['角色选择后锁定，不进入其他角色线路。'] };
}

function stage(number, { partial = false, tag = '新版阶段' } = {}) {
    return [
        `<!-- STAGE_START:${number} -->`, `### 阶段${number}: 模型临时标题${number}`,
        '**虚拟训练官名字**: 探索引导者', '**阶段描述**: 完成本阶段专业训练。', '**互动轮次**: 4',
        `**flowCondition**: WRONG_LINEAR_${number + 1}`, '**transitionPrompt**:', '```', '继续专业讨论。', '```',
        '**开场白**:', '> 请说明你的分析依据。', '**提示词**:', '```markdown', '# Role', '你是探索引导者。',
        '# Workflow', `${tag}${number}：` + '依据原始资料和证据分析，达到考核要求后仅输出指定关键词。'.repeat(6),
        partial ? '本阶段尚未写完，不' : `完成后输出 WRONG_LINEAR_${number + 1}。`,
        ...(partial ? [] : ['```', `<!-- STAGE_END:${number} -->`]),
    ].join('\n');
}

function prefix() {
    return '# 四条角色分支 - 训练剧本配置\n\n## 📋 基础配置\n- **任务名称**: 四条角色分支\n- **任务描述**: 专业训练。\n- **角色锁定规则**: GLOBAL_ROLE_LOCK，选择后锁定到本线路 END。\n\n## 📝 训练阶段\n';
}

function modelResponse(parts, signal, delayMs = 0) {
    const encoder = new TextEncoder();
    let timer;
    return new Response(new ReadableStream({
        start(controller) {
            let index = 0;
            const abort = () => { clearTimeout(timer); controller.error(signal.reason); };
            signal?.addEventListener('abort', abort, { once: true });
            const next = () => {
                if (signal?.aborted) return;
                if (index < parts.length) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[index++] } }] })}\n\n`));
                    timer = setTimeout(next, delayMs);
                } else {
                    signal?.removeEventListener('abort', abort);
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            };
            timer = setTimeout(next, delayMs);
        },
        cancel() { clearTimeout(timer); },
    }), { headers: { 'content-type': 'text/event-stream' } });
}

async function runRoute(t, { incomplete = 8, hangOnce = false, omitTargetOnce = false, omitTargetAlways = false, failureMode } = {}) {
    const calls = [];
    let abortedRequests = 0;
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const payload = JSON.parse(init.body);
        calls.push(payload);
        if (failureMode === 'content_filter') return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        if (failureMode === 'empty') return modelResponse([], init.signal);
        if (failureMode === 'service') return Response.json({ code: 500, stackTrace: [
            JSON.stringify({ error: { type: 'aigateway_error', code: 'unknown_service_err', requestid: `fixture-failure-${calls.length}` } }), '503 Service Unavailable from upstream',
        ] }, { status: 500 });
        if (calls.length === 1) return modelResponse([
            prefix() + Array.from({ length: incomplete - 1 }, (_, index) => stage(index + 1, { tag: '原有完整阶段' })).join('\n\n') + '\n\n' + stage(incomplete, { partial: true }),
        ], init.signal);
        if (hangOnce && calls.length === 2) return new Response(new ReadableStream({
            start(controller) { init.signal.addEventListener('abort', () => { abortedRequests++; controller.error(init.signal.reason); }, { once: true }); },
        }), { headers: { 'content-type': 'text/event-stream' } });
        const prompt = payload.messages[1].content;
        const range = prompt.match(/本轮范围严格限定为阶段(\d+)至阶段(\d+)/);
        assert.ok(range, '续写必须请求明确阶段范围');
        const first = Number(range[1]);
        const last = Number(range[2]);
        if (omitTargetAlways || (omitTargetOnce && calls.length === 2)) return modelResponse([stage(first + 1)], init.signal);
        const parts = Array.from({ length: last - first + 1 }, (_, index) => stage(first + index));
        if (last === 17) parts.push(`\n\n## 🔄 阶段跳转关系\n阶段9 -> 阶段10\n\n${marker}`);
        return modelResponse(parts.map((part) => part + '\n\n'), init.signal, 2);
    });
    const routeLoad = sourceLoader({
        '@/lib/training-generator/stream-control': {
            guardTrainingStream: (factory, options) => guardTrainingStream(factory, { ...options, firstTokenTimeoutMs: 35, idleTimeoutMs: 35, timeoutMs: 1500, progressIntervalMs: 5 }),
            TrainingStreamTimeoutError,
        },
    });
    const { POST } = routeLoad('app/api/training-generate/route.ts');
    const response = await POST(new Request('http://fixture.invalid/api/training-generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            teacherDocContent: teacherDoc, teacherDocName: '四条角色分支', generateScript: true, generateRubric: false,
            apiKey: 'fixture-key', apiUrl: 'https://model.invalid/v1', model: 'gpt-6.1-sol', modulePlan: planFixture(), userSuggestions: '用户建议：保持四条角色线路。',
        }),
    }));
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const error = events.find((event) => event.type === 'error');
    if (omitTargetAlways || failureMode) {
        assert.ok(error, '连续缺少目标阶段应结束本轮生成并明确报错');
        return { calls, events, error };
    }
    assert.equal(error, undefined, error?.message);
    const result = events.find((event) => event.type === 'complete');
    assert.ok(result, '完整生成必须发送 complete');
    return { calls, events, result, abortedRequests };
}

async function runManualContinuation(t) {
    const calls = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const payload = JSON.parse(init.body);
        calls.push(payload);
        return modelResponse([`${stage(17, { tag: '手动补齐阶段' })}\n\n${marker}`], init.signal, 2);
    });
    const routeLoad = sourceLoader({
        '@/lib/training-generator/stream-control': {
            guardTrainingStream: (factory, options) => guardTrainingStream(factory, { ...options, firstTokenTimeoutMs: 100, idleTimeoutMs: 100, timeoutMs: 1500, progressIntervalMs: 5 }),
            TrainingStreamTimeoutError,
        },
    });
    const { POST } = routeLoad('app/api/training-generate/route.ts');
    const priorScript = prefix() + Array.from(
        { length: 16 },
        (_, index) => stage(index + 1, { tag: '手动续写前保留阶段' }),
    ).join('\n\n');
    const response = await POST(new Request('http://fixture.invalid/api/training-generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            requestMode: 'continue_script',
            teacherDocContent: teacherDoc,
            teacherDocName: '四条角色分支',
            generateScript: true,
            generateRubric: false,
            apiKey: 'fixture-key',
            apiUrl: 'https://model.invalid/v1',
            model: 'gpt-6.1-sol',
            scriptMode: 'roleplay',
            modulePlan: planFixture(),
            userSuggestions: '用户建议：保持四条角色线路。',
            priorScript,
        }),
    }));
    const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
    return { calls, events, result: events.find((event) => event.type === 'complete') };
}

test('17阶段四分支：从残缺阶段8按两阶段一轮补完，正文替换持续发送且保留原始上下文', { timeout: 10000 }, async (t) => {
    const { calls, events, result } = await runRoute(t);
    const prompt = calls[1].messages[1].content;
    assert.ok(prompt.includes(teacherDoc), '原教师文档完整保留');
    for (const module of planFixture().modules) assert.ok(prompt.includes(module.description));
    for (const edge of planFixture().edges) assert.ok(prompt.includes(edge.condition) && prompt.includes(edge.conditionDescription));
    assert.match(prompt, /GLOBAL_ROLE_LOCK/);
    assert.match(prompt, /用户建议：保持四条角色线路/);
    assert.match(prompt, /本轮范围严格限定为阶段8至阶段9/);
    assert.match(prompt, /阶段9 -> END/);
    assert.match(prompt, /下一阶段原始开场白/, '续写保留原内置模板的格式要求');
    assert.ok(events.some((event) => event.type === 'phase_snapshot' && event.fullContent.includes('新版阶段8')));
    const steps = parser.parseTrainingScript(result.script);
    assert.equal(steps.length, 17);
    assert.match(steps[6].llmPrompt, /原有完整阶段7/);
    assert.match(steps[7].llmPrompt, /新版阶段8/);
    assert.equal(steps[8].flowCondition, 'FINISH_9');
    assert.match(steps[8].llmPrompt, /目标：END（结束当前路线）/);
    assert.doesNotMatch(steps[8].llmPrompt, /WRONG_LINEAR_10/);
    assert.doesNotMatch(steps[0].llmPrompt, /WRONG_LINEAR_2/);
    for (const edge of tools.buildSerializableGraphEdges(planFixture())) {
        assert.ok(steps[Number(edge.from.slice(2)) - 1].llmPrompt.includes(edge.condition));
    }
    assert.doesNotMatch(result.script, /^## 🔄 阶段跳转关系/m);
    assert.deepEqual(parser.parseTrainingScriptFlowConfig(result.script).edges, tools.buildSerializableGraphEdges(planFixture()));
    assert.ok(tools.hasTrainingScriptCompleteMarker(result.script));
});

test('手动断点续写：保留前16阶段，只补阶段17并恢复完整非线性关系', { timeout: 10000 }, async (t) => {
    const { calls, events, result } = await runManualContinuation(t);
    assert.equal(calls.length, 1, '手动续写不应重新请求整份剧本');
    assert.ok(result, events.find((event) => event.type === 'error')?.message || '未收到 complete');
    const prompt = calls[0].messages[1].content;
    assert.match(prompt, /本轮范围严格限定为阶段17至阶段17/);
    assert.ok(prompt.includes(teacherDoc), '手动续写仍携带完整教师文档');
    for (const edge of planFixture().edges) {
        assert.ok(prompt.includes(edge.condition) && prompt.includes(edge.conditionDescription));
    }
    assert.ok(events.some((event) => event.type === 'phase_snapshot'));
    const steps = parser.parseTrainingScript(result.script);
    assert.equal(steps.length, 17);
    assert.match(steps[15].llmPrompt, /手动续写前保留阶段16/);
    assert.match(steps[16].llmPrompt, /手动补齐阶段17/);
    assert.deepEqual(parser.parseTrainingScriptFlowConfig(result.script).edges, tools.buildSerializableGraphEdges(planFixture()));
    assert.ok(tools.hasTrainingScriptCompleteMarker(result.script));
});

test('跨线路断点：阶段6引用图上前驱阶段1，不把编号相邻的阶段5当作上游', { timeout: 10000 }, async (t) => {
    const { calls } = await runRoute(t, { incomplete: 6 });
    const prompt = calls[1].messages[1].content;
    assert.match(prompt, /已生成的图上前驱[\s\S]*GLOBAL_ROLE_LOCK|GLOBAL_ROLE_LOCK[\s\S]*已生成的图上前驱/);
    const context = prompt.split('【断点附近上下文】')[1];
    assert.match(context, /【已生成的图上前驱[^】]*】\n<!-- STAGE_START:1 -->/);
    assert.doesNotMatch(context, /上一完整阶段 阶段5/);
});

test('续写流没有正文时按时取消、更新等待进度并自动重试，最终补完17阶段', { timeout: 10000 }, async (t) => {
    const { abortedRequests, events, calls } = await runRoute(t, { hangOnce: true });
    assert.equal(abortedRequests, 1);
    assert.ok(events.some((event) => event.type === 'progress' && /断点续写/.test(event.message) && /已接收 0 字符/.test(event.message)));
    assert.ok(events.some((event) => event.type === 'start' && /续写请求失败/.test(event.message)));
    assert.match(calls[2].messages[1].content, /本轮范围严格限定为阶段8至阶段9/);
});

test('模型漏写目标阶段时保持断点重试，不伪造阶段结束标记或跳过阶段8', { timeout: 10000 }, async (t) => {
    const { calls, result } = await runRoute(t, { omitTargetOnce: true });
    assert.match(calls[2].messages[1].content, /本轮范围严格限定为阶段8至阶段9/);
    assert.equal(parser.parseTrainingScript(result.script).length, 17);
});

test('第9阶段是当前分支终点：单轮停在阶段9，不把另一分支阶段10当作连续任务', { timeout: 10000 }, async (t) => {
    const { calls, result } = await runRoute(t, { incomplete: 9 });
    assert.match(calls[1].messages[1].content, /本轮范围严格限定为阶段9至阶段9/);
    assert.match(calls[2].messages[1].content, /本轮范围严格限定为阶段10至阶段11/);
    assert.equal(parser.parseTrainingScriptFlowConfig(result.script).edges.find((edge) => edge.from === '阶段9').to, 'END');
});

test('连续三轮没有补出目标阶段时结束等待，已有完整阶段仍保留', { timeout: 10000 }, async (t) => {
    const { calls, events } = await runRoute(t, { omitTargetAlways: true });
    assert.equal(calls.length, 4, '首轮生成加三次无进展续写');
    assert.ok(!events.some((event) => event.type === 'complete'));
    assert.match(events.filter((event) => event.type === 'phase_snapshot').at(-1).fullContent, /原有完整阶段7/);
});

test('上游content_filter且没有正文时立即报错，不把空结果送进12轮续写', { timeout: 10000 }, async (t) => {
    const { calls, events, error } = await runRoute(t, { failureMode: 'content_filter' });
    assert.equal(calls.length, 1);
    assert.match(error.message, /content_filter/);
    assert.ok(!events.some((event) => event.type === 'complete' || event.type === 'phase_complete'));
    assert.ok(!events.some((event) => /断点续写/.test(event.message || '')));
});

test('HTTP200空正文只重试一次，然后明确失败，不启动断点续写', { timeout: 10000 }, async (t) => {
    const { calls, events, error } = await runRoute(t, { failureMode: 'empty' });
    assert.equal(calls.length, 2);
    assert.match(error.message, /空正文/);
    assert.ok(!events.some((event) => event.type === 'complete' || /断点续写/.test(event.message || '')));
});

test('用户日志中的外层500内层503：保留服务失败分类，两次失败后结束', { timeout: 10000 }, async (t) => {
    const { calls, events, error } = await runRoute(t, { failureMode: 'service' });
    assert.equal(calls.length, 2);
    assert.match(error.message, /上游 HTTP 503/);
    assert.ok(!events.some((event) => event.type === 'complete'));
});

test('图规划默认出口保留显式选择，路由同步重复运行不重复添加提示词', () => {
    const plan = planFixture();
    const edges = tools.buildSerializableGraphEdges(plan).filter((edge) => edge.from === '阶段1');
    assert.equal(edges.find((edge) => edge.isDefault === 1).to, '阶段6');
    const raw = prefix() + stage(1) + '\n\n' + marker;
    const aligned = tools.alignTrainingScriptWithPlan(raw, plan);
    assert.equal(tools.alignTrainingScriptWithPlan(aligned, plan), aligned);
    assert.equal((aligned.match(/<!-- PLANNED_ROUTING_START -->/g) || []).length, 1);
});

test('首个正文超时：即使上游生成器拒绝取消，本轮等待仍结束', { timeout: 2000 }, async () => {
    let signal;
    await assert.rejects(async () => {
        for await (const _ of guardTrainingStream(async function* (upstreamSignal) {
            signal = upstreamSignal;
            await new Promise(() => {});
        }, { firstTokenTimeoutMs: 15, timeoutMs: 200 })) { /* consume */ }
    }, TrainingStreamTimeoutError);
    assert.equal(signal.aborted, true);
});

test('正文中途停流：保留已接收片段并触发空闲超时', { timeout: 2000 }, async () => {
    let text = '';
    await assert.rejects(async () => {
        for await (const chunk of guardTrainingStream(async function* () {
            yield '阶段8已生成的正文';
            await new Promise(() => {});
        }, { firstTokenTimeoutMs: 100, idleTimeoutMs: 15, timeoutMs: 200 })) text += chunk;
    }, (error) => error instanceof TrainingStreamTimeoutError && /没有新增正文/.test(error.message));
    assert.equal(text, '阶段8已生成的正文');
});

test('调用方取消：向上游传递取消原因并结束本轮读取', { timeout: 2000 }, async () => {
    const controller = new AbortController();
    const reason = new DOMException('fixture cancel', 'AbortError');
    let signal;
    setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(async () => {
        for await (const _ of guardTrainingStream(async function* (upstreamSignal) {
            signal = upstreamSignal;
            await new Promise(() => {});
        }, { signal: controller.signal })) { /* consume */ }
    }, (error) => error === reason);
    assert.equal(signal.aborted, true);
});

test('模型持续输出但超过单轮总时长时仍按时退出，留给下一轮续写', { timeout: 2000 }, async () => {
    await assert.rejects(async () => {
        for await (const _ of guardTrainingStream(async function* (signal) {
            while (!signal.aborted) {
                yield '持续生成正文';
                await new Promise((resolve) => setTimeout(resolve, 3));
            }
        }, { firstTokenTimeoutMs: 100, idleTimeoutMs: 100, timeoutMs: 20 })) { /* consume */ }
    }, (error) => error instanceof TrainingStreamTimeoutError && /单次生成超过/.test(error.message));
});
