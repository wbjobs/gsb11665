/* 系统文件处理器
 * 技术栈：File Handling API + File API + FileReader + DOM + IndexedDB
 */
'use strict';

/* ---------------- 常量 ---------------- */
const ACCEPT = {
  extensions: ['.txt', '.log', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
  mimePrefixes: ['text/', 'image/'],
  mimes: ['application/json']
};
const MAX_TEXT_PREVIEW = 4096;      // 文本预览最大字符数
const MAX_HISTORY = 50;             // IndexedDB 最多保留条数
const DB_NAME = 'file-handler-db';
const DB_STORE = 'records';

/* ---------------- 小工具 ---------------- */
const $ = (sel) => document.querySelector(sel);

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('#toast-area').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4200);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function isAcceptedFile(file) {
  const name = (file.name || '').toLowerCase();
  const extOk = ACCEPT.extensions.some((e) => name.endsWith(e));
  const typeOk = ACCEPT.mimes.includes(file.type) ||
    ACCEPT.mimePrefixes.some((p) => (file.type || '').startsWith(p));
  return extOk || typeOk;
}

function isImage(file) {
  return (file.type || '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name || '');
}

/* ---------------- IndexedDB ---------------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveRecord(record) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).add(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await pruneHistory(db);
    db.close();
  } catch (err) {
    console.warn('记录保存失败', err);
  }
}

async function pruneHistory(db) {
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= MAX_HISTORY) return;
  all.sort((a, b) => b.time - a.time);
  const stale = all.slice(MAX_HISTORY);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    stale.forEach((r) => store.delete(r.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHistory() {
  try {
    const db = await openDB();
    const all = await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all.sort((a, b) => b.time - a.time);
  } catch (err) {
    console.warn('历史记录读取失败', err);
    return [];
  }
}

async function clearHistory() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    renderHistory([]);
    toast('历史记录已清空', 'info');
  } catch (err) {
    toast('清空历史记录失败：' + err.message, 'error');
  }
}

/* ---------------- 文件读取（FileReader） ---------------- */
function readAsText(file, maxChars) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result || '');
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（内容过长，已截断）';
      resolve(text);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader 读取失败'));
    reader.onabort = () => reject(new Error('读取被中止'));
    reader.readAsText(file);
  });
}

/* ---------------- 渲染 ---------------- */
function buildFileCard({ name, type, size, time, preview, imageURL, error }) {
  const li = document.createElement('li');
  li.className = 'file-card';

  const head = document.createElement('div');
  head.className = 'file-head';
  const title = document.createElement('strong');
  title.textContent = name || '(未命名)';
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = `${type || '未知类型'} · ${formatSize(size || 0)} · ${new Date(time).toLocaleString()}`;
  head.append(title, meta);
  li.appendChild(head);

  if (error) {
    const err = document.createElement('p');
    err.className = 'file-error';
    err.textContent = '⚠ ' + error;
    li.appendChild(err);
  } else if (imageURL) {
    const img = document.createElement('img');
    img.className = 'file-image';
    img.src = imageURL;
    img.alt = name;
    li.appendChild(img);
  } else if (preview != null) {
    const pre = document.createElement('pre');
    pre.className = 'file-preview';
    pre.textContent = preview || '（空文件）';
    li.appendChild(pre);
  }
  return li;
}

function renderHistory(records) {
  const list = $('#history-list');
  list.innerHTML = '';
  if (!records.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-tip';
    empty.textContent = '暂无记录';
    list.appendChild(empty);
    return;
  }
  for (const rec of records) {
    const imageURL = rec.blob ? URL.createObjectURL(rec.blob) : null;
    const card = buildFileCard({
      name: rec.name, type: rec.type, size: rec.size, time: rec.time,
      preview: rec.preview, imageURL, error: rec.error
    });
    card.classList.add('history-card');
    list.appendChild(card);
  }
}

/* ---------------- 核心处理流程 ---------------- */
const processedKeys = new Set();   // 会话内去重，防止重复打开崩溃/重复渲染
let currentCount = 0;

async function processOneFile(file, source) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (processedKeys.has(key)) {
    toast(`「${file.name}」已处理过，忽略重复打开`, 'warn');
    return;
  }
  processedKeys.add(key);

  const base = { name: file.name, type: file.type || '未知', size: file.size, time: Date.now() };

  // 类型不匹配
  if (!isAcceptedFile(file)) {
    toast(`类型不匹配：「${file.name}」（${file.type || '未知类型'}）不在支持范围内`, 'error');
    const card = buildFileCard({ ...base, error: '不支持的文件类型' });
    $('#current-list').appendChild(card);
    await saveRecord({ ...base, source, error: '不支持的文件类型' });
    return;
  }

  try {
    let preview = null, imageURL = null, blob = null;
    if (isImage(file)) {
      imageURL = URL.createObjectURL(file);
      blob = file.size <= 2 * 1024 * 1024 ? file : null; // 大图片不存库，避免占满 IndexedDB
    } else {
      preview = await readAsText(file, MAX_TEXT_PREVIEW);
    }
    const card = buildFileCard({ ...base, preview, imageURL });
    $('#current-list').appendChild(card);
    currentCount += 1;
    $('#current-count').textContent = String(currentCount);
    await saveRecord({ ...base, source, preview, blob });
    toast(`已处理：${file.name}`, 'success');
  } catch (err) {
    toast(`读取失败：「${file.name}」${err.message || err}`, 'error');
    const card = buildFileCard({ ...base, error: '读取失败：' + (err.message || err) });
    $('#current-list').appendChild(card);
    await saveRecord({ ...base, source, error: '读取失败' });
  }
  renderHistory(await loadHistory());
}

/** 顺序处理多个文件（保证多文件按顺序处理） */
async function processFiles(files, source) {
  const arr = Array.from(files || []);
  if (!arr.length) return;
  for (const file of arr) {
    await processOneFile(file, source);
  }
}

/* ---------------- File Handling API（系统“打开方式”入口） ---------------- */
function setupFileHandling() {
  if (!('launchQueue' in window) || !('setConsumer' in window.launchQueue)) {
    return false;
  }
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || !launchParams.files.length) return;
    // launchParams.files 是 FileSystemFileHandle，需要 getFile() 取 File
    for (const handle of launchParams.files) {
      try {
        const file = await handle.getFile();
        await processOneFile(file, '系统打开方式');
      } catch (err) {
        // 文件被删除 / 无权限 / 读取句柄失败
        toast(`无法打开系统传入的文件「${handle.name || '?'}」：文件可能已被删除或移动`, 'error');
        const card = buildFileCard({
          name: handle.name || '(未知文件)', type: '未知', size: 0,
          time: Date.now(), error: '文件不可访问（可能已被删除或移动）'
        });
        $('#current-list').appendChild(card);
      }
    }
  });
  return true;
}

/* ---------------- 降级方案：拖拽 + 手动选择 ---------------- */
function setupFallback() {
  const dropZone = $('#drop-zone');
  const input = $('#file-input');

  $('#pick-btn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  dropZone.addEventListener('click', () => input.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    processFiles(input.files, '手动选择');
    input.value = ''; // 允许再次选择同一文件
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
  dropZone.addEventListener('drop', (e) => {
    processFiles(e.dataTransfer.files, '拖拽');
  });
}

/* ---------------- 能力检测与横幅 ---------------- */
function detectCapabilities() {
  const caps = [
    { name: '安全上下文（HTTPS / localhost）', ok: window.isSecureContext,
      failTip: '当前不是安全上下文，File Handling API 与 Service Worker 不可用。请用 HTTPS 或 localhost 访问。' },
    { name: 'File Handling API（launchQueue）', ok: 'launchQueue' in window,
      failTip: '浏览器不支持 File Handling API，已降级为「拖拽 / 手动选择」模式。安装为 PWA 并使用 Chrome/Edge 可获得系统级集成。' },
    { name: 'Service Worker', ok: 'serviceWorker' in navigator,
      failTip: '不支持 Service Worker，无法注册为可安装的 PWA。' },
    { name: 'IndexedDB', ok: 'indexedDB' in window,
      failTip: '不支持 IndexedDB，最近处理记录将无法保存。' },
    { name: 'FileReader', ok: 'FileReader' in window,
      failTip: '不支持 FileReader，无法预览文件内容。' }
  ];
  const ul = $('#capability-list');
  for (const cap of caps) {
    const li = document.createElement('li');
    li.className = cap.ok ? 'cap-ok' : 'cap-fail';
    li.textContent = (cap.ok ? '✅ ' : '❌ ') + cap.name;
    ul.appendChild(li);
    if (!cap.ok) {
      const banner = document.createElement('div');
      banner.className = 'banner banner-warn';
      banner.textContent = '⚠ ' + cap.failTip;
      $('#banner-area').appendChild(banner);
    }
  }
  return Object.fromEntries(caps.map((c) => [c.name, c.ok]));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    if (reg.installing) {
      toast('正在安装应用组件…', 'info');
    }
  } catch (err) {
    // 注册失败提示
    const banner = document.createElement('div');
    banner.className = 'banner banner-error';
    banner.textContent = '⚠ 应用注册失败（Service Worker）：' + err.message +
      '。将无法被系统「打开方式」调用，但仍可手动选择文件。';
    $('#banner-area').appendChild(banner);
    toast('注册失败：' + err.message, 'error');
  }
}

/* ---------------- 启动 ---------------- */
async function init() {
  const caps = detectCapabilities();

  if (window.isSecureContext && 'serviceWorker' in navigator) {
    await registerServiceWorker();
  }

  const fileHandlingOK = window.isSecureContext && setupFileHandling();
  if (fileHandlingOK) {
    const banner = document.createElement('div');
    banner.className = 'banner banner-ok';
    banner.textContent = '✅ 已就绪：安装本应用后，可在系统「打开方式」中选择「系统文件处理器」。';
    $('#banner-area').appendChild(banner);
  }

  setupFallback(); // 降级方案始终可用
  $('#clear-history').addEventListener('click', clearHistory);

  if (caps['IndexedDB']) {
    renderHistory(await loadHistory()); // 恢复最近处理记录
  }
}

init();
