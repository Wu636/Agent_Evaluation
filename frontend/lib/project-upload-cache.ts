import { PROJECT_PUBLISH_RULE_VERSION, sha256File } from "./project-publish-preflight.ts";

export interface CachedUpload {
  key: string;
  ossUrl: string;
  fileId: string;
  path: string;
  uploadedAt: number;
}

const DATABASE_NAME = "polymas-project-publish";
const STORE_NAME = "uploads";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("上传缓存数据库被其他标签页占用。"));
  });
}

export async function projectUploadKey(file: File, contentHash?: string): Promise<string> {
  // Filename and MIME type affect the response headers chosen by the platform.
  return `${PROJECT_PUBLISH_RULE_VERSION}:${file.name}:${file.type}:${contentHash || await sha256File(file)}`;
}

export async function findCachedProjectUpload(key: string): Promise<CachedUpload | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const database = await openDatabase();
    return await new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as CachedUpload | undefined) || null);
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => database.close();
      transaction.onabort = transaction.onerror = () => { database.close(); resolve(null); };
    });
  } catch {
    return null;
  }
}

export async function rememberProjectUpload(key: string, path: string, ossUrl: string, fileId = ""): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, ossUrl, fileId, path, uploadedAt: Date.now() } satisfies CachedUpload);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = transaction.onerror = () => { database.close(); reject(transaction.error); };
    });
    return true;
  } catch {
    // Private browsing may deny storage. Uploading still works without reuse.
    return false;
  }
}

export async function forgetCachedProjectUpload(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = transaction.onerror = () => { database.close(); resolve(); };
    });
  } catch {
    // A failed eviction can be retried on the next run.
  }
}

export type UploadUrlState = "valid" | "invalid" | "unavailable";

/** 每次平台接收成功即保存；网络验证暂不可用时保留记录，防止重复上传。 */
export async function reuseOrUploadProjectFile(options: {
  file: File;
  path: string;
  sourceHash?: string;
  verify: (url: string) => Promise<UploadUrlState>;
  upload: () => Promise<{ ossUrl: string; fileId?: string }>;
  cache?: {
    find: typeof findCachedProjectUpload;
    remember: typeof rememberProjectUpload;
    forget: typeof forgetCachedProjectUpload;
  };
}): Promise<{ ossUrl: string; reused: boolean; persisted: boolean }> {
  const cache = options.cache || { find: findCachedProjectUpload, remember: rememberProjectUpload, forget: forgetCachedProjectUpload };
  const key = await projectUploadKey(options.file, options.sourceHash);
  const cached = await cache.find(key);
  if (cached) {
    const state = await options.verify(cached.ossUrl);
    if (state === "valid") return { ossUrl: cached.ossUrl, reused: true, persisted: true };
    if (state === "unavailable") throw new Error(`暂时无法验证已上传资源：${options.path}。记录已保留，请稍后重试，不会立即重复上传。`);
    await cache.forget(key);
  }
  const data = await options.upload();
  const persisted = await cache.remember(key, options.path, data.ossUrl, data.fileId);
  if (await options.verify(data.ossUrl) !== "valid") {
    throw new Error(`资源已上传但公网地址未通过验证：${options.path}。${persisted ? "上传记录已保存，重试时会先验证并复用。" : "浏览器无法保存上传记录，重试可能重新上传。"}`);
  }
  return { ossUrl: data.ossUrl, reused: false, persisted };
}
