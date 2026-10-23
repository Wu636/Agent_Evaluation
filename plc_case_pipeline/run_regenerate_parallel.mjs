const target = process.argv[2];
const concurrency = Math.max(1, Math.min(8, Number(process.argv[3] || 4)));
if (!target) throw new Error("usage: run_regenerate_parallel.mjs TARGET_URL [CONCURRENCY]");
const authorization = process.env.PLC_AUTHORIZATION || "";
const cookie = process.env.PLC_COOKIE || "";
if (!authorization || !cookie) throw new Error("missing PLC credentials in environment");

const targetUrl = new URL(target);
const trainTaskId = targetUrl.searchParams.get("trainTaskId");
if (!trainTaskId) throw new Error("target URL missing trainTaskId");
const apiHeaders = {
  "Content-Type": "application/json;charset=utf-8",
  Authorization: authorization,
  Cookie: cookie,
};
const nodesResponse = await fetch("https://cloudapi.polymas.com/teacher-course/abilityTrain/queryScriptStepList", {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ trainTaskId, trainSubType: "ability" }),
});
const nodesJson = await nodesResponse.json();
if (!(nodesJson.code === 200 || nodesJson.success === true)) throw new Error(`queryScriptStepList failed: ${nodesJson.msg || nodesJson.message || nodesJson.code}`);
const allNodes = (Array.isArray(nodesJson.data) ? nodesJson.data : []).filter((node) => node.stepDetailDTO?.nodeType === "SCRIPT_NODE");
const pending = allNodes.filter((node) => {
  const detail = node.stepDetailDTO || {};
  return !String(detail.backgroundTheme || "").trim() && !String(detail.scriptStepCover?.fileId || "").trim();
});
console.error(`stages=${allNodes.length} pending=${pending.length} concurrency=${concurrency}`);

const results = [];
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= pending.length) return;
    const node = pending[index];
    const detail = node.stepDetailDTO || {};
    const snapshot = {
      stepName: detail.stepName || "",
      description: detail.description || "",
      prologue: detail.prologue || "",
      modelId: detail.modelId || "",
      llmPrompt: detail.llmPrompt || "",
      trainerName: detail.trainerName || "",
      interactiveRounds: Number(detail.interactiveRounds) || 0,
      agentId: detail.agentId || "",
      agentVoiceId: detail.agentVoiceId || "",
      avatarNid: detail.avatarNid || "",
      customDigitalHuman: detail.customDigitalHuman || "",
      knowledgeBaseId: detail.knowledgeBaseId || "",
      knowledgeBaseSwitch: detail.knowledgeBaseSwitch,
      searchEngineSwitch: detail.searchEngineSwitch,
      position: {
        x: Number(node.positionDTO?.x) || 100,
        y: Number(node.positionDTO?.y) || 300,
      },
    };
    try {
      const response = await fetch("http://localhost:3000/api/training-inject/regenerate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trainTaskId: target,
          credentials: { authorization, cookie },
          targetType: "background",
          stepId: node.stepId,
          stepSnapshot: snapshot,
          trainTaskName: "PLC能力训练",
          trainDescription: "可编程序控制器原理及应用实训",
          backgroundStylePrompt: "专业写实的工业自动化与PLC实训场景，适合作为阶段卡片背景，16:9横版，无文字、无水印、无拼贴",
        }),
      });
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { raw: raw.slice(0, 300) }; }
      const ok = response.ok && parsed?.success === true;
      results[index] = { index, stepId: node.stepId, stageName: detail.stepName || "", ok, status: response.status, error: ok ? undefined : parsed?.error || parsed?.message || parsed?.raw };
      console.error(`[${index + 1}/${pending.length}] ${ok ? "OK" : "FAIL"} ${detail.stepName || node.stepId}`);
    } catch (error) {
      results[index] = { index, stepId: node.stepId, stageName: detail.stepName || "", ok: false, error: String(error) };
      console.error(`[${index + 1}/${pending.length}] FAIL ${detail.stepName || node.stepId}: ${error}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
const failed = results.filter((item) => !item?.ok);
console.log(JSON.stringify({ trainTaskId, totalStages: allNodes.length, pending: pending.length, success: pending.length - failed.length, failed }, null, 2));
