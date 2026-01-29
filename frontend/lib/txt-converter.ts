/**
 * TXT 对话记录转 JSON 格式转换器
 * 支持两种格式：
 * 1. 时间戳格式: [YYYY-MM-DD HH:MM:SS] 第 X 轮 ...
 * 2. Step 格式: Step: 阶段名 | step_id: xxx | 第 X 轮 | 来源: xxx
 */

export interface DialogueMessage {
    role: 'assistant' | 'user';
    content: string;
    round: number;
    stage?: string;
}

export interface DialogueMetadata {
    task_id: string;
    student_level: string;
    created_at: string;
    total_rounds: number;
}

export interface DialogueData {
    metadata: DialogueMetadata;
    stages: Array<{
        stage_name: string;
        messages: DialogueMessage[];
    }>;
}

/**
 * 检测是否为 Step 格式的标题行
 * 例如: "Step: 导入 | step_id: f5BUbUoApqiYoAKVeE7UT | 来源: runCard"
 */
function isStepHeaderLine(line: string): boolean {
    return line.startsWith('Step:') && line.includes('|');
}

/**
 * 从 Step 标题行中提取阶段名和轮次
 */
function parseStepHeader(line: string): { stageName: string; round: number } {
    let stageName = '';
    let round = 0;

    // 提取阶段名: "Step: 导入 | ..."
    const stageMatch = line.match(/^Step:\s*([^|]+)/);
    if (stageMatch) {
        stageName = stageMatch[1].trim();
    }

    // 提取轮次: "... | 第 2 轮 | ..."
    const roundMatch = line.match(/第\s*(\d+)\s*轮/);
    if (roundMatch) {
        round = parseInt(roundMatch[1], 10);
    }

    return { stageName, round };
}

/**
 * 检测是否为分隔线
 */
function isSeparatorLine(line: string): boolean {
    return line.startsWith('---') || line.startsWith('===');
}

/**
 * 解析 TXT 格式的对话记录，转换为 JSON 格式
 */
export function parseTxtDialogue(txtContent: string): DialogueData {
    const lines = txtContent.trim().split('\n');

    const metadata: DialogueMetadata = {
        task_id: '',
        student_level: '',
        created_at: '',
        total_rounds: 0
    };

    const messages: DialogueMessage[] = [];
    let currentRound = 0;
    let currentStage = '';
    let maxRound = 0;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        // 解析元数据字段
        if (line.startsWith('日志创建时间:')) {
            metadata.created_at = line.split(':').slice(1).join(':').trim();
            i++;
            continue;
        }
        if (line.startsWith('task_id:')) {
            metadata.task_id = line.split(':').slice(1).join(':').trim();
            i++;
            continue;
        }
        if (line.startsWith('学生档位:')) {
            metadata.student_level = line.split(':').slice(1).join(':').trim();
            i++;
            continue;
        }

        // 跳过分隔线和空行
        if (isSeparatorLine(line) || line === '') {
            i++;
            continue;
        }

        // 检测 Step 格式的标题行
        if (isStepHeaderLine(line)) {
            const { stageName, round } = parseStepHeader(line);
            currentStage = stageName;
            if (round > 0) {
                currentRound = round;
                maxRound = Math.max(maxRound, currentRound);
            }
            i++;
            continue;
        }

        // 检测旧版时间戳格式: [YYYY-MM-DD HH:MM:SS] 第 X 轮 ...
        if (line.startsWith('[') && line.includes(']')) {
            const roundMatch = line.match(/第\s*(\d+)\s*轮/);
            if (roundMatch) {
                currentRound = parseInt(roundMatch[1], 10);
                maxRound = Math.max(maxRound, currentRound);
            }
            i++;
            continue;
        }

        // 解析 AI 消息
        if (line.startsWith('AI:') || line.startsWith('AI：')) {
            const content = line.includes(':')
                ? line.split(':').slice(1).join(':').trim()
                : line.split('：').slice(1).join('：').trim();

            // 收集多行内容
            const contentLines = [content];
            i++;
            while (i < lines.length) {
                const nextLine = lines[i];
                const trimmedNext = nextLine.trim();

                // 遇到新消息、分隔线或 Step 头，停止
                if (trimmedNext.startsWith('用户:') || trimmedNext.startsWith('用户：') ||
                    trimmedNext.startsWith('AI:') || trimmedNext.startsWith('AI：') ||
                    isSeparatorLine(trimmedNext) ||
                    isStepHeaderLine(trimmedNext) ||
                    (trimmedNext.startsWith('[') && trimmedNext.includes(']'))) {
                    break;
                }
                contentLines.push(nextLine);
                i++;
            }

            const fullContent = contentLines.join('\n').trim();
            if (fullContent) {
                messages.push({
                    role: 'assistant',
                    content: fullContent,
                    round: currentRound || 1,
                    stage: currentStage || undefined
                });
            }
            continue;
        }

        // 解析用户消息
        if (line.startsWith('用户:') || line.startsWith('用户：')) {
            const content = line.includes(':')
                ? line.split(':').slice(1).join(':').trim()
                : line.split('：').slice(1).join('：').trim();

            // 收集多行内容
            const contentLines = [content];
            i++;
            while (i < lines.length) {
                const nextLine = lines[i];
                const trimmedNext = nextLine.trim();

                // 遇到新消息、分隔线或 Step 头，停止
                if (trimmedNext.startsWith('用户:') || trimmedNext.startsWith('用户：') ||
                    trimmedNext.startsWith('AI:') || trimmedNext.startsWith('AI：') ||
                    isSeparatorLine(trimmedNext) ||
                    isStepHeaderLine(trimmedNext) ||
                    (trimmedNext.startsWith('[') && trimmedNext.includes(']'))) {
                    break;
                }
                contentLines.push(nextLine);
                i++;
            }

            const fullContent = contentLines.join('\n').trim();
            if (fullContent) {
                messages.push({
                    role: 'user',
                    content: fullContent,
                    round: currentRound || 1,
                    stage: currentStage || undefined
                });
            }
            continue;
        }

        // 其他行跳过
        i++;
    }

    metadata.total_rounds = maxRound || 1;

    // 按阶段分组消息（如果有阶段信息）
    const stageMap = new Map<string, DialogueMessage[]>();
    for (const msg of messages) {
        const stageName = msg.stage || '对话记录';
        if (!stageMap.has(stageName)) {
            stageMap.set(stageName, []);
        }
        stageMap.get(stageName)!.push(msg);
    }

    // 如果只有一个阶段，使用简化的结构
    const stages = Array.from(stageMap.entries()).map(([stageName, msgs]) => ({
        stage_name: stageName,
        messages: msgs
    }));

    return {
        metadata,
        stages: stages.length > 0 ? stages : [{ stage_name: '对话记录', messages: [] }]
    };
}
