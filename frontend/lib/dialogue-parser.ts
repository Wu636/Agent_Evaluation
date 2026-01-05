/**
 * 对话记录解析器
 * 解析包含 Step 信息的对话记录
 */

import { DialogueData } from "./llm/types";

/**
 * 解析对话记录文本，提取环节和对话信息
 */
export function parseDialogueRecord(content: string): DialogueData {
    const lines = content.split("\n");

    // 提取元数据
    const metadata: DialogueData["metadata"] = {
        task_id: "",
        total_rounds: 0,
    };

    for (const line of lines) {
        if (line.includes("task_id:")) {
            metadata.task_id = line.split("task_id:")[1].trim();
        }
        if (line.includes("学生档位:")) {
            metadata.student_level = line.split("学生档位:")[1].trim();
        }
        if (line.includes("日志创建时间:")) {
            metadata.created_at = line.split("日志创建时间:")[1].trim();
        }
    }

    // 解析对话记录，按环节分组
    const stagesMap = new Map<string, any>();
    let currentStageName = "";
    let currentRound = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 匹配对话记录行：[时间] Step: 环节名 | step_id: xxx | ...
        const stepMatch = line.match(/\[[\d\-\s:]+\]\s*Step:\s*([^|]+)\|/);
        if (stepMatch) {
            currentStageName = stepMatch[1].trim();

            // 提取轮数
            const roundMatch = line.match(/第\s*(\d+)\s*轮/);
            if (roundMatch) {
                currentRound = parseInt(roundMatch[1]);
            }

            // 跳过第一条（runCard）不计入轮数
            if (!line.includes("runCard")) {
                metadata.total_rounds = Math.max(
                    metadata.total_rounds,
                    currentRound
                );
            }

            // 初始化环节
            if (!stagesMap.has(currentStageName)) {
                stagesMap.set(currentStageName, {
                    stage_name: currentStageName,
                    messages: [],
                });
            }

            // 提取AI/用户的对话内容
            const nextLine = lines[i + 1];
            if (nextLine) {
                if (nextLine.startsWith("AI:")) {
                    stagesMap.get(currentStageName).messages.push({
                        role: "assistant",
                        content: nextLine.replace(/^AI:\s*/, "").trim(),
                        round: currentRound || 0,
                    });
                } else if (nextLine.startsWith("用户:")) {
                    stagesMap.get(currentStageName).messages.push({
                        role: "user",
                        content: nextLine.replace(/^用户:\s*/, "").trim(),
                        round: currentRound,
                    });
                }
            }
        }
    }

    return {
        metadata,
        stages: Array.from(stagesMap.values()),
    };
}

/**
 * 按环节名称查找对话
 */
export function findStageDialogue(
    dialogueData: DialogueData,
    stageName: string
): DialogueData["stages"][0] | null {
    // 精确匹配
    let found = dialogueData.stages.find((s) => s.stage_name === stageName);
    if (found) return found;

    // 模糊匹配
    found = dialogueData.stages.find((s) => s.stage_name.includes(stageName));
    if (found) return found;

    // 反向模糊匹配
    found = dialogueData.stages.find((s) => stageName.includes(s.stage_name));

    return found || null;
}
