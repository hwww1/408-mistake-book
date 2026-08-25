import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  getSetting,
  listMistakes,
  type Mistake,
  putMistake,
  removeMistake,
  setSetting,
} from './lib/db';

type LocalFileHandle = {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
};

type LocalDirectoryHandle = {
  kind: 'directory';
  name: string;
  entries: () => AsyncIterableIterator<[string, LocalFileHandle | LocalDirectoryHandle]>;
  queryPermission?: (options: { mode: 'read' }) => Promise<'granted' | 'denied' | 'prompt'>;
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
type View = 'reader' | 'mistakes';

const SUBJECTS = [
  { code: 'DS', name: '数据结构', tone: 'green' },
  { code: 'CO', name: '计算机组成原理', tone: 'orange' },
  { code: 'OS', name: '操作系统', tone: 'blue' },
  { code: 'CN', name: '计算机网络', tone: 'violet' },
];

const REASONS = ['概念不清', '计算错误', '审题失误', '知识遗忘', '方法不熟', '其他'];

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
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draftSelection, setDraftSelection] = useState<Rect | null>(null);
  const [questionNo, setQuestionNo] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [toast, setToast] = useState('');
  const [filterSubject, setFilterSubject] = useState('全部');
  const [filterStatus, setFilterStatus] = useState('待掌握');
  const [search, setSearch] = useState('');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasBoxRef = useRef<HTMLDivElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const renderToken = useRef(0);

  const refreshMistakes = useCallback(async () => {
    setMistakes(await listMistakes());
  }, []);

  const loadRoot = useCallback(async (root: LocalDirectoryHandle) => {
    setReaderMessage('正在读取分节练习册…');
    const files = await scanFolder(root);
    setEntries(files);
    setConnectedName(root.name);
    const first = files.find((file) => file.subjectCode === activeSubject && file.version === '做题版') || files[0];
    if (first) {
      setActiveSubject(first.subjectCode);
      setSelectedEntry(first);
      setReaderMessage('正在打开 PDF…');
    } else {
      setReaderMessage('这个文件夹中没有找到 PDF');
    }
  }, [activeSubject]);

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
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!selectedEntry) return;
    let cancelled = false;
    setSelection(null);
    setDraftSelection(null);
    setPageNumber(1);
    setReaderMessage('正在打开 PDF…');
    selectedEntry.handle.getFile().then((file) => file.arrayBuffer()).then(async (data) => {
      const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const document = await pdfjs.getDocument({ data }).promise;
      if (cancelled) {
        await (document as any).destroy();
        return;
      }
      setPdfDocument((current: any) => {
        if (current) current.destroy().catch(() => undefined);
        return document;
      });
      setPageCount(document.numPages);
      setReaderMessage('');
    }).catch(() => setReaderMessage('这个 PDF 没有成功打开，请换一个文件试试'));
    return () => { cancelled = true; };
  }, [selectedEntry]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;
    const token = ++renderToken.current;
    setReaderMessage('正在显示第 ' + pageNumber + ' 页…');
    setSelection(null);
    setDraftSelection(null);
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
      if (token === renderToken.current) setReaderMessage('');
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

  const filteredMistakes = useMemo(() => mistakes.filter((mistake) => {
    if (filterSubject !== '全部' && mistake.subjectCode !== filterSubject) return false;
    if (filterStatus === '待掌握' && mistake.mastered) return false;
    if (filterStatus === '已掌握' && !mistake.mastered) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${mistake.subject} ${mistake.chapter} ${mistake.section} ${mistake.questionNo} ${mistake.reason} ${mistake.note}`.toLowerCase().includes(query);
  }), [filterStatus, filterSubject, mistakes, search]);

  async function connectFolder() {
    const picker = (window as unknown as {
      showDirectoryPicker?: (options?: { mode: 'read' }) => Promise<LocalDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      window.alert('请使用最新版 Microsoft Edge 或 Chrome 打开。');
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

  function chooseSubject(code: string) {
    setActiveSubject(code);
    const first = entries.find((entry) => entry.subjectCode === code && entry.version === '做题版') || entries.find((entry) => entry.subjectCode === code);
    if (first) setSelectedEntry(first);
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
      setToast('题目已框选，可以加入错题本');
    } else {
      setDraftSelection(null);
    }
  }

  async function addMistake() {
    const canvas = canvasRef.current;
    if (!canvas || !selection || !selectedEntry) return;
    const bounds = canvas.getBoundingClientRect();
    const ratioX = canvas.width / bounds.width;
    const ratioY = canvas.height / bounds.height;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(selection.width * ratioX));
    crop.height = Math.max(1, Math.round(selection.height * ratioY));
    const context = crop.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, crop.width, crop.height);
    context.drawImage(
      canvas,
      Math.round(selection.x * ratioX), Math.round(selection.y * ratioY), crop.width, crop.height,
      0, 0, crop.width, crop.height,
    );
    const image = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, 'image/png'));
    if (!image) return;
    const mistake: Mistake = {
      id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      subject: selectedEntry.subject, subjectCode: selectedEntry.subjectCode,
      chapter: selectedEntry.chapter, section: selectedEntry.section, version: selectedEntry.version,
      pdfName: selectedEntry.name, pdfPath: selectedEntry.path, page: pageNumber,
      questionNo: questionNo.trim(), reason: reason || '未填写', note: note.trim(), mastered: false, image,
    };
    await putMistake(mistake);
    await refreshMistakes();
    setQuestionNo(''); setReason(''); setNote(''); setSelection(null);
    setToast('已加入错题本');
  }

  async function toggleMastered(mistake: Mistake) {
    await putMistake({ ...mistake, mastered: !mistake.mastered });
    await refreshMistakes();
  }

  async function deleteMistake(mistake: Mistake) {
    if (!window.confirm('确定删除这道错题吗？')) return;
    await removeMistake(mistake.id);
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
        await putMistake({ ...mistake, image: dataUrlToBlob(imageDataUrl) });
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
      <header className="topbar">
        <button className="brand" onClick={() => setView('reader')} aria-label="返回练习册">
          <span className="brand-mark">错</span>
          <span><b>408 错题收集器</b><small>框选题目，一键加入错题本</small></span>
        </button>
        <div className="top-actions">
          <span className="privacy-pill"><i />仅保存在本机</span>
          <button className={view === 'mistakes' ? 'ghost-button active' : 'ghost-button'} onClick={() => setView(view === 'reader' ? 'mistakes' : 'reader')}>
            {view === 'reader' ? '我的错题' : '返回练习册'} <b>{mistakes.length}</b>
          </button>
        </div>
      </header>

      {view === 'reader' ? (
        <div className="workspace">
          <aside className="sidebar">
            <button className="folder-button" onClick={connectFolder}>
              <span className="folder-icon" />
              <span><b>{connectedName ? '练习册已连接' : '选择练习册文件夹'}</b>{connectedName && <small>{connectedName}</small>}</span>
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
                {chapterGroups.map(([chapter, files], index) => <details key={chapter} open={index === 0 || files.some((file) => file.id === selectedEntry?.id)}><summary>{chapter}<small>{new Set(files.map((file) => file.section)).size}</small></summary><div>{files.map((file) => <button key={file.id} className={file.id === selectedEntry?.id ? 'pdf-link active' : 'pdf-link'} onClick={() => setSelectedEntry(file)}><span>{file.section}</span><em>{file.version.replace('版', '')}</em></button>)}</div></details>)}
              </div>
            </>}
            <div className="quick-card"><span>待复习</span><strong>{pendingCount ? `${pendingCount} 道还没掌握` : '还没有待复习错题'}</strong><p>{pendingCount ? '打开“我的错题”即可逐题复习。' : '框选第一道错题，复习列表会自动建立。'}</p></div>
          </aside>

          <section className="reader-panel">
            <div className="reader-toolbar">
              <div><span className="crumb">{selectedEntry ? `${selectedEntry.subject} / ${selectedEntry.chapter}` : '等待连接练习册'}</span><strong>{selectedEntry ? `${selectedEntry.section} · ${selectedEntry.version}` : '请选择 D:\\408\\按章节整理'}</strong></div>
              <div className="page-controls">
                <button disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} aria-label="上一页">‹</button>
                <span>第 <b>{pageNumber}</b> / {pageCount || '—'} 页</span>
                <button disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} aria-label="下一页">›</button>
                <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label="缩放"><option value={0.8}>80%</option><option value={1}>100%</option><option value={1.2}>120%</option><option value={1.5}>150%</option></select>
              </div>
            </div>
            <div className="document-stage">
              {!selectedEntry ? <div className="connect-empty"><div className="empty-icon"><span /></div><h2>连接你的分节练习册</h2><p>点击下方按钮，选择 <b>D:\408\按章节整理</b></p><button onClick={connectFolder}>选择练习册文件夹</button><small>只读取 PDF，文件不会被上传或修改</small></div> : <div className="canvas-wrap" ref={canvasBoxRef} onPointerDown={beginSelection} onPointerMove={moveSelection} onPointerUp={endSelection} onPointerCancel={endSelection}><canvas ref={canvasRef} />{activeRect && <div className={`selection-box ${selection ? 'done' : ''}`} style={{ left: activeRect.x, top: activeRect.y, width: activeRect.width, height: activeRect.height }}><span>{selection ? '已框选' : '松开完成'}</span></div>}{readerMessage && <div className="reader-message"><i />{readerMessage}</div>}</div>}
            </div>
          </section>

          <aside className="capture-panel">
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
          <div className="mistakes-heading"><div><span>我的错题</span><h2>{mistakes.length} 道错题，{pendingCount} 道待掌握</h2></div><div className="heading-actions"><input ref={backupInputRef} className="backup-input" type="file" accept="application/json,.json" onChange={importBackup} /><button className="backup-button" onClick={() => backupInputRef.current?.click()}>导入备份</button><button className="backup-button" disabled={!mistakes.length} onClick={exportBackup}>导出备份</button><button className="print-button" disabled={!filteredMistakes.length} onClick={printMistakes}>打印 / 保存为 PDF</button></div></div>
          <div className="filterbar"><select value={filterSubject} onChange={(event) => setFilterSubject(event.target.value)}><option>全部</option>{SUBJECTS.map((subject) => <option key={subject.code} value={subject.code}>{subject.name}</option>)}</select><select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}><option>全部状态</option><option>待掌握</option><option>已掌握</option></select><div className="mistake-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索题号、章节、错因或笔记" /></div></div>
          <div className="sync-note"><b>换电脑使用：</b>旧电脑点击“导出备份”，在新电脑打开同一个网站后点击“导入备份”。PDF 和错题不会公开上传。</div>
          {filteredMistakes.length ? <div className="mistake-grid">{filteredMistakes.map((mistake) => <article className={mistake.mastered ? 'mistake-card mastered' : 'mistake-card'} key={mistake.id}><div className="mistake-image"><MistakeImage image={mistake.image} alt={`${mistake.section} 第${mistake.questionNo || ''}题`} />{mistake.mastered && <span>已掌握</span>}</div><div className="mistake-body"><div className="mistake-tags"><span>{mistake.subjectCode}</span><span>{mistake.section.split(' ')[0]}</span><span>第{mistake.page}页</span></div><h3>{mistake.questionNo ? `第 ${mistake.questionNo} 题` : '未填写题号'} · {mistake.reason}</h3><p className="mistake-path">{mistake.chapter} / {mistake.section}</p>{mistake.note && <p className="mistake-note">{mistake.note}</p>}<div className="mistake-actions"><button onClick={() => toggleMastered(mistake)}>{mistake.mastered ? '标记为待复习' : '✓ 我已掌握'}</button><button className="delete-button" onClick={() => deleteMistake(mistake)}>删除</button></div></div></article>)}</div> : <div className="mistakes-empty"><div>✓</div><h3>{mistakes.length ? '没有符合条件的错题' : '错题本还是空的'}</h3><p>{mistakes.length ? '换一个筛选条件再看看。' : '返回练习册，拖动框选题目后点击“加入错题本”。'}</p><button onClick={() => setView('reader')}>返回练习册</button></div>}
        </section>
      )}
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}
