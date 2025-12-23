export async function evaluateFiles(teacherDoc, dialogueRecord, apiConfig = {}) {
    const formData = new FormData();
    formData.append('teacher_doc', teacherDoc);
    formData.append('dialogue_record', dialogueRecord);

    // Add optional API configuration
    if (apiConfig.apiKey) formData.append('api_key', apiConfig.apiKey);
    if (apiConfig.apiUrl) formData.append('api_url', apiConfig.apiUrl);
    if (apiConfig.model) formData.append('model', apiConfig.model);

    const response = await fetch('http://127.0.0.1:8001/api/evaluate', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Evaluation failed');
    }

    return response.json();
}

export async function getModels() {
    const response = await fetch('http://127.0.0.1:8001/api/models');
    if (!response.ok) throw new Error('Failed to fetch models');
    return response.json();
}

export async function getHistory() {
    const response = await fetch('http://127.0.0.1:8001/api/history');
    if (!response.ok) throw new Error('Failed to fetch history');
    return response.json();
}

export async function getHistoryById(id) {
    const response = await fetch(`http://127.0.0.1:8001/api/history/${id}`);
    if (!response.ok) throw new Error('Failed to fetch history item');
    return response.json();
}

export async function deleteHistory(id) {
    const response = await fetch(`http://127.0.0.1:8001/api/history/${id}`, {
        method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete history item');
    return response.json();
}
