// API 客户端 - 使用相对路径指向 Next.js API Routes

export interface EvaluationReport {
    total_score: number;
    dimensions: Record<string, { score: number; comment: string }>;
    analysis: string;
    issues: string[];
    suggestions: string[];
    final_level?: string;
    pass_criteria_met?: boolean;
    veto_reasons?: string[];
    history_id?: string;
}

export interface HistoryItem {
    id: string;
    timestamp: string;
    total_score: number;
    teacher_doc_name: string;
    dialogue_record_name: string;
    model: string;
    final_level: string;
}

export interface ModelInfo {
    id: string;
    name: string;
    description: string;
}

export interface ApiConfig {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
}

export async function evaluateFiles(
    teacherDoc: File,
    dialogueRecord: File,
    apiConfig: ApiConfig = {}
): Promise<EvaluationReport> {
    const formData = new FormData();
    formData.append('teacher_doc', teacherDoc);
    formData.append('dialogue_record', dialogueRecord);

    // Add optional API configuration
    if (apiConfig.apiKey) formData.append('api_key', apiConfig.apiKey);
    if (apiConfig.apiUrl) formData.append('api_url', apiConfig.apiUrl);
    if (apiConfig.model) formData.append('model', apiConfig.model);

    const response = await fetch('/api/evaluate', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Evaluation failed');
    }

    return response.json();
}

export interface StreamProgress {
    type: 'start' | 'progress' | 'dimension_complete' | 'complete' | 'error';
    dimension?: string;
    current?: number;
    total?: number;
    score?: number;
    report?: EvaluationReport;
    message?: string;
}

export async function evaluateFilesStream(
    teacherDoc: File,
    dialogueRecord: File,
    apiConfig: ApiConfig = {},
    onProgress: (progress: StreamProgress) => void,
    workflowConfig?: File | null // 新增：可选的工作流配置文件
): Promise<EvaluationReport> {
    const formData = new FormData();
    formData.append('teacher_doc', teacherDoc);
    formData.append('dialogue_record', dialogueRecord);

    // 添加工作流配置（如果有）
    if (workflowConfig) {
        formData.append('workflow_config', workflowConfig);
    }

    if (apiConfig.apiKey) formData.append('api_key', apiConfig.apiKey);
    if (apiConfig.apiUrl) formData.append('api_url', apiConfig.apiUrl);
    if (apiConfig.model) formData.append('model', apiConfig.model);

    const response = await fetch('/api/evaluate-stream', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error('Stream evaluation failed');
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
        throw new Error('No response body');
    }

    let finalReport: EvaluationReport | null = null;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    try {
                        const event: StreamProgress = JSON.parse(data);
                        onProgress(event);

                        if (event.type === 'complete' && event.report) {
                            finalReport = event.report;
                        } else if (event.type === 'error') {
                            throw new Error(event.message || 'Evaluation failed');
                        }
                    } catch (e) {
                        console.error('Failed to parse SSE data:', e);
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (!finalReport) {
        throw new Error('No final report received');
    }

    return finalReport;
}

export async function getModels(): Promise<{ models: ModelInfo[] }> {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error('Failed to fetch models');
    return response.json();
}

export async function getHistory(): Promise<{ history: HistoryItem[] }> {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error('Failed to fetch history');
    return response.json();
}

export async function getHistoryById(id: string): Promise<{ report: EvaluationReport }> {
    const response = await fetch(`/api/history/${id}`);
    if (!response.ok) throw new Error('Failed to fetch history item');
    return response.json();
}

export async function deleteHistory(id: string): Promise<void> {
    const response = await fetch(`/api/history/${id}`, {
        method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete history item');
}
