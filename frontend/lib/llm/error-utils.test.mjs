import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./error-utils.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function('module', 'exports', compiled)(module, module.exports);
const { LlmHttpError, summarizeLlmHttpError } = module.exports;

test('外层500包裹网关503：提取实际服务错误并保留排查用请求ID', () => {
    const raw = JSON.stringify({ code: 500, stackTrace: [
        JSON.stringify({ error: { message: 'Unknown service error', type: 'aigateway_error', requestid: 'fixture-request_123', code: 'unknown_service_err' } }),
        '503 Service Unavailable from POST /upstream',
    ] });
    const error = new LlmHttpError(500, raw);
    assert.equal(error.status, 500);
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, 'fixture-request_123');
    assert.match(error.message, /上游 HTTP 503/);
    assert.doesNotMatch(error.message, /stackTrace|fixture-request|\/upstream/);
});

test('无法完整解析的转义网关堆栈仍识别503，避免原样展示堆栈', () => {
    const raw = '{"stackTrace":["{\\"error\\":{\\"type\\":\\"aigateway_error\\",\\"code\\":\\"unknown_service_err\\"}}","503 Service Unavailable from';
    const message = summarizeLlmHttpError(500, raw);
    assert.match(message, /上游 HTTP 503/);
    assert.doesNotMatch(message, /stackTrace|aigateway_error/);
});

test('网关带有明确参数错误时保留参数名称供修复', () => {
    const message = summarizeLlmHttpError(400, JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }));
    assert.match(message, /max_tokens/);
    assert.match(message, /400/);
});

test('身份验证和模型不存在错误保留原有分类', () => {
    assert.match(summarizeLlmHttpError(401, JSON.stringify({ error: { message: 'invalid api key' } })), /API Key/);
    assert.match(summarizeLlmHttpError(404, JSON.stringify({ error: { code: 'model_not_found' } })), /模型不存在/);
});
