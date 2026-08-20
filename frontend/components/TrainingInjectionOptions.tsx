"use client";

export type TrainingInjectionMode = "replace" | "append";

export function TrainingInjectionOptions({
  injectScript,
  injectRubric,
  injectMode,
  hasScript = true,
  hasRubric = true,
  disabled = false,
  modeAppliesToAllSelected = false,
  onInjectScriptChange,
  onInjectRubricChange,
  onInjectModeChange,
}: {
  injectScript: boolean;
  injectRubric: boolean;
  injectMode: TrainingInjectionMode;
  hasScript?: boolean;
  hasRubric?: boolean;
  disabled?: boolean;
  modeAppliesToAllSelected?: boolean;
  onInjectScriptChange: (value: boolean) => void;
  onInjectRubricChange: (value: boolean) => void;
  onInjectModeChange: (value: TrainingInjectionMode) => void;
}) {
  const showMode = modeAppliesToAllSelected
    ? injectScript || injectRubric
    : injectScript;
  return (
    <div className="grid grid-cols-1 gap-6 border-t border-slate-100 pt-2 md:grid-cols-2">
      <div className="space-y-3">
        <label className="block text-xs font-medium text-slate-700">
          注入内容
        </label>
        <label
          className={`flex items-center gap-2 rounded-lg border p-2 transition-colors ${!hasScript || disabled ? "cursor-not-allowed bg-slate-50 opacity-50" : "cursor-pointer hover:bg-slate-50"}`}
        >
          <input
            type="checkbox"
            checked={injectScript}
            onChange={(event) => onInjectScriptChange(event.target.checked)}
            disabled={!hasScript || disabled}
            className="rounded text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-slate-700">
            训练剧本配置节点
          </span>
          {!hasScript && (
            <span className="ml-auto text-xs text-slate-400">未生成</span>
          )}
        </label>
        <label
          className={`flex items-center gap-2 rounded-lg border p-2 transition-colors ${!hasRubric || disabled ? "cursor-not-allowed bg-slate-50 opacity-50" : "cursor-pointer hover:bg-slate-50"}`}
        >
          <input
            type="checkbox"
            checked={injectRubric}
            onChange={(event) => onInjectRubricChange(event.target.checked)}
            disabled={!hasRubric || disabled}
            className="rounded text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-slate-700">
            任务评分标准
          </span>
          {!hasRubric && (
            <span className="ml-auto text-xs text-slate-400">未生成</span>
          )}
        </label>
      </div>

      {showMode && (
        <div className="space-y-3">
          <label className="block text-xs font-medium text-slate-700">
            {modeAppliesToAllSelected ? "注入模式" : "节点注入模式"}
          </label>
          <div className="flex flex-col gap-2">
            <label
              className={`rounded-lg border p-2 transition-colors ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${injectMode === "replace" ? "border-indigo-500 bg-indigo-50/50" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <div className="mb-1 flex items-center gap-2">
                <input
                  type="radio"
                  checked={injectMode === "replace"}
                  onChange={() => onInjectModeChange("replace")}
                  disabled={disabled}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm font-medium text-slate-800">
                  全部清除后重建（推荐）
                </span>
              </div>
              <p className="pl-6 text-xs text-slate-500">
                {modeAppliesToAllSelected
                  ? "只清除本次勾选的目标内容，然后写入优化结果。"
                  : "将会删除目标任务中所有旧的剧本节点和连线，然后完整创建新的流程。"}
              </p>
            </label>
            <label
              className={`rounded-lg border p-2 transition-colors ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${injectMode === "append" ? "border-indigo-500 bg-indigo-50/50" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <div className="mb-1 flex items-center gap-2">
                <input
                  type="radio"
                  checked={injectMode === "append"}
                  onChange={() => onInjectModeChange("append")}
                  disabled={disabled}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm font-medium text-slate-800">
                  在现有内容后追加
                </span>
              </div>
              <p className="pl-6 text-xs text-slate-500">
                {modeAppliesToAllSelected
                  ? "保留目标训练的现有节点、连线和评分项，再追加勾选内容。"
                  : "保留原有的节点，只新增节点，请稍后手动调整连线。"}
              </p>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
