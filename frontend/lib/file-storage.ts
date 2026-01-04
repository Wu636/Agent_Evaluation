/**
 * 文件持久化存储服务
 * 使用 IndexedDB 存储用户上传的文件，支持跨视图持久化
 */

const DB_NAME = 'llm-eval-files';
const DB_VERSION = 1;
const STORE_NAME = 'uploaded-files';

interface StoredFile {
    id: string;
    name: string;
    type: string;
    content: ArrayBuffer;
    lastModified: number;
}

let db: IDBDatabase | null = null;

/**
 * 初始化数据库
 */
async function initDB(): Promise<IDBDatabase> {
    if (db) return db;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = (event.target as IDBOpenDBRequest).result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

/**
 * 保存文件到 IndexedDB
 */
export async function saveFile(id: string, file: File): Promise<void> {
    const database = await initDB();
    const arrayBuffer = await file.arrayBuffer();

    const storedFile: StoredFile = {
        id,
        name: file.name,
        type: file.type,
        content: arrayBuffer,
        lastModified: file.lastModified,
    };

    return new Promise((resolve, reject) => {
        const transaction = database.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(storedFile);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
    });
}

/**
 * 从 IndexedDB 读取文件
 */
export async function loadFile(id: string): Promise<File | null> {
    try {
        const database = await initDB();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const storedFile = request.result as StoredFile | undefined;
                if (storedFile) {
                    const file = new File(
                        [storedFile.content],
                        storedFile.name,
                        {
                            type: storedFile.type,
                            lastModified: storedFile.lastModified,
                        }
                    );
                    resolve(file);
                } else {
                    resolve(null);
                }
            };
        });
    } catch (error) {
        console.error('加载文件失败:', error);
        return null;
    }
}

/**
 * 删除存储的文件
 */
export async function deleteFile(id: string): Promise<void> {
    try {
        const database = await initDB();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    } catch (error) {
        console.error('删除文件失败:', error);
    }
}

/**
 * 清空所有存储的文件
 */
export async function clearAllFiles(): Promise<void> {
    try {
        const database = await initDB();

        return new Promise((resolve, reject) => {
            const transaction = database.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    } catch (error) {
        console.error('清空文件失败:', error);
    }
}

// 文件 ID 常量
export const TEACHER_DOC_ID = 'teacher_doc';
export const DIALOGUE_RECORD_ID = 'dialogue_record';
