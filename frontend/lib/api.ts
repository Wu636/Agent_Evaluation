const API_BASE_URL = 'http://127.0.0.1:8000';

export interface EvaluationReport {
    total_score: number;
    dimensions: Record<string, { score: number; comment: string }>;
    analysis: string;
    issues: string[];
    suggestions: string[];
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

    const response = await fetch(`${API_BASE_URL}/api/evaluate`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Evaluation failed');
    }

    return response.json();
}

export async function getModels(): Promise<{ models: ModelInfo[] }> {
    const response = await fetch(`${API_BASE_URL}/api/models`);
    if (!response.ok) throw new Error('Failed to fetch models');
    return response.json();
}

export async function getHistory(): Promise<{ history: HistoryItem[] }> {
    const response = await fetch(`${API_BASE_URL}/api/history`);
    if (!response.ok) throw new Error('Failed to fetch history');
    return response.json();
}

export async function getHistoryById(id: string): Promise<{ report: EvaluationReport }> {
    const response = await fetch(`${API_BASE_URL}/api/history/${id}`);
    if (!response.ok) throw new Error('Failed to fetch history item');
    return response.json();
}

export async function deleteHistory(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api/history/${id}`, {
        method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete history item');
}
