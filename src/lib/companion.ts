import {
  getSetting,
  listMistakes,
  type Mistake,
  putMistake,
  removeMistake,
  setSetting,
} from './db';

export type CompanionStatus = {
  ok: boolean;
  connected: boolean;
  auth: { connected: boolean; label: string };
  dataRoot: string;
  libraryRoot: string;
  libraryCount: number;
  oneDrive: boolean;
};

export type CompanionPdf = { name: string; path: string; size: number };

export type CodexAnalysis = {
  analysis: string;
  noteToAppend: string;
  suggestedReason?: string;
};

export type CodexSummary = {
  overview: string;
  patterns: string[];
  priorities: string[];
  reviewPlan: string[];
  checklist: string[];
};

type SerializedMistake = Omit<Mistake, 'image'> & { imageDataUrl: string };
type DeletedMistakes = Record<string, string>;
type SyncSnapshot = {
  format: '408-mistake-book-sync';
  updatedAt: string;
  mistakes: SerializedMistake[];
  deletedIds: DeletedMistakes;
};

const DELETED_KEY = '408-deleted-mistakes';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4184';

export const companionOrigin = window.location.hostname === '127.0.0.1' && window.location.port === '4184'
  ? ''
  : LOOPBACK_ORIGIN;

function companionUrl(path: string) {
  return `${companionOrigin}/api${path}`;
}

async function fetchJson<T>(path: string, options: RequestInit = {}, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(companionUrl(path), {
      ...options,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((payload as { error?: string }).error || `本地助手请求失败：${response.status}`);
    return payload as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata, payload] = dataUrl.split(',', 2);
  if (!metadata?.startsWith('data:image/') || !payload) throw new Error('同步图片格式无效');
  const mime = metadata.match(/^data:([^;]+)/)?.[1] || 'image/png';
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

function timestampOf(mistake: Pick<Mistake, 'createdAt' | 'updatedAt'>) {
  return mistake.updatedAt || mistake.createdAt;
}

export async function getCompanionStatus(): Promise<CompanionStatus> {
  return fetchJson<CompanionStatus>('/status', {}, 3500);
}

export async function getCompanionLibrary(): Promise<CompanionPdf[]> {
  const payload = await fetchJson<{ items: CompanionPdf[] }>('/library', {}, 10000);
  return payload.items;
}

export async function fetchCompanionPdf(path: string, signal?: AbortSignal): Promise<File> {
  const response = await fetch(`${companionUrl('/pdf')}?path=${encodeURIComponent(path)}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`本机 PDF 读取失败：${response.status}`);
  const blob = await response.blob();
  return new File([blob], path.split('/').pop() || 'section.pdf', { type: 'application/pdf' });
}

async function makeSnapshot(): Promise<SyncSnapshot> {
  const mistakes = await listMistakes();
  const records = await Promise.all(mistakes.map(async ({ image, ...mistake }) => ({
    ...mistake,
    updatedAt: mistake.updatedAt || mistake.createdAt,
    imageDataUrl: await blobToDataUrl(image),
  })));
  return {
    format: '408-mistake-book-sync',
    updatedAt: new Date().toISOString(),
    mistakes: records,
    deletedIds: await getSetting<DeletedMistakes>(DELETED_KEY) || {},
  };
}

async function applySnapshot(snapshot: SyncSnapshot): Promise<Mistake[]> {
  const current = await listMistakes();
  const currentMap = new Map(current.map((mistake) => [mistake.id, mistake]));
  const localDeleted = await getSetting<DeletedMistakes>(DELETED_KEY) || {};
  const deletedIds = { ...localDeleted, ...(snapshot.deletedIds || {}) };

  for (const [id, deletedAt] of Object.entries(deletedIds)) {
    const existing = currentMap.get(id);
    if (existing && deletedAt >= timestampOf(existing)) {
      await removeMistake(id);
      currentMap.delete(id);
    }
  }

  for (const record of snapshot.mistakes || []) {
    const { imageDataUrl, ...metadata } = record;
    const deletedAt = deletedIds[record.id];
    if (deletedAt && deletedAt >= timestampOf(record)) continue;
    const existing = currentMap.get(record.id);
    if (!existing || timestampOf(record) >= timestampOf(existing)) {
      const mistake = { ...metadata, image: dataUrlToBlob(imageDataUrl) } as Mistake;
      await putMistake(mistake);
      currentMap.set(mistake.id, mistake);
    }
  }

  await setSetting(DELETED_KEY, deletedIds);
  return listMistakes();
}

export async function syncMistakesWithCompanion(): Promise<Mistake[]> {
  const snapshot = await makeSnapshot();
  const merged = await fetchJson<SyncSnapshot>('/sync', {
    method: 'POST',
    body: JSON.stringify(snapshot),
  }, 45000);
  return applySnapshot(merged);
}

export async function saveMistakeSynced(mistake: Mistake): Promise<Mistake> {
  const updated = { ...mistake, updatedAt: new Date().toISOString() };
  const deleted = await getSetting<DeletedMistakes>(DELETED_KEY) || {};
  if (deleted[updated.id]) {
    delete deleted[updated.id];
    await setSetting(DELETED_KEY, deleted);
  }
  await putMistake(updated);
  try { await syncMistakesWithCompanion(); } catch { /* Local-only fallback stays usable. */ }
  return updated;
}

export async function deleteMistakeSynced(id: string): Promise<void> {
  await removeMistake(id);
  const deleted = await getSetting<DeletedMistakes>(DELETED_KEY) || {};
  deleted[id] = new Date().toISOString();
  await setSetting(DELETED_KEY, deleted);
  try { await syncMistakesWithCompanion(); } catch { /* Tombstone syncs next time. */ }
}

export async function analyzeMistakeWithCodex(mistake: Mistake): Promise<CodexAnalysis> {
  return fetchJson<CodexAnalysis>('/analyze', {
    method: 'POST',
    body: JSON.stringify({
      mistake: {
        id: mistake.id,
        subject: mistake.subject,
        chapter: mistake.chapter,
        section: mistake.section,
        page: mistake.page,
        questionNo: mistake.questionNo,
        reason: mistake.reason,
        note: mistake.note,
      },
      imageDataUrl: await blobToDataUrl(mistake.image),
    }),
  }, 12 * 60 * 1000);
}

export async function summarizeMistakesWithCodex(
  scope: { subject: string; chapter: string; section?: string; label: string },
  mistakes: Mistake[],
): Promise<CodexSummary> {
  return fetchJson<CodexSummary>('/summarize', {
    method: 'POST',
    body: JSON.stringify({
      scope,
      mistakes: mistakes.map((mistake) => ({
        id: mistake.id,
        subject: mistake.subject,
        chapter: mistake.chapter,
        section: mistake.section,
        page: mistake.page,
        questionNo: mistake.questionNo,
        reason: mistake.reason,
        note: mistake.note,
        mastered: mistake.mastered,
      })),
    }),
  }, 12 * 60 * 1000);
}
