(() => {
  'use strict';

  const DOCUMENT_EXTENSIONS = [
    '.txt', '.text', '.md', '.markdown', '.csv', '.log', '.json', '.xml',
    '.yaml', '.yml', '.html', '.htm', '.css', '.js', '.mjs', '.ts'
  ];
  const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp'];
  const PDF_EXTENSIONS = ['.pdf'];
  const DOCUMENT_MIME_TYPES = [
    'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/markdown',
    'text/csv', 'text/xml', 'text/yaml', 'application/javascript',
    'application/json', 'application/xml', 'application/yaml', 'application/x-yaml'
  ];
  const IMAGE_MIME_TYPES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
    'image/avif', 'image/x-icon', 'image/bmp'
  ];
  const PDF_MIME_TYPES = ['application/pdf'];
  const IGNORED_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'inode/x-empty']);
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const MAX_STORED_CHARS = 20000;
  const MAX_HISTORY = 50;

  const EXTENSION_CATEGORY = buildExtensionCategory();
  const MIME_CATEGORY = buildMimeCategory();
  const ACCEPT_ATTRIBUTE = [
    ...DOCUMENT_EXTENSIONS,
    ...IMAGE_EXTENSIONS,
    ...PDF_EXTENSIONS,
    ...DOCUMENT_MIME_TYPES,
    ...IMAGE_MIME_TYPES,
    ...PDF_MIME_TYPES
  ].join(',');

  const els = {};
  const state = {
    entries: [],
    history: [],
    seen: new Map(),
    chain: Promise.resolve(),
    nextOrder: 1,
    db: null,
    dbReady: null,
    dbError: null,
    deferredPrompt: null,
    installed: detectInstalledState(),
    swPromise: null,
    swRegistration: null,
    swError: null,
    manifestError: null,
    registrationInProgress: false,
    dragCounter: 0,
    historyUrls: new Map()
  };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    Object.assign(els, {
      installButton: document.getElementById('install-button'),
      pickButton: document.getElementById('pick-button'),
      fileInput: document.getElementById('file-input'),
      secureCard: document.getElementById('secure-card'),
      supportCard: document.getElementById('support-card'),
      registrationCard: document.getElementById('registration-card'),
      secureStatus: document.getElementById('secure-status'),
      supportStatus: document.getElementById('support-status'),
      registrationStatus: document.getElementById('registration-status'),
      dropZone: document.getElementById('drop-zone'),
      fileList: document.getElementById('file-list'),
      queueSummary: document.getElementById('queue-summary'),
      historyList: document.getElementById('history-list'),
      clearHistory: document.getElementById('clear-history'),
      toastRegion: document.getElementById('toast-region'),
      fileCardTemplate: document.getElementById('file-card-template')
    });

    els.fileInput.accept = ACCEPT_ATTRIBUTE;
    bindEvents();
    updateEnvironmentStatus();
    updateRegistrationStatus();
    renderFileList();
    initializeHistory();

    if (window.isSecureContext) {
      registerServiceWorker(false).catch(() => {});
      validateManifest().catch(() => {});
    }
    setupLaunchQueue();
  }

  function bindEvents() {
    els.installButton.addEventListener('click', handleInstallClick);
    els.pickButton.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      enqueueItems(Array.from(els.fileInput.files || []).map((file) => ({ file })), 'manual');
      els.fileInput.value = '';
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredPrompt = event;
      updateRegistrationStatus();
    });
    window.addEventListener('appinstalled', () => {
      state.installed = true;
      state.deferredPrompt = null;
      safeStorageSet('file-handler-lab-installed', '1');
      updateRegistrationStatus();
      toast('安装成功，浏览器已写入系统文件关联。可在系统“打开方式”中选择本应用。', 'success');
    });

    els.dropZone.addEventListener('click', () => els.fileInput.click());
    els.dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        els.fileInput.click();
      }
    });
    els.dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      state.dragCounter += 1;
      els.dropZone.classList.add('dragging');
    });
    els.dropZone.addEventListener('dragover', (event) => event.preventDefault());
    els.dropZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      state.dragCounter = Math.max(0, state.dragCounter - 1);
      if (state.dragCounter === 0) els.dropZone.classList.remove('dragging');
    });
    els.dropZone.addEventListener('drop', handleDrop);

    els.historyList.addEventListener('click', handleHistoryAction);
    els.clearHistory.addEventListener('click', clearHistory);
  }

  async function handleInstallClick() {
    const environment = getEnvironment();
    if (!environment.secure) {
      toast('当前不是安全上下文。请通过 HTTPS 或 localhost 访问后再注册。', 'error');
      return;
    }
    if (!environment.fileHandlingSupported) {
      toast('当前浏览器不支持 File Handling API，已保留手动选择与拖拽作为降级方案。', 'error');
      return;
    }

    state.registrationInProgress = true;
    updateRegistrationStatus();
    try {
      if (!state.swPromise) await registerServiceWorker(true);
      if (state.swError) throw state.swError;
      await validateManifest();
      if (state.manifestError) throw state.manifestError;

      const promptEvent = state.deferredPrompt;
      if (promptEvent) {
        promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice.outcome !== 'accepted') {
          toast('安装被取消，系统文件处理器尚未注册。', 'warn');
        }
        state.deferredPrompt = null;
      } else if (state.installed) {
        toast('应用已安装，文件处理器已由浏览器通过 Manifest 静态注册。', 'success');
      } else {
        toast('未捕获浏览器安装入口：请使用地址栏“安装”菜单；安装后系统关联才会生效。', 'warn');
      }
    } catch (error) {
      toast(`注册失败：${friendlyError(error)}。仍可使用手动选择或拖拽文件。`, 'error');
    } finally {
      state.registrationInProgress = false;
      updateRegistrationStatus();
    }
  }

  async function registerServiceWorker(manual) {
    if (state.swPromise) return state.swPromise;
    if (!('serviceWorker' in navigator)) {
      state.swError = new Error('当前浏览器不支持 Service Worker');
      updateRegistrationStatus();
      throw state.swError;
    }

    state.swError = null;
    updateRegistrationStatus();
    state.swPromise = navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        state.swRegistration = registration;
        updateRegistrationStatus();
        if (manual) toast('Service Worker 注册成功。', 'success');
        return registration;
      })
      .catch((error) => {
        state.swError = error;
        state.swPromise = null;
        updateRegistrationStatus();
        toast(`Service Worker 注册失败：${friendlyError(error)}`, 'error');
        throw error;
      });
    return state.swPromise;
  }

  async function validateManifest() {
    if (!window.isSecureContext) return null;
    try {
      const response = await fetch('/manifest.webmanifest', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = await response.json();
      if (!Array.isArray(manifest.file_handlers) || manifest.file_handlers.length === 0) {
        throw new Error('Manifest 缺少 file_handlers 配置');
      }
      state.manifestError = null;
      updateRegistrationStatus();
      return manifest;
    } catch (error) {
      const invalidManifest = error instanceof SyntaxError || String(error.message).includes('file_handlers');
      state.manifestError = invalidManifest ? error : null;
      if (invalidManifest) {
        updateRegistrationStatus();
        toast(`文件处理器配置无效：${friendlyError(error)}`, 'error');
        throw error;
      }
      return null;
    }
  }

  function setupLaunchQueue() {
    if (typeof window.launchQueue?.setConsumer !== 'function') return;
    window.launchQueue.setConsumer((launchParams) => {
      const handles = Array.isArray(launchParams?.files) ? launchParams.files : [];
      if (handles.length === 0) return;
      toast(`系统“打开方式”传入 ${handles.length} 个文件。`, 'success');
      enqueueItems(handles.map((handle) => ({ handle })), 'system').catch((error) => {
        toast(`接收系统文件失败：${friendlyError(error)}`, 'error');
      });
    });
  }

  async function handleDrop(event) {
    event.preventDefault();
    state.dragCounter = 0;
    els.dropZone.classList.remove('dragging');
    try {
      const items = await collectDroppedItems(event.dataTransfer);
      if (items.length === 0) {
        toast('没有可处理的文件。请拖入一个或多个文件。', 'warn');
        return;
      }
      await enqueueItems(items, 'drag');
    } catch (error) {
      toast(`读取拖拽内容失败：${friendlyError(error)}`, 'error');
    }
  }

  async function collectDroppedItems(dataTransfer) {
    if (!dataTransfer) return [];
    const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file');
    if (items.length === 0) {
      return Array.from(dataTransfer.files || []).map((file) => ({ file }));
    }

    const result = [];
    for (const item of items) {
      if (typeof item.getAsFileSystemHandle === 'function') {
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle) {
            result.push({ handle });
            continue;
          }
        } catch {
          const file = item.getAsFile();
          if (file) result.push({ file });
          continue;
        }
      }

      const fsEntry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (fsEntry?.isDirectory) {
        result.push({ directoryName: fsEntry.name });
      } else {
        const file = item.getAsFile();
        if (file) result.push({ file });
      }
    }
    return result;
  }

  async function enqueueItems(items, source) {
    if (state.entries.length === 0) els.fileList.replaceChildren();
    const entries = items
      .filter(Boolean)
      .map((item) => createEntry(item, source, state.nextOrder++));
    state.entries.push(...entries);
    entries.forEach(renderEntry);
    updateQueueSummary();

    for (const entry of entries) {
      state.chain = state.chain.then(async () => {
        try {
          await processEntry(entry);
        } catch (error) {
          failEntry(entry, error);
          await persistEntry(entry);
          renderEntry(entry);
        }
      });
    }
    return state.chain;
  }

  function createEntry(item, source, order) {
    const handle = item.handle && typeof item.handle === 'object' ? item.handle : null;
    const file = item.file instanceof File ? item.file : null;
    const directoryName = typeof item.directoryName === 'string' ? item.directoryName : '';
    const isDirectory = Boolean(directoryName || handle?.kind === 'directory');
    return {
      id: createId(),
      order,
      source,
      handle,
      file,
      name: file?.name || handle?.name || directoryName || '未命名文件',
      size: file?.size ?? null,
      lastModified: file?.lastModified ?? null,
      type: file?.type || '',
      category: null,
      kind: isDirectory ? 'directory' : null,
      status: 'queued',
      errorCode: null,
      errorMessage: null,
      previewKind: null,
      previewUrl: null,
      snippet: '',
      truncated: false,
      thumbnailBlob: null,
      isRepeat: false,
      el: null
    };
  }

  async function processEntry(entry) {
    entry.status = 'reading';
    entry.errorCode = null;
    entry.errorMessage = null;
    renderEntry(entry);

    let file = entry.file;
    if (!file) {
      if (entry.kind === 'directory') {
        return finishMismatch(entry, '文件夹不是可预览的文件类型');
      }
      if (!entry.handle || typeof entry.handle.getFile !== 'function') {
        throw makeError('invalid-entry', '没有可用的文件句柄或 File 对象');
      }
      file = await entry.handle.getFile();
      entry.file = file;
    }

    entry.name = file.name || entry.name;
    entry.size = file.size;
    entry.lastModified = file.lastModified;
    entry.type = file.type || '';

    const typeInfo = inspectFileType(file);
    if (!typeInfo.supported) {
      return finishMismatch(entry, typeInfo.reason);
    }

    entry.category = typeInfo.category;
    entry.kind = typeInfo.kind;

    const duplicateKey = fingerprint(file);
    const previous = state.seen.get(duplicateKey);
    if (previous && (previous.status === 'ready' || previous.status === 'duplicate')) {
      entry.isRepeat = true;
      entry.category = previous.category;
      entry.kind = previous.kind;
      entry.previewKind = previous.previewKind;
      entry.previewUrl = previous.previewUrl;
      entry.snippet = previous.snippet;
      entry.truncated = previous.truncated;
      entry.thumbnailBlob = previous.thumbnailBlob;
      entry.status = 'duplicate';
      await persistEntry(entry);
      renderEntry(entry);
      updateQueueSummary();
      return;
    }
    state.seen.set(duplicateKey, entry);

    if (entry.kind === 'document') {
      const blob = file.size > MAX_TEXT_BYTES ? file.slice(0, MAX_TEXT_BYTES) : file;
      const text = await readWithFileReader(blob, 'text');
      entry.snippet = text.slice(0, MAX_STORED_CHARS);
      entry.truncated = file.size > MAX_TEXT_BYTES || text.length > MAX_STORED_CHARS;
      entry.previewKind = 'text';
    } else if (entry.kind === 'image') {
      await prepareImagePreview(entry, file);
    } else if (entry.kind === 'pdf') {
      await preparePdfPreview(entry, file);
    } else {
      throw makeError('unsupported-type', '无法确定文件处理方式');
    }

    entry.status = 'ready';
    await persistEntry(entry);
    renderEntry(entry);
    updateQueueSummary();
  }

  async function prepareImagePreview(entry, file) {
    if (file.size === 0) throw makeError('empty-file', '图片文件为空');
    let sourceUrl;
    if (file.size <= 20 * 1024 * 1024) {
      sourceUrl = await readWithFileReader(file, 'data-url');
    } else {
      await readWithFileReader(file.slice(0, 64 * 1024), 'array-buffer');
      sourceUrl = URL.createObjectURL(file);
    }

    try {
      const thumbnail = await createImageThumbnail(sourceUrl);
      entry.thumbnailBlob = thumbnail;
      entry.previewUrl = URL.createObjectURL(thumbnail);
      if (sourceUrl.startsWith('blob:')) URL.revokeObjectURL(sourceUrl);
    } catch (error) {
      entry.previewUrl = sourceUrl;
      entry.errorMessage = '无法生成缩略图，已显示原始图片。';
    }
    entry.previewKind = 'image';
  }

  async function preparePdfPreview(entry, file) {
    if (file.size === 0) throw makeError('empty-file', 'PDF 文件为空');
    const header = await readWithFileReader(file.slice(0, 5), 'text');
    if (header !== '%PDF-') throw makeError('invalid-pdf', '文件内容不是有效的 PDF');
    entry.previewUrl = URL.createObjectURL(file);
    entry.previewKind = 'pdf';
  }

  function renderEntry(entry) {
    if (!entry.el) {
      const fragment = els.fileCardTemplate.content.cloneNode(true);
      entry.el = fragment.querySelector('.file-card');
      entry.el.dataset.entryId = entry.id;
      els.fileList.appendChild(fragment);
    }

    const icon = entry.el.querySelector('.file-icon');
    const name = entry.el.querySelector('.file-name');
    const meta = entry.el.querySelector('.file-meta');
    const stateBadge = entry.el.querySelector('.file-state');
    const preview = entry.el.querySelector('.preview');

    icon.textContent = iconFor(entry);
    name.textContent = `${entry.order}. ${entry.name}`;
    meta.textContent = [
      entry.type || '未知 MIME 类型',
      formatBytes(entry.size),
      formatDate(entry.lastModified),
      sourceLabel(entry.source)
    ].join(' · ');

    stateBadge.textContent = statusLabel(entry.status);
    stateBadge.className = `file-state ${statusClass(entry.status)}`;
    preview.replaceChildren();

    if (entry.status === 'error' || entry.status === 'unsupported') {
      const message = document.createElement('p');
      message.className = 'preview-message error';
      message.textContent = entry.errorMessage || '文件处理失败。';
      preview.appendChild(message);
      return;
    }

    if (entry.errorMessage && entry.status === 'ready') {
      const message = document.createElement('p');
      message.className = 'preview-message';
      message.textContent = entry.errorMessage;
      preview.appendChild(message);
    }

    if (entry.status === 'duplicate') {
      const message = document.createElement('p');
      message.className = 'preview-message';
      message.textContent = '检测到重复打开，已复用之前的预览结果。';
      preview.appendChild(message);
    }

    if (entry.previewKind === 'text') {
      const pre = document.createElement('pre');
      pre.textContent = entry.snippet || '（文件为空）';
      preview.appendChild(pre);
      if (entry.truncated) {
        const message = document.createElement('p');
        message.className = 'preview-message';
        message.textContent = '文件较大，仅显示并保存前 2 MB 内容。';
        preview.appendChild(message);
      }
    } else if (entry.previewKind === 'image' && entry.previewUrl) {
      const image = document.createElement('img');
      image.src = entry.previewUrl;
      image.alt = `${entry.name} 的图片预览`;
      preview.appendChild(image);
    } else if (entry.previewKind === 'pdf' && entry.previewUrl) {
      const frame = document.createElement('iframe');
      frame.src = entry.previewUrl;
      frame.title = `${entry.name} 的 PDF 预览`;
      frame.loading = 'lazy';
      preview.appendChild(frame);
    } else if (entry.status === 'reading') {
      const message = document.createElement('p');
      message.className = 'preview-message';
      message.textContent = '正在读取文件…';
      preview.appendChild(message);
    }
  }

  function renderFileList() {
    els.fileList.replaceChildren();
    if (state.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '等待系统“打开方式”、拖拽或手动选择文件。';
      els.fileList.appendChild(empty);
      return;
    }
    state.entries.forEach((entry) => {
      entry.el = null;
      renderEntry(entry);
    });
  }

  function updateQueueSummary() {
    const total = state.entries.length;
    if (total === 0) {
      els.queueSummary.textContent = '尚未接收文件';
      return;
    }
    const ready = state.entries.filter((entry) => entry.status === 'ready' || entry.status === 'duplicate').length;
    const failed = state.entries.filter((entry) => entry.status === 'error' || entry.status === 'unsupported').length;
    const reading = state.entries.filter((entry) => entry.status === 'reading' || entry.status === 'queued').length;
    els.queueSummary.textContent = `${total} 个文件 · ${ready} 个成功 · ${failed} 个失败 · ${reading} 个处理中`;
  }

  function finishMismatch(entry, reason) {
    entry.status = 'unsupported';
    entry.errorCode = 'unsupported-type';
    entry.errorMessage = `文件类型不匹配：${reason}`;
    return persistEntry(entry).then(() => {
      renderEntry(entry);
      updateQueueSummary();
      toast(entry.errorMessage, 'warn');
    });
  }

  function failEntry(entry, error) {
    const failure = classifyError(error);
    entry.status = 'error';
    entry.errorCode = failure.code;
    entry.errorMessage = failure.message;
    updateQueueSummary();
    toast(`${entry.name}：${failure.message}`, 'error');
  }

  function initializeHistory() {
    if (!('indexedDB' in window)) {
      state.dbError = new Error('当前浏览器不支持 IndexedDB');
      state.dbReady = Promise.resolve(false);
      renderHistory();
      toast('当前浏览器不支持 IndexedDB，最近处理记录不可用。', 'warn');
      return;
    }

    renderHistory();
    state.dbReady = new Promise((resolve) => {
      const request = indexedDB.open('file-handler-lab', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'id' });
          store.createIndex('processedAt', 'processedAt');
        }
      };
      request.onsuccess = async () => {
        state.db = request.result;
        state.dbError = null;
        try {
          await loadHistory();
        } catch (error) {
          state.dbError = error;
          renderHistory();
          toast(`读取最近处理记录失败：${friendlyError(error)}`, 'error');
        } finally {
          resolve(Boolean(state.db));
        }
      };
      request.onerror = () => {
        state.dbError = request.error || new Error('IndexedDB 打开失败');
        renderHistory();
        toast(`最近处理记录不可用：${friendlyError(state.dbError)}`, 'warn');
        resolve(false);
      };
      request.onblocked = () => {
        state.dbError = new Error('IndexedDB 被其他页面占用');
        renderHistory();
        toast('最近处理记录暂时不可用：IndexedDB 被其他页面占用。', 'warn');
        resolve(false);
      };
    });
  }

  async function loadHistory() {
    const records = await idbRequest(state.db.transaction('records', 'readonly').objectStore('records').getAll());
    state.history = (records || [])
      .sort((a, b) => (b.processedAt || 0) - (a.processedAt || 0))
      .slice(0, MAX_HISTORY);
    renderHistory();
  }

  async function persistEntry(entry) {
    if (state.dbReady) await state.dbReady;
    if (!state.db) return;
    entry.processedAt = Date.now();
    const record = {
      id: entry.id,
      name: entry.name,
      size: entry.size,
      lastModified: entry.lastModified,
      type: entry.type,
      category: entry.category,
      kind: entry.kind,
      source: entry.source,
      status: entry.status,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      previewKind: entry.previewKind,
      snippet: entry.snippet,
      truncated: entry.truncated,
      thumbnailBlob: entry.thumbnailBlob,
      handle: entry.handle,
      processedAt: entry.processedAt
    };

    try {
      const tx = state.db.transaction('records', 'readwrite');
      tx.objectStore('records').put(record);
      await idbTransaction(tx);
      await pruneHistory();
      await loadHistory();
    } catch (error) {
      state.dbError = error;
      toast(`保存最近处理记录失败：${friendlyError(error)}`, 'warn');
    }
  }

  async function pruneHistory() {
    const readTx = state.db.transaction('records', 'readonly');
    const records = await idbRequest(readTx.objectStore('records').getAll());
    if (!Array.isArray(records) || records.length <= MAX_HISTORY) return;

    const stale = records
      .sort((a, b) => (a.processedAt || 0) - (b.processedAt || 0))
      .slice(0, records.length - MAX_HISTORY);
    const tx = state.db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    stale.forEach((record) => store.delete(record.id));
    await idbTransaction(tx);
  }

  function renderHistory() {
    revokeHistoryUrls();
    els.historyList.replaceChildren();
    if (state.dbError) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = `最近记录不可用：${friendlyError(state.dbError)}`;
      els.historyList.appendChild(empty);
      return;
    }
    if (state.history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无最近处理记录。';
      els.historyList.appendChild(empty);
      return;
    }

    state.history.forEach((record) => {
      const item = document.createElement('article');
      item.className = 'history-item';

      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = record.name;
      const meta = document.createElement('p');
      meta.textContent = [
        record.type || '未知 MIME 类型',
        formatBytes(record.size),
        formatDate(record.processedAt),
        statusLabel(record.status)
      ].join(' · ');
      body.append(title, meta);

      if (record.previewKind === 'image' && record.thumbnailBlob) {
        const url = URL.createObjectURL(record.thumbnailBlob);
        state.historyUrls.set(record.id, url);
        const image = document.createElement('img');
        image.src = url;
        image.alt = `${record.name} 缩略图`;
        image.width = 72;
        image.height = 72;
        body.appendChild(image);
      } else if (record.previewKind === 'text' && record.snippet) {
        const snippet = document.createElement('p');
        snippet.textContent = record.snippet.slice(0, 160);
        body.appendChild(snippet);
      } else if (record.errorMessage) {
        const error = document.createElement('p');
        error.textContent = record.errorMessage;
        body.appendChild(error);
      }

      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.textContent = record.handle ? '重新打开' : '重新处理';
      reopen.dataset.action = 'reopen';
      reopen.dataset.id = record.id;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.dataset.action = 'remove';
      remove.dataset.id = record.id;
      actions.append(reopen, remove);

      item.append(body, actions);
      els.historyList.appendChild(item);
    });
  }

  async function handleHistoryAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const record = state.history.find((item) => item.id === button.dataset.id);
    if (!record) return;

    if (button.dataset.action === 'remove') {
      await deleteHistoryRecord(record.id);
      return;
    }
    await reopenHistoryRecord(record);
  }

  async function reopenHistoryRecord(record) {
    if (!record.handle || typeof record.handle.getFile !== 'function') {
      toast('该记录没有可恢复的文件句柄，无法重新读取原文件。', 'warn');
      return;
    }

    try {
      if (typeof record.handle.queryPermission === 'function') {
        const permission = await record.handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted' && typeof record.handle.requestPermission === 'function') {
          const requested = await record.handle.requestPermission({ mode: 'read' });
          if (requested !== 'granted') throw makeError('permission-denied', '未获得读取该文件的权限');
        }
      }
      await enqueueItems([{ handle: record.handle }], 'history');
    } catch (error) {
      const failure = classifyError(error);
      toast(`恢复记录失败：${failure.message}`, 'error');
    }
  }

  async function deleteHistoryRecord(id) {
    if (state.dbReady) await state.dbReady;
    if (!state.db) return;
    try {
      const tx = state.db.transaction('records', 'readwrite');
      tx.objectStore('records').delete(id);
      await idbTransaction(tx);
      await loadHistory();
    } catch (error) {
      toast(`删除记录失败：${friendlyError(error)}`, 'error');
    }
  }

  async function clearHistory() {
    if (state.dbReady) await state.dbReady;
    if (!state.db) return;
    try {
      const tx = state.db.transaction('records', 'readwrite');
      tx.objectStore('records').clear();
      await idbTransaction(tx);
      await loadHistory();
      toast('最近处理记录已清空。', 'success');
    } catch (error) {
      toast(`清空记录失败：${friendlyError(error)}`, 'error');
    }
  }

  function readWithFileReader(blob, mode) {
    return new Promise((resolve, reject) => {
      if (!('FileReader' in window)) {
        reject(makeError('unsupported-api', '当前浏览器不支持 FileReader'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || makeError('read-failed', 'FileReader 读取失败'));
      reader.onabort = () => reject(makeError('read-aborted', '文件读取被中断'));
      reader.onload = () => resolve(reader.result);
      if (mode === 'text') reader.readAsText(blob);
      else if (mode === 'data-url') reader.readAsDataURL(blob);
      else reader.readAsArrayBuffer(blob);
    });
  }

  async function createImageThumbnail(sourceUrl) {
    const image = await loadImage(sourceUrl);
    const maxSize = 960;
    const scale = Math.min(1, maxSize / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw makeError('thumbnail-failed', '当前浏览器无法创建图片画布');
    context.drawImage(image, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(makeError('thumbnail-failed', '无法生成图片缩略图'));
        }, 'image/png');
      } catch (error) {
        reject(error);
      }
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(makeError('decode-failed', '图片内容无法解码'));
      image.src = url;
    });
  }

  function inspectFileType(file) {
    const extension = extensionOf(file.name);
    const extensionCategory = extension ? EXTENSION_CATEGORY.get(extension) : null;
    const mime = (file.type || '').toLowerCase();
    const mimeCategory = mime && !IGNORED_MIME_TYPES.has(mime) ? MIME_CATEGORY.get(mime) : null;

    if (extensionCategory && mimeCategory && extensionCategory !== mimeCategory) {
      return {
        supported: false,
        reason: `扩展名 ${extension} 与 MIME 类型 ${file.type} 不一致`
      };
    }
    if (extensionCategory) return { supported: true, ...extensionCategory };
    if (mimeCategory) return { supported: true, ...mimeCategory };
    return {
      supported: false,
      reason: `不支持 ${extension || '无扩展名'} / ${file.type || '未知 MIME 类型'}`
    };
  }

  function classifyError(error) {
    if (error?.code === 'unsupported-type') {
      return { code: error.code, message: `文件类型不匹配：${error.message}` };
    }
    if (error?.code === 'invalid-pdf') {
      return { code: error.code, message: error.message };
    }
    if (error?.code === 'empty-file') {
      return { code: error.code, message: error.message };
    }
    if (error?.code === 'decode-failed') {
      return { code: error.code, message: '读取失败：图片内容无法解码' };
    }
    if (error?.name === 'NotFoundError') {
      return { code: 'file-deleted', message: '文件已被删除、移动或当前不可用' };
    }
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      return { code: 'permission-denied', message: '没有读取该文件的权限' };
    }
    if (error?.name === 'AbortError' || error?.code === 'read-aborted') {
      return { code: 'read-aborted', message: '文件读取被中断' };
    }
    if (error?.name === 'EncodingError') {
      return { code: 'decode-failed', message: '读取失败：文件内容无法按文本解码' };
    }
    if (error?.code === 'unsupported-api') {
      return { code: error.code, message: error.message };
    }
    return { code: 'read-failed', message: `读取失败：${friendlyError(error)}` };
  }

  function updateEnvironmentStatus() {
    const environment = getEnvironment();
    setStatusCard(
      els.secureCard,
      els.secureStatus,
      environment.secure ? 'ok' : 'error',
      environment.secure
        ? '当前为安全上下文，可注册系统文件处理器。'
        : '当前不是安全上下文。请通过 HTTPS 或 localhost 访问。'
    );
    setStatusCard(
      els.supportCard,
      els.supportStatus,
      environment.fileHandlingSupported ? 'ok' : 'warn',
      environment.fileHandlingSupported
        ? '支持 launchQueue 与文件句柄，可接收系统“打开方式”。'
        : '不支持 File Handling API，已启用手动选择与拖拽降级。'
    );
  }

  function updateRegistrationStatus() {
    const environment = getEnvironment();
    let level = 'warn';
    let message = '正在准备注册能力。';

    if (!environment.secure) {
      level = 'error';
      message = '非安全上下文，无法安装 PWA 或注册系统文件处理器。';
    } else if (!environment.fileHandlingSupported) {
      level = 'warn';
      message = '浏览器不支持系统文件处理注册，请使用手动选择或拖拽。';
    } else if (state.manifestError) {
      level = 'error';
      message = `注册配置无效：${friendlyError(state.manifestError)}`;
    } else if (state.swError) {
      level = 'error';
      message = `Service Worker 注册失败：${friendlyError(state.swError)}`;
    } else if (state.installed) {
      level = 'ok';
      message = '已安装。Manifest 中的 file_handlers 已由浏览器注册到系统。';
    } else if (state.registrationInProgress) {
      message = '正在注册文件处理器…';
    } else if (state.swRegistration && state.deferredPrompt) {
      message = '已满足安装条件，点击按钮完成系统注册。';
    } else if (state.swRegistration) {
      message = '运行环境就绪。若按钮未弹窗，请使用浏览器地址栏“安装”。';
    }

    setStatusCard(els.registrationCard, els.registrationStatus, level, message);
    els.installButton.disabled = !environment.secure || !environment.fileHandlingSupported || state.registrationInProgress;
    els.installButton.textContent = state.installed ? '已注册为系统文件处理器' : '注册为系统文件处理器';
  }

  function getEnvironment() {
    return {
      secure: Boolean(window.isSecureContext),
      fileHandlingSupported: typeof window.launchQueue?.setConsumer === 'function' && 'FileSystemFileHandle' in window,
      fileReaderSupported: 'FileReader' in window,
      indexedDbSupported: 'indexedDB' in window
    };
  }

  function setStatusCard(card, target, level, message) {
    card.classList.remove('ok', 'warn', 'error');
    card.classList.add(level);
    target.textContent = message;
  }

  function buildExtensionCategory() {
    const map = new Map();
    DOCUMENT_EXTENSIONS.forEach((extension) => map.set(extension, { category: '文档', kind: 'document' }));
    IMAGE_EXTENSIONS.forEach((extension) => map.set(extension, { category: '图片', kind: 'image' }));
    PDF_EXTENSIONS.forEach((extension) => map.set(extension, { category: 'PDF', kind: 'pdf' }));
    return map;
  }

  function buildMimeCategory() {
    const map = new Map();
    DOCUMENT_MIME_TYPES.forEach((mime) => map.set(mime, { category: '文档', kind: 'document' }));
    IMAGE_MIME_TYPES.forEach((mime) => map.set(mime, { category: '图片', kind: 'image' }));
    PDF_MIME_TYPES.forEach((mime) => map.set(mime, { category: 'PDF', kind: 'pdf' }));
    return map;
  }

  function extensionOf(name) {
    const index = String(name || '').lastIndexOf('.');
    return index >= 0 ? String(name).slice(index).toLowerCase() : '';
  }

  function fingerprint(file) {
    return [file.name, file.size, file.lastModified, file.type || 'unknown'].join('::');
  }

  function makeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function friendlyError(error) {
    return error?.message || String(error || '未知错误');
  }

  function createId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function detectInstalledState() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
    return Boolean(standalone || safeStorageGet('file-handler-lab-installed') === '1');
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
    });
  }

  function idbTransaction(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    });
  }

  function revokeHistoryUrls() {
    state.historyUrls.forEach((url) => URL.revokeObjectURL(url));
    state.historyUrls.clear();
  }

  function iconFor(entry) {
    if (entry.kind === 'directory') return '夹';
    if (entry.kind === 'image') return '图';
    if (entry.kind === 'pdf') return 'PDF';
    if (entry.kind === 'document') return '文';
    return '件';
  }

  function statusLabel(status) {
    const labels = {
      queued: '排队中',
      reading: '读取中',
      ready: '已完成',
      duplicate: '重复打开',
      unsupported: '类型不匹配',
      error: '读取失败'
    };
    return labels[status] || '未知状态';
  }

  function statusClass(status) {
    if (status === 'ready') return 'ok';
    if (status === 'duplicate' || status === 'unsupported') return 'warn';
    if (status === 'error') return 'error';
    return '';
  }

  function sourceLabel(source) {
    const labels = {
      system: '系统打开方式',
      drag: '拖拽',
      manual: '手动选择',
      history: '最近记录'
    };
    return labels[source] || source;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '未知大小';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** index;
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDate(timestamp) {
    if (!Number.isFinite(timestamp)) return '未知时间';
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
  }

  function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    item.textContent = message;
    els.toastRegion.appendChild(item);
    window.setTimeout(() => item.remove(), type === 'error' ? 7000 : 4500);
  }
})();
