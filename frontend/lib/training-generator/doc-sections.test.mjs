import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';

const frontend = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const nativeRequire = createRequire(import.meta.url);

function sourceLoader() {
    const cache = new Map();
    function load(relative) {
        const filename = resolve(frontend, relative);
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const require = (id) => {
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
const sections = load('lib/training-generator/doc-sections.ts');

function filler(chars = 1200) {
    return '任务流程说明与角色要求。'.repeat(Math.ceil(chars / 12)).slice(0, chars);
}

test('剥离 Markdown 标题形式的评分标准章节及其子章节', () => {
    const doc = [
        '# 任务要求',
        filler(1400),
        '# 评分标准',
        '| 评分项 | 分值 |',
        '| 病史采集 | 20 |',
        '## 评分细则',
        '每个评分区间必须描述清楚。',
        '# 附件',
        filler(1000),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 1);
    assert.equal(result.removedSections[0].title, '评分标准');
    assert.ok(result.removedChars > 0);
    assert.ok(!result.content.includes('病史采集'));
    assert.ok(!result.content.includes('评分区间'));
    assert.ok(result.content.includes('# 任务要求'));
    assert.ok(result.content.includes('# 附件'));
});

test('剥离中文编号标题形式的评分标准章节', () => {
    const doc = [
        '一、任务要求',
        filler(1200),
        '八、评分标准（100分）',
        '病史采集 20 分，沟通表达 10 分。',
        '九、附录',
        filler(900),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 1);
    assert.ok(result.removedSections[0].title.includes('评分标准'));
    assert.ok(!result.content.includes('病史采集 20 分'));
    assert.ok(result.content.includes('九、附录'));
});

test('混合标题不整段删除，仅删除其下独立评分子章节', () => {
    const doc = [
        '二、任务要求与评分标准',
        filler(1400),
        '（一）评分标准',
        '总分 100 分，包含 5 个评分项。',
        '三、附件',
        filler(900),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 1);
    assert.ok(result.removedSections[0].title.includes('评分标准'));
    assert.ok(result.content.includes('二、任务要求与评分标准'));
    assert.ok(!result.content.includes('总分 100 分'));
    assert.ok(result.content.includes('三、附件'));
});

test('多个评分标准章节全部剥离', () => {
    const doc = [
        '# 任务目标',
        filler(1000),
        '# 评分标准',
        '评分项一 20 分。',
        '# 任务流程',
        filler(1000),
        '# 评价标准',
        '评分项二 30 分。',
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 2);
    assert.ok(!result.content.includes('评分项一'));
    assert.ok(!result.content.includes('评分项二'));
    assert.ok(result.content.includes('# 任务流程'));
});

test('无标题或仅引用评分标准时不裁剪', () => {
    const plain = '评分标准：见附件。\n'.repeat(100);
    assert.deepEqual(sections.stripRubricSections(plain).removedSections, []);

    const referenced = [
        '评分标准：见附件。',
        filler(2000),
    ].join('\n');
    assert.deepEqual(sections.stripRubricSections(referenced).removedSections, []);
});

test('识别过度导致剩余正文过少时保持原文', () => {
    const doc = [
        '# 评分标准',
        '评分项一 20 分。',
        '## 任务要求',
        filler(600),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 0);
    assert.equal(result.content, doc);
});

test('保留文档开头内容并收敛多余空行', () => {
    const doc = [
        '本训练面向护理专业学生。',
        '',
        '# 任务流程',
        filler(1200),
        '',
        '',
        '# 评分标准',
        '评分项一 20 分。',
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.ok(result.content.startsWith('本训练面向护理专业学生。'));
    assert.ok(!result.content.includes('评分项一'));
    assert.ok(!/\n{3,}/.test(result.content));
});

test('评分体系标题连同其下 9.x 子标题与长段说明一并剥离', () => {
    const doc = [
        '# 乳腺癌术后护理教学智能体设计',
        filler(1200),
        '九、评分体系：六维雷达图',
        '9.1 为什么最终落到雷达图',
        '前期设计的三个评价落点——当场反馈、课后作业、出科谈话——都是过程性的：它们发生在对话里、发生在当下，老师说完就过去了。',
        '9.2 六维雷达图怎么打分',
        '每个维度按 0-5 分打分，临床思维权重最高。'.repeat(30),
        '9.3 评分校准',
        '同一份对话由两位老师独立打分，分差超过 1 分需要重新校准。'.repeat(20),
        '十、训练实施',
        filler(900),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 1);
    assert.ok(result.removedSections[0].title.includes('评分体系'));
    assert.ok(!result.content.includes('9.1 为什么最终落到雷达图'));
    assert.ok(!result.content.includes('临床思维权重最高'));
    assert.ok(!result.content.includes('评分校准'));
    assert.ok(result.content.includes('十、训练实施'));
    assert.ok(result.content.includes('乳腺癌术后护理教学智能体设计'));
});

test('考核方式、评分内容等扩展标题可识别，混合任务标题仍跳过', () => {
    const doc = [
        '一、任务要求',
        filler(1200),
        '九、考核方式',
        '采用过程性评价与终结性评价结合的方式。'.repeat(10),
        '十、附录',
        filler(900),
    ].join('\n');

    const result = sections.stripRubricSections(doc);
    assert.equal(result.removedSections.length, 1);
    assert.ok(result.removedSections[0].title.includes('考核方式'));
    assert.ok(!result.content.includes('过程性评价与终结性评价'));

    const mixed = [
        '二、任务要求与评分内容',
        filler(1400),
        '三、附件',
        filler(900),
    ].join('\n');
    assert.deepEqual(sections.stripRubricSections(mixed).removedSections, []);
});
