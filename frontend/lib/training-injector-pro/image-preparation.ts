import { prepareImages, type ImagePreparationJob, type PreparedImage } from '../training-injector/image-preparation';

export interface ProImageParams {
  trainName: string; trainDescription: string; stageName: string; stageDescription: string;
}
export type ProImageStrategy = 'preserve' | 'missing' | 'regenerate';
export interface ProImagePlan {
  strategy?: ProImageStrategy;
  retained?: ReadonlyMap<string, string>;
  global: { abilityName: string; description?: string; coverImageDescription?: string };
  stages: Array<{ cardName: string; backgroundImageDescription?: string }>;
  options: {
    injectCoverImage: boolean; injectBackgroundImage: boolean;
    coverStylePrompt: string; backgroundStylePrompt: string;
    imageProviderMode: string; imageModel: string;
  };
}
/** Pure plan: no requests, credentials or node writes. IDs stay stable within the parsed stage order. */
export function buildProImageJobs(plan: ProImagePlan, generate: (params: ProImageParams) => Promise<PreparedImage | null>): ImagePreparationJob[] {
  const { global, stages, options } = plan;
  const jobs: ImagePreparationJob[] = [];
  const add = (id: string, stageName: string, stageDescription: string) => {
    if (plan.strategy === 'preserve' || (plan.strategy === 'missing' && plan.retained?.has(id))) return;
    const params = { trainName: global.abilityName, trainDescription: global.description || global.abilityName, stageName, stageDescription };
    jobs.push({ id, fingerprint: { schema: 'pro-images-v1', params, provider: options.imageProviderMode, model: options.imageModel, size: '2560x1440' }, generate: () => generate(params) });
  };
  if (options.injectCoverImage && global.coverImageDescription) add('cover', `${global.abilityName} 课程封面`, `${global.coverImageDescription}\n封面风格要求：${options.coverStylePrompt}`);
  if (options.injectBackgroundImage) stages.forEach((stage, index) => {
    if (stage.backgroundImageDescription) add(`background:${index}`, stage.cardName, `${stage.backgroundImageDescription}\n背景风格要求：${options.backgroundStylePrompt}`);
  });
  return jobs;
}
/** Read only the Pro DTO fields used by this route. Unknown list payloads fail before fresh deletion.
 * Existing platform references are rebound directly, never inserted into generated-image cache.
 */
export function retainedProImages(task: Record<string, unknown>, existing: unknown[], stages: ProImagePlan['stages']): Map<string, string> {
  const retained = new Map<string, string>();
  const url = (value: unknown, label: string): string | null => {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) throw new Error(`无法安全保留${label}：仅支持平台已知HTTP(S)字符串引用`);
    return value;
  };
  if (!Object.hasOwn(task, 'trainTaskCover')) throw new Error('无法安全保留封面：任务详情缺少 trainTaskCover');
  const cover = url(task.trainTaskCover, '封面');
  if (cover) retained.set('cover', cover);
  const names = new Set<string>();
  for (const stage of stages) {
    if (!stage.cardName || names.has(stage.cardName)) throw new Error('保留素材要求目标阶段名称非空且唯一');
    names.add(stage.cardName);
  }
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of existing) {
    if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).stepName !== 'string') throw new Error('阶段列表缺少完整stepName，不能安全恢复背景');
    const row = item as Record<string, unknown>;
    const name = row.stepName as string;
    if (byName.has(name)) throw new Error('现有阶段同名，不能安全匹配背景');
    byName.set(name, row);
  }
  stages.forEach((stage, index) => {
    const row = byName.get(stage.cardName);
    if (!row) return; // newly named stage has no existing image
    if (!row.extConfig || typeof row.extConfig !== 'object' || !Object.hasOwn(row.extConfig, 'bgMedia')) throw new Error('阶段列表缺少extConfig.bgMedia，不能判断图片是否缺失');
    const ext = row.extConfig as Record<string, unknown>;
    const background = url(ext.bgMedia, '背景');
    if (background && Number(ext.bgMediaType) !== 1) throw new Error('现有背景不是可确认的图片类型，不转换媒体');
    if (background) retained.set(`background:${index}`, background);
  });
  return retained;
}
export function prepareProImages(plan: ProImagePlan, generate: (params: ProImageParams) => Promise<PreparedImage | null>, options: Parameters<typeof prepareImages>[1]) {
  return prepareImages(buildProImageJobs(plan, generate), options);
}
