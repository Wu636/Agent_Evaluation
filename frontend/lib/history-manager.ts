/**
 * 历史记录管理器
 * 使用 JSON 文件存储评估历史
 * 支持 Vercel serverless 环境（只读文件系统）
 */

import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface HistoryEntry {
    id: string;
    timestamp: string;
    teacher_doc_name: string;
    dialogue_record_name: string;
    model: string;
    total_score: number;
    final_level: string;
    report: Record<string, unknown>;
}

export interface HistorySummary {
    id: string;
    timestamp: string;
    teacher_doc_name: string;
    dialogue_record_name: string;
    model: string;
    total_score: number;
    final_level: string;
}

const HISTORY_FILE = process.env.HISTORY_FILE || 'evaluations_history.json';

// 检测是否在 Vercel 环境中
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

// 内存缓存作为后备（Vercel 函数实例可能会被复用）
let memoryCache: HistoryEntry[] = [];

async function getHistoryFilePath(): Promise<string> {
    // 在 Vercel 环境中，只有 /tmp 目录可写
    if (isVercel) {
        return path.join('/tmp', HISTORY_FILE);
    }
    // 本地开发或其他环境使用 DATA_DIR 或当前目录
    const dataDir = process.env.DATA_DIR || process.cwd();
    return path.join(dataDir, HISTORY_FILE);
}

async function ensureFileExists(): Promise<void> {
    const filePath = await getHistoryFilePath();
    try {
        await fs.access(filePath);
    } catch {
        try {
            await fs.writeFile(filePath, '[]', 'utf-8');
        } catch (writeError) {
            // 在 Vercel 中可能会失败，使用内存缓存
            console.warn('无法创建历史文件，将使用内存缓存:', writeError);
        }
    }
}

async function readHistory(): Promise<HistoryEntry[]> {
    const filePath = await getHistoryFilePath();
    try {
        await ensureFileExists();
        const content = await fs.readFile(filePath, 'utf-8');
        const history = JSON.parse(content);
        // 同步到内存缓存
        memoryCache = history;
        return history;
    } catch (error) {
        console.warn('读取历史文件失败，使用内存缓存:', error);
        // 返回内存缓存
        return memoryCache;
    }
}

async function writeHistory(history: HistoryEntry[]): Promise<void> {
    // 始终更新内存缓存
    memoryCache = history;

    const filePath = await getHistoryFilePath();
    try {
        await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
    } catch (error) {
        console.warn('写入历史文件失败，数据已保存到内存缓存:', error);
        // 在 Vercel 中写入可能失败，但数据已在内存缓存中
        // 注意：内存缓存在函数冷启动后会丢失
    }
}


/**
 * 保存评估到历史记录
 */
export async function saveEvaluation(
    report: Record<string, unknown>,
    teacherDocName: string,
    dialogueRecordName: string,
    model: string = 'gpt-4o'
): Promise<string> {
    const history = await readHistory();

    const evalId = uuidv4();

    const entry: HistoryEntry = {
        id: evalId,
        timestamp: new Date().toISOString(),
        teacher_doc_name: teacherDocName,
        dialogue_record_name: dialogueRecordName,
        model,
        total_score: (report.total_score as number) || 0,
        final_level: (report.final_level as string) || '',
        report
    };

    // 添加到列表开头（最新的在前）
    history.unshift(entry);

    // 限制历史记录数量
    if (history.length > 100) {
        history.length = 100;
    }

    await writeHistory(history);
    return evalId;
}

/**
 * 获取所有历史记录摘要
 */
export async function getAllHistory(): Promise<HistorySummary[]> {
    const history = await readHistory();
    return history.map(entry => ({
        id: entry.id,
        timestamp: entry.timestamp,
        teacher_doc_name: entry.teacher_doc_name,
        dialogue_record_name: entry.dialogue_record_name,
        model: entry.model,
        total_score: entry.total_score,
        final_level: entry.final_level
    }));
}

/**
 * 根据 ID 获取特定评估
 */
export async function getHistoryById(evalId: string): Promise<HistoryEntry | null> {
    const history = await readHistory();
    return history.find(entry => entry.id === evalId) || null;
}

/**
 * 删除指定 ID 的评估
 */
export async function deleteHistoryById(evalId: string): Promise<boolean> {
    const history = await readHistory();
    const originalLength = history.length;
    const filtered = history.filter(entry => entry.id !== evalId);

    if (filtered.length < originalLength) {
        await writeHistory(filtered);
        return true;
    }
    return false;
}
