interface StageSection {
    heading: string;
    markdown: string;
}

interface ParsedStage {
    stepName?: string;
    llmPrompt?: string;
    flowCondition?: string;
}

function hasStageEnd(markdown: string, stageNumber: number): boolean {
    return new RegExp(`^<!--\\s*STAGE_END\\s*:?\\s*${stageNumber}\\s*-->\\s*$`, "im").test(markdown);
}

export function findIncompleteTrainingScriptStageIndex(
    stages: StageSection[],
    parsedSteps: ParsedStage[],
    expectedStageCount: number,
    hasCompleteMarker: boolean,
): number {
    const incompleteIndex = stages.findIndex((stage, index) => {
        const stageNumber = Number.parseInt(
            stage.heading.match(/^#{3,}\s*阶段\s*(\d+)(?:\b|[：:])/i)?.[1] || "",
            10,
        );
        const step = parsedSteps[index];
        const promptLastLine = String(step?.llmPrompt || "").trim().split("\n").at(-1)?.trim() || "";
        const promptEndsMidSentence = index === stages.length - 1 &&
            stages.length >= expectedStageCount &&
            /(?:[，,：:、（(]|不|未|应|需|并|及|或|与|和|而|但|且|将|对|在|由|为|以|按|如|若|当|则|的)$/.test(promptLastLine);
        const hasStageStart = /^<!--\s*STAGE_START\s*:?\s*\d+\s*-->\s*$/im.test(stage.markdown);

        return stageNumber !== index + 1 ||
            !step ||
            !String(step.stepName || "").trim() ||
            !String(step.llmPrompt || "").trim() ||
            !String(step.flowCondition || "").trim() ||
            (hasStageStart && !hasStageEnd(stage.markdown, index + 1)) ||
            promptEndsMidSentence;
    });
    if (incompleteIndex >= 0) return incompleteIndex;

    // Legacy output has no stage boundaries. Until the document ends, the final
    // stage may be a fragment even when its mandatory fields have some text.
    if (stages.length > 0 && stages.length >= expectedStageCount && !hasCompleteMarker &&
        !hasStageEnd(stages[stages.length - 1].markdown, stages.length)) {
        return stages.length - 1;
    }
    return -1;
}
