import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';

const frontend = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nativeRequire = createRequire(import.meta.url);

// 直接转译真实源码，避免依赖 Next 服务器或真实模型服务。
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
const pipeline = load('lib/training-generator/doc-extraction/pipeline.ts');
const prompts = load('lib/training-generator/doc-extraction/prompts.ts');
const generator = load('lib/training-generator/generator.ts');

function section(overrides) {
    return {
        id: 'sec_1',
        title: '章节',
        level: 2,
        path: '章节',
        status: 'kept',
        excerpt: '',
        reason: '',
        markdown: '',
        originalChars: 0,
        keptChars: 0,
        ...overrides,
    };
}

function planFixture() {
    return {
        taskName: '长文档提取测试',
        audience: '学生',
        overallObjective: '完成重点提取后的训练任务',
        recommendedMode: 'general',
        flowType: 'linear',
        modules: [{
            id: 'm1',
            title: '任务导入',
            moduleType: 'general',
            objective: '明确任务目标',
            description: '引导者介绍任务目标与评分要求。',
            keyPoints: ['任务目标', '评分要求'],
            interactionStyle: '引导式问答',
            transitionGoal: '学生确认任务目标',
            suggestedRounds: 3,
        }],
        edges: [],
        notes: [],
    };
}

test('splitDocSections 识别常见标题格式并跳过代码围栏', () => {
    const doc = [
        '# 总览',
        '开头说明。',
        '',
        '## 一、任务目标',
        '完成接诊训练。',
        '',
        '### 1.1 评分标准',
        '- 病史采集 20 分',
        '',
        '```md',
        '# 代码块里的标题不是章节',
        '```',
        '',
        '## 二、附件',
        '附录内容。',
    ].join('\n');

    const sections = pipeline.splitDocSections(doc);
    assert.deepEqual(sections.map((item) => item.title), ['总览', '一、任务目标', '1.1 评分标准', '二、附件']);
    assert.equal(sections[2].level, 3);
    assert.ok(sections[1].path.includes('总览'));
});

test('splitDocIntoChunks 对超长章节切片并标记续篇', () => {
    const doc = `# 长章节\n\n${'这是一段用于测试切片的正文内容。\n\n'.repeat(300)}`;
    const chunks = pipeline.splitDocIntoChunks(doc, { maxChars: 1500, overlap: 100 });

    assert.ok(chunks.length > 1);
    assert.ok(chunks.slice(1).every((chunk) => chunk.path.includes('（续）')));
    assert.ok(chunks.every((chunk) => chunk.text.length <= 1600));
    assert.equal(chunks[0].path, '长章节');
});

test('aggregateChunkSections 合并重复章节并记录冲突', () => {
    const source = pipeline.splitDocSections('# A\n内容A\n\n# B\n内容B\n\n# C\n内容C');

    const { sections, conflicts } = pipeline.aggregateChunkSections([
        { title: 'A', level: 1, path: 'A', status: 'kept', markdown: 'A1', excerpt: '', reason: '' },
        { title: 'A', level: 1, path: 'A', status: 'kept', markdown: 'A2', excerpt: '', reason: '' },
        { title: 'B', level: 1, path: 'B', status: 'merged', markdown: 'B1', excerpt: 'B 的片段', reason: '并入 A' },
        { title: 'C', level: 1, path: 'C', status: 'omitted', markdown: '会被丢弃', excerpt: 'C 的片段', reason: '低优先级' },
    ], source);

    assert.deepEqual(sections.map((item) => item.title), ['A', 'B', 'C']);
    assert.equal(sections[0].markdown, 'A1\n\nA2');
    assert.equal(sections[0].originalChars, source[0].text.length);
    assert.equal(sections[1].status, 'merged');
    assert.equal(sections[2].markdown, '');
    assert.equal(sections[2].reason, '低优先级');
    assert.equal(conflicts.length, 0);

    const conflicting = pipeline.aggregateChunkSections([
        { title: 'A', level: 1, path: 'A', status: 'kept', markdown: 'A1', excerpt: '', reason: '' },
        { title: 'A', level: 1, path: 'A', status: 'omitted', markdown: '', excerpt: '', reason: '' },
    ], source);
    assert.equal(conflicting.conflicts.length, 1);
    assert.equal(conflicting.sections[0].status, 'kept');
});

test('buildExtractionMarkdown 排除省略章节并自动补标题', () => {
    const markdown = pipeline.buildExtractionMarkdown([
        section({ id: 'sec_1', title: '任务目标', level: 2, markdown: '完成接诊训练。' }),
        section({ id: 'sec_2', title: '附录', status: 'omitted', markdown: '' }),
    ]);
    assert.equal(markdown, '## 任务目标\n\n完成接诊训练。');
});

test('runDeterministicChecks 对评分数字、评分项与章节覆盖给出分级提示', () => {
    const original = [
        '# 评分标准',
        '- 病史采集 20 分',
        '- 沟通表达 10 分',
        '',
        '# 附件',
        '背景材料内容。'.repeat(80),
    ].join('\n');
    const extracted = '# 评分标准\n仅保留概述。';
    const checks = pipeline.runDeterministicChecks(original, extracted, [
        section({ title: '评分标准' }),
    ], 'balanced');

    assert.ok(checks.some((check) => check.code === 'missing-scoring-number' && check.level === 'error'));
    assert.ok(checks.some((check) => check.code === 'rubric-count' && check.level === 'error'));
    assert.ok(checks.some((check) => check.code === 'coverage-gap' && check.level === 'warning'));
    assert.ok(checks.some((check) => check.code === 'over-compressed'));
});

test('runDeterministicChecks 在空结果与保留评分时给出正确结论', () => {
    const emptyChecks = pipeline.runDeterministicChecks('原文内容', '', [], 'strict');
    assert.deepEqual(emptyChecks.map((check) => check.code), ['empty-extraction']);

    const original = '# 评分标准\n- 病史采集 20 分\n- 沟通表达 10 分';
    const keptChecks = pipeline.runDeterministicChecks(original, original, [
        section({ title: '评分标准' }),
    ], 'balanced');
    assert.ok(!keptChecks.some((check) => check.level === 'error'));
});

test('createExtractionResult 与 reauditExtractionResult 计算统计并标记手动编辑', () => {
    const original = '# 任务目标\n完成接诊训练。\n\n# 评分标准\n- 病史采集 20 分';
    const extracted = '# 任务目标\n完成接诊训练。\n\n# 评分标准\n- 病史采集 20 分\n- 沟通表达 10 分';
    const fingerprint = pipeline.buildDocFingerprint({ content: original });
    const result = pipeline.createExtractionResult({
        originalContent: original,
        extractedMarkdown: extracted,
        sections: [section({ title: '任务目标' }), section({ id: 'sec_2', title: '评分标准' })],
        mode: 'balanced',
        docFingerprint: fingerprint,
        promptVersion: 'doc-extract-v1',
        createdAt: '2026-10-30T00:00:00.000Z',
    });

    assert.ok(result.id.startsWith(fingerprint.slice(0, 12)));
    assert.equal(result.originalChars, original.length);
    assert.equal(result.extractedChars, extracted.length);
    assert.ok(result.stats.compressionRatio > 1);
    assert.ok(result.rationale.includes('提取档位：均衡'));
    assert.equal(result.createdAt, '2026-10-30T00:00:00.000Z');

    const edited = pipeline.reauditExtractionResult(result, `${extracted}\n补充说明`);
    assert.equal(edited.edited, true);
    assert.equal(edited.extractedChars, `${extracted}\n补充说明`.length);
    assert.ok(edited.checks.some((check) => check.code === 'manual-edit'));
});

test('buildDocFingerprint 对文本与文件稳定且可区分', () => {
    assert.equal(
        pipeline.buildDocFingerprint({ content: '相同内容' }),
        pipeline.buildDocFingerprint({ content: '相同内容' }),
    );
    assert.notEqual(
        pipeline.buildDocFingerprint({ content: '内容 A' }),
        pipeline.buildDocFingerprint({ content: '内容 B' }),
    );
    assert.equal(
        pipeline.buildDocFingerprint({ fileName: '任务.docx', fileSize: 1024, fileLastModified: 1700000000000 }),
        'file:任务.docx:1024:1700000000000',
    );
});

test('轻度档使用 8k–10k 字目标并提示超出或遗漏', () => {
    const original = `# 章节\n${'原文内容说明。'.repeat(2500)}`;
    const sections = [section({ title: '章节' })];

    const tooLong = pipeline.runDeterministicChecks(original, '重点内容。'.repeat(2500), sections, 'light');
    assert.ok(tooLong.some((check) => check.code === 'extraction-too-long' && check.level === 'warning'));

    const tooShort = pipeline.runDeterministicChecks(original, '重点。'.repeat(1000), sections, 'light');
    assert.ok(tooShort.some((check) => check.code === 'extraction-too-short' && check.level === 'warning'));

    const target = pipeline.runDeterministicChecks(original, '重点。'.repeat(2000), sections, 'light');
    assert.ok(!target.some((check) => check.code === 'extraction-too-long'));
    assert.ok(!target.some((check) => check.code === 'extraction-too-short'));
});

test('轻度档提示词与提取思路说明 8k–10k 字目标', () => {
    const prompt = prompts.buildChunkExtractionPrompt({
        chunkText: '正文内容',
        chunkPath: '第一章',
        mode: 'light',
        targetChars: 1200,
    });
    assert.ok(prompt.includes('轻度档'));
    assert.ok(prompt.includes('8000–10000 字'));
    assert.ok(prompt.includes('本分块建议输出约 1200 字'));

    const result = pipeline.createExtractionResult({
        originalContent: '# 章节\n原文内容。',
        extractedMarkdown: '# 章节\n重点内容。',
        sections: [section({ title: '章节' })],
        mode: 'light',
        docFingerprint: 'text:test',
        promptVersion: 'doc-extract-v1',
    });
    assert.ok(result.rationale.includes('提取档位：轻度（目标 8k–10k 字，上限 12k 字）'));
});

test('均衡档与严格档使用新的字数目标', () => {
    const balancedPrompt = prompts.buildChunkExtractionPrompt({
        chunkText: '正文内容',
        chunkPath: '第一章',
        mode: 'balanced',
    });
    assert.ok(balancedPrompt.includes('均衡档'));
    assert.ok(balancedPrompt.includes('6000–8000 字'));

    const strictPrompt = prompts.buildChunkExtractionPrompt({
        chunkText: '正文内容',
        chunkPath: '第一章',
        mode: 'strict',
    });
    assert.ok(strictPrompt.includes('严格档'));
    assert.ok(strictPrompt.includes('4000–6000 字'));

    const original = `# 章节\n${'原文内容说明。'.repeat(4000)}`;
    const sections = [section({ title: '章节' })];

    const balancedTooLong = pipeline.runDeterministicChecks(original, '重点内容。'.repeat(2500), sections, 'balanced');
    assert.ok(balancedTooLong.some((check) => check.code === 'extraction-too-long'));
    const balancedTooShort = pipeline.runDeterministicChecks(original, '重点。'.repeat(1000), sections, 'balanced');
    assert.ok(balancedTooShort.some((check) => check.code === 'extraction-too-short'));

    const strictTooLong = pipeline.runDeterministicChecks(original, '重点内容。'.repeat(2000), sections, 'strict');
    assert.ok(strictTooLong.some((check) => check.code === 'extraction-too-long'));
    const strictTooShort = pipeline.runDeterministicChecks(original, '重点。'.repeat(400), sections, 'strict');
    assert.ok(strictTooShort.some((check) => check.code === 'extraction-too-short'));

    const balancedResult = pipeline.createExtractionResult({
        originalContent: '# 章节\n原文内容。',
        extractedMarkdown: '# 章节\n重点内容。',
        sections: [section({ title: '章节' })],
        mode: 'balanced',
        docFingerprint: 'text:test',
        promptVersion: 'doc-extract-v1',
    });
    assert.ok(balancedResult.rationale.includes('提取档位：均衡（目标 6k–8k 字，上限 10k 字）'));

    const strictResult = pipeline.createExtractionResult({
        originalContent: '# 章节\n原文内容。',
        extractedMarkdown: '# 章节\n重点内容。',
        sections: [section({ title: '章节' })],
        mode: 'strict',
        docFingerprint: 'text:test',
        promptVersion: 'doc-extract-v1',
    });
    assert.ok(strictResult.rationale.includes('提取档位：严格（目标 4k–6k 字，上限 8k 字）'));
});

test('提取版规划跳过自动压缩并提示模型不要再次压缩', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(planFixture()) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const longDoc = `# 教师任务文档\n\n${'任务要求与评分说明。'.repeat(1500)}`;
        assert.ok(longDoc.length > 12000);

        const result = await generator.planTrainingScriptModules(
            longDoc,
            { apiKey: 'test-key', baseUrl: 'https://llm.example.com/v1', model: 'gpt-4o' },
            { teacherDocSource: 'extracted' },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].maxTokens, 2200);
        const userMessage = calls[0].messages.find((message) => message.role === 'user').content;
        assert.ok(userMessage.includes('重点提取版'));
        assert.ok(!userMessage.includes('已为规划自动压缩'));
        assert.ok(userMessage.includes(longDoc.slice(-80)));
        assert.equal(result.plan.modules.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('原始长文档规划仍使用自动压缩档位', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(planFixture()) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const longDoc = `# 教师任务文档\n\n${'任务要求与评分说明。'.repeat(1500)}`;
        await generator.planTrainingScriptModules(
            longDoc,
            { apiKey: 'test-key', baseUrl: 'https://llm.example.com/v1', model: 'gpt-4o' },
            { teacherDocSource: 'original' },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].maxTokens, 1800);
        const userMessage = calls[0].messages.find((message) => message.role === 'user').content;
        assert.ok(userMessage.includes('已为规划自动压缩'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});
