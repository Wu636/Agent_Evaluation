/**
 * 客户端历史记录管理器
 * 使用 localStorage 存储评估历史（适用于 Vercel serverless 环境）
 */

import { EvaluationReport } from './api';

const HISTORY_KEY = 'llm-eval-history';
const MAX_HISTORY_ITEMS = 50;

export interface HistoryEntry {
    id: string;
    timestamp: string;
    teacher_doc_name: string;
    dialogue_record_name: string;
    model: string;
    total_score: number;
    final_level: string;
    report: EvaluationReport;
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

/**
 * 生成唯一 ID
 */
function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * 从 localStorage 读取历史记录
 */
function readHistory(): HistoryEntry[] {
    if (typeof window === 'undefined') return [];

    try {
        const data = localStorage.getItem(HISTORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error('读取历史记录失败:', error);
        return [];
    }
}

/**
 * 写入历史记录到 localStorage
 */
function writeHistory(history: HistoryEntry[]): void {
    if (typeof window === 'undefined') return;

    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
        console.error('保存历史记录失败:', error);
    }
}

/**
 * 保存评估到历史记录
 */
export function saveToHistory(
    report: EvaluationReport,
    teacherDocName: string,
    dialogueRecordName: string,
    model: string = 'gpt-4o'
): string {
    const history = readHistory();

    const evalId = generateId();

    const entry: HistoryEntry = {
        id: evalId,
        timestamp: new Date().toISOString(),
        teacher_doc_name: teacherDocName,
        dialogue_record_name: dialogueRecordName,
        model,
        total_score: report.total_score || 0,
        final_level: report.final_level || '',
        report
    };

    // 添加到列表开头
    history.unshift(entry);

    // 限制数量
    if (history.length > MAX_HISTORY_ITEMS) {
        history.length = MAX_HISTORY_ITEMS;
    }

    writeHistory(history);
    return evalId;
}

/**
 * 获取所有历史记录摘要
 */
export function getHistoryList(): HistorySummary[] {
    const history = readHistory();
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
export function getHistoryItem(evalId: string): HistoryEntry | null {
    const history = readHistory();
    return history.find(entry => entry.id === evalId) || null;
}

/**
 * 删除指定 ID 的评估
 */
export function deleteHistoryItem(evalId: string): boolean {
    const history = readHistory();
    const originalLength = history.length;
    const filtered = history.filter(entry => entry.id !== evalId);

    if (filtered.length < originalLength) {
        writeHistory(filtered);
        return true;
    }
    return false;
}

/**
 * 清空所有历史记录
 */
export function clearHistory(): void {
    writeHistory([]);
}
