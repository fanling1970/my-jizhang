/* my-jizhang 前端：目录树（带头部菜单 + 节点更多）+ 富文本记账编辑器 + 图片右键菜单 + 多图横排 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    tree: $('#tree'),
    tabStrip: $('#tab-strip'),
    editor: $('#editor'),
    docScroll: $('#doc-scroll'),
    docBody: $('#doc-body'),
    docTitle: $('#doc-title'),
    saveStatus: $('#save-status'),
    formatBar: $('#format-bar'),
    fontSize: $('#font-size'),
    fileInput: $('#file-input'),
    ctxMenu: $('#ctx-menu'),
    imgBar: $('#img-bar'),
    imgSize: $('#img-size'),
    sidebar: $('#sidebar'),
    sidebarCollapsed: $('#sidebar-collapsed'),
    btnLocate: $('#btn-locate'),
    btnFoldall: $('#btn-foldall'),
    btnSidebarMore: $('#btn-sidebar-more'),
    btnSidebarCollapse: $('#btn-sidebar-collapse'),
    imgCtxMenu: $('#img-ctx-menu'),
    imgCtxSrc: $('#img-ctx-src'),
    imgCtxTitle: $('#img-ctx-title'),
    imgCtxAlt: $('#img-ctx-alt'),
    imgWidthPx: $('#img-width-px'),
    imgWidthPct: $('#img-width-pct'),
    imgWidthPctLabel: $('#img-width-pct-label'),
    imgHeightPx: $('#img-height-px'),
    imgHeightPct: $('#img-height-pct'),
    imgHeightPctLabel: $('#img-height-pct-label'),
  };

  const ICON = {
    chevron:
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>',
    folder:
      '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path opacity=".92" d="M2 4.2c0-.9.7-1.6 1.6-1.6h2.3l1.2 1.4h6.3c.9 0 1.6.7 1.6 1.6v6.8c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V4.2z"/></svg>',
    doc:
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.8h4.4l3 3v9.4H4z"/><path d="M8.2 1.9v3.1h3.1"/></svg>',
    more:
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></svg>',
  };

  const LS = {
    expanded: 'my-jizhang.expanded',
    tabs: 'my-jizhang.tabs',
    active: 'my-jizhang.active',
    sidebarCollapsed: 'my-jizhang.sidebarCollapsed',
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
  let imgCtxTarget = null;
  let ctxMenuOpen = null; // 'ctx' | 'sidebar' | null

  /* ---------------- 基础工具 ---------------- */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(v) { return escapeHtml(v).replace(/'/g, '&#39;'); }

  async function api(path, options) {
    const opts = Object.assign({}, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    if (res.ok) return res;
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const findMeta = (id) => state.docs.find((d) => d.id === id);

  function setStatus(text) { el.saveStatus.textContent = text || ''; }

  function persistUi() {
    try {
      localStorage.setItem(LS.tabs, JSON.stringify(state.tabs));
      localStorage.setItem(LS.active, state.activeId || '');
      localStorage.setItem(LS.expanded, JSON.stringify(Array.from(state.expanded)));
      localStorage.setItem(LS.sidebarCollapsed, el.sidebar.classList.contains('collapsed') ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  function restoreUi() {
    try {
      const expanded = JSON.parse(localStorage.getItem(LS.expanded) || '[]');
      expanded.forEach((id) => state.expanded.add(id));
      const tabs = JSON.parse(localStorage.getItem(LS.tabs) || '[]');
      state.tabs = tabs.filter((id) => state.docs.some((d) => d.id === id));
      const active = localStorage.getItem(LS.active);
      if (active && state.docs.some((d) => d.id === active)) state.activeId = active;
      const collapsed = localStorage.getItem(LS.sidebarCollapsed) === '1';
      if (collapsed) collapseSidebar(true);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 侧边栏折叠 ---------------- */

  function collapseSidebar(silent) {
    el.sidebar.classList.add('collapsed');
    el.sidebarCollapsed.hidden = false;
    if (!silent) persistUi();
  }
  function expandSidebar(silent) {
    el.sidebar.classList.remove('collapsed');
    el.sidebarCollapsed.hidden = true;
    if (!silent) persistUi();
  }

  /* ---------------- 数据 ---------------- */

  async function loadDocs() {
    const res = await fetch('/api/docs');
    if (!res.ok) throw new Error('加载目录失败');
    state.docs = await res.json();
  }

  async function getDoc(id) {
    try {
      return await api(`/api/docs/${encodeURIComponent(id)}`);
    } catch { return null; }
  }

  async function openDoc(id) {
    if (state.activeId === id) { renderTabs(); renderTree(); return; }
    await flushSave();
    const doc = await getDoc(id);
    if (!doc) {
      setStatus('文档不存在');
      await loadDocs(); renderTree(); renderTabs();
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
    state.dirty = false; setStatus('');
    hideImgBar(); hideImgCtxMenu();
    recalcTotals();
    el.docScroll.scrollTop = 0;
  }

  function renderEmpty() {
    el.editor.classList.add('is-empty');
    el.docTitle.textContent = '';
    el.docBody.innerHTML = '';
    state.dirty = false; currentImg = null;
    hideImgBar(); hideImgCtxMenu(); setStatus('');
  }

  async function createDoc(parentId, kind) {
    const prompt = kind === 'folder' ? '目录名称' : '文档名称（通常写月份，如 2026年12月）';
    const defaultName = kind === 'folder' ? '新目录' : '新文档';
    const typed = window.prompt(prompt, defaultName);
    if (typed === null) return;
    const name = typed.trim();
    if (!name) return;
    try {
      const created = await api('/api/docs', {
        method: 'POST',
        body: { parent_id: parentId || null, name, kind },
      });
      state.docs.push(created);
      if (parentId) state.expanded.add(parentId);
      renderTree();
      persistUi();
      if (kind === 'doc') await openDoc(created.id);
    } catch (err) {
      window.alert(err.message || '创建失败');
    }
  }

  async function renameDoc(doc, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === doc.name) return;
    try {
      await api(`/api/docs/${encodeURIComponent(doc.id)}`, { method: 'PUT', body: { name: trimmed } });
      doc.name = trimmed;
      renderTree(); renderTabs(); persistUi();
    } catch { /* 重命名静默失败 */ }
  }

  async function deleteDoc(doc) {
    if (!window.confirm(`确定删除「${doc.name}」及其全部子文档？`)) return;
    await flushSave();
    try {
      await api(`/api/docs/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
      await loadDocs();
      state.tabs = state.tabs.filter((id) => state.docs.some((d) => d.id === id));
      if (!state.docs.some((d) => d.id === state.activeId)) {
        state.activeId = null;
        const next = state.tabs[state.tabs.length - 1];
        if (next) await openDoc(next); else renderEmpty();
      }
      renderTree(); renderTabs(); persistUi();
    } catch (err) {
      window.alert(err.message || '删除失败');
    }
  }

  async function moveDoc(doc, newParentId) {
    if (newParentId === doc.parent_id) return;
    if (newParentId && doc.id === newParentId) return;
    if (newParentId) {
      let cur = findMeta(newParentId);
      while (cur) {
        if (cur.id === doc.id) { window.alert('不能移动到自己的子目录下'); return; }
        cur = cur.parent_id ? findMeta(cur.parent_id) : null;
      }
    }
    try {
      await api(`/api/docs/${encodeURIComponent(doc.id)}`, { method: 'PUT', body: { parent_id: newParentId || null } });
      doc.parent_id = newParentId || null;
      await loadDocs(); renderTree(); persistUi();
    } catch (err) { window.alert(err.message || '移动失败'); }
  }

  /* ---------------- 目录树 ---------------- */

  function renderTree() {
    const byParent = new Map();
    state.docs.forEach((d) => {
      const k = d.parent_id || '';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(d);
    });
    byParent.forEach((list) => list.sort((a, b) => (a.sort || 0) - (b.sort || 0)));
    const roots = byParent.get('') || [];
    el.tree.innerHTML = roots.length
      ? roots.map((d) => renderRow(d, 0, byParent)).join('')
      : '<div class="tree-empty">还没有文档</div>';
  }

  function renderRow(doc, depth, byParent) {
    const children = byParent.get(doc.id) || [];
    const isFolder = doc.kind === 'folder';
    const open = isFolder && state.expanded.has(doc.id);
    const selected = doc.id === state.activeId;
    const padding = 10 + depth * 16;
    const caret = isFolder && children.length
      ? `<button class="caret ${open ? 'open' : ''}" data-act="toggle">${ICON.chevron}</button>`
      : '<span class="caret-space"></span>';
    const row =
      `<div class="tree-row ${isFolder ? 'is-folder' : 'is-doc'} ${selected ? 'selected' : ''}" ` +
      `data-id="${doc.id}" data-kind="${doc.kind}" style="padding-left:${padding}px">` +
      caret +
      `<span class="node-icon ${isFolder ? 'folder' : 'doc'}">${isFolder ? ICON.folder : ICON.doc}</span>` +
      `<span class="node-name" title="${escapeAttr(doc.name)}">${escapeHtml(doc.name)}</span>` +
      `<span class="node-actions">` +
      (isFolder ? `<button class="node-add" data-act="add" title="新建子文档">＋</button>` : '') +
      `<button class="node-more" data-act="more" title="更多菜单">${ICON.more}</button>` +
      `</span>` +
      '</div>';
    if (!isFolder || !open) return row;
    return row + children.map((c) => renderRow(c, depth + 1, byParent)).join('');
  }

  function toggleExpand(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderTree(); persistUi();
  }

  function collapseAll() { state.expanded.clear(); renderTree(); persistUi(); }
  function expandAll() { state.docs.forEach((d) => { if (d.kind === 'folder') state.expanded.add(d.id); }); renderTree(); persistUi(); }

  function locateActiveDoc() {
    if (!state.activeId) return;
    let cur = findMeta(state.activeId);
    while (cur) {
      if (cur.parent_id) state.expanded.add(cur.parent_id);
      cur = cur.parent_id ? findMeta(cur.parent_id) : null;
    }
    renderTree(); persistUi();
    requestAnimationFrame(() => {
      const row = el.tree.querySelector(`.tree-row[data-id="${CSS.escape(state.activeId)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /* ---------------- 节点/侧边栏更多菜单 ---------------- */

  function showSidebarMoreMenu(x, y) {
    hideImgCtxMenu();
    const inner = `
      <button data-act="new-root" id="btn-new-doc-2">新建笔记本</button>
      <button data-act="import" disabled>导入笔记本 <span class="shortcut">—</span></button>
      <button data-act="reindex" disabled>重建索引 <span class="shortcut">—</span></button>
      <div class="ctx-divider"></div>
      <button data-act="foldall">全部折叠</button>
      <button data-act="unfoldall">全部展开</button>
      <div class="ctx-divider"></div>
      <button data-act="sort">排序 <span class="sub-arrow">›</span></button>
    `;
    el.ctxMenu.innerHTML = inner;
    ctxTargetId = null;
    positionMenu(x, y, el.ctxMenu);
    el.ctxMenu.classList.add('show');
    ctxMenuOpen = 'sidebar';
  }

  function showFolderCtxMenu(x, y, doc) {
    hideImgCtxMenu();
    ctxTargetId = doc.id;
    el.ctxMenu.innerHTML = `
      <button data-act="rename">重命名 <span class="shortcut">F2</span></button>
      <button data-act="sort">排序 <span class="sub-arrow">›</span></button>
      <button data-act="search" disabled>搜索 <span class="shortcut">Ctrl+F</span></button>
      <div class="ctx-divider"></div>
      <button data-act="child-doc">在下方新建文档</button>
      <button data-act="child-folder">在下方新建目录</button>
      <button data-act="child-doc-above">在上方新建文档</button>
      <div class="ctx-divider"></div>
      <button data-act="move">移动 <span class="sub-arrow">›</span></button>
      <button data-act="export" disabled>导出 <span class="sub-arrow">›</span></button>
      <div class="ctx-divider"></div>
      <button data-act="delete" class="danger">删除</button>
    `;
    positionMenu(x, y, el.ctxMenu);
    el.ctxMenu.classList.add('show');
    ctxMenuOpen = 'ctx';
  }

  function showDocCtxMenu(x, y, doc) {
    hideImgCtxMenu();
    ctxTargetId = doc.id;
    el.ctxMenu.innerHTML = `
      <button data-act="rename">重命名 <span class="shortcut">F2</span></button>
      <button data-act="pin">置顶</button>
      <div class="ctx-divider"></div>
      <button data-act="above">在上方新建文档</button>
      <button data-act="below">在下方新建文档</button>
      <button data-act="duplicate">复制</button>
      <div class="ctx-divider"></div>
      <button data-act="open-right">在页签右侧打开 <span class="shortcut">Alt+点击</span></button>
      <button data-act="move">移动 <span class="sub-arrow">›</span></button>
      <button data-act="export" disabled>导出 <span class="sub-arrow">›</span></button>
      <div class="ctx-divider"></div>
      <button data-act="delete" class="danger">删除</button>
    `;
    positionMenu(x, y, el.ctxMenu);
    el.ctxMenu.classList.add('show');
    ctxMenuOpen = 'ctx';
  }

  function positionMenu(x, y, menu) {
    menu.hidden = false;
    requestAnimationFrame(() => {
      const w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
      menu.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
    });
  }

  function hideCtxMenu() {
    el.ctxMenu.classList.remove('show');
    ctxTargetId = null;
    ctxMenuOpen = null;
  }

  /* ---------------- 标签 ---------------- */

  function renderTabs() {
    state.tabs = state.tabs.filter((id) => state.docs.some((d) => d.id === id));
    const tabs = state.tabs
      .map((id) => {
        const d = findMeta(id);
        const active = id === state.activeId ? 'active' : '';
        return (
          `<div class="tab ${active}" data-id="${id}">` +
          `<span class="tab-name">${escapeHtml(d ? d.name : '文档')}</span>` +
          `<button class="tab-close" data-act="close">×</button>` +
          '</div>'
        );
      })
      .join('');
    el.tabStrip.innerHTML = tabs + '<button class="tab-new" id="tab-new" title="新建文档">＋</button>';
  }

  async function closeTab(id) {
    if (id === state.activeId) await flushSave();
    state.tabs = state.tabs.filter((t) => t !== id);
    state.tabs = state.tabs.filter((t) => state.docs.some((d) => d.id === t));
    if (id === state.activeId) {
      state.activeId = null;
      persistUi();
      const next = state.tabs[state.tabs.length - 1];
      if (next) await openDoc(next); else renderEmpty();
    }
    renderTabs(); renderTree(); persistUi();
  }

  /* ---------------- 保存 ---------------- */

  function markDirty() {
    state.dirty = true; setStatus('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow(), 700);
  }
  function serialize() { return el.docBody.innerHTML; }

  async function saveNow() {
    if (!state.activeId || !state.dirty) return;
    if (state.savePromise) return state.savePromise;
    const id = state.activeId;
    const content = serialize();
    setStatus('保存中…');
    state.savePromise = (async () => {
      try {
        await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: { content } });
        state.dirty = false; setStatus('已保存');
      } catch (e) { setStatus('保存失败'); }
      finally { state.savePromise = null; }
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

  /* ---------------- 光标 ---------------- */

  function getActiveRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.anchorNode && el.docBody.contains(sel.anchorNode)) {
      return sel.getRangeAt(0).cloneRange();
    }
    if (lastRange && el.docBody.contains(lastRange.startContainer)) return lastRange.cloneRange();
    return null;
  }

  function restoreSelection() {
    const range = getActiveRange();
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
    el.docBody.focus();
  }

  function placeCaret(node, offset) {
    el.docBody.focus();
    const range = document.createRange();
    range.setStart(node, offset || 0); range.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    lastRange = range.cloneRange();
  }

  function insertBlockAtCaret(node) {
    const range = getActiveRange();
    let anchor = el.docBody.lastElementChild;
    if (range) {
      let n = range.startContainer;
      if (n.nodeType !== 1) n = n.parentElement;
      while (n && n !== el.docBody && n.parentElement !== el.docBody) n = n.parentElement;
      if (n && n.parentElement === el.docBody) anchor = n;
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
      `<span class="money-badge" title="点击切换收入 / 支出">${isIncome ? '收入' : '支出'}</span>` +
      `<label class="money-field">内容<input class="money-desc" value="${escapeAttr(desc || '')}" placeholder="如：买菜"></label>` +
      `<label class="money-field">金额<input class="money-amount" type="number" step="0.01" min="0" value="${escapeAttr(amount || '')}" placeholder="0.00"></label>` +
      '<span class="money-unit">元</span>' +
      '<button class="money-del" type="button" title="删除这条记录">✕</button>';
    return block;
  }

  function insertMoney(type) {
    if (!state.activeId) return;
    restoreSelection();
    const block = createMoneyBlock(type);
    insertBlockAtCaret(block);
    recalcTotals(); markDirty();
    block.querySelector('.money-desc').focus();
  }

  function createTotalBlock() {
    const b = document.createElement('div');
    b.className = 'total-block';
    b.contentEditable = 'false';
    b.innerHTML =
      '<span class="total-title">本月合计</span>' +
      '<span class="total-item">收入 <b class="total-income">¥0.00</b></span>' +
      '<span class="total-item">支出 <b class="total-expense">¥0.00</b></span>' +
      '<span class="total-item">结余 <b class="total-balance">¥0.00</b></span>';
    return b;
  }

  function insertTotal() {
    if (!state.activeId) return;
    restoreSelection();
    const b = createTotalBlock();
    insertBlockAtCaret(b);
    recalcTotals(); markDirty();
  }

  function recalcTotals() {
    let inc = 0, exp = 0;
    $$('.money-block', el.docBody).forEach((b) => {
      const input = b.querySelector('.money-amount');
      const v = parseFloat(input ? input.value : '');
      if (!Number.isFinite(v)) return;
      if (b.dataset.type === 'income') inc += v; else exp += v;
    });
    $$('.total-block', el.docBody).forEach((b) => {
      const incEl = b.querySelector('.total-income');
      const expEl = b.querySelector('.total-expense');
      const balEl = b.querySelector('.total-balance');
      if (incEl) incEl.textContent = '¥' + inc.toFixed(2);
      if (expEl) expEl.textContent = '¥' + exp.toFixed(2);
      if (balEl) balEl.textContent = '¥' + (inc - exp).toFixed(2);
    });
  }

  /* ---------------- 图片 ---------------- */

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result); r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function insertImage(src, opts = {}) {
    if (!state.activeId) return;
    restoreSelection();
    const wrap = document.createElement('div');
    wrap.className = `img-wrap align-${opts.align || 'center'}`;
    wrap.contentEditable = 'false';
    const img = document.createElement('img');
    img.className = 'doc-img';
    img.dataset.rotate = '0';
    img.alt = opts.alt || '记账凭证';
    img.title = opts.title || '';
    img.addEventListener('load', () => {
      if (!img.style.width) {
        const w = el.docBody.clientWidth || 720;
        img.style.width = Math.min(img.naturalWidth || w, w) + 'px';
      }
      markDirty();
    });
    img.addEventListener('error', () => { setStatus('图片加载失败'); });
    img.src = src;
    wrap.appendChild(img);
    insertBlockAtCaret(wrap);
    markDirty();
  }

  function insertImgGrid(srcs) {
    if (!state.activeId || !srcs.length) return;
    restoreSelection();
    const grid = document.createElement('div');
    grid.className = 'img-grid';
    grid.contentEditable = 'false';
    srcs.forEach((src) => {
      const img = document.createElement('img');
      img.className = 'doc-img';
      img.dataset.rotate = '0';
      img.alt = '记账凭证';
      img.src = src;
      img.addEventListener('load', () => {
        if (!img.style.width) img.style.width = '';
        markDirty();
      });
      grid.appendChild(img);
    });
    insertBlockAtCaret(grid);
    markDirty();
  }

  /* 浮动工具条 */
  function showImgBar(img) {
    currentImg = img;
    el.imgBar.classList.add('show');
    positionImgBar();
  }
  function positionImgBar() {
    if (!currentImg || !document.body.contains(currentImg)) { hideImgBar(); return; }
    const rect = currentImg.getBoundingClientRect();
    const bw = el.imgBar.offsetWidth || 330;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 8));
    let top = rect.top - 42;
    if (top < 8) top = rect.bottom + 8;
    el.imgBar.style.left = `${left}px`;
    el.imgBar.style.top = `${top}px`;
    el.imgSize.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }
  function hideImgBar() { currentImg = null; el.imgBar.classList.remove('show'); }

  function zoomImg(f) {
    if (!currentImg) return;
    const cw = el.docBody.clientWidth || 720;
    let w = parseFloat(currentImg.style.width);
    if (!Number.isFinite(w)) w = Math.min(currentImg.naturalWidth || cw, cw);
    w = Math.max(60, Math.min(w * f, cw * 3));
    currentImg.style.width = Math.round(w) + 'px';
    currentImg.style.height = '';
    markDirty(); positionImgBar();
    updateImgCtxSize();
  }
  function rotateImg(delta) {
    if (!currentImg) return;
    const cur = Number(currentImg.dataset.rotate || 0) + delta;
    const next = ((cur % 360) + 360) % 360;
    currentImg.dataset.rotate = String(next);
    currentImg.style.transform = `rotate(${next}deg)`;
    markDirty(); positionImgBar();
  }
  function resetImg() {
    if (!currentImg) return;
    const cw = el.docBody.clientWidth || 720;
    currentImg.style.width = Math.min(currentImg.naturalWidth || cw, cw) + 'px';
    currentImg.style.height = '';
    currentImg.style.transform = '';
    currentImg.dataset.rotate = '0';
    markDirty(); positionImgBar(); updateImgCtxSize();
  }
  function fitImgWidth() {
    if (!currentImg) return;
    currentImg.style.width = (el.docBody.clientWidth || 720) + 'px';
    markDirty(); positionImgBar(); updateImgCtxSize();
  }

  /* 图片右键菜单 */
  function showImgCtxMenu(x, y, img) {
    hideCtxMenu();
    hideImgBar();
    imgCtxTarget = img;
    el.imgCtxSrc.value = img.src;
    el.imgCtxTitle.value = img.title || '';
    el.imgCtxAlt.value = img.alt || '';
    // 重置子菜单面板
    $$('.img-size-sub.open', el.imgCtxMenu).forEach((el) => el.classList.remove('open'));
    updateImgCtxSize();
    el.imgCtxMenu.hidden = false;
    requestAnimationFrame(() => {
      const w = el.imgCtxMenu.offsetWidth, h = el.imgCtxMenu.offsetHeight;
      el.imgCtxMenu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
      el.imgCtxMenu.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
      el.imgCtxMenu.classList.add('show');
    });
  }
  function hideImgCtxMenu() {
    el.imgCtxMenu.classList.remove('show');
    el.imgCtxMenu.hidden = true;
    imgCtxTarget = null;
  }

  function updateImgCtxSize() {
    if (!imgCtxTarget) return;
    const rect = imgCtxTarget.getBoundingClientRect();
    const containerWidth = el.docBody.clientWidth || 720;
    const pct = Math.round((rect.width / containerWidth) * 100);
    el.imgWidthPx.value = Math.round(rect.width);
    el.imgWidthPct.value = Math.min(200, Math.max(10, pct));
    el.imgWidthPctLabel.textContent = pct + '%';
    const naturalH = imgCtxTarget.naturalHeight || rect.height;
    const naturalW = imgCtxTarget.naturalWidth || rect.width;
    const hPct = Math.round((rect.height / naturalH) * 100);
    el.imgHeightPx.value = Math.round(rect.height);
    el.imgHeightPct.value = Math.min(200, Math.max(10, hPct));
    el.imgHeightPctLabel.textContent = hPct + '%';
    // 宽度百分比可能变化图片
    if (naturalW && naturalH) {
      const aspect = naturalW / naturalH;
      const w = parseFloat(el.imgWidthPx.value) || rect.width;
      el.imgHeightPx.value = Math.round(w / aspect);
    }
  }

  function applyImgWidth(pctOrPx, unit) {
    if (!imgCtxTarget) return;
    const cw = el.docBody.clientWidth || 720;
    let w;
    if (unit === 'pct') w = cw * (pctOrPx / 100);
    else w = pctOrPx;
    w = Math.max(20, Math.min(w, cw * 3));
    imgCtxTarget.style.width = Math.round(w) + 'px';
    // 高保持等比
    if (imgCtxTarget.naturalWidth && imgCtxTarget.naturalHeight) {
      imgCtxTarget.style.height = '';
    }
    markDirty(); positionImgBar();
  }

  function applyImgHeight(pctOrPx, unit) {
    if (!imgCtxTarget) return;
    let h;
    if (unit === 'pct') h = (imgCtxTarget.naturalHeight || 100) * (pctOrPx / 100);
    else h = pctOrPx;
    h = Math.max(20, Math.min(h, 1600));
    imgCtxTarget.style.height = Math.round(h) + 'px';
    markDirty(); positionImgBar();
  }

  /* ---------------- 富文本 ---------------- */

  function applyFontSize(px) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (sel.isCollapsed) {
      let node = sel.anchorNode;
      if (node && node.nodeType !== 1) node = node.parentElement;
      const block = node && node.closest ? node.closest('p, li, blockquote, h1, h2, h3') : null;
      const target = block && el.docBody.contains(block) ? block : el.docBody;
      target.style.fontSize = px + 'px';
      return;
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    $$('font[size="7"]', el.docBody).forEach((font) => {
      const span = document.createElement('span');
      span.style.fontSize = px + 'px';
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
    } catch { /* ignore */ }
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

    /* 侧边栏头部按钮 */
    el.btnLocate.addEventListener('click', locateActiveDoc);
    el.btnFoldall.addEventListener('click', () => {
      if (state.expanded.size) collapseAll(); else expandAll();
    });
    el.btnSidebarMore.addEventListener('click', (e) => {
      e.stopPropagation();
      showSidebarMoreMenu(e.clientX, e.clientY);
    });
    el.btnSidebarCollapse.addEventListener('click', collapseSidebar);
    el.sidebarCollapsed.addEventListener('click', expandSidebar);

    /* 目录树 */
    el.tree.addEventListener('click', (event) => {
      hideCtxMenu(); hideImgCtxMenu();
      const row = event.target.closest('.tree-row');
      if (!row) return;
      const doc = findMeta(row.dataset.id);
      if (!doc) return;

      if (event.target.closest('[data-act="toggle"]')) {
        toggleExpand(doc.id); return;
      }
      if (event.target.closest('[data-act="add"]')) {
        event.stopPropagation();
        createDoc(doc.id, 'doc'); return;
      }
      if (event.target.closest('[data-act="more"]')) {
        event.stopPropagation();
        if (doc.kind === 'folder') showFolderCtxMenu(event.clientX, event.clientY, doc);
        else showDocCtxMenu(event.clientX, event.clientY, doc);
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
      if (doc.kind === 'folder') showFolderCtxMenu(event.clientX, event.clientY, doc);
      else showDocCtxMenu(event.clientX, event.clientY, doc);
    });

    /* 通用 ctx-menu（节点/侧边栏） */
    el.ctxMenu.addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const doc = ctxTargetId ? findMeta(ctxTargetId) : null;
      const x = parseInt(btn.dataset.x || '0', 10);
      const y = parseInt(btn.dataset.y || '0', 10);
      hideCtxMenu();

      if (ctxMenuOpen === 'sidebar') {
        if (act === 'new-root') {
          const root = state.docs.find((d) => !d.parent_id && d.kind === 'folder');
          await createDoc(root ? root.id : null, 'folder');
        } else if (act === 'foldall') collapseAll();
        else if (act === 'unfoldall') expandAll();
        else if (act === 'sort') { window.prompt('排序子菜单暂未实现，后续补充', document.body.innerText); renderTree(); }
        return;
      }

      /* 节点菜单 */
      if (!doc) return;
      if (act === 'rename') {
        const typed = window.prompt('重命名', doc.name);
        if (typed !== null) await renameDoc(doc, typed);
      } else if (act === 'delete') {
        await deleteDoc(doc);
      } else if (act === 'child-doc') {
        await createDoc(doc.id, 'doc');
      } else if (act === 'child-folder') {
        await createDoc(doc.id, 'folder');
      } else if (act === 'child-doc-above' || act === 'above' || act === 'below') {
        await createDoc(doc.parent_id, 'doc');
      } else if (act === 'duplicate') {
        window.alert('复制暂未实现');
      } else if (act === 'pin') {
        window.alert('置顶暂未实现');
      } else if (act === 'open-right') {
        if (!state.tabs.includes(doc.id)) state.tabs.push(doc.id);
        await openDoc(doc.id);
      } else if (act === 'move') {
        const options = ['（顶级笔记本）', ...state.docs.filter((d) => d.kind === 'folder' && d.id !== doc.id).map((d) => d.name)];
        const names = options.join('\n');
        const idx = window.prompt('移动到哪个目录？（输入序号，1 = 顶级笔记本）\n' + names, '1');
        if (idx !== null) {
          const n = parseInt(idx, 10) - 1;
          if (n >= 0 && n < options.length) {
            const target = n === 0 ? null : state.docs.filter((d) => d.kind === 'folder')[n - 1]?.id || null;
            await moveDoc(doc, target);
          }
        }
      }
    });

    /* 标签 */
    el.tabStrip.addEventListener('click', (event) => {
      if (event.target.closest('#tab-new')) {
        const root = state.docs.find((d) => !d.parent_id && d.kind === 'folder');
        createDoc(root ? root.id : null, 'doc');
        return;
      }
      const tab = event.target.closest('.tab');
      if (!tab) return;
      if (event.target.closest('[data-act="close"]')) { closeTab(tab.dataset.id); return; }
      openDoc(tab.dataset.id);
    });

    /* 标题 */
    el.docTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); el.docTitle.blur(); }
    });
    el.docTitle.addEventListener('blur', () => {
      const doc = findMeta(state.activeId);
      if (!doc) return;
      const typed = (el.docTitle.textContent || '').trim();
      if (!typed) { el.docTitle.textContent = doc.name; return; }
      renameDoc(doc, typed);
    });
    el.docTitle.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
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

    /* 正文点击 */
    el.docBody.addEventListener('click', (event) => {
      const img = event.target.closest ? event.target.closest('.doc-img') : null;
      if (img) {
        showImgBar(img);
        return;
      }
      const wrap = event.target.closest ? event.target.closest('.img-wrap, .img-grid') : null;
      if (!wrap && !el.imgBar.contains(event.target)) hideImgBar();

      const delBtn = event.target.closest ? event.target.closest('.money-del') : null;
      if (delBtn) {
        const block = delBtn.closest('.money-block');
        if (block) {
          block.remove(); recalcTotals(); markDirty();
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
          recalcTotals(); markDirty();
        }
      }
    });

    el.docBody.addEventListener('contextmenu', (event) => {
      const img = event.target.closest ? event.target.closest('.doc-img') : null;
      if (img) {
        event.preventDefault();
        showImgCtxMenu(event.clientX, event.clientY, img);
      }
    });

    /* 粘贴图片 */
    el.docBody.addEventListener('paste', async (event) => {
      const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
      const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
      if (!imageItems.length) return;
      event.preventDefault();
      const urls = [];
      for (const it of imageItems) {
        const file = it.getAsFile();
        if (file) urls.push(await readFileAsDataUrl(file));
      }
      if (urls.length === 1) insertImage(urls[0]);
      else insertImgGrid(urls);
    });

    /* 工具栏 */
    $$('.fmt-btn[data-cmd]', el.formatBar).forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (!state.activeId) return;
        restoreSelection();
        document.execCommand(btn.dataset.cmd, false, null);
        markDirty(); updateFormatState();
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
      markDirty(); el.fontSize.value = '';
    });

    $('#btn-image').addEventListener('click', () => {
      if (!state.activeId) return;
      lastRange = getActiveRange() || lastRange;
      el.fileInput.multiple = true;
      el.fileInput.click();
    });

    el.fileInput.addEventListener('change', async () => {
      const files = Array.from(el.fileInput.files || []);
      el.fileInput.value = ''; el.fileInput.multiple = false;
      if (!files.length) return;
      const imgs = files.filter((f) => f.type.startsWith('image/'));
      if (!imgs.length) { window.alert('请选择图片文件'); return; }
      if (imgs.length > 8) { window.alert('一次最多插入 8 张图片'); return; }
      const urls = [];
      for (const f of imgs) urls.push(await readFileAsDataUrl(f));
      if (urls.length === 1) insertImage(urls[0]);
      else insertImgGrid(urls);
    });

    $('#btn-net-image').addEventListener('click', () => {
      if (!state.activeId) return;
      const url = window.prompt('输入网络图片地址（http(s):// 开头）');
      if (!url) return;
      if (!/^(https?:\/\/|data:image\/)/i.test(url.trim())) {
        window.alert('地址需以 http(s):// 开头'); return;
      }
      insertImage(url.trim());
    });

    $('#btn-income').addEventListener('click', () => insertMoney('income'));
    $('#btn-expense').addEventListener('click', () => insertMoney('expense'));
    $('#btn-total').addEventListener('click', () => insertTotal());

    /* 浮动工具条 */
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
        const parent = currentImg.closest('.img-wrap, .img-grid');
        const grid = currentImg.closest('.img-grid');
        if (grid && grid.children.length > 1) {
          currentImg.remove();
          if (grid.children.length <= 1) {
            // 只剩一张，转成单图
            const remaining = grid.firstElementChild;
            const wrap = document.createElement('div');
            wrap.className = 'img-wrap align-center';
            wrap.contentEditable = 'false';
            remaining.before(wrap);
            wrap.appendChild(remaining);
            grid.remove();
          }
        } else if (parent) parent.remove();
        hideImgBar(); markDirty();
      }
    });

    /* 图片右键菜单 */
    el.imgCtxMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn || !imgCtxTarget) return;
      const act = btn.dataset.act;
      if (act === 'align-center') {
        const wrap = imgCtxTarget.closest('.img-wrap');
        if (wrap) { wrap.classList.remove('align-left', 'align-right'); wrap.classList.add('align-center'); markDirty(); }
      } else if (act === 'align-left') {
        const wrap = imgCtxTarget.closest('.img-wrap');
        if (wrap) { wrap.classList.remove('align-center', 'align-right'); wrap.classList.add('align-left'); markDirty(); }
      } else if (act === 'copy-url') {
        navigator.clipboard?.writeText(imgCtxTarget.src);
        setStatus('已复制图片地址');
      } else if (act === 'copy-img') {
        setStatus('复制图片（浏览器限制，建议直接复制地址）');
      } else if (act === 'del-img') {
        const parent = imgCtxTarget.closest('.img-wrap, .img-grid');
        const grid = imgCtxTarget.closest('.img-grid');
        if (grid && grid.children.length > 1) {
          imgCtxTarget.remove();
          if (grid.children.length <= 1) {
            const remaining = grid.firstElementChild;
            const wrap = document.createElement('div');
            wrap.className = 'img-wrap align-center';
            wrap.contentEditable = 'false';
            remaining.before(wrap);
            wrap.appendChild(remaining);
            grid.remove();
          }
        } else if (parent) parent.remove();
        hideImgCtxMenu(); markDirty();
      } else if (act === 'rename') {
        imgCtxTarget.title = el.imgCtxTitle.value.trim();
        imgCtxTarget.alt = el.imgCtxAlt.value.trim() || '记账凭证';
        markDirty();
      } else if (btn.dataset.submenu) {
        const key = btn.dataset.submenu;
        $$(`.img-size-sub[data-submenu="${key}"]`, el.imgCtxMenu).forEach((el) => el.classList.toggle('open'));
      }
    });

    el.imgCtxSrc.addEventListener('click', () => {
      el.imgCtxSrc.select();
      document.execCommand('copy');
      setStatus('已复制地址');
    });

    el.imgCtxTitle.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      imgCtxTarget.title = el.imgCtxTitle.value.trim();
      markDirty();
    });
    el.imgCtxAlt.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      imgCtxTarget.alt = el.imgCtxAlt.value.trim() || '记账凭证';
      markDirty();
    });

    // 宽度
    el.imgWidthPct.addEventListener('input', () => {
      if (!imgCtxTarget) return;
      el.imgWidthPctLabel.textContent = el.imgWidthPct.value + '%';
      applyImgWidth(Number(el.imgWidthPct.value), 'pct');
      updateImgCtxSize();
    });
    el.imgWidthPx.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      const v = Number(el.imgWidthPx.value);
      if (!Number.isFinite(v) || v <= 0) return;
      applyImgWidth(v, 'px');
      updateImgCtxSize();
    });
    $$('.img-size-presets[data-submenu="width"] button, .img-size-presets button', el.imgCtxMenu).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!imgCtxTarget) return;
        const pct = Number(btn.dataset.pct);
        if (!Number.isFinite(pct)) return;
        applyImgWidth(pct, 'pct');
        el.imgWidthPct.value = pct;
        el.imgWidthPctLabel.textContent = pct + '%';
        updateImgCtxSize();
      });
    });
    $('button[data-reset="width"]', el.imgCtxMenu).addEventListener('click', () => {
      if (!imgCtxTarget) return;
      resetImg();
      updateImgCtxSize();
    });

    // 高度
    el.imgHeightPct.addEventListener('input', () => {
      if (!imgCtxTarget) return;
      el.imgHeightPctLabel.textContent = el.imgHeightPct.value + '%';
      applyImgHeight(Number(el.imgHeightPct.value), 'pct');
      updateImgCtxSize();
    });
    el.imgHeightPx.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      const v = Number(el.imgHeightPx.value);
      if (!Number.isFinite(v) || v <= 0) return;
      applyImgHeight(v, 'px');
      updateImgCtxSize();
    });
    $$('.img-size-presets[data-submenu="height"] button', el.imgCtxMenu).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!imgCtxTarget) return;
        const pct = Number(btn.dataset.pct);
        applyImgHeight(pct, 'pct');
        el.imgHeightPct.value = pct;
        el.imgHeightPctLabel.textContent = pct + '%';
        updateImgCtxSize();
      });
    });
    $('button[data-reset="height"]', el.imgCtxMenu).addEventListener('click', () => {
      if (!imgCtxTarget) return;
      resetImg();
      updateImgCtxSize();
    });

    /* 滚动与窗口 */
    el.docScroll.addEventListener('scroll', () => { hideImgBar(); hideImgCtxMenu(); });
    window.addEventListener('resize', () => {
      if (currentImg) positionImgBar();
      if (imgCtxTarget) updateImgCtxSize();
    });

    /* 点击空白处关闭菜单 */
    document.addEventListener('mousedown', (event) => {
      if (!el.ctxMenu.contains(event.target)) hideCtxMenu();
      if (!el.imgCtxMenu.contains(event.target) && !event.target.closest('.doc-img')) hideImgCtxMenu();
      if (!el.imgBar.contains(event.target) && !event.target.closest('.doc-img') && !event.target.closest('.img-bar')) {
        hideImgBar();
      }
    });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); flushSave();
      }
      if (event.key === 'Escape') {
        hideImgBar(); hideCtxMenu(); hideImgCtxMenu();
      }
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
    window.addEventListener('beforeunload', () => { if (state.dirty) saveNow(); });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    bindEvents();
    try { await loadDocs(); }
    catch { el.tree.innerHTML = '<div class="tree-empty">加载失败，请刷新重试</div>'; return; }

    restoreUi();
    renderTree();

    const rootFolder = state.docs.find((d) => !d.parent_id && d.kind === 'folder');
    if (rootFolder) state.expanded.add(rootFolder.id);
    const yearFolder = state.docs.find((d) => d.name === '2026年');
    if (yearFolder) state.expanded.add(yearFolder.id);
    renderTree();

    const preferred = state.activeId
      ? state.activeId
      : state.docs.some((d) => d.name === '2026年11月')
      ? state.docs.find((d) => d.name === '2026年11月').id
      : state.docs.find((d) => d.kind === 'doc')?.id;

    if (preferred) {
      state.activeId = null; await openDoc(preferred);
    } else {
      renderEmpty(); renderTabs();
    }

    document.execCommand('defaultParagraphSeparator', false, 'p');
  }

  init();
})();
