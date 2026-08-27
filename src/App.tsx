import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  getSetting,
  listMistakes,
  type Mistake,
  setSetting,
} from './lib/db';
import {
  analyzeMistakeWithCodex,
  type CodexAnalysis,
  type CodexSummary,
  type CompanionStatus,
  deleteMistakeSynced,
  fetchCompanionPdf,
  getCompanionLibrary,
  getCompanionStatus,
  saveMistakeSynced,
  summarizeMistakesWithCodex,
  syncMistakesWithCompanion,
} from './lib/companion';

type LocalFileHandle = {
  kind: 'file';
  name: string;
  getFile: (signal?: AbortSignal) => Promise<File>;
  clearCache?: () => void;
};

type LocalDirectoryHandle = {
  kind: 'directory';
  name: string;
  entries: () => AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]>;
  queryPermission?: (options: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
};

type BrowserFile = File & { webkitRelativePath?: string };

type GitHubContentItem = {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
  download_url?: string | null;
};

type PdfEntry = {
  id: string;
  name: string;
  path: string;
  subject: string;
  subjectCode: string;
  chapter: string;
  section: string;
  version: string;
  handle: LocalFileHandle;
};

type Rect = { x: number; y: number; width: number; height: number };
type QuestionRegion = Rect & { index: number };
type View = 'reader' | 'mistakes';
type SiteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};
type MistakeBookBridge = {
  getCurrent: () => Record<string, unknown>;
  list: (query: string) => Record<string, unknown>;
  open: (id: string) => Record<string, unknown>;
  update: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const SUBJECTS = [
  { code: 'DS', name: '数据结构', tone: 'green' },
  { code: 'CO', name: '计算机组成原理', tone: 'orange' },
  { code: 'OS', name: '操作系统', tone: 'blue' },
  { code: 'CN', name: '计算机网络', tone: 'violet' },
];

const REASONS = ['概念不清', '计算错误', '审题失误', '知识遗忘', '方法不熟', '其他'];
const GITHUB_OWNER = 'hwww1';
const GITHUB_REPO = '408-pdf-library';
const GITHUB_BRANCH = 'main';
const GITHUB_TOKEN_KEY = '408-private-repo-token';
const SELECTED_PDF_KEY = '408-selected-pdf';
const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=408%20PDF%20Library&description=Read-only%20access%20for%20408%20mistake%20book&target_name=hwww1&expires_in=45&contents=read';
const REMOTE_PDF_CACHE_LIMIT = 3;
const remotePdfCache = new Map<string, Promise<File>>();

function parsePdf(parts: string[], handle: LocalFileHandle): PdfEntry {
  const subjectFolder = parts[0] || '';
  const chapterFolder = parts[1] || '';
  const sectionFolder = parts[2] || '';
  const subjectMatch = subjectFolder.match(/^\d+_([A-Z]+)_(.+)$/);
  const chapterMatch = chapterFolder.match(/^第(\d+)章_(.+)$/);
  const sectionMatch = sectionFolder.match(/^(\d+\.\d+)_(.+)$/);
  const subjectCode = subjectMatch?.[1] || 'OT';
  const subject = subjectMatch?.[2] || subjectFolder || '其他';
  const chapter = chapterMatch ? `第${Number(chapterMatch[1])}章 ${chapterMatch[2]}` : chapterFolder || '未分类章节';
  const section = sectionMatch ? `${sectionMatch[1]} ${sectionMatch[2]}` : sectionFolder || '未分类小节';
  const version = handle.name.includes('PAD版') ? 'PAD版' : handle.name.includes('做题版') ? '做题版' : 'PDF';
  return {
    id: parts.join('/'),
    name: handle.name,
    path: parts.join('/'),
    subject,
    subjectCode,
    chapter,
    section,
    version,
    handle,
  };
}

function parseFlatPdf(fileName: string, relativePath: string, handle: LocalFileHandle, identity: string): PdfEntry {
  const baseName = fileName.replace(/\.pdf$/i, '');
  const matchedSubject = SUBJECTS.find((subject) => baseName.startsWith(subject.name));
  const sectionMatch = baseName.match(/(?:^|_)(\d+)\.(\d+)_([^_]+)/);
  const sectionNumber = sectionMatch ? `${sectionMatch[1]}.${sectionMatch[2]}` : '未分类';
  const sectionTitle = sectionMatch?.[3] || '未分类小节';
  const version = fileName.includes('PAD版') ? 'PAD版' : fileName.includes('做题版') ? '做题版' : 'PDF';

  return {
    id: identity,
    name: fileName,
    path: relativePath,
    subject: matchedSubject?.name || '其他',
    subjectCode: matchedSubject?.code || 'OT',
    chapter: sectionMatch ? `第${Number(sectionMatch[1])}章` : '未分类章节',
    section: `${sectionNumber} ${sectionTitle}`,
    version,
    handle,
  };
}

function parseUploadedPdf(file: BrowserFile): PdfEntry {
  const relativePath = file.webkitRelativePath || file.name;
  let parts = relativePath.split(/[\\/]/).filter(Boolean);
  const subjectFolderIndex = parts.findIndex((part) => /^\d+_[A-Z]+_/.test(part));
  if (subjectFolderIndex > 0) parts = parts.slice(subjectFolderIndex);

  const handle: LocalFileHandle = {
    kind: 'file',
    name: file.name,
    getFile: async () => file,
  };

  if (parts.length >= 4 && /^\d+_[A-Z]+_/.test(parts[0])) {
    return parsePdf(parts, handle);
  }

  return parseFlatPdf(file.name, relativePath, handle, `${relativePath}:${file.size}:${file.lastModified}`);
}

function githubHeaders(token: string, raw = false): Record<string, string> {
  return {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function parseGitHubPdf(item: GitHubContentItem, token: string): PdfEntry {
  const blobUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${item.sha}`;
  const handle: LocalFileHandle = {
    kind: 'file',
    name: item.name,
    clearCache: () => { remotePdfCache.delete(item.sha); },
    getFile: async (signal) => {
      const existing = remotePdfCache.get(item.sha);
      if (existing) {
        remotePdfCache.delete(item.sha);
        remotePdfCache.set(item.sha, existing);
        return existing;
      }
      const pending = (async () => {
        const response = await fetch(blobUrl, { cache: 'no-store', headers: githubHeaders(token), signal });
        if (!response.ok) throw new Error(`GitHub PDF blob failed: ${response.status}`);
        const payload = await response.json() as { content?: string; encoding?: string; size?: number };
        if (payload.encoding !== 'base64' || !payload.content) throw new Error('GitHub PDF blob format is invalid');
        const binary = atob(payload.content.replace(/\s/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        if (item.size && bytes.length !== item.size) throw new Error(`GitHub PDF incomplete: ${bytes.length}/${item.size}`);
        return new File([bytes], item.name, { type: 'application/pdf' });
      })();
      remotePdfCache.set(item.sha, pending);
      while (remotePdfCache.size > REMOTE_PDF_CACHE_LIMIT) {
        const oldestKey = remotePdfCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        remotePdfCache.delete(oldestKey);
      }
      try {
        return await pending;
      } catch (error) {
        if (remotePdfCache.get(item.sha) === pending) remotePdfCache.delete(item.sha);
        throw error;
      }
    },
  };
  return parseFlatPdf(item.name, item.path, handle, `github:${item.sha}`);
}

async function scanFolder(root: LocalDirectoryHandle): Promise<PdfEntry[]> {
  const found: PdfEntry[] = [];
  async function walk(directory: LocalDirectoryHandle, parts: string[]) {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') {
        await walk(handle, [...parts, name]);
      } else if (name.toLowerCase().endsWith('.pdf')) {
        found.push(parsePdf([...parts, name], handle));
      }
    }
  }
  await walk(root, []);
  return found.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
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
  if (!dataUrl.startsWith('data:image/')) throw new Error('备份中的图片格式不正确');
  const [metadata, payload] = dataUrl.split(',', 2);
  if (!metadata || !payload) throw new Error('备份中的图片不完整');
  const mime = metadata.match(/^data:([^;]+)/)?.[1] || 'image/png';
  const bytes = metadata.includes(';base64')
    ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return new Blob([bytes], { type: mime });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character] || character);
}

function displayQuestionNo(value: string) {
  if (!value) return '未填写题号';
  return value.includes('本页第') ? value : `第 ${value} 题`;
}

function questionSequence(mistake: Mistake) {
  const pageQuestion = mistake.questionNo.match(/本页第\s*(\d+)/)?.[1];
  const plainQuestion = mistake.questionNo.match(/\d+/)?.[0];
  const autoIndex = mistake.id.match(/:(\d+)$/)?.[1];
  return Number(pageQuestion || plainQuestion || autoIndex || Number.MAX_SAFE_INTEGER);
}

function compareMistakes(a: Mistake, b: Mistake) {
  const subjectA = SUBJECTS.findIndex((subject) => subject.code === a.subjectCode);
  const subjectB = SUBJECTS.findIndex((subject) => subject.code === b.subjectCode);
  const subjectOrder = (subjectA < 0 ? 99 : subjectA) - (subjectB < 0 ? 99 : subjectB);
  if (subjectOrder) return subjectOrder;
  const chapterOrder = a.chapter.localeCompare(b.chapter, 'zh-CN', { numeric: true, sensitivity: 'base' });
  if (chapterOrder) return chapterOrder;
  const sectionOrder = a.section.localeCompare(b.section, 'zh-CN', { numeric: true, sensitivity: 'base' });
  if (sectionOrder) return sectionOrder;
  if (a.page !== b.page) return a.page - b.page;
  const questionOrder = questionSequence(a) - questionSequence(b);
  if (questionOrder) return questionOrder;
  return a.createdAt.localeCompare(b.createdAt);
}

function detectQuestionRegions(canvas: HTMLCanvasElement): QuestionRegion[] {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || !canvas.width || !canvas.height) return [];
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  const isDark = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return pixels[offset] < 170 && pixels[offset + 1] < 170 && pixels[offset + 2] < 170;
  };

  const xScanStart = Math.floor(width * 0.06);
  const xScanEnd = Math.floor(width * 0.34);
  const yScanStart = Math.floor(height * 0.07);
  const yScanEnd = Math.floor(height * 0.92);
  const rawLines: Array<[number, number]> = [];
  let lineStart = -1;
  for (let y = yScanStart; y < yScanEnd; y += 1) {
    let ink = 0;
    for (let x = xScanStart; x < xScanEnd; x += 1) {
      if (isDark(x, y) && ++ink > 2) break;
    }
    if (ink > 2 && lineStart < 0) lineStart = y;
    if (ink <= 2 && lineStart >= 0) {
      if (y - lineStart > 2) rawLines.push([lineStart, y - 1]);
      lineStart = -1;
    }
  }

  // Keep wrapped question text as separate lines at PDF.js' lower browser
  // resolution; otherwise a two-line stem can make its leading number look
  // too short and get skipped.
  const mergeGap = Math.max(3, Math.round(height * 0.003));
  const lines: Array<[number, number]> = [];
  rawLines.forEach(([start, end]) => {
    const previous = lines[lines.length - 1];
    if (previous && start - previous[1] <= mergeGap) previous[1] = end;
    else lines.push([start, end]);
  });

  type Component = { minX: number; maxX: number; minY: number; maxY: number; area: number };
  function componentsIn(startY: number, endY: number, startX: number, endX: number): Component[] {
    const cropWidth = Math.max(0, endX - startX + 1);
    const cropHeight = Math.max(0, endY - startY + 1);
    const seen = new Uint8Array(cropWidth * cropHeight);
    const components: Component[] = [];
    const stack: number[] = [];

    for (let localY = 0; localY < cropHeight; localY += 1) {
      for (let localX = 0; localX < cropWidth; localX += 1) {
        const seed = localY * cropWidth + localX;
        if (seen[seed] || !isDark(startX + localX, startY + localY)) continue;
        seen[seed] = 1;
        stack.push(seed);
        let minX = localX; let maxX = localX; let minY = localY; let maxY = localY; let area = 0;
        while (stack.length) {
          const current = stack.pop() as number;
          const currentY = Math.floor(current / cropWidth);
          const currentX = current % cropWidth;
          area += 1;
          minX = Math.min(minX, currentX); maxX = Math.max(maxX, currentX);
          minY = Math.min(minY, currentY); maxY = Math.max(maxY, currentY);
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nextX = currentX + dx; const nextY = currentY + dy;
              if (nextX < 0 || nextY < 0 || nextX >= cropWidth || nextY >= cropHeight) continue;
              const next = nextY * cropWidth + nextX;
              if (!seen[next] && isDark(startX + nextX, startY + nextY)) {
                seen[next] = 1;
                stack.push(next);
              }
            }
          }
        }
        if (area >= 2) components.push({ minX: minX + startX, maxX: maxX + startX, minY: minY + startY, maxY: maxY + startY, area });
      }
    }
    return components.sort((a, b) => a.minX - b.minX);
  }

  const starts: number[] = [];
  let pendingKnowledgeHeading: number | null = null;
  let lastContentEnd = yScanStart;
  lines.forEach(([start, end]) => {
    lastContentEnd = Math.max(lastContentEnd, end);
    let left = xScanEnd;
    for (let y = start; y <= end; y += 1) {
      for (let x = xScanStart; x < xScanEnd; x += 1) {
        if (isDark(x, y)) { left = Math.min(left, x); break; }
      }
    }
    if (left > width * 0.096) return;

    const components = componentsIn(start, end, left, Math.min(width - 1, left + Math.round(width * 0.065)))
      .reduce<Component[]>((merged, component) => {
        const previous = merged[merged.length - 1];
        if (previous && component.minX <= previous.maxX) {
          previous.minX = Math.min(previous.minX, component.minX);
          previous.maxX = Math.max(previous.maxX, component.maxX);
          previous.minY = Math.min(previous.minY, component.minY);
          previous.maxY = Math.max(previous.maxY, component.maxY);
          previous.area += component.area;
        } else merged.push({ ...component });
        return merged;
      }, []);
    const lineHeight = end - start + 1;
    const isSmallDot = (component: Component) => {
      const componentHeight = component.maxY - component.minY + 1;
      const componentWidth = component.maxX - component.minX + 1;
      return componentHeight <= Math.max(6, lineHeight * 0.42) && componentWidth <= Math.max(5, width * 0.005);
    };
    const isTall = (component: Component) => component.maxY - component.minY + 1 >= lineHeight * 0.5;

    const isKnowledgeHeading = components.length >= 5
      && isTall(components[0]) && isSmallDot(components[1])
      && isTall(components[2]) && isSmallDot(components[3])
      && isTall(components[4])
      && components[1].minX - components[0].maxX >= 2
      && components[2].minX - components[1].maxX >= 2
      && components[3].minX - components[2].maxX >= 2
      && components[4].minX - components[3].maxX >= 2;
    const minimumTextGap = Math.max(6, Math.round(width * 0.006));
    const firstDotIndex = components.findIndex(isSmallDot);
    const dot = components[firstDotIndex];
    const nextAfterDot = components[firstDotIndex + 1];
    const hasQuestionDot = firstDotIndex > 0
      && components.slice(0, firstDotIndex).every(isTall)
      && Boolean(nextAfterDot)
      && nextAfterDot.minX - dot.maxX - 1 >= minimumTextGap;
    // A printed full stop can shrink to a single antialiased pixel. In that
    // case, the large gap between the leading digit and the stem is the more
    // reliable signal.
    const nextAfterLeadingDigit = components[1];
    const hasFaintQuestionDot = components.length > 1
      && isTall(components[0])
      && nextAfterLeadingDigit.minX - components[0].maxX - 1 >= Math.max(9, Math.round(width * 0.01));
    const isQuestionStart = hasQuestionDot || hasFaintQuestionDot;

    if (isKnowledgeHeading && !isQuestionStart) pendingKnowledgeHeading = start;
    if (isQuestionStart) {
      const regionStart = pendingKnowledgeHeading !== null ? pendingKnowledgeHeading : start;
      const minimumQuestionGap = Math.max(lineHeight * 1.5, height * 0.045);
      if (!starts.length || regionStart - starts[starts.length - 1] > minimumQuestionGap) starts.push(regionStart);
      pendingKnowledgeHeading = null;
    }
  });

  const padding = Math.max(8, Math.round(height * 0.008));
  return starts.map((start, index) => {
    const nextStart = starts[index + 1] ?? Math.min(yScanEnd, lastContentEnd + padding * 2);
    const top = Math.max(yScanStart, start - padding);
    const bottom = Math.max(top + 30, nextStart - Math.floor(padding / 2));
    return {
      index,
      x: Math.floor(width * 0.065),
      y: top,
      width: Math.floor(width * 0.88),
      height: Math.min(yScanEnd, bottom) - top,
    };
  }).filter((region) => region.height >= 30);
}

function MistakeImage({ image, alt }: { image: Blob; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const nextUrl = URL.createObjectURL(image);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [image]);
  return url ? <img src={url} alt={alt} /> : <div className="image-loading">正在读取题目…</div>;
}

export default function Home() {
  const [view, setView] = useState<View>('reader');
  const [entries, setEntries] = useState<PdfEntry[]>([]);
  const [connectedName, setConnectedName] = useState('');
  const [activeSubject, setActiveSubject] = useState('DS');
  const [selectedEntry, setSelectedEntry] = useState<PdfEntry | null>(null);
  const [pdfDocument, setPdfDocument] = useState<any>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [readerMessage, setReaderMessage] = useState('先选择练习册文件夹');
  const [readerError, setReaderError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draftSelection, setDraftSelection] = useState<Rect | null>(null);
  const [questionRegions, setQuestionRegions] = useState<QuestionRegion[]>([]);
  const [addingQuestionIndex, setAddingQuestionIndex] = useState<number | null>(null);
  const [pendingQuestionRegion, setPendingQuestionRegion] = useState<QuestionRegion | null>(null);
  const [pendingQuestionReason, setPendingQuestionReason] = useState('');
  const [pendingQuestionNote, setPendingQuestionNote] = useState('');
  const [questionNo, setQuestionNo] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [detailMistake, setDetailMistake] = useState<Mistake | null>(null);
  const [detailReason, setDetailReason] = useState('');
  const [detailNote, setDetailNote] = useState('');
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailEditorSide, setDetailEditorSide] = useState<'left' | 'right'>('right');
  const [detailEditorSize, setDetailEditorSize] = useState<'compact' | 'normal' | 'wide'>('normal');
  const [detailNoteScale, setDetailNoteScale] = useState(1);
  const [codexReadyId, setCodexReadyId] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexAnalysis, setCodexAnalysis] = useState<CodexAnalysis | null>(null);
  const [companionStatus, setCompanionStatus] = useState<CompanionStatus | null>(null);
  const [siteToolsSupported, setSiteToolsSupported] = useState(false);
  const [toast, setToast] = useState('');
  const [filterSubject, setFilterSubject] = useState('全部');
  const [filterChapter, setFilterChapter] = useState('全部章节');
  const [filterSection, setFilterSection] = useState('全部小节');
  const [filterStatus, setFilterStatus] = useState('待掌握');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryScope, setSummaryScope] = useState<'chapter' | 'section'>('chapter');
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryResult, setSummaryResult] = useState<CodexSummary | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [search, setSearch] = useState('');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const [githubTokenDraft, setGithubTokenDraft] = useState('');
  const [githubConnecting, setGithubConnecting] = useState(false);
  const [githubError, setGithubError] = useState('');
  const [mobilePanel, setMobilePanel] = useState<'chapters' | 'capture' | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasBoxRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const renderToken = useRef(0);
  const pdfDocumentRef = useRef<any>(null);
  const autoRecoveryRef = useRef({ entryId: '', attempts: 0 });
  const companionStartedRef = useRef(false);
  const mistakesRef = useRef<Mistake[]>([]);
  const detailMistakeRef = useRef<Mistake | null>(null);
  const detailDraftRef = useRef({ reason: '', note: '' });

  const refreshMistakes = useCallback(async () => {
    setMistakes(await listMistakes());
  }, []);

  const activateFiles = useCallback((files: PdfEntry[], label: string) => {
    setEntries(files);
    setConnectedName(label);
    const savedPdfId = window.sessionStorage.getItem(SELECTED_PDF_KEY);
    const first = files.find((file) => file.id === savedPdfId)
      || files.find((file) => file.subjectCode === activeSubject && file.version === '做题版')
      || files[0];
    if (first) {
      setActiveSubject(first.subjectCode);
      setSelectedEntry(first);
      setReaderMessage('正在打开 PDF…');
    } else {
      setReaderMessage('这个文件夹中没有找到 PDF');
    }
  }, [activeSubject]);

  const loadRoot = useCallback(async (root: LocalDirectoryHandle) => {
    setReaderMessage('正在读取分节练习册…');
    const files = await scanFolder(root);
    activateFiles(files, root.name);
  }, [activateFiles]);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    refreshMistakes();
    getSetting<LocalDirectoryHandle>('rootHandle').then(async (handle) => {
      if (!handle?.queryPermission) return;
      if (await handle.queryPermission({ mode: 'read' }) === 'granted') {
        await loadRoot(handle);
      }
    }).catch(() => undefined);
  }, [loadRoot, refreshMistakes]);

  useEffect(() => {
    const savedToken = window.sessionStorage.getItem(GITHUB_TOKEN_KEY);
    if (savedToken) void connectGitHubRepo(savedToken, true);
  }, []);

  useEffect(() => {
    if (companionStartedRef.current) return;
    companionStartedRef.current = true;
    let stopped = false;
    const connectCompanion = async () => {
      try {
        const status = await getCompanionStatus();
        if (stopped) return;
        setCompanionStatus(status);
        const [items] = await Promise.all([
          getCompanionLibrary(),
          syncMistakesWithCompanion().then(() => refreshMistakes()),
        ]);
        if (stopped || !items.length) return;
        const files = items.map((item) => {
          const parts = item.path.split('/').filter(Boolean);
          const handle: LocalFileHandle = {
            kind: 'file',
            name: item.name,
            getFile: (signal) => fetchCompanionPdf(item.path, signal),
          };
          return parts.length >= 4 && /^\d+_[A-Z]+_/.test(parts[0])
            ? parsePdf(parts, handle)
            : parseFlatPdf(item.name, item.path, handle, `companion:${item.path}:${item.size}`);
        });
        activateFiles(files, '本机 408 分节练习册');
      } catch {
        if (!stopped) setCompanionStatus(null);
      }
    };
    void connectCompanion();
    return () => { stopped = true; };
  }, [activateFiles, refreshMistakes]);

  useEffect(() => {
    mistakesRef.current = mistakes;
    detailMistakeRef.current = detailMistake;
    detailDraftRef.current = { reason: detailReason, note: detailNote };
    const siteWindow = window as Window & { __mistakeBookBridge?: MistakeBookBridge };
    const summarize = (mistake: Mistake) => ({
      id: mistake.id,
      subject: mistake.subject,
      chapter: mistake.chapter,
      section: mistake.section,
      page: mistake.page,
      questionNo: displayQuestionNo(mistake.questionNo),
      reason: mistake.reason,
      note: mistake.note,
      mastered: mistake.mastered,
    });
    const bridge: MistakeBookBridge = {
      getCurrent: () => {
        const current = detailMistakeRef.current;
        if (!current) return { found: false, message: '请先在“我的错题”中打开一道题目。' };
        return {
          found: true,
          ...summarize(current),
          reason: detailDraftRef.current.reason || '未填写',
          note: detailDraftRef.current.note,
          imageHint: '题目图片正在网页的错题详情弹窗左侧显示，可直接查看页面。',
        };
      },
      list: (query) => {
        const normalized = query.trim().toLowerCase();
        const rows = mistakesRef.current.filter((mistake) => !normalized || `${mistake.subject} ${mistake.chapter} ${mistake.section} ${mistake.questionNo} ${mistake.reason} ${mistake.note}`.toLowerCase().includes(normalized));
        return { count: rows.length, mistakes: rows.slice(0, 50).map(summarize) };
      },
      open: (id) => {
        const target = mistakesRef.current.find((mistake) => mistake.id === id);
        if (!target) return { opened: false, message: '没有找到这道错题。' };
        setView('mistakes');
        openMistakeDetail(target);
        return { opened: true, mistake: summarize(target), imageHint: '题目图片已在网页中放大显示。' };
      },
      update: async (input) => {
        const id = typeof input.id === 'string' ? input.id : detailMistakeRef.current?.id;
        const current = mistakesRef.current.find((mistake) => mistake.id === id);
        if (!current) return { updated: false, message: '没有找到要更新的错题。' };
        const reasonInput = typeof input.reason === 'string' ? input.reason : undefined;
        const reasonValue = reasonInput && REASONS.includes(reasonInput) ? reasonInput : current.reason;
        const addition = typeof input.noteToAppend === 'string' ? input.noteToAppend.trim() : '';
        const nextNote = addition ? [current.note.trim(), addition].filter(Boolean).join('\n\n') : current.note;
        const updated = {
          ...current,
          reason: reasonValue,
          note: nextNote,
          mastered: typeof input.mastered === 'boolean' ? input.mastered : current.mastered,
        };
        const saved = await saveMistakeSynced(updated);
        await refreshMistakes();
        if (detailMistakeRef.current?.id === saved.id) {
          setDetailMistake(saved);
          setDetailReason(saved.reason === '未填写' ? '' : saved.reason);
          setDetailNote(saved.note);
        }
        return { updated: true, mistake: summarize(saved) };
      },
    };
    siteWindow.__mistakeBookBridge = bridge;
    return () => {
      if (siteWindow.__mistakeBookBridge === bridge) delete siteWindow.__mistakeBookBridge;
    };
  }, [detailMistake, detailNote, detailReason, mistakes, refreshMistakes]);

  useEffect(() => {
    const siteDocument = document as Document & {
      modelContext?: { registerTool: (tool: SiteTool) => void | Promise<void> };
    };
    const siteWindow = window as Window & {
      __mistakeBookBridge?: MistakeBookBridge;
      __mistakeBookToolsRegistered?: boolean;
    };
    let stopped = false;
    let timer = 0;
    const callBridge = <T extends keyof MistakeBookBridge>(method: T, ...args: Parameters<MistakeBookBridge[T]>) => {
      const bridge = siteWindow.__mistakeBookBridge;
      if (!bridge) return { error: '错题本页面尚未准备好，请稍后再试。' };
      return (bridge[method] as (...values: Parameters<MistakeBookBridge[T]>) => ReturnType<MistakeBookBridge[T]>)(...args);
    };
    const register = async () => {
      if (stopped || typeof siteDocument.modelContext?.registerTool !== 'function') return false;
      setSiteToolsSupported(true);
      if (siteWindow.__mistakeBookToolsRegistered) return true;
      const tools: SiteTool[] = [
        {
          name: 'get_current_mistake',
          description: '读取用户当前在 408 错题本中放大打开的题目、章节、错误原因和笔记。题目图片同时显示在当前网页中。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          execute: async () => callBridge('getCurrent'),
        },
        {
          name: 'list_mistakes',
          description: '按科目、章节、题号、错因或笔记关键词检索 408 错题本。',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: '可选的搜索关键词，留空返回最近的错题。' } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: async (input) => callBridge('list', typeof input.query === 'string' ? input.query : ''),
        },
        {
          name: 'open_mistake',
          description: '在当前网页中打开并放大指定错题，让用户和 Codex 一起查看题目图片。',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'list_mistakes 返回的错题 id。' } },
            required: ['id'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: async (input) => callBridge('open', String(input.id || '')),
        },
        {
          name: 'update_mistake_learning',
          description: '把 Codex 的简短分析追加进错题笔记，并可更新错误原因或掌握状态；不会删除原笔记。',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '错题 id；省略时更新当前打开的错题。' },
              noteToAppend: { type: 'string', description: '要追加到原笔记末尾的学习结论。' },
              reason: { type: 'string', enum: REASONS },
              mastered: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false },
          execute: async (input) => callBridge('update', input),
        },
      ];
      for (const tool of tools) await siteDocument.modelContext.registerTool(tool);
      siteWindow.__mistakeBookToolsRegistered = true;
      return true;
    };
    const waitForSupport = async () => {
      if (await register()) return;
      timer = window.setTimeout(waitForSupport, 600);
    };
    void waitForSupport();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!selectedEntry) return;
    let cancelled = false;
    let loadingTask: any = null;
    let activeController: AbortController | null = null;
    let timedOut = false;
    let timeout = 0;
    let recoveryTimer = 0;
    if (autoRecoveryRef.current.entryId !== selectedEntry.id) {
      autoRecoveryRef.current = { entryId: selectedEntry.id, attempts: 0 };
    }
    renderToken.current += 1;
    setSelection(null);
    setDraftSelection(null);
    setQuestionRegions([]);
    setPageNumber(1);
    setPageCount(0);
    setReaderError(false);
    setReaderMessage('正在打开 PDF…');

    setPdfDocument(null);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }

    const loadDocument = async () => {
      const previousDocument = pdfDocumentRef.current;
      pdfDocumentRef.current = null;
      if (previousDocument) await previousDocument.destroy().catch(() => undefined);
      if (cancelled) return;

      const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          activeController?.abort('retry-replaced');
          activeController = new AbortController();
          const file = await selectedEntry.handle.getFile(activeController.signal);
          if (cancelled) return;
          loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
          const document = await loadingTask.promise;
          loadingTask = null;
          if (cancelled) {
            await (document as any).destroy();
            return;
          }
          pdfDocumentRef.current = document;
          setPdfDocument(document);
          setPageCount(document.numPages);
          setReaderMessage('');
          autoRecoveryRef.current = { entryId: selectedEntry.id, attempts: 0 };
          return;
        } catch (error) {
          lastError = error;
          console.warn('PDF_OPEN_FAILED', selectedEntry.name, attempt + 1, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          if (loadingTask) await loadingTask.destroy().catch(() => undefined);
          loadingTask = null;
          selectedEntry.handle.clearCache?.();
          if (cancelled || timedOut || attempt === 3) break;
          setReaderMessage('GitHub 大文件连接暂时繁忙，正在后台自动恢复…');
          const retryDelay = [10_000, 25_000, 40_000][attempt];
          await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        }
      }
      throw lastError;
    };

    timeout = window.setTimeout(() => {
      timedOut = true;
      activeController?.abort('timeout');
      if (loadingTask) loadingTask.destroy().catch(() => undefined);
    }, 120_000);
    loadDocument().catch((error) => {
      if (cancelled) return;
      const recovery = autoRecoveryRef.current;
      if (!timedOut && selectedEntry.id.startsWith('github:') && recovery.entryId === selectedEntry.id && recovery.attempts < 2) {
        autoRecoveryRef.current = { entryId: selectedEntry.id, attempts: recovery.attempts + 1 };
        setReaderError(false);
        setReaderMessage('GitHub 大文件连接暂时繁忙，正在后台自动恢复…');
        recoveryTimer = window.setTimeout(() => {
          if (!cancelled) setLoadAttempt((value) => value + 1);
        }, recovery.attempts === 0 ? 5_000 : 15_000);
        return;
      }
      setReaderError(true);
      if (timedOut) {
        setReaderMessage('下载超过 2 分钟，已停止。请检查网络后重新打开');
      } else {
        setReaderMessage(`这个 PDF 没有成功打开${error instanceof Error && error.message.includes('401') ? '，请重新连接私有仓库' : '，请重新打开'}`);
      }
    }).finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(recoveryTimer);
      activeController?.abort('chapter-changed');
      if (loadingTask) loadingTask.destroy().catch(() => undefined);
    };
  }, [loadAttempt, selectedEntry]);

  useEffect(() => {
    const restoreOnReturn = () => {
      if (!document.hidden && selectedEntry && readerError) setLoadAttempt((value) => value + 1);
    };
    document.addEventListener('visibilitychange', restoreOnReturn);
    return () => document.removeEventListener('visibilitychange', restoreOnReturn);
  }, [readerError, selectedEntry]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;
    const token = ++renderToken.current;
    setReaderMessage('正在显示第 ' + pageNumber + ' 页…');
    setSelection(null);
    setDraftSelection(null);
    setQuestionRegions([]);
    pdfDocument.getPage(pageNumber).then(async (page: any) => {
      if (token !== renderToken.current) return;
      const viewport = page.getViewport({ scale: 1.45 * zoom });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: context, viewport }).promise;
      if (token === renderToken.current) {
        setQuestionRegions(detectQuestionRegions(canvas));
        setReaderMessage('');
      }
    }).catch(() => setReaderMessage('这一页暂时无法显示'));
  }, [pageNumber, pdfDocument, zoom]);

  const entriesForSubject = useMemo(() => entries.filter((entry) => {
    const haystack = `${entry.chapter} ${entry.section} ${entry.version}`.toLowerCase();
    return entry.subjectCode === activeSubject && haystack.includes(sidebarSearch.trim().toLowerCase());
  }), [activeSubject, entries, sidebarSearch]);

  const chapterGroups = useMemo(() => {
    const groups = new Map<string, PdfEntry[]>();
    entriesForSubject.forEach((entry) => groups.set(entry.chapter, [...(groups.get(entry.chapter) || []), entry]));
    return [...groups.entries()];
  }, [entriesForSubject]);

  const mistakeChapterOptions = useMemo(() => [...new Set(mistakes
    .filter((mistake) => filterSubject === '全部' || mistake.subjectCode === filterSubject)
    .map((mistake) => mistake.chapter))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })), [filterSubject, mistakes]);

  const mistakeSectionOptions = useMemo(() => [...new Set(mistakes
    .filter((mistake) => (filterSubject === '全部' || mistake.subjectCode === filterSubject)
      && (filterChapter === '全部章节' || mistake.chapter === filterChapter))
    .map((mistake) => mistake.section))].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })), [filterChapter, filterSubject, mistakes]);

  const orderedMistakes = useMemo(() => [...mistakes].sort(compareMistakes), [mistakes]);

  const filteredMistakes = useMemo(() => orderedMistakes.filter((mistake) => {
    if (filterSubject !== '全部' && mistake.subjectCode !== filterSubject) return false;
    if (filterChapter !== '全部章节' && mistake.chapter !== filterChapter) return false;
    if (filterSection !== '全部小节' && mistake.section !== filterSection) return false;
    if (filterStatus === '待掌握' && mistake.mastered) return false;
    if (filterStatus === '已掌握' && !mistake.mastered) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${mistake.subject} ${mistake.chapter} ${mistake.section} ${mistake.questionNo} ${mistake.reason} ${mistake.note}`.toLowerCase().includes(query);
  }), [filterChapter, filterSection, filterStatus, filterSubject, orderedMistakes, search]);

  const detailNavigation = useMemo(() => {
    if (!detailMistake) return { items: filteredMistakes, index: -1, previous: null, next: null };
    const items = filteredMistakes.some((mistake) => mistake.id === detailMistake.id) ? filteredMistakes : orderedMistakes;
    const index = items.findIndex((mistake) => mistake.id === detailMistake.id);
    return { items, index, previous: index > 0 ? items[index - 1] : null, next: index >= 0 && index < items.length - 1 ? items[index + 1] : null };
  }, [detailMistake, filteredMistakes, orderedMistakes]);

  const groupedMistakes = useMemo(() => {
    const groups = new Map<string, Mistake[]>();
    filteredMistakes.forEach((mistake) => {
      const key = `${mistake.subjectCode}|||${mistake.chapter}`;
      groups.set(key, [...(groups.get(key) || []), mistake]);
    });
    return [...groups.entries()].map(([key, items]) => {
      const [subjectCode, chapter] = key.split('|||');
      return { subjectCode, subject: items[0]?.subject || subjectCode, chapter, items };
    });
  }, [filteredMistakes]);

  async function connectFolder() {
    const picker = (window as unknown as {
      showDirectoryPicker?: (options?: { mode: 'read' }) => Promise<LocalDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      folderInputRef.current?.click();
      return;
    }
    try {
      const root = await picker({ mode: 'read' });
      await setSetting('rootHandle', root).catch(() => undefined);
      await loadRoot(root);
      setToast('练习册连接成功');
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') window.alert('没有成功读取文件夹，请重新选择。');
    }
  }

  function connectPdfFiles(fileList: FileList | null, fromFolder: boolean) {
    const files = Array.from(fileList || [])
      .filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      .map((file) => parseUploadedPdf(file as BrowserFile))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));

    if (!files.length) {
      window.alert('没有选到 PDF，请重新选择。');
      return;
    }

    const firstFile = (fileList?.[0] as BrowserFile | undefined);
    const rootName = firstFile?.webkitRelativePath?.split(/[\\/]/)[0];
    activateFiles(files, rootName || `${files.length} 个 PDF`);
    setToast(fromFolder ? `已读取 ${files.length} 个 PDF` : `已选择 ${files.length} 个 PDF`);
  }

  function openGitHubDialog() {
    setGithubTokenDraft(window.sessionStorage.getItem(GITHUB_TOKEN_KEY) || '');
    setGithubError('');
    setGithubDialogOpen(true);
  }

  async function connectGitHubRepo(tokenInput = githubTokenDraft, silent = false) {
    const token = tokenInput.trim();
    if (!token) {
      setGithubError('请先粘贴 GitHub 只读访问令牌。');
      setGithubDialogOpen(true);
      return;
    }

    setGithubConnecting(true);
    setGithubError('');
    if (!silent) setReaderMessage('正在连接私有 PDF 仓库…');
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents?ref=${GITHUB_BRANCH}`,
        { headers: githubHeaders(token) },
      );
      if (!response.ok) {
        if (response.status === 401) throw new Error('令牌无效或已过期，请重新创建。');
        if (response.status === 403) throw new Error('令牌没有读取权限，创建时请把 Contents 设为 Read-only。');
        if (response.status === 404) throw new Error('令牌没有选中 408-pdf-library 仓库。');
        throw new Error(`GitHub 暂时无法连接（${response.status}）。`);
      }

      const payload = await response.json() as GitHubContentItem[];
      const files = payload
        .filter((item) => item.type === 'file' && item.name.toLowerCase().endsWith('.pdf'))
        .map((item) => parseGitHubPdf(item, token))
        .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
      if (!files.length) throw new Error('私有仓库中没有找到 PDF。');

      window.sessionStorage.setItem(GITHUB_TOKEN_KEY, token);
      activateFiles(files, `GitHub 私有仓库 · ${files.length} 个 PDF`);
      setGithubDialogOpen(false);
      setGithubTokenDraft('');
      setToast(`已连接私有仓库，共 ${files.length} 个 PDF`);
    } catch (error) {
      const message = (error as Error).message || '连接失败，请稍后重试。';
      setGithubError(message);
      setGithubDialogOpen(true);
      window.sessionStorage.removeItem(GITHUB_TOKEN_KEY);
      if (silent) setReaderMessage('私有仓库连接已失效，请重新连接');
    } finally {
      setGithubConnecting(false);
    }
  }

  function chooseSubject(code: string) {
    setActiveSubject(code);
    const first = entries.find((entry) => entry.subjectCode === code && entry.version === '做题版') || entries.find((entry) => entry.subjectCode === code);
    if (first) openPdfEntry(first);
  }

  function openPdfEntry(file: PdfEntry) {
    setMobilePanel(null);
    window.sessionStorage.setItem(SELECTED_PDF_KEY, file.id);
    if (file.id === selectedEntry?.id) {
      if (readerError) setLoadAttempt((value) => value + 1);
      return;
    }
    setSelectedEntry(file);
  }

  function pointInCanvas(event: ReactPointerEvent<HTMLDivElement>) {
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!box) return null;
    return {
      x: Math.max(0, Math.min(event.clientX - box.left, box.width)),
      y: Math.max(0, Math.min(event.clientY - box.top, box.height)),
    };
  }

  function beginSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pdfDocument || readerMessage) return;
    const point = pointInCanvas(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    setSelection(null);
    setDraftSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function moveSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    const point = pointInCanvas(event);
    if (!start || !point) return;
    setDraftSelection({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }

  function endSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    moveSelection(event);
    const start = dragStart.current;
    const point = pointInCanvas(event);
    dragStart.current = null;
    if (!point) return;
    const next = {
      x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y),
    };
    if (next.width >= 30 && next.height >= 30) {
      setSelection(next);
      setDraftSelection(null);
      setMobilePanel('capture');
      setToast('题目已框选，可以加入错题本');
    } else {
      setDraftSelection(null);
    }
  }

  async function saveCanvasRegion(
    source: Rect,
    details: { id?: string; questionNo: string; reason: string; note: string },
  ) {
    const canvas = canvasRef.current;
    if (!canvas || !selectedEntry) return false;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(source.width));
    crop.height = Math.max(1, Math.round(source.height));
    const context = crop.getContext('2d');
    if (!context) return false;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, crop.width, crop.height);
    context.drawImage(
      canvas,
      Math.round(source.x), Math.round(source.y), crop.width, crop.height,
      0, 0, crop.width, crop.height,
    );
    const image = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, 'image/png'));
    if (!image) return false;
    const mistake: Mistake = {
      id: details.id || crypto.randomUUID(), createdAt: new Date().toISOString(),
      subject: selectedEntry.subject, subjectCode: selectedEntry.subjectCode,
      chapter: selectedEntry.chapter, section: selectedEntry.section, version: selectedEntry.version,
      pdfName: selectedEntry.name, pdfPath: selectedEntry.path, page: pageNumber,
      questionNo: details.questionNo, reason: details.reason || '未填写', note: details.note, mastered: false, image,
    };
    await saveMistakeSynced(mistake);
    await refreshMistakes();
    return true;
  }

  async function addMistake() {
    const canvas = canvasRef.current;
    if (!canvas || !selection || !selectedEntry) return;
    const bounds = canvas.getBoundingClientRect();
    const ratioX = canvas.width / bounds.width;
    const ratioY = canvas.height / bounds.height;
    const saved = await saveCanvasRegion({
      x: selection.x * ratioX,
      y: selection.y * ratioY,
      width: selection.width * ratioX,
      height: selection.height * ratioY,
    }, { questionNo: questionNo.trim(), reason, note: note.trim() });
    if (!saved) return;
    setQuestionNo(''); setReason(''); setNote(''); setSelection(null);
    setMobilePanel(null);
    setToast('已加入错题本');
  }

  function openDetectedQuestionDialog(region: QuestionRegion) {
    if (!selectedEntry) return;
    const mistakeId = `auto:${selectedEntry.id}:${pageNumber}:${region.index}`;
    const existing = mistakes.find((mistake) => mistake.id === mistakeId);
    if (existing) {
      openMistakeDetail(existing);
      return;
    }
    setPendingQuestionRegion(region);
    setPendingQuestionReason('');
    setPendingQuestionNote('');
  }

  async function addDetectedQuestion() {
    const region = pendingQuestionRegion;
    if (!selectedEntry || !region) return;
    const mistakeId = `auto:${selectedEntry.id}:${pageNumber}:${region.index}`;
    setAddingQuestionIndex(region.index);
    try {
      const label = `第 ${pageNumber} 页 · 本页第 ${region.index + 1} 题`;
      const saved = await saveCanvasRegion(region, {
        id: mistakeId,
        questionNo: label,
        reason: pendingQuestionReason,
        note: pendingQuestionNote.trim(),
      });
      if (saved) {
        setPendingQuestionRegion(null);
        setPendingQuestionReason('');
        setPendingQuestionNote('');
        setToast(`${label}已加入错题本`);
      }
    } finally {
      setAddingQuestionIndex(null);
    }
  }

  function openMistakeDetail(mistake: Mistake) {
    setDetailMistake(mistake);
    setDetailReason(mistake.reason === '未填写' ? '' : mistake.reason);
    setDetailNote(mistake.note || '');
    setCodexReadyId('');
    setCodexAnalysis(null);
  }

  function navigateMistake(mistake: Mistake | null) {
    if (!mistake || detailSaving || codexBusy) return;
    openMistakeDetail(mistake);
  }

  function openSummary() {
    if (filterSubject === '全部' || filterChapter === '全部章节') {
      setToast('请先选择一个科目和章节，再生成 AI 总结');
      return;
    }
    setSummaryScope(filterSection === '全部小节' ? 'chapter' : 'section');
    setSummaryResult(null);
    setSummaryError('');
    setSummaryOpen(true);
  }

  async function generateSummary() {
    if (filterSubject === '全部' || filterChapter === '全部章节') return;
    if (summaryScope === 'section' && filterSection === '全部小节') {
      setSummaryError('请先关闭窗口，在上方选择一个具体小节。');
      return;
    }
    const items = orderedMistakes.filter((mistake) => mistake.subjectCode === filterSubject
      && mistake.chapter === filterChapter
      && (summaryScope === 'chapter' || mistake.section === filterSection));
    if (!items.length) {
      setSummaryError('当前范围还没有错题。');
      return;
    }
    if (!companionStatus?.connected || !companionStatus.auth.connected) {
      setSummaryError('请先在电脑上启动 408 AI 错题助手并登录 Codex。');
      return;
    }
    setSummaryBusy(true);
    setSummaryError('');
    setSummaryResult(null);
    try {
      const subject = items[0].subject;
      const section = summaryScope === 'section' ? filterSection : undefined;
      const label = [subject, filterChapter, section].filter(Boolean).join(' · ');
      setSummaryResult(await summarizeMistakesWithCodex({ subject, chapter: filterChapter, section, label }, items));
    } catch (error) {
      setSummaryError(`总结失败：${(error as Error).message}`);
    } finally {
      setSummaryBusy(false);
    }
  }

  async function prepareCodexQuestion() {
    if (!detailMistake) return;
    setCodexReadyId(detailMistake.id);
    if (companionStatus?.connected) {
      if (!companionStatus.auth.connected) {
        setCodexAnalysis({ analysis: '本地助手已经运行，但 Codex 尚未登录。请先在 Codex 桌面应用中登录。', noteToAppend: '' });
        return;
      }
      setCodexBusy(true);
      setCodexAnalysis(null);
      try {
        const draft = {
          ...detailMistake,
          reason: detailReason || '未填写',
          note: detailNote.trim(),
        };
        const result = await analyzeMistakeWithCodex(draft);
        const nextReason = detailReason || result.suggestedReason || '未填写';
        const nextNote = [detailNote.trim(), result.noteToAppend.trim()].filter(Boolean).join('\n\n');
        const saved = await saveMistakeSynced({ ...draft, reason: nextReason, note: nextNote });
        setDetailMistake(saved);
        setDetailReason(saved.reason === '未填写' ? '' : saved.reason);
        setDetailNote(saved.note);
        setCodexAnalysis(result);
        await refreshMistakes();
        setToast('Codex 分析完成，精炼结论已加入笔记并同步');
      } catch (error) {
        setCodexAnalysis({ analysis: `分析失败：${(error as Error).message}`, noteToAppend: '' });
      } finally {
        setCodexBusy(false);
      }
      return;
    }
    const prompt = '请分析我在 408 错题收集器中当前打开的错题。先调用 get_current_mistake 读取章节、错误原因和笔记，再查看网页左侧的题目图片，告诉我：①考点；②正确思路；③我为什么容易错；④下次遇到同类题的检查步骤。最后把简短结论追加到这道题的笔记中。';
    try {
      await navigator.clipboard.writeText(prompt);
      setToast(siteToolsSupported ? '提问已复制，回到旁边的 Codex 对话发送即可' : '提问已复制；开启 Codex Site tools 后即可读取当前题');
    } catch {
      setToast(siteToolsSupported ? '当前错题已准备好，可以在旁边询问 Codex' : '请开启 Codex 的 Site tools 后刷新本站');
    }
  }

  async function saveMistakeDetail() {
    if (!detailMistake) return;
    setDetailSaving(true);
    try {
      const updated = {
        ...detailMistake,
        reason: detailReason || '未填写',
        note: detailNote.trim(),
      };
      const saved = await saveMistakeSynced(updated);
      await refreshMistakes();
      setDetailMistake(saved);
      setToast('错误原因和笔记已保存');
    } finally {
      setDetailSaving(false);
    }
  }

  async function toggleMastered(mistake: Mistake) {
    await saveMistakeSynced({ ...mistake, mastered: !mistake.mastered });
    await refreshMistakes();
  }

  async function deleteMistake(mistake: Mistake) {
    if (!window.confirm('确定删除这道错题吗？')) return;
    await deleteMistakeSynced(mistake.id);
    await refreshMistakes();
    setToast('错题已删除');
  }

  async function printMistakes() {
    if (!filteredMistakes.length) return;
    const popup = window.open('', '_blank');
    if (!popup) {
      window.alert('浏览器阻止了打印窗口，请允许弹出窗口后再试。');
      return;
    }
    popup.document.write('<p style="font-family:sans-serif;padding:30px">正在整理错题，请稍候…</p>');
    const cards = await Promise.all(filteredMistakes.map(async (mistake, index) => {
      const image = await blobToDataUrl(mistake.image);
      return `<section><header><b>${index + 1}. ${escapeHtml(mistake.subject)} · ${escapeHtml(mistake.section)}</b><span>${escapeHtml(mistake.chapter)} · 第${mistake.page}页</span></header><img src="${image}"><p><strong>题号：</strong>${escapeHtml(mistake.questionNo || '未填写')}　<strong>错因：</strong>${escapeHtml(mistake.reason)}</p>${mistake.note ? `<p><strong>笔记：</strong>${escapeHtml(mistake.note)}</p>` : ''}</section>`;
    }));
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>408错题本</title><style>@page{size:A4;margin:16mm}body{font-family:"Microsoft YaHei",sans-serif;color:#17231e}h1{font-size:24px;margin:0 0 24px}section{break-inside:avoid;border-bottom:1px solid #ddd;padding:0 0 22px;margin:0 0 24px}header{display:flex;justify-content:space-between;gap:15px;margin-bottom:12px}header span{font-size:12px;color:#68756e}img{display:block;max-width:100%;max-height:460px;border:1px solid #ddd}p{font-size:13px;line-height:1.7;margin:10px 0 0}@media print{button{display:none}}</style></head><body><h1>408 错题本</h1>${cards.join('')}<button onclick="window.print()">打印 / 保存为 PDF</button></body></html>`);
    popup.document.close();
  }

  async function exportBackup() {
    if (!mistakes.length) return;
    const records = await Promise.all(mistakes.map(async ({ image, ...mistake }) => ({
      ...mistake,
      imageDataUrl: await blobToDataUrl(image),
    })));
    const backup = {
      format: '408-mistake-book-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      mistakes: records,
    };
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `408错题本备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setToast('备份已导出，可带到另一台电脑');
  }

  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text()) as {
        format?: string;
        mistakes?: Array<Omit<Mistake, 'image'> & { imageDataUrl: string }>;
      };
      if (backup.format !== '408-mistake-book-backup' || !Array.isArray(backup.mistakes)) {
        throw new Error('这不是有效的 408 错题本备份');
      }
      for (const record of backup.mistakes) {
        const { imageDataUrl, ...mistake } = record;
        if (!mistake.id || !mistake.subjectCode || !mistake.section) throw new Error('备份记录不完整');
        await saveMistakeSynced({ ...mistake, image: dataUrlToBlob(imageDataUrl) });
      }
      await refreshMistakes();
      setToast(`已导入 ${backup.mistakes.length} 道错题`);
    } catch (error) {
      window.alert((error as Error).message || '备份导入失败');
    }
  }

  const activeRect = draftSelection || selection;
  const pendingCount = mistakes.filter((mistake) => !mistake.mastered).length;

  return (
    <main className="app-shell">
      <input ref={folderInputRef} className="file-input" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { connectPdfFiles(event.target.files, true); event.target.value = ''; }} />
      <input ref={pdfInputRef} className="file-input" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { connectPdfFiles(event.target.files, false); event.target.value = ''; }} />
      <header className="topbar">
        <button className="brand" onClick={() => { setMobilePanel(null); setView('reader'); }} aria-label="返回练习册">
          <span className="brand-mark">错</span>
          <span><b>408 错题收集器</b><small>每题一点，自动加入错题本</small></span>
        </button>
        <div className="top-actions">
          <span className="privacy-pill"><i />{companionStatus?.connected ? `OneDrive 自动同步 · 本机 ${companionStatus.libraryCount} 份分节 PDF` : '错题本地保存 · PDF 私有读取'}{companionStatus?.auth.connected || siteToolsSupported ? ' · Codex 已连接' : ''}</span>
          <button className={view === 'mistakes' ? 'ghost-button active' : 'ghost-button'} onClick={() => { setMobilePanel(null); setView(view === 'reader' ? 'mistakes' : 'reader'); }}>
            {view === 'reader' ? '我的错题' : '返回练习册'} <b>{mistakes.length}</b>
          </button>
        </div>
      </header>

      {view === 'reader' ? (
        <div className="workspace">
          <aside className={`sidebar ${mobilePanel === 'chapters' ? 'mobile-open' : ''}`}>
            <button className="drawer-close" onClick={() => setMobilePanel(null)} aria-label="关闭章节目录">×</button>
            <button className="folder-button" onClick={entries.length ? connectFolder : openGitHubDialog}>
              <span className="folder-icon" />
              <span><b>{connectedName ? '练习册已连接' : '连接私有 PDF 仓库'}</b>{connectedName && <small>{connectedName}</small>}</span>
            </button>
            <p className="sidebar-label">四科目录</p>
            <nav className="subject-grid" aria-label="科目目录">
              {SUBJECTS.map((subject) => {
                const sectionCount = new Set(entries.filter((entry) => entry.subjectCode === subject.code).map((entry) => entry.section)).size;
                return <button key={subject.code} className={activeSubject === subject.code ? 'subject active' : 'subject'} onClick={() => chooseSubject(subject.code)}><span className={`subject-code ${subject.tone}`}>{subject.code}</span><span><strong>{subject.name}</strong><small>{sectionCount ? `${sectionCount} 个小节` : '等待连接'}</small></span></button>;
              })}
            </nav>
            {entries.length > 0 && <>
              <div className="chapter-search"><span>⌕</span><input value={sidebarSearch} onChange={(event) => setSidebarSearch(event.target.value)} placeholder="搜索章节或小节" /></div>
              <div className="chapter-tree">
                {chapterGroups.map(([chapter, files], index) => <details key={chapter} open={index === 0 || files.some((file) => file.id === selectedEntry?.id)}><summary>{chapter}<small>{new Set(files.map((file) => file.section)).size}</small></summary><div>{files.map((file) => <button key={file.id} className={file.id === selectedEntry?.id ? 'pdf-link active' : 'pdf-link'} onClick={() => openPdfEntry(file)}><span>{file.section}</span><em>{file.version.replace('版', '')}</em></button>)}</div></details>)}
              </div>
            </>}
            <div className="quick-card"><span>待复习</span><strong>{pendingCount ? `${pendingCount} 道还没掌握` : '还没有待复习错题'}</strong><p>{pendingCount ? '打开“我的错题”即可逐题复习。' : '点击题目右侧的“＋错题”，复习列表会自动建立。'}</p></div>
          </aside>

          <section className="reader-panel">
            <div className="reader-toolbar">
              <div><span className="crumb">{selectedEntry ? `${selectedEntry.subject} / ${selectedEntry.chapter}` : '等待连接练习册'}</span><strong>{selectedEntry ? `${selectedEntry.section} · ${selectedEntry.version}` : '请连接私有仓库或选择本地 PDF'}</strong>{selectedEntry && !readerMessage && <small className={questionRegions.length ? 'question-detection ready' : 'question-detection'}>{questionRegions.length ? `已识别本页 ${questionRegions.length} 道题，点题目右侧“＋错题”即可` : '本页未识别出题号，可继续拖动框选'}</small>}</div>
              <div className="page-controls">
                <button disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} aria-label="上一页">‹</button>
                <span>第 <b>{pageNumber}</b> / {pageCount || '—'} 页</span>
                <button disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} aria-label="下一页">›</button>
                <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="缩放"><option value={0.8}>80%</option><option value={1}>100%</option><option value={1.2}>120%</option><option value={1.5}>150%</option></select>
              </div>
            </div>
            <div className="document-stage">
              {!selectedEntry ? <div className="connect-empty"><div className="empty-icon"><span /></div><h2>连接你的分节练习册</h2><p>换电脑也能用：直接读取你的 GitHub 私有 PDF 仓库</p><div className="connect-actions"><button onClick={openGitHubDialog}>连接私有 PDF 仓库</button><button className="secondary" onClick={connectFolder}>选择本地文件夹</button><button className="secondary" onClick={() => pdfInputRef.current?.click()}>选择 PDF 文件</button></div><small>访问令牌只保留在当前浏览器标签页；错题仍保存在本机</small></div> : <div className="canvas-wrap" ref={canvasBoxRef} onPointerDown={beginSelection} onPointerMove={moveSelection} onPointerUp={endSelection} onPointerCancel={endSelection}>
                <canvas ref={canvasRef} />
                {questionRegions.map((region) => {
                  const alreadyAdded = mistakes.some((mistake) => mistake.id === `auto:${selectedEntry.id}:${pageNumber}:${region.index}`);
                  return <div className="question-region" key={`${pageNumber}:${region.index}`} style={{ left: `${region.x / (canvasRef.current?.width || 1) * 100}%`, top: `${region.y / (canvasRef.current?.height || 1) * 100}%`, width: `${region.width / (canvasRef.current?.width || 1) * 100}%`, height: `${region.height / (canvasRef.current?.height || 1) * 100}%` }}><span>本页第 {region.index + 1} 题</span><button className={alreadyAdded ? 'added' : ''} disabled={addingQuestionIndex !== null} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openDetectedQuestionDialog(region); }}>{addingQuestionIndex === region.index ? '添加中…' : alreadyAdded ? '✓ 查看' : '＋ 错题'}</button></div>;
                })}
                {activeRect && <div className={`selection-box ${selection ? 'done' : ''}`} style={{ left: activeRect.x, top: activeRect.y, width: activeRect.width, height: activeRect.height }}><span>{selection ? '已框选' : '松开完成'}</span></div>}
                {readerMessage && <div className={readerError ? 'reader-message error' : 'reader-message'}><i /><span>{readerMessage}</span>{readerError && <button onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setLoadAttempt((value) => value + 1); }}>重新打开</button>}</div>}
              </div>}
            </div>
          </section>

          <div className="mobile-dock" aria-label="练习册工具">
            <button className="mobile-chapters-button" onClick={() => setMobilePanel('chapters')}>☰ 章节目录</button>
            <button onClick={() => setMobilePanel('capture')} disabled={!selectedEntry}>＋ 加入错题</button>
          </div>
          {mobilePanel && <button className="mobile-drawer-backdrop" onClick={() => setMobilePanel(null)} aria-label="关闭面板" />}

          <aside className={`capture-panel ${mobilePanel === 'capture' ? 'mobile-open' : ''}`}>
            <button className="drawer-close" onClick={() => setMobilePanel(null)} aria-label="关闭错题面板">×</button>
            <div className="capture-head"><span className={selection ? 'capture-icon ready' : 'capture-icon'}>{selection ? '✓' : '＋'}</span><div><strong>加入错题本</strong><small>{selection ? '题目已框选，补充信息后保存' : '在中间 PDF 上拖动框选题目'}</small></div></div>
            {selection && <div className="selection-ready">已截取 {Math.round(selection.width)} × {Math.round(selection.height)} 区域 <button onClick={() => setSelection(null)}>重选</button></div>}
            <label>题号 <span>选填</span><input value={questionNo} onChange={(event) => setQuestionNo(event.target.value)} placeholder="例如：12" /></label>
            <label>错误原因 <span>选填</span><select value={reason} onChange={(event) => setReason(event.target.value)}><option value="">请选择</option>{REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>我的笔记 <span>选填</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下正确思路或易错点…" /></label>
            <div className="auto-tags">{selectedEntry && <><span>{selectedEntry.subjectCode}</span><span>{selectedEntry.section.split(' ')[0]}</span><span>第 {pageNumber} 页</span></>}</div>
            <button className="primary-button" disabled={!selection} onClick={addMistake}>＋ 加入错题本</button>
            <p className="capture-tip">保存后可按科目、章节和掌握状态筛选，并打印或另存为 PDF。</p>
          </aside>
        </div>
      ) : (
        <section className="mistakes-view">
          <div className="mistakes-heading"><div><span>我的错题</span><h2>{mistakes.length} 道错题，{pendingCount} 道待掌握</h2></div><div className="heading-actions"><input ref={backupInputRef} className="backup-input" type="file" accept="application/json,.json" onChange={importBackup} /><button className="summary-button" disabled={!mistakes.length} onClick={openSummary}>✦ AI 章节总结</button><button className="backup-button" onClick={() => backupInputRef.current?.click()}>导入备份</button><button className="backup-button" disabled={!mistakes.length} onClick={exportBackup}>导出备份</button><button className="print-button" disabled={!filteredMistakes.length} onClick={printMistakes}>打印 / 保存为 PDF</button></div></div>
          <div className="filterbar"><select value={filterSubject} onChange={(event) => { setFilterSubject(event.target.value); setFilterChapter('全部章节'); setFilterSection('全部小节'); }}><option>全部</option>{SUBJECTS.map((subject) => <option key={subject.code} value={subject.code}>{subject.name}</option>)}</select><select value={filterChapter} onChange={(event) => { setFilterChapter(event.target.value); setFilterSection('全部小节'); }}><option>全部章节</option>{mistakeChapterOptions.map((chapter) => <option key={chapter}>{chapter}</option>)}</select><select value={filterSection} onChange={(event) => setFilterSection(event.target.value)}><option>全部小节</option>{mistakeSectionOptions.map((section) => <option key={section}>{section}</option>)}</select><select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}><option>全部状态</option><option>待掌握</option><option>已掌握</option></select><div className="mistake-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索章节、小节、页码或题目" /></div></div>
          <div className="sync-note"><b>{companionStatus?.connected ? '双电脑自动同步已开启：' : '换电脑或手机使用：'}</b>{companionStatus?.connected ? `电脑间的错题、错因、笔记和 Codex 分析保存在 OneDrive；手机可打开在线网站查看，并用“导入备份”带入错题。当前读取 ${companionStatus.libraryRoot}。` : '在电脑点击“导出备份”，手机或新电脑打开同一个网站后点击“导入备份”。PDF 和错题不会公开上传。'}</div>
          {filteredMistakes.length ? <div className="mistake-chapter-list">{groupedMistakes.map((group) => <section className="mistake-chapter-group" key={`${group.subjectCode}:${group.chapter}`}><div className="mistake-chapter-heading"><div><span>{group.subjectCode}</span><h3>{group.subject} · {group.chapter}</h3></div><b>{group.items.length} 道</b></div><div className="mistake-grid">{group.items.map((mistake) => <article className={mistake.mastered ? 'mistake-card mastered' : 'mistake-card'} key={mistake.id}><button className="mistake-image" onClick={() => openMistakeDetail(mistake)} aria-label={`放大并编辑 ${displayQuestionNo(mistake.questionNo)}`}><MistakeImage image={mistake.image} alt={`${mistake.section} ${mistake.questionNo || ''}`} />{mistake.mastered && <span>已掌握</span>}<em>点击放大 · 编辑笔记</em></button><div className="mistake-body"><div className="mistake-tags"><span>{mistake.subjectCode}</span><span>{mistake.section.split(' ')[0]}</span><span>第{mistake.page}页</span></div><h3>{displayQuestionNo(mistake.questionNo)} · {mistake.reason}</h3><p className="mistake-path">{mistake.chapter} / {mistake.section}</p>{mistake.note && <p className="mistake-note">{mistake.note}</p>}<div className="mistake-actions"><button onClick={() => openMistakeDetail(mistake)}>放大 / 编辑</button><button onClick={() => toggleMastered(mistake)}>{mistake.mastered ? '标记为待复习' : '✓ 我已掌握'}</button><button className="delete-button" onClick={() => deleteMistake(mistake)}>删除</button></div></div></article>)}</div></section>)}</div> : <div className="mistakes-empty"><div>✓</div><h3>{mistakes.length ? '没有符合条件的错题' : '错题本还是空的'}</h3><p>{mistakes.length ? '换一个科目、章节或小节再看看。' : '返回练习册，点击题目右侧的“＋错题”即可加入。'}</p><button onClick={() => setView('reader')}>返回练习册</button></div>}
        </section>
      )}
      {pendingQuestionRegion && selectedEntry && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && addingQuestionIndex === null) setPendingQuestionRegion(null); }}>
        <section className="question-add-dialog" role="dialog" aria-modal="true" aria-labelledby="question-add-title">
          <button className="dialog-close" onClick={() => setPendingQuestionRegion(null)} disabled={addingQuestionIndex !== null} aria-label="关闭">×</button>
          <span className="dialog-kicker">保存前先补充信息</span>
          <h2 id="question-add-title">加入本页第 {pendingQuestionRegion.index + 1} 题</h2>
          <p>{selectedEntry.subject} · {selectedEntry.chapter} · {selectedEntry.section} · 第 {pageNumber} 页</p>
          <label>错误原因 <span>选填</span><select value={pendingQuestionReason} onChange={(event) => setPendingQuestionReason(event.target.value)}><option value="">请选择</option>{REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>我的笔记 <span>可以稍后继续修改</span><textarea value={pendingQuestionNote} onChange={(event) => setPendingQuestionNote(event.target.value)} placeholder="写下正确思路、易错点或以后要复习的内容…" /></label>
          <div className="dialog-actions"><button className="dialog-cancel" onClick={() => setPendingQuestionRegion(null)} disabled={addingQuestionIndex !== null}>取消</button><button className="dialog-connect" onClick={() => void addDetectedQuestion()} disabled={addingQuestionIndex !== null}>{addingQuestionIndex !== null ? '正在加入…' : '确认加入错题本'}</button></div>
        </section>
      </div>}
      {detailMistake && <div className="modal-backdrop mistake-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !detailSaving && !codexBusy) setDetailMistake(null); }}>
        <section className={`mistake-detail-dialog editor-${detailEditorSide} editor-${detailEditorSize}`} role="dialog" aria-modal="true" aria-labelledby="mistake-detail-title">
          <button className="dialog-close" onClick={() => setDetailMistake(null)} disabled={detailSaving || codexBusy} aria-label="关闭">×</button>
          <div className="mistake-detail-image"><MistakeImage image={detailMistake.image} alt={`${detailMistake.section} ${detailMistake.questionNo || ''}`} /><div className="mistake-detail-nav"><button disabled={!detailNavigation.previous} onClick={() => navigateMistake(detailNavigation.previous)}>← 上一题</button><span>{detailNavigation.index + 1} / {detailNavigation.items.length}</span><button disabled={!detailNavigation.next} onClick={() => navigateMistake(detailNavigation.next)}>下一题 →</button></div></div>
          <div className="mistake-detail-editor">
            <span className="dialog-kicker">错题详情</span>
            <h2 id="mistake-detail-title">{displayQuestionNo(detailMistake.questionNo)}</h2>
            <p>{detailMistake.subject} · {detailMistake.chapter}<br />{detailMistake.section} · 第 {detailMistake.page} 页</p>
            <div className="note-layout-tools"><button onClick={() => setDetailEditorSide((side) => side === 'right' ? 'left' : 'right')}>⇄ 笔记移到{detailEditorSide === 'right' ? '左边' : '右边'}</button><span>面板</span>{(['compact', 'normal', 'wide'] as const).map((size, index) => <button className={detailEditorSize === size ? 'active' : ''} key={size} onClick={() => setDetailEditorSize(size)}>{['窄', '标准', '宽'][index]}</button>)}<span>文字</span><button onClick={() => setDetailNoteScale((value) => Math.max(.8, Number((value - .1).toFixed(1))))}>A−</button><button onClick={() => setDetailNoteScale((value) => Math.min(1.6, Number((value + .1).toFixed(1))))}>A＋</button></div>
            <label>错误原因<select value={detailReason} onChange={(event) => setDetailReason(event.target.value)}><option value="">请选择</option>{REASONS.map((item) => <option key={item}>{item}</option>)}</select></label>
            <label>我的笔记 <span>右下角也可自由拖动大小</span><textarea style={{ fontSize: `${detailNoteScale}rem` }} value={detailNote} onChange={(event) => setDetailNote(event.target.value)} placeholder="补充正确思路、易错点或复习记录…" /></label>
            {codexReadyId === detailMistake.id && <div className="codex-help"><b>{companionStatus?.connected ? (codexBusy ? 'Codex 正在分析这道题…' : codexAnalysis ? 'Codex 分析已完成' : '本地 Codex 已连接') : siteToolsSupported ? 'Codex 已能读取这道题' : '尚未连接本地 408 AI 助手'}</b><span>{companionStatus?.connected ? (codexBusy ? '正在读取题目图片并生成考点、错因和检查步骤，请稍候。' : codexAnalysis?.analysis || '点击“AI 分析”后会直接调用你的 Codex 订阅，不需要 API。') : siteToolsSupported ? '回到旁边的对话，粘贴或直接说“帮我分析当前错题”。' : '请从桌面启动“408 AI 错题助手”；没有本地助手时仍可复制提问。'}</span></div>}
            <div className="dialog-actions detail-actions"><button className="dialog-cancel" onClick={() => setDetailMistake(null)} disabled={detailSaving || codexBusy}>关闭</button><button className="codex-button" onClick={() => void prepareCodexQuestion()} disabled={detailSaving || codexBusy}>{codexBusy ? '分析中…' : companionStatus?.connected ? '✦ AI 分析' : '✦ 问 Codex'}</button><button className="dialog-connect" onClick={() => void saveMistakeDetail()} disabled={detailSaving || codexBusy}>{detailSaving ? '正在保存…' : '保存修改'}</button></div>
          </div>
        </section>
      </div>}
      {summaryOpen && <div className="modal-backdrop summary-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !summaryBusy) setSummaryOpen(false); }}>
        <section className="summary-dialog" role="dialog" aria-modal="true" aria-labelledby="summary-title">
          <button className="dialog-close" onClick={() => setSummaryOpen(false)} disabled={summaryBusy} aria-label="关闭">×</button>
          <span className="dialog-kicker">限定范围，避免内容过多</span>
          <h2 id="summary-title">AI 错题总结</h2>
          <p>{SUBJECTS.find((subject) => subject.code === filterSubject)?.name} · {filterChapter}{summaryScope === 'section' && filterSection !== '全部小节' ? ` · ${filterSection}` : ''}</p>
          <div className="summary-scope"><button className={summaryScope === 'chapter' ? 'active' : ''} onClick={() => { setSummaryScope('chapter'); setSummaryResult(null); setSummaryError(''); }}>总结本章</button><button className={summaryScope === 'section' ? 'active' : ''} onClick={() => { setSummaryScope('section'); setSummaryResult(null); setSummaryError(''); }}>总结当前小节</button></div>
          {!summaryResult && !summaryBusy && <div className="summary-ready"><b>{summaryScope === 'chapter' ? '会综合这一章的全部错题' : filterSection === '全部小节' ? '请先在错题本上方选一个具体小节' : '只综合当前小节的错题'}</b><span>总结包含重复错因、补弱优先级、复习安排和做题检查清单；此功能使用 Codex 额度。</span></div>}
          {summaryBusy && <div className="summary-loading"><i />正在生成针对性的错题总结，请稍候…</div>}
          {summaryError && <div className="summary-error">{summaryError}</div>}
          {summaryResult && <div className="summary-result"><section><h3>掌握概况</h3><p>{summaryResult.overview}</p></section>{([['重复问题', summaryResult.patterns], ['优先补强', summaryResult.priorities], ['复习安排', summaryResult.reviewPlan], ['做题检查清单', summaryResult.checklist]] as const).map(([title, items]) => <section key={title}><h3>{title}</h3><ol>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ol></section>)}</div>}
          <div className="dialog-actions"><button className="dialog-cancel" onClick={() => setSummaryOpen(false)} disabled={summaryBusy}>关闭</button><button className="dialog-connect" onClick={() => void generateSummary()} disabled={summaryBusy || (summaryScope === 'section' && filterSection === '全部小节')}>{summaryBusy ? '总结中…' : summaryResult ? '重新生成' : '开始总结'}</button></div>
        </section>
      </div>}
      {githubDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !githubConnecting) setGithubDialogOpen(false); }}>
        <section className="github-dialog" role="dialog" aria-modal="true" aria-labelledby="github-dialog-title">
          <button className="dialog-close" onClick={() => setGithubDialogOpen(false)} disabled={githubConnecting} aria-label="关闭">×</button>
          <span className="dialog-kicker">第一次使用只需设置一次</span>
          <h2 id="github-dialog-title">连接私有 PDF 仓库</h2>
          <p>创建一个只允许读取 <b>{GITHUB_REPO}</b> 的访问令牌，网页就能按章节加载 PDF。</p>
          <ol>
            <li>点下面的按钮，在 GitHub 选择 <b>Only select repositories</b></li>
            <li>只勾选 <b>{GITHUB_REPO}</b>，并保持 <b>Contents: Read-only</b></li>
            <li>创建后复制令牌，粘贴到这里</li>
          </ol>
          <a className="token-link" href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer">创建只读访问令牌 ↗</a>
          <label htmlFor="github-token">GitHub 访问令牌</label>
          <input id="github-token" type="password" value={githubTokenDraft} onChange={(event) => setGithubTokenDraft(event.target.value)} placeholder="github_pat_…" autoComplete="off" onKeyDown={(event) => { if (event.key === 'Enter' && !githubConnecting) void connectGitHubRepo(); }} />
          {githubError && <div className="github-error">{githubError}</div>}
          <div className="dialog-actions"><button className="dialog-cancel" onClick={() => setGithubDialogOpen(false)} disabled={githubConnecting}>取消</button><button className="dialog-connect" onClick={() => void connectGitHubRepo()} disabled={githubConnecting}>{githubConnecting ? '正在连接…' : '连接并打开练习册'}</button></div>
          <small>令牌只保存在当前标签页，不会写进网页代码，也不会上传到其他地方。</small>
        </section>
      </div>}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}

