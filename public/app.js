/* my-jizhang 前端：目录树 + 富文本记账编辑器 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    tree: $('#tree'),
    tabStrip: $('#tab-strip'),
    editor: $('#editor'),
    docScroll: $('#doc-scroll'),
    docInner: $('#doc-inner'),
    docTitle: $('#doc-title'),
    docBody: $('#doc-body'),
    saveStatus: $('#save-status'),
    formatBar: $('#format-bar'),
    fontSize: $('#font-size'),
    fileInput: $('#file-input'),
    ctxMenu: $('#ctx-menu'),
    imgBar: $('#img-bar'),
    imgSize: $('#img-size'),
  };

  const ICON = {
    chevron:
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>',
    folder:
      '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path opacity=".92" d="M2 4.2c0-.9.7-1.6 1.6-1.6h2.3l1.2 1.4h6.3c.9 0 1.6.7 1.6 1.6v6.8c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V4.2z"/></svg>',
    doc:
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.8h4.4l3 3v9.4H4z"/><path d="M8.2 1.9v3.1h3.1"/></svg>',
  };

  const LS = {
    expanded: 'my-jizhang.expanded',
    tabs: 'my-jizhang.tabs',
    active: 'my-jizhang.active',
  };

  const state = {
    docs: [],
    tabs: [],
    activeId: null,
    expanded: new Set(),
    dirty: false,
    saveTimer: null,
    savePromise: null,
  };

  let lastRange = null;
  let currentImg = null;
  let ctxTargetId = null;

  /* ---------------- 基础工具 ---------------- */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
  }

  function api(path, options) {
    const opts = Object.assign({}, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts);
  }

  const findMeta = (id) => state.docs.find((doc) => doc.id === id);

  function setStatus(text) {
    el.saveStatus.textContent = text || '';
  }

  function persistUi() {
    try {
      localStorage.setItem(LS.tabs, JSON.stringify(state.tabs));
      localStorage.setItem(LS.active, state.activeId || '');
      localStorage.setItem(LS.expanded, JSON.stringify(Array.from(state.expanded)));
    } catch (err) {
      /* 忽略存储异常 */
    }
  }

  function restoreUi() {
    try {
      const expanded = JSON.parse(localStorage.getItem(LS.expanded) || '[]');
      expanded.forEach((id) => state.expanded.add(id));
      const tabs = JSON.parse(localStorage.getItem(LS.tabs) || '[]');
      state.tabs = tabs.filter((id) => state.docs.some((doc) => doc.id === id));
      const active = localStorage.getItem(LS.active);
      if (active && state.docs.some((doc) => doc.id === active)) state.activeId = active;
    } catch (err) {
      /* 忽略存储异常 */
    }
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadDocs() {
    const res = await api('/api/docs');
    if (!res.ok) throw new Error('加载目录失败');
    state.docs = await res.json();
  }

  async function getDoc(id) {
    const res = await api(`/api/docs/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return res.json();
  }

  async function openDoc(id) {
    if (state.activeId === id) {
      renderTabs();
      return;
    }
    await flushSave();
    const doc = await getDoc(id);
    if (!doc) {
      setStatus('文档不存在');
      await loadDocs();
      renderTree();
      renderTabs();
      return;
    }
    state.activeId = id;
    if (!state.tabs.includes(id)) state.tabs.push(id);
    renderDoc(doc);
    renderTabs();
    renderTree();
    persistUi();
  }

  function renderDoc(doc) {
    el.editor.classList.remove('is-empty');
    el.docTitle.textContent = doc.name;
    el.docBody.innerHTML = doc.content || '';
    state.dirty = false;
    setStatus('');
    hideImgBar();
    recalcTotals();
    el.docScroll.scrollTop = 0;
  }

  function renderEmpty() {
    el.editor.classList.add('is-empty');
    el.docTitle.textContent = '';
    el.docBody.innerHTML = '';
    state.dirty = false;
    currentImg = null;
    hideImgBar();
    setStatus('');
  }

  async function createDoc(parentId, kind) {
    const typed = window.prompt(kind === 'folder' ? '目录名称' : '文档名称（通常写月份，如 2026年12月）', kind === 'folder' ? '新目录' : '新文档');
    if (typed === null) return;
    const name = typed.trim();
    if (!name) return;
    const res = await api('/api/docs', { method: 'POST', body: { parent_id: parentId || null, name, kind } });
    if (!res.ok) {
      window.alert('创建失败，请重试');
      return;
    }
    const created = await res.json();
    state.docs.push(created);
    if (parentId) state.expanded.add(parentId);
    renderTree();
    persistUi();
    if (kind === 'doc') await openDoc(created.id);
  }

  async function renameDoc(doc, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === doc.name) return;
    const res = await api(`/api/docs/${encodeURIComponent(doc.id)}`, { method: 'PUT', body: { name: trimmed } });
    if (!res.ok) {
      window.alert('重命名失败');
      return;
    }
    doc.name = trimmed;
    renderTree();
    renderTabs();
    persistUi();
  }

  async function deleteDoc(doc) {
    if (!window.confirm(`确定删除「${doc.name}」及其全部子文档？`)) return;
    await flushSave();
    const res = await api(`/api/docs/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error || '删除失败');
      return;
    }
    await loadDocs();
    state.tabs = state.tabs.filter((id) => state.docs.some((item) => item.id === id));
    if (!state.docs.some((item) => item.id === state.activeId)) {
      state.activeId = null;
      const next = state.tabs[state.tabs.length - 1];
      if (next) await openDoc(next);
      else renderEmpty();
    }
    renderTree();
    renderTabs();
    persistUi();
  }

  /* ---------------- 目录树 ---------------- */

  function renderTree() {
    const byParent = new Map();
    state.docs.forEach((doc) => {
      const key = doc.parent_id || '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(doc);
    });
    byParent.forEach((list) => list.sort((a, b) => (a.sort || 0) - (b.sort || 0)));
    const roots = byParent.get('') || [];
    el.tree.innerHTML = roots.length
      ? roots.map((doc) => renderRow(doc, 0, byParent)).join('')
      : '<div class="tree-empty">还没有文档</div>';
  }

  function renderRow(doc, depth, byParent) {
    const children = byParent.get(doc.id) || [];
    const isFolder = doc.kind === 'folder';
    const open = isFolder && state.expanded.has(doc.id);
    const selected = doc.id === state.activeId;
    const padding = 10 + depth * 16;
    const caret = isFolder && children.length
      ? `<button class="caret ${open ? 'open' : ''}" data-act="toggle" title="展开 / 收起">${ICON.chevron}</button>`
      : '<span class="caret-space"></span>';
    const row =
      `<div class="tree-row ${isFolder ? 'is-folder' : 'is-doc'} ${selected ? 'selected' : ''}" ` +
      `data-id="${doc.id}" data-kind="${doc.kind}" style="padding-left:${padding}px">` +
      caret +
      `<span class="node-icon ${isFolder ? 'folder' : 'doc'}">${isFolder ? ICON.folder : ICON.doc}</span>` +
      `<span class="node-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>` +
      (isFolder ? '<button class="node-add" data-act="add" title="新建子文档">＋</button>' : '') +
      '</div>';
    if (!isFolder || !open) return row;
    return row + children.map((child) => renderRow(child, depth + 1, byParent)).join('');
  }

  function toggleExpand(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderTree();
    persistUi();
  }

  /* ---------------- 顶部标签 ---------------- */

  function renderTabs() {
    state.tabs = state.tabs.filter((id) => state.docs.some((doc) => doc.id === id));
    const tabs = state.tabs
      .map((id) => {
        const doc = findMeta(id);
        const active = id === state.activeId ? 'active' : '';
        return (
          `<div class="tab ${active}" data-id="${id}">` +
          `<span class="tab-name">${escapeHtml(doc ? doc.name : '文档')}</span>` +
          `<button class="tab-close" data-act="close" title="关闭">×</button>` +
          '</div>'
        );
      })
      .join('');
    el.tabStrip.innerHTML = tabs + '<button class="tab-new" id="tab-new" title="新建文档">＋</button>';
  }

  async function closeTab(id) {
    if (id === state.activeId) await flushSave();
    state.tabs = state.tabs.filter((tabId) => tabId !== id);
    state.tabs = state.tabs.filter((tabId) => state.docs.some((doc) => doc.id === tabId));
    if (id === state.activeId) {
      state.activeId = null;
      persistUi();
      const next = state.tabs[state.tabs.length - 1];
      if (next) {
        await openDoc(next);
      } else {
        renderEmpty();
      }
    }
    renderTabs();
    renderTree();
    persistUi();
  }

  /* ---------------- 保存 ---------------- */

  function markDirty() {
    state.dirty = true;
    setStatus('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow(), 700);
  }

  function serialize() {
    return el.docBody.innerHTML;
  }

  async function saveNow() {
    if (!state.activeId || !state.dirty) return;
    if (state.savePromise) return state.savePromise;
    const id = state.activeId;
    const content = serialize();
    setStatus('保存中…');
    state.savePromise = (async () => {
      try {
        const res = await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: { content } });
        if (!res.ok) throw new Error('save failed');
        state.dirty = false;
        setStatus('已保存');
      } catch (err) {
        setStatus('保存失败，请检查网络');
      } finally {
        state.savePromise = null;
      }
    })();
    await state.savePromise;
    if (state.dirty) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => saveNow(), 500);
    }
  }

  async function flushSave() {
    clearTimeout(state.saveTimer);
    if (state.dirty) await saveNow();
    if (state.savePromise) await state.savePromise;
  }

  /* ---------------- 光标与插入块 ---------------- */

  function getActiveRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.anchorNode && el.docBody.contains(sel.anchorNode)) {
      return sel.getRangeAt(0).cloneRange();
    }
    if (lastRange && el.docBody.contains(lastRange.startContainer)) {
      return lastRange.cloneRange();
    }
    return null;
  }

  function restoreSelection() {
    const range = getActiveRange();
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.docBody.focus();
  }

  function placeCaret(node, offset) {
    el.docBody.focus();
    const range = document.createRange();
    range.setStart(node, offset || 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    lastRange = range.cloneRange();
  }

  /** 在光标所在行之后插入一个块级元素，并在其后留一个空行 */
  function insertBlockAtCaret(node) {
    const range = getActiveRange();
    let anchor = el.docBody.lastElementChild;
    if (range) {
      let nodeAtCaret = range.startContainer;
      if (nodeAtCaret.nodeType !== 1) nodeAtCaret = nodeAtCaret.parentElement;
      while (nodeAtCaret && nodeAtCaret !== el.docBody && nodeAtCaret.parentElement !== el.docBody) {
        nodeAtCaret = nodeAtCaret.parentElement;
      }
      if (nodeAtCaret && nodeAtCaret.parentElement === el.docBody) anchor = nodeAtCaret;
    }
    if (anchor && anchor.parentElement === el.docBody) anchor.after(node);
    else el.docBody.appendChild(node);
    const blank = document.createElement('p');
    node.after(blank);
    el.docScroll.scrollTop = el.docScroll.scrollHeight;
    placeCaret(blank, 0);
  }

  /* ---------------- 收入 / 支出 ---------------- */

  function createMoneyBlock(type, desc, amount) {
    const isIncome = type === 'income';
    const block = document.createElement('div');
    block.className = `money-block ${isIncome ? 'income' : 'expense'}`;
    block.dataset.type = type;
    block.contentEditable = 'false';
    block.innerHTML =
      `<span class="money-badge" title="点击可切换收入 / 支出">${isIncome ? '收入' : '支出'}</span>` +
      `<label class="money-field">内容<input class="money-desc" value="${escapeAttr(desc || '')}" placeholder="如：买菜"></label>` +
      `<label class="money-field">金额<input class="money-amount" type="number" step="0.01" min="0" value="${escapeAttr(amount || '')}" placeholder="0.00"></label>` +
      '<span class="money-unit">元</span>' +
      '<button class="money-del" type="button" title="删除这条记录">×</button>';
    return block;
  }

  function insertMoney(type) {
    if (!state.activeId) return;
    restoreSelection();
    const block = createMoneyBlock(type);
    insertBlockAtCaret(block);
    recalcTotals();
    markDirty();
    const descInput = block.querySelector('.money-desc');
    if (descInput) descInput.focus();
  }

  function createTotalBlock() {
    const block = document.createElement('div');
    block.className = 'total-block';
    block.contentEditable = 'false';
    block.innerHTML =
      '<span class="total-title">本月合计</span>' +
      '<span class="total-item">收入 <b class="total-income">¥0.00</b></span>' +
      '<span class="total-item">支出 <b class="total-expense">¥0.00</b></span>' +
      '<span class="total-item">结余 <b class="total-balance">¥0.00</b></span>';
    return block;
  }

  function insertTotal() {
    if (!state.activeId) return;
    restoreSelection();
    const block = createTotalBlock();
    insertBlockAtCaret(block);
    recalcTotals();
    markDirty();
  }

  /* ---------------- 自动合计 ---------------- */

  function formatMoney(value) {
    return '¥' + value.toFixed(2);
  }

  function recalcTotals() {
    let income = 0;
    let expense = 0;
    $$('.money-block', el.docBody).forEach((block) => {
      const input = block.querySelector('.money-amount');
      const amount = parseFloat(input ? input.value : '');
      if (!Number.isFinite(amount)) return;
      if (block.dataset.type === 'income') income += amount;
      else expense += amount;
    });
    $$('.total-block', el.docBody).forEach((block) => {
      const incomeEl = block.querySelector('.total-income');
      const expenseEl = block.querySelector('.total-expense');
      const balanceEl = block.querySelector('.total-balance');
      if (incomeEl) incomeEl.textContent = formatMoney(income);
      if (expenseEl) expenseEl.textContent = formatMoney(expense);
      if (balanceEl) balanceEl.textContent = formatMoney(income - expense);
    });
  }

  /* ---------------- 图片 ---------------- */

  function insertImage(src) {
    if (!state.activeId) return;
    restoreSelection();
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.contentEditable = 'false';
    const img = document.createElement('img');
    img.className = 'doc-img';
    img.dataset.rotate = '0';
    img.alt = '记账凭证';
    img.addEventListener('load', () => {
      if (!img.style.width) {
        const width = el.docBody.clientWidth || 720;
        img.style.width = Math.min(img.naturalWidth || width, width) + 'px';
      }
      markDirty();
    });
    img.addEventListener('error', () => {
      wrap.classList.add('img-broken');
      img.style.width = '200px';
      img.style.height = '80px';
      img.style.background = '#f3f4f6';
      setStatus('图片加载失败');
    });
    img.src = src;
    wrap.appendChild(img);
    insertBlockAtCaret(wrap);
    markDirty();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function showImgBar(img) {
    currentImg = img;
    el.imgBar.classList.add('show');
    positionImgBar();
  }

  function positionImgBar() {
    if (!currentImg || !document.body.contains(currentImg)) {
      hideImgBar();
      return;
    }
    const rect = currentImg.getBoundingClientRect();
    const barWidth = el.imgBar.offsetWidth || 330;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - barWidth / 2, window.innerWidth - barWidth - 8));
    let top = rect.top - 42;
    if (top < 8) top = rect.bottom + 8;
    el.imgBar.style.left = `${left}px`;
    el.imgBar.style.top = `${top}px`;
    el.imgSize.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function hideImgBar() {
    currentImg = null;
    el.imgBar.classList.remove('show');
  }

  function zoomImg(factor) {
    if (!currentImg) return;
    const containerWidth = el.docBody.clientWidth || 720;
    let width = parseFloat(currentImg.style.width);
    if (!Number.isFinite(width)) width = Math.min(currentImg.naturalWidth || containerWidth, containerWidth);
    width = Math.max(60, Math.min(width * factor, containerWidth * 3));
    currentImg.style.width = `${Math.round(width)}px`;
    currentImg.style.height = 'auto';
    markDirty();
    positionImgBar();
  }

  function rotateImg(delta) {
    if (!currentImg) return;
    const current = Number(currentImg.dataset.rotate || 0) + delta;
    const next = ((current % 360) + 360) % 360;
    currentImg.dataset.rotate = String(next);
    currentImg.style.transform = `rotate(${next}deg)`;
    markDirty();
    positionImgBar();
  }

  function resetImg() {
    if (!currentImg) return;
    const containerWidth = el.docBody.clientWidth || 720;
    currentImg.style.width = Math.min(currentImg.naturalWidth || containerWidth, containerWidth) + 'px';
    currentImg.style.transform = '';
    currentImg.dataset.rotate = '0';
    markDirty();
    positionImgBar();
  }

  function fitImgWidth() {
    if (!currentImg) return;
    const containerWidth = el.docBody.clientWidth || 720;
    currentImg.style.width = containerWidth + 'px';
    markDirty();
    positionImgBar();
  }

  /* ---------------- 富文本格式 ---------------- */

  function applyFontSize(px) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (sel.isCollapsed) {
      let node = sel.anchorNode;
      if (node && node.nodeType !== 1) node = node.parentElement;
      const block = node && node.closest ? node.closest('p, li, blockquote, h1, h2, h3') : null;
      const target = block && el.docBody.contains(block) ? block : el.docBody;
      target.style.fontSize = `${px}px`;
      return;
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    $$('font[size="7"]', el.docBody).forEach((font) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      while (font.firstChild) span.appendChild(font.firstChild);
      font.replaceWith(span);
    });
  }

  function updateFormatState() {
    try {
      ['bold', 'italic', 'underline'].forEach((cmd) => {
        const btn = el.formatBar.querySelector(`[data-cmd="${cmd}"]`);
        if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
      });
    } catch (err) {
      /* 某些环境不支持 queryCommandState，忽略 */
    }
  }

  /* ---------------- 右键菜单 ---------------- */

  function showCtxMenu(x, y, doc) {
    ctxTargetId = doc.id;
    const isFolder = doc.kind === 'folder';
    el.ctxMenu.innerHTML =
      `<button data-act="child-doc" ${isFolder ? '' : 'disabled'}>新建子文档</button>` +
      `<button data-act="child-folder" ${isFolder ? '' : 'disabled'}>新建子目录</button>` +
      '<div class="ctx-divider"></div>' +
      '<button data-act="rename">重命名</button>' +
      '<button data-act="delete" class="danger">删除</button>';
    el.ctxMenu.classList.add('show');
    const width = el.ctxMenu.offsetWidth;
    const height = el.ctxMenu.offsetHeight;
    el.ctxMenu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
    el.ctxMenu.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  }

  function hideCtxMenu() {
    el.ctxMenu.classList.remove('show');
    ctxTargetId = null;
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.anchorNode && el.docBody.contains(sel.anchorNode)) {
        lastRange = sel.getRangeAt(0).cloneRange();
      }
      updateFormatState();
    });

    /* 目录树 */
    el.tree.addEventListener('click', (event) => {
      const row = event.target.closest('.tree-row');
      if (!row) return;
      const doc = findMeta(row.dataset.id);
      if (!doc) return;
      if (event.target.closest('[data-act="toggle"]')) {
        toggleExpand(doc.id);
        return;
      }
      if (event.target.closest('[data-act="add"]')) {
        event.stopPropagation();
        createDoc(doc.id, 'doc');
        return;
      }
      if (doc.kind === 'folder') toggleExpand(doc.id);
      else openDoc(doc.id);
    });

    el.tree.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.tree-row');
      if (!row) return;
      const doc = findMeta(row.dataset.id);
      if (!doc) return;
      event.preventDefault();
      showCtxMenu(event.clientX, event.clientY, doc);
    });

    el.ctxMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      const doc = findMeta(ctxTargetId);
      const act = btn.dataset.act;
      hideCtxMenu();
      if (!doc) return;
      if (act === 'child-doc') createDoc(doc.id, 'doc');
      else if (act === 'child-folder') createDoc(doc.id, 'folder');
      else if (act === 'rename') {
        const typed = window.prompt('重命名', doc.name);
        if (typed !== null) renameDoc(doc, typed);
      } else if (act === 'delete') deleteDoc(doc);
    });

    $("#btn-new-folder").addEventListener('click', () => {
      const root = state.docs.find((doc) => !doc.parent_id && doc.kind === 'folder');
      createDoc(root ? root.id : null, 'folder');
    });

    $('#btn-new-doc').addEventListener('click', () => {
      let parent = state.activeId ? findMeta(state.activeId) : null;
      if (parent && parent.kind !== 'folder') {
        parent = parent.parent_id ? findMeta(parent.parent_id) : null;
      }
      const root = state.docs.find((doc) => !doc.parent_id && doc.kind === 'folder');
      createDoc(parent ? parent.id : root ? root.id : null, 'doc');
    });

    /* 标签栏 */
    el.tabStrip.addEventListener('click', (event) => {
      if (event.target.closest('#tab-new')) {
        const root = state.docs.find((doc) => !doc.parent_id && doc.kind === 'folder');
        createDoc(root ? root.id : null, 'doc');
        return;
      }
      const tab = event.target.closest('.tab');
      if (!tab) return;
      if (event.target.closest('[data-act="close"]')) {
        closeTab(tab.dataset.id);
        return;
      }
      openDoc(tab.dataset.id);
    });

    /* 标题重命名 */
    el.docTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.docTitle.blur();
      }
    });
    el.docTitle.addEventListener('blur', () => {
      const doc = findMeta(state.activeId);
      if (!doc) return;
      const typed = (el.docTitle.textContent || '').trim();
      if (!typed) {
        el.docTitle.textContent = doc.name;
        return;
      }
      renameDoc(doc, typed);
    });
    el.docTitle.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    /* 正文输入 */
    el.docBody.addEventListener('input', (event) => {
      const target = event.target;
      if (target && target.matches && target.matches('.money-amount, .money-desc')) {
        target.setAttribute('value', target.value);
        recalcTotals();
      }
      markDirty();
    });

    el.docBody.addEventListener('click', (event) => {
      const img = event.target.closest ? event.target.closest('.doc-img') : null;
      if (img) {
        showImgBar(img);
        return;
      }
      if (!el.imgBar.contains(event.target)) hideImgBar();

      const delBtn = event.target.closest ? event.target.closest('.money-del') : null;
      if (delBtn) {
        const block = delBtn.closest('.money-block');
        if (block) {
          block.remove();
          recalcTotals();
          markDirty();
        }
        return;
      }

      const badge = event.target.closest ? event.target.closest('.money-badge') : null;
      if (badge) {
        const block = badge.closest('.money-block');
        if (block) {
          const next = block.dataset.type === 'income' ? 'expense' : 'income';
          block.dataset.type = next;
          block.classList.toggle('income', next === 'income');
          block.classList.toggle('expense', next === 'expense');
          badge.textContent = next === 'income' ? '收入' : '支出';
          recalcTotals();
          markDirty();
        }
      }
    });

    /* 粘贴图片 */
    el.docBody.addEventListener('paste', (event) => {
      const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
      const imageItem = items.find((item) => item.type && item.type.startsWith('image/'));
      if (!imageItem) return;
      event.preventDefault();
      const file = imageItem.getAsFile();
      if (file) readFileAsDataUrl(file).then((url) => insertImage(url));
    });

    /* 工具栏 */
    $$('.fmt-btn[data-cmd]', el.formatBar).forEach((btn) => {
      btn.addEventListener('mousedown', (event) => event.preventDefault());
      btn.addEventListener('click', () => {
        if (!state.activeId) return;
        restoreSelection();
        document.execCommand(btn.dataset.cmd, false, null);
        markDirty();
        updateFormatState();
      });
    });

    el.formatBar.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
    });

    el.fontSize.addEventListener('change', () => {
      const px = el.fontSize.value;
      if (!px || !state.activeId) return;
      restoreSelection();
      applyFontSize(px);
      markDirty();
      el.fontSize.value = '';
    });

    $('#btn-image').addEventListener('click', () => {
      if (!state.activeId) return;
      lastRange = getActiveRange() || lastRange;
      el.fileInput.click();
    });

    el.fileInput.addEventListener('change', async () => {
      const file = el.fileInput.files && el.fileInput.files[0];
      el.fileInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        window.alert('请选择图片文件');
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        window.alert('图片超过 8MB，建议压缩后再插入');
        return;
      }
      const url = await readFileAsDataUrl(file);
      insertImage(url);
    });

    $('#btn-net-image').addEventListener('click', () => {
      if (!state.activeId) return;
      const url = window.prompt('输入网络图片地址（http 或 https 开头）');
      if (!url) return;
      const trimmed = url.trim();
      if (!/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
        window.alert('地址格式不正确，需要以 http(s):// 开头');
        return;
      }
      insertImage(trimmed);
    });

    $('#btn-income').addEventListener('click', () => insertMoney('income'));
    $('#btn-expense').addEventListener('click', () => insertMoney('expense'));
    $('#btn-total').addEventListener('click', () => insertTotal());

    /* 图片工具条 */
    el.imgBar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn || !currentImg) return;
      const act = btn.dataset.act;
      if (act === 'rotl') rotateImg(-90);
      else if (act === 'rotr') rotateImg(90);
      else if (act === 'zoomout') zoomImg(0.9);
      else if (act === 'zoomin') zoomImg(1.1);
      else if (act === 'reset') resetImg();
      else if (act === 'fit') fitImgWidth();
      else if (act === 'del') {
        const wrap = currentImg.closest('.img-wrap');
        if (wrap) wrap.remove();
        hideImgBar();
        markDirty();
      }
    });

    /* 滚动与窗口变化 */
    el.docScroll.addEventListener('scroll', hideImgBar);
    window.addEventListener('resize', () => {
      if (currentImg) positionImgBar();
    });

    /* 点击空白处收起菜单 */
    document.addEventListener('mousedown', (event) => {
      if (!el.ctxMenu.contains(event.target)) hideCtxMenu();
      if (!el.imgBar.contains(event.target) && !event.target.closest('.doc-img')) {
        /* 图片工具条在点击正文其他位置时收起 */
        if (event.target.closest('#doc-body') || event.target.closest('.format-bar')) hideImgBar();
      }
    });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        flushSave();
      }
      if (event.key === 'Escape') {
        hideImgBar();
        hideCtxMenu();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) saveNow();
    });

    window.addEventListener('beforeunload', () => {
      if (state.dirty) saveNow();
    });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    bindEvents();
    try {
      await loadDocs();
    } catch (err) {
      el.tree.innerHTML = '<div class="tree-empty">加载失败，请刷新重试</div>';
      return;
    }
    restoreUi();
    renderTree();

    const rootFolder = state.docs.find((doc) => !doc.parent_id && doc.kind === 'folder');
    if (rootFolder) state.expanded.add(rootFolder.id);
    const yearFolder = state.docs.find((doc) => doc.name === '2026年');
    if (yearFolder) state.expanded.add(yearFolder.id);
    renderTree();

    const preferred = state.activeId
      ? state.activeId
      : state.docs.some((doc) => doc.name === '2026年11月')
      ? state.docs.find((doc) => doc.name === '2026年11月').id
      : state.docs.find((doc) => doc.kind === 'doc')?.id;

    if (preferred) {
      state.activeId = null;
      await openDoc(preferred);
    } else {
      renderEmpty();
      renderTabs();
    }

    document.execCommand('defaultParagraphSeparator', false, 'p');
  }

  init();
})();
