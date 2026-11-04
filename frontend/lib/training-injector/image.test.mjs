import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const endpoint = 'https://llm-service-beta.polymas.com/api/openai/v1/images/generations';
const credentials = { authorization: 'Bearer platform-fixture', cookie: 'sid=fixture' };
const params = {
  trainName: '测试训练', trainDescription: '训练描述', stageName: '阶段一', stageDescription: '阶段描述',
  imageModel: 'doubao-seedream-5-0-260128',
  llmApiUrl: endpoint.replace('/images/generations', '/chat/completions'),
  arkApiKey: 'model-fixture',
};

function loadApi(fetch) {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'process', 'console', js)(
    id => {
      assert.equal(id, '../oral-training/vocabulary');
      return {};
    }, module, module.exports, fetch,
    { env: { POLYMAS_IMAGE_FALLBACK_API_KEY: 'model-fixture' } },
    { log() {}, warn() {}, error() {} },
  );
  return module.exports;
}

for (const kind of ['cover', 'background']) {
  test(`${kind}: 平台默认接口超时后继续所选模型`, async () => {
    const calls = [];
    const api = loadApi(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/ai-tools/image/generate')) throw new DOMException('aborted', 'AbortError');
      if (url === endpoint) {
        assert.equal(JSON.parse(init.body).model, params.imageModel);
        return Response.json({ data: [{ url: 'https://files.invalid/new.png' }] });
      }
      if (url === 'https://files.invalid/new.png') return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
      if (url.endsWith('/basic-resource/file/upload')) return Response.json({ code: 200, data: { fileId: 'uploaded', ossUrl: 'https://files.invalid/uploaded.png' } });
      assert.fail(`额外请求: ${url}`);
    });
    const result = await api[kind === 'cover' ? 'generateCourseCoverImageSource' : 'generateBackgroundImage'](params, credentials);
    assert.ok(result?.fileUrl);
    assert.equal(calls[0].url.endsWith('/ai-tools/image/generate'), true);
    assert.equal(calls[1].url, endpoint);
    if (kind === 'background') assert.equal(result.fileId, 'uploaded');
  });
}

test('所选模型失败时返回带模型和 HTTP 状态的错误，不包含密钥', async () => {
  const api = loadApi(async () => Response.json({ error: { message: 'Unknown model' } }, { status: 400 }));
  await assert.rejects(api.generateCourseCoverImageSource({
    ...params, imageProviderPriority: 'openai', throwOnError: true,
  }, credentials), error => {
    assert.match(error.message, /doubao-seedream-5-0-260128/);
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /Unknown model/);
    assert.doesNotMatch(error.message, /model-fixture|platform-fixture|sid=fixture/);
    return true;
  });
});

test('GPT 图片请求省略 Seedream 专属参数', async () => {
  const api = loadApi(async (url, init) => {
    assert.equal(url, endpoint);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'prompt']);
    assert.equal(body.model, 'gpt-image-2');
    assert.equal(typeof body.prompt, 'string');
    return Response.json({ data: [{ url: 'https://files.invalid/gpt.png' }] });
  });
  const result = await api.generateCourseCoverImageSource({ ...params, imageModel: 'gpt-image-2', imageProviderPriority: 'openai' }, credentials);
  assert.equal(result?.fileUrl, 'https://files.invalid/gpt.png');
});

test('网关包裹的供应商错误展示具体原因并隐藏密钥和堆栈地址', async () => {
  const api = loadApi(async () => Response.json({ code: 500, stackTrace: [
    JSON.stringify({ error: { message: 'field messages is required model-fixture' } }),
    '400 Bad Request from POST https://internal.invalid/private-route',
  ] }, { status: 500 }));
  await assert.rejects(api.generateCourseCoverImageSource({
    ...params, imageProviderPriority: 'openai', throwOnError: true,
  }, credentials), error => {
    assert.match(error.message, /field messages is required/);
    assert.doesNotMatch(error.message, /model-fixture|internal.invalid/);
    return true;
  });
});

test('旧调用方保持返回 null 的错误约定', async () => {
  const api = loadApi(async () => { throw new DOMException('aborted', 'AbortError'); });
  assert.equal(await api.generateCourseCoverImageSource(params, credentials), null);
  assert.equal(await api.generateBackgroundImage(params, credentials), null);
});
