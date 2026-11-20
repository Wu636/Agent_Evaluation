import { NextRequest, NextResponse } from 'next/server';
import { queryScriptSteps, queryScriptFlows, editScriptStepDetailDTO, editScriptFlowDTO } from '@/lib/training-injector/api';
import type { PolymasCredentials } from '@/lib/training-injector/types';
import { applyIncremental, assertSnapshot, fingerprint, planIncremental, resourcePreservingDetail, restoreResources, normalizeControlTokens } from '@/lib/training-injector/incremental';
import type { IncrementalSnapshot } from '@/lib/training-injector/incremental';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action = 'plan', baseSnapshot, desiredSnapshot, trainTaskId, type, courseId, libraryFolderId, credentials } = body as {
      action?: string; baseSnapshot: IncrementalSnapshot; desiredSnapshot: IncrementalSnapshot;
      trainTaskId: string; type: 'ability'|'oral'; courseId?: string; libraryFolderId?: string; credentials: PolymasCredentials;
    };
    if (!['plan','snapshot','preflight','apply','restore-resources','normalize-control-tokens'].includes(action)) throw new Error('未知action');
    // Pure local plan path: neither credentials nor a platform request is needed.
    if (action === 'plan') {
      const plan = planIncremental(baseSnapshot, desiredSnapshot);
      return NextResponse.json({ success: true, mode: 'plan', atomic: false, ...plan, changes: plan.changes.map(({stepId,stepName,fields}) => ({stepId,stepName,fields})) });
    }
    if (!trainTaskId || !['ability','oral'].includes(type) || !credentials?.cookie || !credentials?.authorization) throw new Error('缺少明确目标/类型/凭据');
    const creds = { ...credentials, trainSubType: type };
    const read = async () => {
      const [steps, flows] = await Promise.all([queryScriptSteps(trainTaskId, creds), queryScriptFlows(trainTaskId, creds)]);
      const result = { trainTaskId, type, steps, flows } as unknown as IncrementalSnapshot;
      assertSnapshot(result); return result;
    };
    if (action === 'snapshot') {
      const snapshot = await read();
      return NextResponse.json({ success: true, snapshot, fingerprint: fingerprint(snapshot) });
    }
    if (action === 'normalize-control-tokens') {
      if (body.confirmNormalizeControlTokens !== true || typeof body.expectedFingerprint !== 'string') throw new Error('连线控制词修复需要明确授权和完整快照指纹');
      if (baseSnapshot?.trainTaskId !== trainTaskId || baseSnapshot?.type !== type) throw new Error('请求目标与快照不一致');
      const result = await normalizeControlTokens(baseSnapshot, body.expectedFingerprint, {
        read, editFlow: flow => editScriptFlowDTO(trainTaskId, flow, creds),
      });
      return NextResponse.json(result, { status: result.success ? 200 : 409 });
    }
    if (action === 'restore-resources') {
      const { originalSnapshot, stepId, expectedFingerprint } = body;
      if (body.confirmRestoreResources !== true || !courseId || !libraryFolderId || typeof stepId !== 'string' || typeof expectedFingerprint !== 'string') throw new Error('阶段资源恢复需要当前明确授权、目标和完整快照指纹');
      if (baseSnapshot?.trainTaskId !== trainTaskId || originalSnapshot?.trainTaskId !== trainTaskId || baseSnapshot?.type !== type || originalSnapshot?.type !== type) throw new Error('请求目标与快照不一致');
      const result = await restoreResources(baseSnapshot, originalSnapshot, stepId, expectedFingerprint, {
        read,
        edit: step => editScriptStepDetailDTO(trainTaskId, step.stepId, step.stepDetailDTO, courseId, libraryFolderId, step.positionDTO, creds),
      });
      return NextResponse.json(result, { status: result.success ? 200 : 409 });
    }
    if (baseSnapshot?.trainTaskId !== trainTaskId || desiredSnapshot?.trainTaskId !== trainTaskId || baseSnapshot?.type !== type || desiredSnapshot?.type !== type) throw new Error('请求目标与快照不一致');
    if (action === 'apply' && (body.confirmApply !== true || !courseId || !libraryFolderId)) throw new Error('apply需要当前明确授权confirmApply与目标courseId/libraryFolderId');
    // Validate every outgoing resource contract before the first platform mutation.
    const mutationDetails = new Map(planIncremental(baseSnapshot, desiredSnapshot).changes.map(change => {
      const detail = resourcePreservingDetail(change.step.stepDetailDTO);
      // Write-only discriminator: the read DTO omits this field. Never add it to
      // the expected read snapshot or weaken the full readback comparison.
      if (change.fields.some(field => ['scriptStepCover', 'backgroundTheme', 'stepExtProperty.backgroundTheme', 'stepExtProperty.bgMediaType'].includes(field))) detail.scriptBackgroundType = 'image';
      return [change.stepId, detail] as const;
    }));
    const result = await applyIncremental(baseSnapshot, desiredSnapshot, {
      read,
      edit: step => editScriptStepDetailDTO(trainTaskId, step.stepId, mutationDetails.get(step.stepId)!, courseId!, libraryFolderId!, step.positionDTO, creds),
    }, action === 'apply', { allowResourceBindingIdRefresh: body.allowResourceBindingIdRefresh === true });
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch (error) {
    // Do not echo credential-bearing payloads or transport exceptions.
    const text = error instanceof Error ? error.message : '增量更新失败';
    const known = /CONFLICT|快照|节点|阶段|目标|文本|拓扑|连线|apply需要|action|缺少明确|平台在基线/.test(text);
    return NextResponse.json({ success: false, error: known ? text : '增量更新失败；结果不确定时请回查，禁止自动fresh或重试', atomic: false }, { status: text.startsWith('CONFLICT') ? 409 : 400 });
  }
}
