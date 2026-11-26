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
    docBreadcrumb: $('#doc-breadcrumb'),
    saveStatus: $('#save-status'),
    formatBar: $('#format-bar'),
    fontSize: $('#font-size'),
    fontColor: $('#font-color'),
    fileInput: $('#file-input'),
    ctxMenu: $('#ctx-menu'),
    sidebar: $('#sidebar'),
    sidebarCollapsed: $('#sidebar-collapsed'),
    sidebarMask: $('#sidebar-mask'),
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
    btnSettings: $('#btn-settings'),
    btnLogout: $('#btn-logout'),
    settingsModal: $('#settings-modal'),
    importInput: $('#import-input'),
    pwMsg: $('#pw-msg'),
    backupList: $('#backup-list'),
    auditLog: $('#audit-log'),
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
  let lastTableInput = null; // 最后聚焦的表格原生输入框（.lg-desc/.lg-amount/.lg-date）
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
    if (res.status === 401) {
      if (location.pathname !== '/login.html') location.href = '/login.html';
      throw new Error('未登录');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
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

  /* ---------------- 手机端侧边栏抽屉（默认收起，右滑打开） ---------------- */

  function isMobileUi() {
    try { return window.matchMedia('(max-width: 760px)').matches; } catch { return false; }
  }
  function openMobileSidebar() {
    if (!isMobileUi()) return;
    el.sidebar.classList.add('mobile-open');
    if (el.sidebarMask) el.sidebarMask.hidden = false;
  }
  function closeMobileSidebar() {
    el.sidebar.classList.remove('mobile-open');
    if (el.sidebarMask) el.sidebarMask.hidden = true;
  }

  /** 编辑区任意位置右滑打开抽屉、抽屉内左滑关闭（不依赖屏幕左边缘，避开系统返回手势） */
  function bindMobileSidebarSwipe() {
    let start = null;
    document.addEventListener('touchstart', (e) => {
      if (!isMobileUi() || e.touches.length !== 1) { start = null; return; }
      const t = e.touches[0];
      const target = e.target;
      /* 菜单/滑杆/横向可滚动区域上的手势不当作拉抽屉 */
      if (target && target.closest && target.closest('.ctx-menu, .img-ctx-menu, input[type="range"], .modal, .tab-strip')) {
        start = null; return;
      }
      const opened = el.sidebar.classList.contains('mobile-open');
      const sidebarW = el.sidebar.getBoundingClientRect().width || 280;
      if (opened) {
        /* 抽屉展开时，只有从抽屉上开始左滑才收起 */
        start = t.clientX <= sidebarW ? { x: t.clientX, y: t.clientY, mode: 'close' } : null;
      } else {
        /* 抽屉收起时，编辑区任意位置右滑都可拉出 */
        start = { x: t.clientX, y: t.clientY, mode: 'open' };
      }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      /* 纵向为主的滑动交给页面滚动 */
      if (Math.abs(dy) > Math.abs(dx) * 0.9) { start = null; return; }
      if (start.mode === 'open' && dx > 55) { openMobileSidebar(); start = null; }
      else if (start.mode === 'close' && dx < -45) { closeMobileSidebar(); start = null; }
    }, { passive: true });
    document.addEventListener('touchend', () => { start = null; }, { passive: true });
    document.addEventListener('touchcancel', () => { start = null; }, { passive: true });
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
    hideImgCtxMenu();
    renderBreadcrumb(doc);
    normalizeImgs();
    normalizeLedgers();
    recalcTotals();
    el.docScroll.scrollTop = 0;
    resetHistory();
  }

  function renderBreadcrumb(doc) {
    const chain = [];
    let cur = doc;
    let guard = 0;
    while (cur && guard < 20) {
      chain.unshift(cur);
      cur = cur.parent_id ? findMeta(cur.parent_id) : null;
      guard += 1;
    }
    if (el.docBreadcrumb) {
      const parts = chain
        .filter((item) => item && item.name)
        .map((item) => `<span>${escapeHtml(item.name)}</span>`);
      el.docBreadcrumb.innerHTML = parts.join('<i>/</i>');
    }
  }

  function renderEmpty() {
    el.editor.classList.add('is-empty');
    el.docTitle.textContent = '';
    el.docBody.innerHTML = '';
    if (el.docBreadcrumb) el.docBreadcrumb.innerHTML = '';
    state.dirty = false;
    hideImgCtxMenu(); setStatus('');
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
    const open = state.expanded.has(doc.id);
    const selected = doc.id === state.activeId;
    const padding = 10 + depth * 16;
    /* 目录和文档都可以有子页面，有子级才显示展开箭头 */
    const caret = children.length
      ? `<button class="caret ${open ? 'open' : ''}" data-act="toggle">${ICON.chevron}</button>`
      : '<span class="caret-space"></span>';
    const row =
      `<div class="tree-row ${isFolder ? 'is-folder' : 'is-doc'} ${selected ? 'selected' : ''}" ` +
      `data-id="${doc.id}" data-kind="${doc.kind}" style="padding-left:${padding}px">` +
      caret +
      `<span class="node-icon ${isFolder ? 'folder' : 'doc'}">${isFolder ? ICON.folder : ICON.doc}</span>` +
      `<span class="node-name" title="${escapeAttr(doc.name)}">${escapeHtml(doc.name)}</span>` +
      `<span class="node-actions">` +
      `<button class="node-add" data-act="add" title="${isFolder ? '新建子文档' : '新建子页面'}">＋</button>` +
      `<button class="node-more" data-act="more" title="更多菜单">${ICON.more}</button>` +
      `</span>` +
      '</div>';
    if (!open) return row;
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
      <button data-act="import">导入笔记本…</button>
      <button data-act="export-all">导出全部数据</button>
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
      <button data-act="export">导出（含子级）</button>
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
      <button data-act="inner-doc">在内部新建子页面</button>
      <button data-act="duplicate">复制</button>
      <div class="ctx-divider"></div>
      <button data-act="open-right">在页签右侧打开 <span class="shortcut">Alt+点击</span></button>
      <button data-act="move">移动 <span class="sub-arrow">›</span></button>
      <button data-act="export">导出</button>
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
    /* 打字即存：250ms 内的连续输入合并成一次请求 */
    state.saveTimer = setTimeout(() => saveNow(), 250);
    scheduleHistory();
  }

  /* ---------------- 撤销 / 重做（双栈快照） ---------------- */

  const hist = { undo: [], redo: [], last: '', timer: null, muted: false };

  function resetHistory() {
    clearTimeout(hist.timer);
    hist.undo = [];
    hist.redo = [];
    hist.last = el.docBody.innerHTML;
  }

  function scheduleHistory() {
    if (hist.muted) return;
    clearTimeout(hist.timer);
    hist.timer = setTimeout(() => commitHistory(true), 500);
  }

  function commitHistory(immediate) {
    if (hist.muted) return;
    const push = () => {
      const html = el.docBody.innerHTML;
      if (html === hist.last) return;
      hist.undo.push(hist.last);
      if (hist.undo.length > 80) hist.undo.shift();
      hist.redo = [];
      hist.last = html;
    };
    if (immediate) { clearTimeout(hist.timer); push(); }
    else scheduleHistory();
  }

  function applyHistory(html) {
    hist.muted = true;
    const scroll = el.docScroll.scrollTop;
    el.docBody.innerHTML = html;
    hist.muted = false;
    hist.last = html;
    normalizeImgs();
    recalcTotals();
    state.dirty = true;
    setStatus('未保存');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveNow(), 250);
    el.docScroll.scrollTop = scroll;
  }

  function undoDoc() {
    /* 先把当前状态补记下来，保证重做能回到这里 */
    commitHistory(true);
    if (!hist.undo.length) return;
    hist.redo.push(hist.last);
    applyHistory(hist.undo.pop());
  }

  function redoDoc() {
    if (!hist.redo.length) return;
    hist.undo.push(hist.last);
    applyHistory(hist.redo.pop());
  }

  /** 把表格里的 select / input 的实时状态写回 HTML 属性，否则重载后会丢 */
  function syncTables() {
    $$('.ledger-row', el.docBody).forEach((row) => {
      const sel = row.querySelector('.lg-type');
      if (sel) {
        row.dataset.type = sel.value;
        Array.from(sel.options).forEach((opt) => {
          if (opt.value === sel.value) opt.setAttribute('selected', 'selected');
          else opt.removeAttribute('selected');
        });
      }
      $$('input', row).forEach((inp) => inp.setAttribute('value', inp.value));
    });
  }

  function serialize() {
    syncTables();
    return el.docBody.innerHTML;
  }

  async function saveNow() {
    if (!state.activeId || !state.dirty) return;
    if (state.savePromise) return state.savePromise;
    const id = state.activeId;
    const content = serialize();
    const mb = content.length / 1024 / 1024;
    state.dirty = false;
    setStatus('保存中…');
    let blocked = false;
    state.savePromise = (async () => {
      try {
        await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: { content } });
        if (!state.dirty) setStatus(mb > 15 ? `已保存（约 ${mb.toFixed(1)}MB）` : '已保存');
      } catch (e) {
        state.dirty = true;
        if (e.status === 413) {
          blocked = true;
          setStatus(e.message || `文档过大（约 ${mb.toFixed(1)}MB），请删除或压缩部分图片`);
        } else {
          setStatus('保存失败');
        }
      } finally { state.savePromise = null; }
    })();
    await state.savePromise;
    /* 保存过程中又有新的输入，再排一次；413 时不自动重试，避免持续刷屏 */
    if (state.dirty && !blocked) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => saveNow(), 250);
    }
  }

  /** 页面即将关闭时用 sendBeacon 保证最后一次修改能送达 */
  function flushSaveBeacon() {
    if (!state.activeId) return;
    if (!state.dirty) { if (state.savePromise) { /* 已在保存中，交给它 */ } return; }
    clearTimeout(state.saveTimer);
    const id = state.activeId;
    const content = serialize();
    const payload = new Blob([JSON.stringify({ content })], { type: 'application/json' });
    let ok = false;
    try {
      ok = navigator.sendBeacon(`/api/docs/${encodeURIComponent(id)}`, payload);
    } catch (e) { ok = false; }
    if (ok) { state.dirty = false; setStatus('已保存'); }
    else saveNow();
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

  /** 是否为表格里的原生输入框（window.getSelection 取不到它们的光标） */
  function isTableInput(el) {
    return !!(el && el.matches && el.matches('.lg-desc, .lg-amount, .lg-date'));
  }

  /**
   * 统一取当前光标上下文：优先原生表格输入框，其次 contenteditable 选区。
   * 返回 {kind:'range', range, node} | {kind:'input', input} | null
   */
  function getActiveContext() {
    // 原生输入框优先：聚焦 input 时 window.getSelection 会残留一个不相关的 range
    const active = document.activeElement;
    if (isTableInput(active) && el.docBody.contains(active)) return { kind: 'input', input: active };
    if (lastTableInput && el.docBody.contains(lastTableInput)) return { kind: 'input', input: lastTableInput };
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.anchorNode && el.docBody.contains(sel.anchorNode)) {
      let n = sel.getRangeAt(0).startContainer;
      if (n && n.nodeType !== 1) n = n.parentElement;
      if (n && el.docBody.contains(n)) return { kind: 'range', range: sel.getRangeAt(0), node: n };
    }
    if (lastRange && el.docBody.contains(lastRange.startContainer)) {
      let n = lastRange.startContainer;
      if (n.nodeType !== 1) n = n.parentElement;
      return { kind: 'range', range: lastRange, node: n };
    }
    return null;
  }

  function restoreSelection() {
    // 原生 input 的选区由浏览器自己保持，不要用 docBody.focus() 抢走焦点
    if (getActiveContext() && getActiveContext().kind === 'input') return;
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

  /**
   * 在光标所在行插入块级元素（不是插到下一行）。
   * - 光标行是空行：直接用新块替换这一行
   * - 光标在行中：把该行从光标处断成上下两段，新块插在中间
   * - 找不到光标行：追加到末尾
   */
  function insertBlockAtCaret(node) {
    const range = getActiveRange();

    /* 找光标所在的文本块 */
    let block = null;
    if (range) {
      let n = range.startContainer;
      if (n.nodeType !== 1) n = n.parentElement;
      const cand = n && n.closest ? n.closest('p, li, blockquote, h1, h2, h3, h4, pre, .voucher-cell') : null;
      if (cand && el.docBody.contains(cand)) block = cand;
    }

    if (!block) {
      const last = el.docBody.lastElementChild;
      if (last) last.after(node); else el.docBody.appendChild(node);
      const blank = document.createElement('p');
      node.after(blank);
      placeCaret(blank, 0);
      return;
    }

    /* 光标在凭证行里：把块直接插进凭证单元格（不拆行） */
    if (block.classList.contains('voucher-cell')) {
      try {
        range.insertNode(node);
        const parent = node.parentNode;
        const idx = Array.from(parent.childNodes).indexOf(node);
        placeCaret(parent, idx + 1);
      } catch { block.appendChild(node); }
      return;
    }

    const empty = !block.textContent.trim() && !block.querySelector('img, .img-inline, table');
    if (empty) {
      block.replaceWith(node);
      const blank = document.createElement('p');
      node.after(blank);
      placeCaret(blank, 0);
      return;
    }

    let tail = null;
    try {
      const after = range.cloneRange();
      after.selectNodeContents(block);
      after.setStart(range.endContainer, range.endOffset);
      tail = block.cloneNode(false);
      tail.appendChild(after.extractContents());
      block.after(node);
      if (tail.textContent.trim() || tail.querySelector('*')) {
        node.after(tail);
        placeCaret(tail, 0);
      } else {
        const blank = document.createElement('p');
        node.after(blank);
        placeCaret(blank, 0);
      }
    } catch (err) {
      block.after(node);
      const blank = document.createElement('p');
      node.after(blank);
      placeCaret(blank, 0);
    }
  }

  /* ---------------- 收入 / 支出 ---------------- */

  /* ---------------- 收支表格（思源数据库风格） ---------------- */

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function createLedgerRow(type, opts) {
    const o = opts || {};
    const tr = document.createElement('tr');
    tr.className = 'ledger-row';
    tr.dataset.type = type;
    tr.innerHTML =
      `<td class="c-date"><input type="date" class="lg-date" value="${o.date || todayStr()}"></td>` +
      '<td class="c-type"><select class="lg-type">' +
      `<option value="income"${type === 'income' ? ' selected' : ''}>收入</option>` +
      `<option value="expense"${type === 'expense' ? ' selected' : ''}>支出</option>` +
      '</select></td>' +
      `<td class="c-desc"><input class="lg-desc" value="${escapeAttr(o.desc || '')}" placeholder="如：买菜"></td>` +
      `<td class="c-amount num"><input class="lg-amount" type="number" step="0.01" min="0" value="${escapeAttr(o.amount || '')}" placeholder="0.00"></td>` +
      '<td class="c-op"><button class="lg-del" type="button" title="删除该行">✕</button></td>';
    return tr;
  }

  function createLedger(type) {
    const wrap = document.createElement('div');
    wrap.className = 'ledger';
    wrap.contentEditable = 'false';
    wrap.innerHTML =
      '<div class="ledger-resize" title="拖动调整表格宽度（仅内容列变化）"></div>' +
      '<table class="ledger-table">' +
      '<colgroup>' +
      '<col class="col-date" style="width:120px">' +
      '<col class="col-type" style="width:84px">' +
      '<col class="col-desc">' +
      '<col class="col-amount" style="width:116px">' +
      '<col class="col-op" style="width:32px">' +
      '</colgroup>' +
      '<thead><tr>' +
      '<th class="c-date">日期</th><th class="c-type">类型</th><th class="c-desc">内容</th>' +
      '<th class="c-amount">金额</th><th class="c-op"></th>' +
      '</tr></thead><tbody></tbody>' +
      '<tfoot><tr class="ledger-foot">' +
      '<td colspan="5"><div class="lg-foot-inner">' +
      '<span class="lg-label">合计</span>' +
      '<span class="lg-sum">' +
      '<span class="lg-income">收入 ¥0.00</span>' +
      '<span class="lg-expense">支出 ¥0.00</span>' +
      '<span class="lg-balance">结余 ¥0.00</span>' +
      '</span></div></td>' +
      '</tr></tfoot></table>' +
      '<div class="ledger-bar">' +
      '<button class="lg-add" data-type="income" type="button">＋ 收入</button>' +
      '<button class="lg-add" data-type="expense" type="button">－ 支出</button>' +
      '<button class="lg-add" data-act="voucher" type="button">＋ 凭证</button>' +
      '<button class="lg-set" data-act="settings" type="button" title="表格设置（字号/加粗/颜色/背景/边框/行高）">⚙</button>' +
      '</div>';
    wrap.querySelector('tbody').appendChild(createLedgerRow(type));
    return wrap;
  }

  /** 把旧版表格（无 colgroup / 旧合计行 / 无凭证按钮）统一升级，保证渲染一致 */
  function normalizeLedger(ledger) {
    if (!ledger) return;
    const tbl = ledger.querySelector('.ledger-table');
    if (tbl && !ledger.querySelector('colgroup')) {
      const cg = document.createElement('colgroup');
      cg.innerHTML =
        '<col class="col-date" style="width:120px">' +
        '<col class="col-type" style="width:84px">' +
        '<col class="col-desc">' +
        '<col class="col-amount" style="width:116px">' +
        '<col class="col-op" style="width:32px">';
      tbl.insertBefore(cg, tbl.firstChild);
    }
    if (!ledger.querySelector('.ledger-resize')) {
      const h = document.createElement('div');
      h.className = 'ledger-resize';
      h.title = '拖动调整表格宽度（仅内容列变化）';
      ledger.insertBefore(h, ledger.firstChild);
    }
    const foot = ledger.querySelector('.ledger-foot');
    if (foot && !foot.querySelector('.lg-foot-inner')) {
      foot.innerHTML =
        '<td colspan="5"><div class="lg-foot-inner">' +
        '<span class="lg-label">合计</span>' +
        '<span class="lg-sum">' +
        '<span class="lg-income">收入 ¥0.00</span>' +
        '<span class="lg-expense">支出 ¥0.00</span>' +
        '<span class="lg-balance">结余 ¥0.00</span>' +
        '</span></div></td>';
    }
    const bar = ledger.querySelector('.ledger-bar');
    if (bar && !bar.querySelector('[data-act="voucher"]')) {
      const b = document.createElement('button');
      b.className = 'lg-add'; b.dataset.act = 'voucher'; b.type = 'button'; b.textContent = '＋ 凭证';
      bar.appendChild(b);
    }
    if (bar && !bar.querySelector('[data-act="settings"]')) {
      const s = document.createElement('button');
      s.className = 'lg-set'; s.dataset.act = 'settings'; s.type = 'button';
      s.title = '表格设置（字号/加粗/颜色/背景/边框/行高）'; s.textContent = '⚙';
      bar.appendChild(s);
    }
    applyTableSettings(ledger);
  }
  function normalizeLedgers() { $$('.ledger', el.docBody).forEach(normalizeLedger); }

  /* ---------------- 表格设置（每张表独立，持久化到 data-* + 内联 CSS 变量） ---------------- */

  const TBL_DEFAULTS = { fs: '13', bold: '', color: '#24292f', bg: '', border: '#e5e6e8', rowh: '32' };

  /** 把 .ledger 上 data-tbl-* 设置应用为内联 CSS 变量，渲染/刷新后由 normalizeLedger 重新应用 */
  function applyTableSettings(ledger) {
    if (!ledger) return;
    const d = ledger.dataset;
    ledger.style.setProperty('--lg-fs', (d.tblFs || TBL_DEFAULTS.fs) + 'px');
    ledger.style.setProperty('--lg-bold', d.tblBold === '1' ? 'bold' : 'normal');
    ledger.style.setProperty('--lg-color', d.tblColor || TBL_DEFAULTS.color);
    ledger.style.setProperty('--lg-bg', d.tblBg || 'transparent');
    ledger.style.setProperty('--lg-border', d.tblBorder || TBL_DEFAULTS.border);
    ledger.style.setProperty('--lg-rowh', (d.tblRowh || TBL_DEFAULTS.rowh) + 'px');
  }

  function setTableSetting(ledger, key, value) {
    if (!ledger) return;
    const attr = 'tbl' + key.charAt(0).toUpperCase() + key.slice(1); // tblFs / tblBold ...
    if (value === '' || value === null || value === undefined) delete ledger.dataset[attr];
    else ledger.dataset[attr] = String(value);
    applyTableSettings(ledger);
    markDirty(); commitHistory(true);
  }

  /* 表格设置浮层（全局共享一个） */
  let tblPanel = null;
  let tblPanelTarget = null;

  function ensureTblPanel() {
    if (tblPanel) return tblPanel;
    tblPanel = document.createElement('div');
    tblPanel.className = 'tbl-settings';
    tblPanel.hidden = true;
    tblPanel.innerHTML =
      '<div class="ts-title">表格设置</div>' +
      '<div class="ts-row"><label>字号</label><input type="number" class="ts-fs" min="10" max="48" step="1"><span class="ts-unit">px</span></div>' +
      '<div class="ts-row"><label>加粗</label><input type="checkbox" class="ts-bold"></div>' +
      '<div class="ts-row"><label>字体颜色</label><input type="color" class="ts-color"></div>' +
      '<div class="ts-row"><label>表格背景</label><input type="color" class="ts-bg"><button type="button" class="ts-clear" data-k="bg">清除</button></div>' +
      '<div class="ts-row"><label>边框颜色</label><input type="color" class="ts-border"></div>' +
      '<div class="ts-row"><label>行高</label><input type="number" class="ts-rowh" min="20" max="160" step="1"><span class="ts-unit">px</span></div>' +
      '<div class="ts-actions"><button type="button" class="ts-reset">恢复默认</button></div>';
    document.body.appendChild(tblPanel);

    const bind = (sel, evt, fn) => {
      const el2 = tblPanel.querySelector(sel);
      if (el2) el2.addEventListener(evt, fn);
    };
    bind('.ts-fs', 'input', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'fs', tblPanel.querySelector('.ts-fs').value); });
    bind('.ts-bold', 'change', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'bold', tblPanel.querySelector('.ts-bold').checked ? '1' : ''); });
    bind('.ts-color', 'input', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'color', tblPanel.querySelector('.ts-color').value); });
    bind('.ts-bg', 'input', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'bg', tblPanel.querySelector('.ts-bg').value); });
    bind('.ts-border', 'input', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'border', tblPanel.querySelector('.ts-border').value); });
    bind('.ts-rowh', 'input', () => { if (tblPanelTarget) setTableSetting(tblPanelTarget, 'rowh', tblPanel.querySelector('.ts-rowh').value); });
    tblPanel.querySelector('.ts-clear').addEventListener('click', () => {
      if (!tblPanelTarget) return;
      setTableSetting(tblPanelTarget, 'bg', '');
      openTblPanel(tblPanelTarget, tblPanel._anchor); // 刷新颜色框显示
    });
    bind('.ts-reset', 'click', () => {
      if (!tblPanelTarget) return;
      ['fs', 'bold', 'color', 'bg', 'border', 'rowh'].forEach((k) => {
        const attr = 'tbl' + k.charAt(0).toUpperCase() + k.slice(1);
        delete tblPanelTarget.dataset[attr];
      });
      applyTableSettings(tblPanelTarget);
      markDirty(); commitHistory(true);
      openTblPanel(tblPanelTarget, tblPanel._anchor);
    });
    // 点击浮层外关闭
    setTimeout(() => {
      document.addEventListener('mousedown', (e) => {
        if (tblPanel.hidden) return;
        if (tblPanel.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.lg-set')) return; // 点齿轮由其自己处理
        closeTblPanel();
      });
    }, 0);
    return tblPanel;
  }

  function fillTblPanel(ledger) {
    if (!tblPanel || !ledger) return;
    const d = ledger.dataset;
    tblPanel.querySelector('.ts-fs').value = d.tblFs || TBL_DEFAULTS.fs;
    tblPanel.querySelector('.ts-bold').checked = d.tblBold === '1';
    tblPanel.querySelector('.ts-color').value = d.tblColor || TBL_DEFAULTS.color;
    tblPanel.querySelector('.ts-bg').value = d.tblBg || '#ffffff';
    tblPanel.querySelector('.ts-border').value = d.tblBorder || TBL_DEFAULTS.border;
    tblPanel.querySelector('.ts-rowh').value = d.tblRowh || TBL_DEFAULTS.rowh;
  }

  function openTblPanel(ledger, anchor) {
    const p = ensureTblPanel();
    tblPanelTarget = ledger;
    p._anchor = anchor;
    fillTblPanel(ledger);
    p.hidden = false;
    const r = anchor.getBoundingClientRect();
    const top = window.scrollY + r.bottom + 4;
    let left = window.scrollX + r.left;
    const pw = 230;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    p.style.top = top + 'px';
    p.style.left = Math.max(8, left) + 'px';
  }
  function closeTblPanel() { if (tblPanel) tblPanel.hidden = true; tblPanelTarget = null; }

  /* ---------------- 单元格内容格式化（作用于当前聚焦的表格输入框） ---------------- */

  function focusedTableInput() {
    const ctx = getActiveContext();
    return ctx && ctx.kind === 'input' ? ctx.input : null;
  }

  /** 工具栏命令作用到表格输入框（整单元格）；返回是否已处理 */
  function applyCmdToTableInput(cmd) {
    const input = focusedTableInput();
    if (!input) return false;
    if (cmd === 'bold') input.style.fontWeight = input.style.fontWeight === 'bold' ? '' : 'bold';
    else if (cmd === 'italic') input.style.fontStyle = input.style.fontStyle === 'italic' ? '' : 'italic';
    else if (cmd === 'underline') input.style.textDecoration = input.style.textDecoration === 'underline' ? '' : 'underline';
    else return false;
    autoGrowRow(input);
    markDirty(); commitHistory(true);
    syncToolbarToInput(input);
    input.focus();
    return true;
  }

  function applyFontSizeToInput(px) {
    const input = focusedTableInput();
    if (!input) return false;
    input.style.fontSize = px + 'px';
    autoGrowRow(input);
    markDirty(); commitHistory(true);
    input.focus();
    return true;
  }

  function applyColorToInput(color) {
    const input = focusedTableInput();
    if (!input) return false;
    input.style.color = color;
    markDirty(); commitHistory(true);
    input.focus();
    return true;
  }

  /** 行高随字号自动加大：由 CSS 驱动（input height:auto，td height 作为最小值，
   *  字号变大输入框变高 → 行撑高；字号调回 → 行回缩）。此处保留钩子便于扩展。 */
  function autoGrowRow(input) {
    void input;
  }

  /** 让字号下拉显示指定值；不在预设项时用一个动态项展示实际字号 */
  function setFontSizeDisplay(px) {
    if (!el.fontSize) return;
    const n = Math.round(parseFloat(px));
    if (!px || !Number.isFinite(n) || n <= 0) { el.fontSize.value = ''; return; }
    const v = String(n);
    let opt = Array.from(el.fontSize.options).find((o) => o.value === v && !o.dataset.dyn);
    if (!opt) {
      let dyn = el.fontSize.querySelector('option[data-dyn]');
      if (!dyn) {
        dyn = document.createElement('option');
        dyn.dataset.dyn = '1';
        el.fontSize.add(dyn, 1);
      }
      dyn.value = v; dyn.textContent = v;
      opt = dyn;
    }
    el.fontSize.value = v;
  }

  /** 当前正文光标处的字号（px），用于工具栏实时显示 */
  function currentCaretFontSize() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode) return null;
    if (!el.docBody.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    if (!node) return null;
    const fs = parseFloat(window.getComputedStyle(node).fontSize);
    return Number.isFinite(fs) ? fs : null;
  }

  /** 聚焦表格输入框时，把工具栏状态同步为该框的样式 */
  function syncToolbarToInput(input) {
    if (!input) return;
    const cs = window.getComputedStyle(input);
    const boldBtn = el.formatBar.querySelector('[data-cmd="bold"]');
    const italBtn = el.formatBar.querySelector('[data-cmd="italic"]');
    const undBtn = el.formatBar.querySelector('[data-cmd="underline"]');
    if (boldBtn) boldBtn.classList.toggle('active', (cs.fontWeight || '').startsWith('7') || cs.fontWeight === 'bold');
    if (italBtn) italBtn.classList.toggle('active', cs.fontStyle === 'italic');
    if (undBtn) undBtn.classList.toggle('active', (cs.textDecorationLine || cs.textDecoration || '').includes('underline'));
    const fs = parseInt(cs.fontSize, 10);
    setFontSizeDisplay(fs && fs >= 10 ? fs : null);
    if (el.fontColor) {
      const m = (cs.color || '').match(/\d+/g);
      if (m && m.length >= 3) {
        const hex = '#' + [m[0], m[1], m[2]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
        el.fontColor.value = hex;
      }
    }
  }

  function findLedgerAtCaret() {
    const range = getActiveRange();
    if (!range) return null;
    let n = range.startContainer;
    if (n.nodeType !== 1) n = n.parentElement;
    return n && n.closest ? n.closest('.ledger') : null;
  }

  /** 光标所在表格 + 当前组归属的数据行（凭证行归属到上方最近的数据行） */
  function findLedgerContext() {
    const ctx = getActiveContext();
    if (!ctx) return null;
    const n = ctx.kind === 'range' ? ctx.node : ctx.input;
    const ledger = n && n.closest ? n.closest('.ledger') : null;
    if (!ledger) return null;
    const row = n.closest ? n.closest('.ledger-row, .voucher-row') : null;
    let owner = null;
    if (row) {
      if (row.classList.contains('ledger-row')) owner = row;
      else {
        let prev = row.previousElementSibling;
        while (prev && !prev.classList.contains('ledger-row')) prev = prev.previousElementSibling;
        owner = prev || null;
      }
    }
    return { ledger, ownerRow: owner };
  }

  /** 当前数据行所在组的最后一行（其后插入新行） */
  function groupEndRow(ownerRow) {
    if (!ownerRow) return null;
    let end = ownerRow;
    let next = ownerRow.nextElementSibling;
    while (next && next.classList.contains('voucher-row')) { end = next; next = next.nextElementSibling; }
    return end;
  }

  function createVoucherRow() {
    const tr = document.createElement('tr');
    tr.className = 'voucher-row';
    tr.innerHTML =
      '<td colspan="5"><div class="voucher-wrap">' +
      '<button class="voucher-del" type="button" contenteditable="false" title="删除该凭证行">✕</button>' +
      '<div class="voucher-cell" contenteditable="true" data-placeholder="在此输入备注，或点工具栏「插入图片」上传凭证…"></div>' +
      '</div></td>';
    return tr;
  }

  function appendLedgerRow(ledger, type) {
    const row = createLedgerRow(type);
    ledger.querySelector('tbody').appendChild(row);
    recalcTotals(); markDirty(); commitHistory(true);
    const desc = row.querySelector('.lg-desc');
    if (desc) desc.focus();
    row.scrollIntoView({ block: 'nearest' });
    return row;
  }

  /** 在指定表格里插数据行：光标在某组 → 插到该组末尾；否则追加到表尾 */
  function insertLedgerRowInLedger(ledger, type) {
    restoreSelection();
    const ctx = findLedgerContext();
    if (ctx && ctx.ledger === ledger && ctx.ownerRow) {
      const end = groupEndRow(ctx.ownerRow);
      const row = createLedgerRow(type);
      end.after(row);
      recalcTotals(); markDirty(); commitHistory(true);
      const desc = row.querySelector('.lg-desc');
      if (desc) desc.focus();
      row.scrollIntoView({ block: 'nearest' });
      return row;
    }
    return appendLedgerRow(ledger, type);
  }

  /** 插入凭证行：必须光标在「内容」输入框内，否则无效 */
  function insertVoucher() {
    if (!state.activeId) return;
    const ctx = getActiveContext();
    let desc = null;
    if (ctx) {
      if (ctx.kind === 'input' && ctx.input.matches('.lg-desc')) desc = ctx.input;
      else if (ctx.kind === 'range') {
        let n = ctx.range.startContainer;
        if (n && n.nodeType !== 1) n = n.parentElement;
        desc = n && n.closest ? n.closest('.lg-desc') : null;
      }
    }
    if (!desc) { setStatus('请先把光标放到某行的「内容」输入框里'); return; }
    const ledger = desc.closest('.ledger');
    const ownerRow = desc.closest('.ledger-row');
    if (!ledger || !ownerRow) { setStatus('请先把光标放到表格的内容输入框里'); return; }
    const end = groupEndRow(ownerRow);
    const v = createVoucherRow();
    end.after(v);
    recalcTotals(); markDirty(); commitHistory(true);
    desc.focus(); // 还焦点给来源内容框（浏览器恢复其选区）
    v.scrollIntoView({ block: 'nearest' });
  }

  function insertMoney(type) {
    if (!state.activeId) return;
    restoreSelection();
    /* 光标在某张表里 → 按位置插到当前组末尾；否则在光标行新建一张表 */
    const ctx = findLedgerContext();
    if (ctx) {
      if (ctx.ownerRow) insertLedgerRowInLedger(ctx.ledger, type);
      else appendLedgerRow(ctx.ledger, type);
      return;
    }
    const ledger = createLedger(type);
    insertBlockAtCaret(ledger);
    recalcTotals(); markDirty(); commitHistory(true);
    const desc = ledger.querySelector('.lg-desc');
    if (desc) desc.focus();
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
    recalcTotals(); markDirty(); commitHistory(true);
  }

  function moneyText(v) { return '¥' + v.toFixed(2); }

  function recalcTotals() {
    let inc = 0, exp = 0;

    /* 表格形态：每张表自己算小计，同时汇总到文档级 */
    $$('.ledger', el.docBody).forEach((ledger) => {
      let lInc = 0, lExp = 0;
      $$('.ledger-row', ledger).forEach((row) => {
        const input = row.querySelector('.lg-amount');
        const v = parseFloat(input ? input.value : '');
        if (!Number.isFinite(v)) return;
        if (row.dataset.type === 'income') lInc += v; else lExp += v;
      });
      const foot = ledger.querySelector('.ledger-foot');
      if (foot) {
        const i = foot.querySelector('.lg-income');
        const e = foot.querySelector('.lg-expense');
        const b = foot.querySelector('.lg-balance');
        if (i) i.textContent = '收入 ' + moneyText(lInc);
        if (e) e.textContent = '支出 ' + moneyText(lExp);
        if (b) b.textContent = '结余 ' + moneyText(lInc - lExp);
      }
      inc += lInc; exp += lExp;
    });

    /* 兼容历史数据里的单条收支块 */
    $$('.money-block', el.docBody).forEach((b) => {
      const input = b.querySelector('.money-amount');
      const v = parseFloat(input ? input.value : '');
      if (!Number.isFinite(v)) return;
      if (b.dataset.type === 'income') inc += v; else exp += v;
    });

    /* 文档级合计卡 */
    $$('.total-block', el.docBody).forEach((b) => {
      const incEl = b.querySelector('.total-income');
      const expEl = b.querySelector('.total-expense');
      const balEl = b.querySelector('.total-balance');
      if (incEl) incEl.textContent = moneyText(inc);
      if (expEl) expEl.textContent = moneyText(exp);
      if (balEl) balEl.textContent = moneyText(inc - exp);
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

  /**
   * 插入前压缩图片：手机原图动辄 3–6MB，base64 内嵌后多张即可撑爆 25MB 上限，
   * 导致保存失败（413）与低端机内存崩溃。这里降采样到最长边 1600px、JPEG 0.72，
   * 单图通常降到 100–300KB。GIF/SVG 或压缩后反而更大时回退原图。
   */
  function compressImageFile(file) {
    return new Promise((resolve) => {
      const type = (file.type || '').toLowerCase();
      if (type === 'image/gif' || type === 'image/svg+xml') { resolve(null); return; }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || 0, h = img.naturalHeight || 0;
        if (!w || !h) { resolve(null); return; }
        const maxDim = 1600;
        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob || !blob.size || blob.size >= file.size) { resolve(null); return; }
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.72);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /** 优先压缩，失败则回退原图 data URL */
  async function imageFileToSrc(file) {
    const compressed = await compressImageFile(file);
    if (compressed) return compressed;
    return readFileAsDataUrl(file);
  }

  /** 生成一行图片：<p class="img-line"><span class="img-inline"><img><button class="img-dots">⋮</button></span></p> */
  function createImgLine(src, opts) {
    const o = opts || {};
    const line = document.createElement('p');
    line.className = 'img-line';
    const box = document.createElement('span');
    box.className = 'img-inline';
    box.contentEditable = 'false';

    const img = document.createElement('img');
    img.className = 'doc-img';
    img.dataset.rotate = '0';
    img.alt = o.alt || '记账凭证';
    if (o.title) img.title = o.title;
    img.addEventListener('error', () => setStatus('图片加载失败'));
    img.addEventListener('load', () => {
      if (!img.isConnected) return;
      /* 新图默认自适应所在容器（表格单元格 / 编辑区）宽度 */
      if (!img.dataset.w) img.dataset.w = String(imgContainerWidth(img));
      applyImgGeometry(img);
    });
    img.src = src;

    const dots = document.createElement('button');
    dots.type = 'button';
    dots.className = 'img-dots';
    dots.title = '图片菜单';
    dots.textContent = '⋮';

    box.appendChild(img);
    box.appendChild(dots);
    line.appendChild(box);
    return line;
  }

  /** 复制一行图片（保留宽度与旋转角度） */
  function cloneImgLine(img) {
    const line = createImgLine(img.src, { alt: img.alt, title: img.title });
    const copy = line.querySelector('img.doc-img');
    if (img.dataset.w) copy.dataset.w = img.dataset.w;
    if (img.dataset.rotate) copy.dataset.rotate = img.dataset.rotate;
    applyImgGeometry(copy);
    return line;
  }

  /** 插入一张图片（在光标所在行） */
  function insertImage(src, opts) {
    if (!state.activeId) return;
    restoreSelection();
    const line = createImgLine(src, opts);
    insertBlockAtCaret(line);
    markDirty();
    commitHistory(true);
    saveNow();
  }

  /** 一次插入多张：每张一行，互不关联，可单独删除 */
  function insertImages(srcs) {
    if (!state.activeId || !srcs.length) return;
    restoreSelection();
    let cursor = createImgLine(srcs[0]);
    insertBlockAtCaret(cursor);
    for (let i = 1; i < srcs.length; i += 1) {
      const line = createImgLine(srcs[i]);
      cursor.after(line);
      cursor = line;
    }
    markDirty();
    commitHistory(true);
    saveNow();
  }

  /* ---------------- 图片尺寸与旋转 ---------------- */

  /** 图片可用宽度：表格内按单元格宽度，正文按编辑区宽度（自适应表格的依据） */
  function imgContainerWidth(img) {
    let host = null;
    if (img) {
      host = img.closest('.voucher-cell') || img.closest('td');
    }
    let w = host ? host.clientWidth : 0;
    if (!w) w = el.docBody.clientWidth || 720;
    return Math.max(60, Math.round(w));
  }

  /** 期望显示宽度（px）：优先 data-w，其次自然宽度（不超过容器），兜底容器宽度 */
  function imgWidthOf(img) {
    const cw = imgContainerWidth(img);
    let w = parseFloat(img.dataset.w);
    if (!Number.isFinite(w) || w <= 0) w = Math.min(img.naturalWidth || cw, cw);
    /* 容器（尤其手机端表格）变窄时按容器宽度显示，不溢出 */
    return Math.min(w, cw);
  }

  /**
   * 按 data-w 和旋转角度重排图片。
   * 旋转 90/270 时外层盒子换成“横躺”尺寸、图片绝对定位居中旋转，
   * 这样旋转后不会溢出到编辑区外面，也不会把后面的内容挤乱。
   */
  function applyImgGeometry(img) {
    if (!img) return;
    const box = img.closest('.img-inline');
    if (!box) return;
    let w = imgWidthOf(img);
    const nw = img.naturalWidth || w;
    const nh = img.naturalHeight || w;
    const deg = ((Number(img.dataset.rotate || 0) % 360) + 360) % 360;
    /* 旋转 90/270 时横躺占位为 h，若超出容器宽度则等比缩小，避免溢出表格 */
    if ((deg === 90 || deg === 270) && Math.round(w * (nh / nw)) > imgContainerWidth(img)) {
      w = Math.max(24, Math.round(imgContainerWidth(img) * (nw / nh)));
    }
    const h = Math.round(w * (nh / nw));

    img.style.width = Math.round(w) + 'px';
    img.style.height = 'auto';
    img.style.maxWidth = 'none';

    if (deg === 90 || deg === 270) {
      box.style.width = h + 'px';
      box.style.height = Math.round(w) + 'px';
      img.style.position = 'absolute';
      img.style.left = '50%';
      img.style.top = '50%';
      img.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
    } else {
      box.style.width = Math.round(w) + 'px';
      box.style.height = 'auto';
      img.style.position = '';
      img.style.left = '';
      img.style.top = '';
      img.style.transform = deg === 180 ? 'rotate(180deg)' : '';
    }
  }

  /** 统一入口：设置宽度后重排并记录（宽度不超过所在容器，避免溢出表格） */
  function setImgWidth(img, w) {
    if (!img) return;
    const cw = imgContainerWidth(img);
    const px = Math.max(24, Math.min(Math.round(w), cw));
    img.dataset.w = String(px);
    applyImgGeometry(img);
    markDirty();
    updateImgCtxSize();
    commitHistory(true);
  }

  function rotateImg(img, delta) {
    if (!img) return;
    const cur = Number(img.dataset.rotate || 0) + delta;
    img.dataset.rotate = String(((cur % 360) + 360) % 360);
    /* 旋转后若横向占位超过容器宽度，立即缩回自适应宽度 */
    const cw = imgContainerWidth(img);
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const deg = Number(img.dataset.rotate);
    const w = parseFloat(img.dataset.w) || Math.min(nw, cw);
    const horiz = deg % 180 === 90 ? w * (nh / nw) : w;
    if (horiz > cw) {
      const fit = deg % 180 === 90 ? cw * (nw / nh) : cw;
      img.dataset.w = String(Math.max(24, Math.round(fit)));
    }
    applyImgGeometry(img);
    markDirty();
    updateImgCtxSize();
    commitHistory(true);
  }

  function fitImgWidth(img) {
    if (!img) return;
    setImgWidth(img, imgContainerWidth(img));
  }

  function resetImg(img) {
    if (!img) return;
    const cw = imgContainerWidth(img);
    img.dataset.rotate = '0';
    setImgWidth(img, Math.min(img.naturalWidth || cw, cw));
  }

  /** 重载文档后按 data-* 还原图片尺寸与旋转 */
  function normalizeImgs() {
    $$('.img-inline img.doc-img', el.docBody).forEach((img) => {
      if (img.dataset.w || img.dataset.rotate) applyImgGeometry(img);
    });
  }

  /* 移动端（窄屏/矮屏）图片菜单为底部抽屉，可滚动 */
  function imgMenuIsSheet() {
    try { return window.matchMedia('(max-width: 760px), (max-height: 520px)').matches; } catch { return false; }
  }

  /* 手机端：调整完缩放比例后自动收起菜单，方便查看图片效果 */
  function autoHideImgMenuOnMobile() {
    if (!imgMenuIsSheet()) return;
    setTimeout(() => { if (imgCtxTarget) hideImgCtxMenu(); }, 200);
  }

  /* 图片菜单：由图片右上角三点弹出 */
  function showImgCtxMenu(x, y, img) {
    hideCtxMenu();
    imgCtxTarget = img;
    el.imgCtxSrc.value = img.src;
    el.imgCtxTitle.value = img.title || '';
    el.imgCtxAlt.value = img.alt || '';
    /* 重置子菜单面板 */
    $$('.img-size-sub.open', el.imgCtxMenu).forEach((n) => n.classList.remove('open'));
    $$('.img-size-title.open', el.imgCtxMenu).forEach((n) => n.classList.remove('open'));
    updateImgCtxSize();
    el.imgCtxMenu.hidden = false;
    el.imgCtxMenu.scrollTop = 0;
    if (imgMenuIsSheet()) {
      /* 底部抽屉：定位交给 CSS，清掉旧的绝对坐标 */
      el.imgCtxMenu.style.left = '';
      el.imgCtxMenu.style.top = '';
      el.imgCtxMenu.classList.add('show');
      return;
    }
    el.imgCtxMenu.style.left = `${Math.min(x, window.innerWidth - 348)}px`;
    el.imgCtxMenu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
    el.imgCtxMenu.classList.add('show');
    requestAnimationFrame(() => {
      const w = el.imgCtxMenu.offsetWidth, h = el.imgCtxMenu.offsetHeight;
      el.imgCtxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
      el.imgCtxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
    });
  }
  function hideImgCtxMenu() {
    el.imgCtxMenu.classList.remove('show');
    el.imgCtxMenu.hidden = true;
    el.imgCtxMenu.style.left = '';
    el.imgCtxMenu.style.top = '';
    imgCtxTarget = null;
  }

  function updateImgCtxSize() {
    if (!imgCtxTarget) return;
    const w = imgWidthOf(imgCtxTarget);
    const nw = imgCtxTarget.naturalWidth || w;
    const nh = imgCtxTarget.naturalHeight || w;
    const h = w * (nh / nw);
    const cw = imgContainerWidth(imgCtxTarget);

    const pct = Math.round((w / cw) * 100);
    el.imgWidthPx.value = Math.round(w);
    el.imgWidthPct.value = Math.min(200, Math.max(10, pct));
    el.imgWidthPctLabel.textContent = pct + '%';

    const hPct = Math.round((h / nh) * 100);
    el.imgHeightPx.value = Math.round(h);
    el.imgHeightPct.value = Math.min(200, Math.max(10, hPct));
    el.imgHeightPctLabel.textContent = hPct + '%';
  }

  function applyImgWidth(pctOrPx, unit) {
    if (!imgCtxTarget) return;
    const cw = imgContainerWidth(imgCtxTarget);
    setImgWidth(imgCtxTarget, unit === 'pct' ? cw * (pctOrPx / 100) : pctOrPx);
  }

  function applyImgHeight(pctOrPx, unit) {
    if (!imgCtxTarget) return;
    const nw = imgCtxTarget.naturalWidth || 300;
    const nh = imgCtxTarget.naturalHeight || 200;
    /* 高度按百分比/像素设定后，换算成等比宽度，保证图片不变形 */
    const h = unit === 'pct' ? nh * (pctOrPx / 100) : pctOrPx;
    setImgWidth(imgCtxTarget, nw * (h / nh));
  }

  /* ---------------- 富文本 ---------------- */

  function applyFontSize(px) {
    // 光标在表格输入框里 → 作用于该单元格（行高随字号自动加大）
    if (applyFontSizeToInput(px)) return;
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
    // 聚焦在表格输入框时，工具栏状态由 syncToolbarToInput 维护，避免被 contenteditable 的查询覆盖
    if (focusedTableInput()) return;
    try {
      ['bold', 'italic', 'underline'].forEach((cmd) => {
        const btn = el.formatBar.querySelector(`[data-cmd="${cmd}"]`);
        if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
      });
    } catch { /* ignore */ }
    // 实时显示当前光标所在字号
    setFontSizeDisplay(currentCaretFontSize());
  }

  /* ---------------- 设置 / 备份 / 导入导出 / 表格调宽 ---------------- */

  function openSettings() {
    el.settingsModal.hidden = false;
    loadBackupList();
    loadAuditLog();
  }
  function closeSettings() { el.settingsModal.hidden = true; }

  async function changePassword() {
    const old = $('#set-old').value, n = $('#set-new').value, n2 = $('#set-new2').value;
    el.pwMsg.className = 'set-msg';
    el.pwMsg.textContent = '';
    if (!old || !n) { el.pwMsg.textContent = '请填写完整'; el.pwMsg.classList.add('err'); return; }
    if (n.length < 6) { el.pwMsg.textContent = '新密码至少 6 位'; el.pwMsg.classList.add('err'); return; }
    if (n !== n2) { el.pwMsg.textContent = '两次输入的新密码不一致'; el.pwMsg.classList.add('err'); return; }
    try {
      await api('/api/change-password', { method: 'POST', body: { old, new: n } });
      el.pwMsg.textContent = '密码已修改';
      el.pwMsg.classList.add('ok');
      $('#set-old').value = ''; $('#set-new').value = ''; $('#set-new2').value = '';
    } catch (e) { el.pwMsg.textContent = e.message || '修改失败'; el.pwMsg.classList.add('err'); }
  }

  async function loadBackupList() {
    try {
      const r = await api('/api/backups');
      const items = r.items || [];
      if (!items.length) { el.backupList.innerHTML = '<div class="set-empty">暂无备份</div>'; return; }
      el.backupList.innerHTML = items.map((it) => {
        const t = new Date(it.mtime);
        const sz = (it.size / 1024).toFixed(1) + ' KB';
        return (
          `<div class="set-item">` +
          `<span class="set-item-name">${escapeHtml(it.name)}</span>` +
          `<span class="set-item-meta">${t.toLocaleString()} · ${sz}</span>` +
          `<span class="set-item-acts">` +
          `<button data-restore="${escapeAttr(it.name)}">恢复</button>` +
          `<button data-del-bk="${escapeAttr(it.name)}" class="danger">删除</button>` +
          `</span></div>`
        );
      }).join('');
    } catch (e) { el.backupList.textContent = '加载失败：' + e.message; }
  }

  async function loadAuditLog() {
    try {
      const r = await api('/api/audit?limit=200');
      const items = r.items || [];
      if (!items.length) { el.auditLog.innerHTML = '<div class="set-empty">暂无日志</div>'; return; }
      el.auditLog.innerHTML = items.map((it) => {
        const t = new Date(it.ts);
        const detail = {};
        Object.keys(it).forEach((k) => { if (!['ts', 'ip', 'event'].includes(k)) detail[k] = it[k]; });
        const dstr = Object.keys(detail).length ? escapeHtml(JSON.stringify(detail)) : '';
        return (
          `<div class="log-line">` +
          `<span class="log-ts">${t.toLocaleString()}</span>` +
          `<span class="log-ip">${escapeHtml(it.ip || '')}</span>` +
          `<span class="log-ev">${escapeHtml(it.event)}</span>` +
          `<span class="log-detail">${dstr}</span>` +
          `</div>`
        );
      }).join('');
    } catch (e) { el.auditLog.textContent = '加载失败：' + e.message; }
  }

  /** 导出：id 为空导出全部，否则导出该节点子树 */
  function exportNode(id) {
    location.href = '/api/export' + (id ? '?id=' + encodeURIComponent(id) : '');
  }

  async function doImport(file) {
    setStatus('导入中…');
    let text;
    try { text = await file.text(); } catch { setStatus('读取文件失败'); return; }
    // 加密文件交给服务端用当前登录密码解密；客户端没有密钥，无法本地解密
    try {
      const r = await api('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
      });
      await loadDocs();
      renderTree();
      setStatus(`导入完成：共 ${r.count || 0} 项`);
    } catch (e) {
      setStatus('导入失败：' + (e.message || '密码不匹配或文件已损坏'));
    }
  }

  /** 表格右边缘拖拽调宽：只改 .ledger 宽度，内容列自动吸收，固定列不变 */
  function bindTableResize() {
    let dragging = null;
    const MIN = 412; // 固定列 120+84+116+32 + 内容列最小 60
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.startX;
      const max = el.docBody.clientWidth || 720;
      const w = Math.max(MIN, Math.min(max, Math.round(dragging.startWidth + dx)));
      dragging.ledger.style.width = w + 'px';
    };
    const onUp = () => {
      if (dragging) { markDirty(); commitHistory(true); dragging = null; }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    el.docBody.addEventListener('mousedown', (e) => {
      const handle = e.target.closest ? e.target.closest('.ledger-resize') : null;
      if (!handle) return;
      const ledger = handle.closest('.ledger');
      if (!ledger) return;
      e.preventDefault();
      dragging = { ledger, startX: e.clientX, startWidth: ledger.getBoundingClientRect().width };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
    el.docBody.addEventListener('dblclick', (e) => {
      const handle = e.target.closest ? e.target.closest('.ledger-resize') : null;
      if (!handle) return;
      const ledger = handle.closest('.ledger');
      if (ledger) { ledger.style.width = ''; markDirty(); commitHistory(true); }
    });
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

    // 记录最后聚焦的表格原生输入框（用于凭证行 / 按组插入的光标判定）。
    // 切回正文编辑区（contenteditable）时才清除；点按钮等非编辑控件时保留。
    el.docBody.addEventListener('focusin', (e) => {
      if (isTableInput(e.target)) { lastTableInput = e.target; syncToolbarToInput(e.target); }
      else if (e.target && e.target.isContentEditable) { lastTableInput = null; updateFormatState(); }
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
    el.btnSidebarCollapse.addEventListener('click', () => {
      if (isMobileUi()) closeMobileSidebar(); else collapseSidebar();
    });
    el.sidebarCollapsed.addEventListener('click', expandSidebar);
    if (el.sidebarMask) el.sidebarMask.addEventListener('click', closeMobileSidebar);
    bindMobileSidebarSwipe();

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
      else { openDoc(doc.id); if (isMobileUi()) closeMobileSidebar(); }
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
        else if (act === 'import') { el.importInput.click(); }
        else if (act === 'export-all') { exportNode(null); }
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
      } else if (act === 'inner-doc') {
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
      } else if (act === 'export') {
        exportNode(doc.id);
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
      if (target && target.matches && target.matches('.money-amount, .money-desc, .lg-amount, .lg-desc, .lg-date')) {
        if (target.matches('.lg-amount, .lg-desc, .lg-date')) target.setAttribute('value', target.value);
        else target.setAttribute('value', target.value);
        recalcTotals();
      }
      markDirty();
    });

    /* 收支表格：切换收支类型 */
    el.docBody.addEventListener('change', (event) => {
      const sel = event.target.closest ? event.target.closest('.lg-type') : null;
      if (!sel) return;
      const row = sel.closest('.ledger-row');
      if (!row) return;
      row.dataset.type = sel.value;
      recalcTotals(); markDirty(); commitHistory(true);
    });

    /* 正文点击 */
    el.docBody.addEventListener('click', (event) => {
      /* 点在正文空白处：把光标放到最后一行，避免沿用上一次的位置 */
      if (event.target === el.docBody) {
        let last = el.docBody.lastElementChild;
        if (!last || last.tagName !== 'P') {
          last = document.createElement('p');
          el.docBody.appendChild(last);
        }
        placeCaret(last, last.childNodes.length);
        return;
      }
      /* 图片右上角三点 → 弹出图片菜单 */
      const dots = event.target.closest ? event.target.closest('.img-dots') : null;
      if (dots) {
        event.preventDefault();
        event.stopPropagation();
        const img = dots.parentElement.querySelector('img.doc-img');
        if (img) {
          const r = dots.getBoundingClientRect();
          showImgCtxMenu(r.right, r.bottom + 4, img);
        }
        return;
      }

      /* 表格设置齿轮 */
      const setBtn = event.target.closest ? event.target.closest('.lg-set') : null;
      if (setBtn) {
        const ledger = setBtn.closest('.ledger');
        if (ledger) {
          event.preventDefault();
          if (tblPanel && !tblPanel.hidden && tblPanelTarget === ledger) closeTblPanel();
          else openTblPanel(ledger, setBtn);
        }
        return;
      }

      /* 收支表格：加一行 / 删一行 / 加凭证 */
      const addBtn = event.target.closest ? event.target.closest('.lg-add') : null;
      if (addBtn) {
        const ledger = addBtn.closest('.ledger');
        if (ledger) {
          if (addBtn.dataset.act === 'voucher') insertVoucher();
          else insertLedgerRowInLedger(ledger, addBtn.dataset.type || 'expense');
        }
        return;
      }
      const voucherDel = event.target.closest ? event.target.closest('.voucher-del') : null;
      if (voucherDel) {
        const vrow = voucherDel.closest('.voucher-row');
        if (vrow) vrow.remove();
        recalcTotals(); markDirty(); commitHistory(true);
        return;
      }
      const rowDel = event.target.closest ? event.target.closest('.lg-del') : null;
      if (rowDel) {
        const row = rowDel.closest('.ledger-row');
        const ledger = row ? row.closest('.ledger') : null;
        const isLastRow = !!(ledger && ledger.querySelectorAll('.ledger-row').length === 1);
        /* 删掉最后一行会连带删除整张表格，需二次确认 */
        if (isLastRow && !window.confirm('这是表格最后一行，删除后整张表格也会被删除，确定继续吗？')) return;
        if (row) row.remove();
        if (isLastRow) {
          const p = document.createElement('p');
          ledger.replaceWith(p);
          placeCaret(p, 0);
        }
        recalcTotals(); markDirty(); commitHistory(true);
        return;
      }

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

    /* 图片不再响应右键（改用右上角三点菜单） */

    /* 粘贴图片 */
    el.docBody.addEventListener('paste', async (event) => {
      const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
      const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
      if (!imageItems.length) return;
      event.preventDefault();
      const urls = [];
      for (const it of imageItems) {
        const file = it.getAsFile();
        if (file) urls.push(await imageFileToSrc(file));
      }
      if (urls.length === 1) insertImage(urls[0]);
      else insertImages(urls);
    });

    /* 工具栏 */
    $$('.fmt-btn[data-cmd]', el.formatBar).forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        if (!state.activeId) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'undo') { undoDoc(); return; }
        if (cmd === 'redo') { redoDoc(); return; }
        // 光标在表格输入框里 → B/I/U 作用于该单元格
        if ((cmd === 'bold' || cmd === 'italic' || cmd === 'underline') && applyCmdToTableInput(cmd)) return;
        el.docBody.focus();
        restoreSelection();
        document.execCommand(cmd, false, null);
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
      markDirty(); setFontSizeDisplay(px);
    });

    el.fontColor.addEventListener('input', () => {
      if (!state.activeId) return;
      const color = el.fontColor.value;
      if (!color) return;
      // 表格输入框 → 单元格改色；否则作用于正文选区
      if (applyColorToInput(color)) { markDirty(); return; }
      restoreSelection();
      el.docBody.focus();
      document.execCommand('foreColor', false, color);
      markDirty(); updateFormatState();
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
      for (const f of imgs) urls.push(await imageFileToSrc(f));
      if (urls.length === 1) insertImage(urls[0]);
      else insertImages(urls);
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

    /* 设置 / 备份 / 导入导出 / 登出 */
    el.btnSettings.addEventListener('click', () => openSettings());
    el.btnLogout.addEventListener('click', async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
      location.href = '/login.html';
    });
    el.settingsModal.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-close]')) closeSettings();
    });
    $('#btn-change-pw').addEventListener('click', changePassword);
    $('#btn-backup-now').addEventListener('click', async () => {
      try { await api('/api/backup', { method: 'POST' }); await loadBackupList(); setStatus('备份已创建'); }
      catch (e) { setStatus('备份失败：' + e.message); }
    });
    $('#btn-export-all').addEventListener('click', () => exportNode(null));
    $('#btn-import-file').addEventListener('click', () => el.importInput.click());
    el.importInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) doImport(f);
      e.target.value = '';
    });
    el.backupList.addEventListener('click', async (e) => {
      const restore = e.target.closest ? e.target.closest('[data-restore]') : null;
      const del = e.target.closest ? e.target.closest('[data-del-bk]') : null;
      if (restore) {
        if (!confirm(`确定从备份「${restore.dataset.restore}」恢复？当前数据将被覆盖。`)) return;
        try {
          await api(`/api/backups/${encodeURIComponent(restore.dataset.restore)}/restore`, { method: 'POST' });
          setStatus('已恢复备份');
          if (state.activeId) renderDoc(state.activeId);
          loadBackupList();
        } catch (err) { setStatus('恢复失败：' + err.message); }
      } else if (del) {
        if (!confirm(`确定删除备份「${del.dataset.delBk}」？`)) return;
        try { await api(`/api/backups/${encodeURIComponent(del.dataset.delBk)}`, { method: 'DELETE' }); loadBackupList(); }
        catch (err) { setStatus('删除失败：' + err.message); }
      }
    });

    bindTableResize();

    /* 图片菜单（由图片右上角三点触发） */
    el.imgCtxMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn || !imgCtxTarget) return;

      /* 右上角关闭按钮 */
      if (btn.id === 'img-ctx-close') { hideImgCtxMenu(); return; }

      /* 宽度 / 高度 折叠面板 */
      if (btn.dataset.submenu) {
        const key = btn.dataset.submenu;
        const panel = el.imgCtxMenu.querySelector(`.img-size-sub[data-submenu="${key}"]`);
        if (panel) panel.classList.toggle('open');
        btn.classList.toggle('open');
        if (imgMenuIsSheet()) {
          /* 抽屉模式：展开后滚动到该面板，避免被遮住 */
          requestAnimationFrame(() => {
            if (panel && panel.classList.contains('open')) panel.scrollIntoView({ block: 'nearest' });
          });
          return;
        }
        requestAnimationFrame(() => {
          const h = el.imgCtxMenu.offsetHeight;
          const top = parseFloat(el.imgCtxMenu.style.top) || 8;
          el.imgCtxMenu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
        });
        return;
      }

      const act = btn.dataset.act;
      const line = imgCtxTarget.closest('.img-line');

      if (act === 'align-center' || act === 'align-left' || act === 'align-right') {
        if (line) {
          line.classList.remove('align-left', 'align-right');
          if (act === 'align-left') line.classList.add('align-left');
          if (act === 'align-right') line.classList.add('align-right');
        }
      } else if (act === 'copy-url') {
        navigator.clipboard?.writeText(imgCtxTarget.src);
        setStatus('已复制图片地址');
      } else if (act === 'copy-img') {
        if (line) line.after(cloneImgLine(imgCtxTarget));
      } else if (act === 'cut-img') {
        if (line) line.replaceWith(cloneImgLine(imgCtxTarget));
      } else if (act === 'del-img') {
        /* 只删当前这一张：同一行里有其它图片时不受影响 */
        const box = imgCtxTarget.closest('.img-inline');
        const rowLine = imgCtxTarget.closest('.img-line');
        if (box) box.remove(); else imgCtxTarget.remove();
        if (rowLine && !rowLine.querySelector('.img-inline')) rowLine.remove();
        hideImgCtxMenu();
        markDirty(); commitHistory(true); saveNow();
        return;
      } else if (act === 'rotl') {
        rotateImg(imgCtxTarget, -90);
      } else if (act === 'rotr') {
        rotateImg(imgCtxTarget, 90);
      } else if (act === 'fit') {
        fitImgWidth(imgCtxTarget);
      } else if (act === 'reset') {
        resetImg(imgCtxTarget);
      } else if (act === 'rename') {
        imgCtxTarget.title = el.imgCtxTitle.value.trim();
        imgCtxTarget.alt = el.imgCtxAlt.value.trim() || '记账凭证';
        setStatus('已更新图片信息');
      }
      markDirty();
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
    el.imgWidthPct.addEventListener('change', autoHideImgMenuOnMobile);
    el.imgWidthPx.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      const v = Number(el.imgWidthPx.value);
      if (!Number.isFinite(v) || v <= 0) return;
      applyImgWidth(v, 'px');
      updateImgCtxSize();
      autoHideImgMenuOnMobile();
    });
    $$('.img-size-presets[data-kind="width"] button', el.imgCtxMenu).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!imgCtxTarget) return;
        const pct = Number(btn.dataset.pct);
        if (!Number.isFinite(pct)) return;
        applyImgWidth(pct, 'pct');
        el.imgWidthPct.value = pct;
        el.imgWidthPctLabel.textContent = pct + '%';
        updateImgCtxSize();
        autoHideImgMenuOnMobile();
      });
    });
    $('button[data-reset="width"]', el.imgCtxMenu).addEventListener('click', () => {
      if (!imgCtxTarget) return;
      resetImg();
      updateImgCtxSize();
      autoHideImgMenuOnMobile();
    });

    // 高度
    el.imgHeightPct.addEventListener('input', () => {
      if (!imgCtxTarget) return;
      el.imgHeightPctLabel.textContent = el.imgHeightPct.value + '%';
      applyImgHeight(Number(el.imgHeightPct.value), 'pct');
      updateImgCtxSize();
    });
    el.imgHeightPct.addEventListener('change', autoHideImgMenuOnMobile);
    el.imgHeightPx.addEventListener('change', () => {
      if (!imgCtxTarget) return;
      const v = Number(el.imgHeightPx.value);
      if (!Number.isFinite(v) || v <= 0) return;
      applyImgHeight(v, 'px');
      updateImgCtxSize();
      autoHideImgMenuOnMobile();
    });
    $$('.img-size-presets[data-kind="height"] button', el.imgCtxMenu).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!imgCtxTarget) return;
        const pct = Number(btn.dataset.pct);
        applyImgHeight(pct, 'pct');
        el.imgHeightPct.value = pct;
        el.imgHeightPctLabel.textContent = pct + '%';
        updateImgCtxSize();
        autoHideImgMenuOnMobile();
      });
    });
    $('button[data-reset="height"]', el.imgCtxMenu).addEventListener('click', () => {
      if (!imgCtxTarget) return;
      resetImg();
      updateImgCtxSize();
      autoHideImgMenuOnMobile();
    });

    /* 滚动与窗口 */
    el.docScroll.addEventListener('scroll', hideImgCtxMenu);

    /* 点在正文下方的空白区（doc-scroll 的留白）也把光标放到末尾 */
    el.docScroll.addEventListener('click', (event) => {
      if (event.target !== el.docScroll) return;
      if (!state.activeId) return;
      let last = el.docBody.lastElementChild;
      if (!last || last.tagName !== 'P') {
        last = document.createElement('p');
        el.docBody.appendChild(last);
      }
      placeCaret(last, last.childNodes.length);
    });
    window.addEventListener('resize', () => {
      if (imgCtxTarget) updateImgCtxSize();
      /* 旋屏/缩放后：切到桌面尺寸时关闭手机抽屉 */
      if (!isMobileUi()) closeMobileSidebar();
      /* 图片按新容器宽度重新自适应（表格内图片不溢出） */
      $$('.img-inline img.doc-img', el.docBody).forEach((img) => applyImgGeometry(img));
    });

    /* 点击空白处关闭菜单 */
    document.addEventListener('mousedown', (event) => {
      if (!el.ctxMenu.contains(event.target)) hideCtxMenu();
      if (!el.imgCtxMenu.contains(event.target) && !event.target.closest('.img-dots')) hideImgCtxMenu();
    });

    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault(); flushSave();
        return;
      }
      /* 编辑器内接管撤销 / 重做（原生撤销不认插入的表格和图片） */
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoDoc(); else undoDoc();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoDoc();
        return;
      }
      if (event.key === 'Escape') {
        hideCtxMenu(); hideImgCtxMenu();
      }
    });

    /* 立即保存：切到后台 / 关页面 / 失焦都用 sendBeacon 兜底 */
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaveBeacon(); });
    window.addEventListener('pagehide', flushSaveBeacon);
    window.addEventListener('beforeunload', flushSaveBeacon);
    window.addEventListener('blur', () => { if (state.dirty) saveNow(); });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    /* 会话校验：未登录直接跳登录页 */
    try {
      const st = await api('/api/auth/status');
      if (!st.authenticated) { location.href = '/login.html'; return; }
    } catch { location.href = '/login.html'; return; }
    bindEvents();
    try { await loadDocs(); }
    catch { el.tree.innerHTML = '<div class="tree-empty">加载失败，请刷新重试</div>'; return; }

    restoreUi();
    if (isMobileUi()) { el.sidebar.classList.remove('collapsed'); el.sidebarCollapsed.hidden = true; closeMobileSidebar(); }
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

    /* 兜底：每 5 秒检查一次，有未保存内容就落盘 */
    setInterval(() => { if (state.dirty) saveNow(); }, 5000);
  }

  init();
})();
