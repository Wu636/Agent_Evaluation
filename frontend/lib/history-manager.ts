/**
 * 历史记录管理器
 * 使用 JSON 文件存储评估历史
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

async function getHistoryFilePath(): Promise<string> {
    // In production, use a data directory
    const dataDir = process.env.DATA_DIR || process.cwd();
    return path.join(dataDir, HISTORY_FILE);
}

async function ensureFileExists(): Promise<void> {
    const filePath = await getHistoryFilePath();
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, '[]', 'utf-8');
    }
}

async function readHistory(): Promise<HistoryEntry[]> {
    await ensureFileExists();
    const filePath = await getHistoryFilePath();
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Error reading history:', error);
        return [];
    }
}

async function writeHistory(history: HistoryEntry[]): Promise<void> {
    const filePath = await getHistoryFilePath();
    try {
        await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error writing history:', error);
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
