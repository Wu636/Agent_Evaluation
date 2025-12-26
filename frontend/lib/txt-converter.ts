/**
 * TXT 对话记录转 JSON 格式转换器
 */

export interface DialogueMessage {
    role: 'assistant' | 'user';
    content: string;
    round: number;
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
    let maxRound = 0;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        // 解析元数据字段
        if (line.startsWith('日志创建时间:')) {
            metadata.created_at = line.split(':').slice(1).join(':').trim();
        } else if (line.startsWith('task_id:')) {
            metadata.task_id = line.split(':').slice(1).join(':').trim();
        } else if (line.startsWith('学生档位:')) {
            metadata.student_level = line.split(':').slice(1).join(':').trim();
        }
        // 解析消息块 - 检测时间戳行 [YYYY-MM-DD HH:MM:SS]
        else if (line.startsWith('[') && line.includes(']')) {
            // 提取轮次信息
            const roundMatch = line.match(/第\s*(\d+)\s*轮/);
            if (roundMatch) {
                currentRound = parseInt(roundMatch[1], 10);
                maxRound = Math.max(maxRound, currentRound);
            } else {
                currentRound = 0;
            }

            // 读取后续的消息内容
            i++;
            while (i < lines.length) {
                const msgLine = lines[i];

                // 遇到分隔线或下一个时间戳，结束当前消息块
                if (msgLine.trim().startsWith('---') ||
                    (msgLine.trim().startsWith('[') && msgLine.includes(']'))) {
                    break;
                }

                // 解析 AI 消息
                if (msgLine.startsWith('AI:') || msgLine.startsWith('AI：')) {
                    const content = msgLine.includes(':')
                        ? msgLine.split(':').slice(1).join(':').trim()
                        : msgLine.split('：').slice(1).join('：').trim();

                    const contentLines = [content];
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        if (nextLine.startsWith('用户:') || nextLine.startsWith('用户：') ||
                            nextLine.trim().startsWith('---') ||
                            (nextLine.trim().startsWith('[') && nextLine.includes(']'))) {
                            i--;
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
                            round: currentRound
                        });
                    }
                }
                // 解析用户消息
                else if (msgLine.startsWith('用户:') || msgLine.startsWith('用户：')) {
                    const content = msgLine.includes(':')
                        ? msgLine.split(':').slice(1).join(':').trim()
                        : msgLine.split('：').slice(1).join('：').trim();

                    const contentLines = [content];
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        if (nextLine.startsWith('AI:') || nextLine.startsWith('AI：') ||
                            nextLine.trim().startsWith('---') ||
                            (nextLine.trim().startsWith('[') && nextLine.includes(']'))) {
                            i--;
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
                            round: currentRound
                        });
                    }
                } else {
                    i++;
                    continue;
                }

                i++;
            }
            continue;
        }

        i++;
    }

    metadata.total_rounds = maxRound;

    return {
        metadata,
        stages: [
            {
                stage_name: '对话记录',
                messages
            }
        ]
    };
}
