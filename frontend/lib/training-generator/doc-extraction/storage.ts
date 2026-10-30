import type { DocExtractionResult, ExtractionMode } from "./types";

const DB_VERSION = 1;
const STORE_NAME = "results";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredExtraction {
    fingerprint: string;
    result: DocExtractionResult;
    updatedAt: number;
}

function hashText(value: string): string {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}

function openDb(databaseName: string): Promise<IDBDatabase | null> {
    if (typeof window === "undefined" || typeof indexedDB === "undefined") {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const request = indexedDB.open(databaseName, DB_VERSION);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
}

export function buildExtractionCacheKey(params: {
    fingerprint: string;
    mode: ExtractionMode;
    promptVersion: string;
    feedback?: string;
    model?: string;
}): string {
    return [
        params.fingerprint,
        params.mode,
        params.promptVersion,
        hashText(params.feedback || ""),
        params.model || "default",
    ].join("::");
}

export async function readDocExtraction(databaseName: string, key: string): Promise<DocExtractionResult | null> {
    const db = await openDb(databaseName);
    if (!db) return null;

    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
                const record = request.result as StoredExtraction | undefined;
                if (!record?.result || Date.now() - (record.updatedAt || 0) > MAX_AGE_MS) {
                    resolve(null);
                    return;
                }
                resolve(record.result);
            };
        } catch {
            resolve(null);
        }
    });
}

export async function writeDocExtraction(databaseName: string, key: string, result: DocExtractionResult): Promise<void> {
    const db = await openDb(databaseName);
    if (!db) return;

    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.put({ fingerprint: result.docFingerprint, result, updatedAt: Date.now() } satisfies StoredExtraction, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

export async function pruneDocExtractions(databaseName: string, fingerprint: string, keep = 5): Promise<void> {
    const db = await openDb(databaseName);
    if (!db) return;

    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const request = store.openCursor();
            const entries: Array<{ key: IDBValidKey; record: StoredExtraction }> = [];

            request.onerror = () => resolve();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    entries.push({ key: cursor.key, record: cursor.value as StoredExtraction });
                    cursor.continue();
                    return;
                }
                entries
                    .filter(({ record }) => record.result?.docFingerprint === fingerprint)
                    .sort((a, b) => (b.record.updatedAt || 0) - (a.record.updatedAt || 0))
                    .slice(keep)
                    .forEach(({ key }) => store.delete(key));
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            };
        } catch {
            resolve();
        }
    });
}
