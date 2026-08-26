export type Mistake = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  subject: string;
  subjectCode: string;
  chapter: string;
  section: string;
  version: string;
  pdfName: string;
  pdfPath: string;
  page: number;
  questionNo: string;
  reason: string;
  note: string;
  mastered: boolean;
  image: Blob;
};

const DB_NAME = '408-mistake-book';
const DB_VERSION = 1;
const MISTAKES = 'mistakes';
const SETTINGS = 'settings';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MISTAKES)) {
        const store = db.createObjectStore(MISTAKES, { keyPath: 'id' });
        store.createIndex('subjectCode', 'subjectCode');
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listMistakes(): Promise<Mistake[]> {
  const db = await openDb();
  const transaction = db.transaction(MISTAKES, 'readonly');
  const result = await requestResult(transaction.objectStore(MISTAKES).getAll());
  db.close();
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putMistake(mistake: Mistake): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(MISTAKES, 'readwrite');
  await requestResult(transaction.objectStore(MISTAKES).put(mistake));
  db.close();
}

export async function removeMistake(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(MISTAKES, 'readwrite');
  await requestResult(transaction.objectStore(MISTAKES).delete(id));
  db.close();
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, 'readwrite');
  await requestResult(transaction.objectStore(SETTINGS).put({ key, value }));
  db.close();
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const transaction = db.transaction(SETTINGS, 'readonly');
  const record = await requestResult<{ key: string; value: T } | undefined>(
    transaction.objectStore(SETTINGS).get(key),
  );
  db.close();
  return record?.value;
}
