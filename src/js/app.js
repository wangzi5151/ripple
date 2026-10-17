import { icon } from './ui/icons.js';

import { Doc } from './crdt/doc.js';
import {
  ROOT_ID,
  addCard,
  addColumn,
  addComment,
  addTag,
  allCards,
  boardStats,
  boardView,
  cardMatches,
  cardView,
  commentsOf,
  ensureBoard,
  ensureDefaultColumns,
  moveCard,
  moveColumn,
  newId,
  parseQuery,
  removeCard,
  removeColumn,
  removeTag,
  renameColumn,
  restoreCard,
  restoreColumn,
  searchCards,
  setCardAssignee,
  setCardDone,
  setCardDue,
  setCardNote,
  setCardTitle,
} from './crdt/board.js';
import { applyTextDiff } from './crdt/text.js';
import { OP } from './crdt/ops.js';
import { createSyncEngine, STATUS } from './sync/engine.js';
import { buildFragment, deriveRoomId, parseFragment, randomKey } from './sync/crypto.js';
import { memoryStorage, pickStorage } from './sync/storage.js';

const COLUMN_COLORS = ['#176c57', '#3b688c', '#9c6b17', '#745a82', '#ba563f', '#4d7b70'];
const TAG_COLORS = [
  ['#d9eee6', '#105541'],
  ['#e4edf4', '#315e7e'],
  ['#f6efd9', '#795211'],
  ['#eee8f1', '#694a77'],
  ['#f8e8e2', '#934333'],
];
const STORAGE_NAMESPACE = 'ripple:workspace:v1';

const state = {
  doc: null,
  sync: null,
  room: 'ripple-demo',
  roomKey: null,
  activeView: 'board',
  search: '',
  selectedCard: null,
  selectedColumn: null,
  menu: null,
  modal: null,
  quickAddColumn: null,
  dragging: null,
  pointerDrag: null,
  demo: { step: 0, running: false, timer: null, log: [] },
  mobileNavOpen: false,
  filters: { due: null, tag: null },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function refreshIcons() {
  // Icons are inline, local SVGs: the app has no runtime CDN dependency.
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(value) {
  const text = String(value ?? '?').trim();
  return [...text].slice(0, 2).join('').toUpperCase();
}

function formatDate(date) {
  if (!date) return '';
  const value = String(date);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (value === today) return '今天';
  if (value === tomorrow) return '明天';
  return value.slice(5).replace('-', ' / ');
}

function isOverdue(date, done = false) {
  return Boolean(date && !done && date < new Date().toISOString().slice(0, 10));
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function setTitle(title) {
  document.title = `${title || 'Ripple'} · Ripple`;
}

async function bootstrap() {
  const fragment = parseFragment(location.hash, { room: state.room });
  state.room = fragment.room || state.room;
  state.roomKey = fragment.key;
  state.doc = new Doc({ node: localClientId() });
  state.sync = createSyncEngine({
    doc: state.doc,
    room: state.room,
    key: state.roomKey,
    url: websocketUrl(),
    storage: pickStorage({ namespace: STORAGE_NAMESPACE }),
    name: localStorage.getItem('ripple:name') || '我的设备',
  });
  state.sync.on(handleSyncEvent);
  await state.sync.load();
  state.doc = state.sync.doc;
  if (state.doc.opCount === 0) {
    ensureBoard(state.doc, '发布计划');
    ensureDefaultColumns(state.doc);
    seedSampleCards(state.doc);
    state.sync.pushOps(state.doc.allOps());
  }
  render();
  state.sync.start();
  registerServiceWorker();
}

function localClientId() {
  let id = localStorage.getItem('ripple:client-id');
  if (!id) {
    id = `device-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem('ripple:client-id', id);
  }
  return id;
}

function websocketUrl() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return 'ws://localhost:8787/ws';
}

function seedSampleCards(doc) {
  const columns = boardView(doc).columns;
  if (columns.some((column) => column.cards.length > 0)) return;
  const [todo, doing, done] = columns.map((column) => column.id);
  addCard(doc, todo, '整理用户反馈', { tags: ['研究'], note: '把上周访谈中的高频问题整理成一页。' });
  addCard(doc, todo, '确定发布文案', { tags: ['内容'], due: todayDate() });
  addCard(doc, doing, '离线同步协议', { tags: ['工程', '重要'], note: '验证乱序、重复投递与断网重连。' });
  const finished = addCard(doc, done, '搭建第一版看板', { tags: ['工程'] });
  const finishedId = finished.find((op) => op.t === OP.MAKE)?.e;
  if (finishedId) setCardDone(doc, finishedId, true);
}

function handleSyncEvent(event) {
  if (event.type === 'loaded') {
    state.doc = state.sync.doc;
    render();
  }
  if (event.type === 'ops' || event.type === 'snapshot') {
    state.doc = state.sync.doc;
    scheduleRender();
  }
  if (event.type === 'status') updateSyncChrome();
  if (event.type === 'peers') updateSyncChrome();
  if (event.type === 'error') {
    console.warn('[Ripple sync]', event.scope, event.error);
    if (event.scope !== 'transport') toast(event.error?.message || '同步出现问题', 'error');
    updateSyncChrome();
  }
}

function commit(ops, { rerender = true } = {}) {
  if (!ops || ops.length === 0) return;
  state.sync.pushOps(ops);
  if (rerender) render();
}

let renderFrame = null;

function scheduleRender() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

function render() {
  const app = $('#app');
  if (!app || !state.doc) return;
  const scroll = $('[data-scroll-container]');
  const scrollTop = scroll?.scrollTop ?? 0;
  const scrollLeft = scroll?.scrollLeft ?? 0;
  const cardScroll = new Map($$('.card-list[data-column-id]').map((node) => [node.dataset.columnId, node.scrollTop]));
  const view = boardView(state.doc);
  setTitle(view.title);
  app.innerHTML = renderShell(view);
  refreshIcons();
  bindShellEvents();
  updateSyncChrome();
  renderModal();
  renderMenu();
  requestAnimationFrame(() => {
    const nextScroll = $('[data-scroll-container]');
    if (nextScroll) {
      nextScroll.scrollTop = scrollTop;
      nextScroll.scrollLeft = scrollLeft;
    }
    for (const node of $$('.card-list[data-column-id]')) node.scrollTop = cardScroll.get(node.dataset.columnId) ?? 0;
  });
}

function renderShell(view) {
  const syncView = state.sync?.view() || { status: 'offline', pending: 0, peers: [] };
  const cards = allCards(state.doc);
  return `
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="#" data-action="home" aria-label="回到看板">
          <span class="brand-mark" aria-hidden="true">r</span>
          <span class="brand-name">Ripple</span>
        </a>
        <span class="topbar-divider"></span>
        <button class="board-title-button" data-action="rename-board" title="重命名看板">
          ${escapeHtml(view.title)} ${icon('chevron-down')}
        </button>
        <span class="topbar-spacer"></span>
        <div class="sync-status ${escapeHtml(syncView.status)}" data-sync-status>
          <span class="sync-dot"></span>
          <span class="sync-status-label">${syncLabel(syncView.status)}</span>
          ${syncView.pending > 0 ? `<span class="sync-pending">${syncView.pending > 99 ? '99+' : syncView.pending}</span>` : ''}
        </div>
        <div class="avatar-stack" data-avatar-stack>${renderAvatars(syncView.peers)}</div>
        <div class="topbar-actions">
          <button class="icon-button optional-action" data-action="open-demo" title="打开双设备同步演示">${icon('radio-tower')}</button>
          <button class="icon-button optional-action" data-action="open-sync" title="同步与分享">${icon('share-2')}</button>
          <button class="icon-button" data-action="open-settings" title="设置">${icon('settings-2')}</button>
        </div>
      </header>
      <div class="workspace">
        ${renderSidebar(view, cards)}
        <section class="main-area">
          ${renderToolbar(view)}
          <div class="board-scroll" data-scroll-container data-view="${escapeHtml(state.activeView)}">
            ${renderActiveView(view)}
          </div>
        </section>
      </div>
    </div>`;
}

function syncLabel(status) {
  return ({ online: '已同步', syncing: '同步中', connecting: '连接中', offline: '离线工作', error: '同步错误', idle: '未连接' })[status] || '离线工作';
}

function renderAvatars(peers) {
  const list = peers.slice(0, 4);
  if (list.length === 0) return '';
  return list.map((peer) => `<span class="avatar" title="${escapeHtml(peer.name || peer.client)}">${escapeHtml(initials(peer.name || peer.client))}</span>`).join('');
}

function renderSidebar(view, cards) {
  const stats = boardStats(state.doc);
  const columns = view.columns;
  return `
    <aside class="sidebar">
      <div class="sidebar-section-label"><span>工作区</span></div>
      <nav class="nav-list" aria-label="工作区导航">
        ${navLink('board', 'layout-dashboard', '看板', view.totalCards, state.activeView === 'board')}
        ${navLink('list', 'list', '列表', view.totalCards, state.activeView === 'list')}
        ${navLink('calendar', 'calendar-days', '日历', stats.upcoming.length, state.activeView === 'calendar')}
        ${navLink('stats', 'chart-no-axes-combined', '统计', null, state.activeView === 'stats')}
      </nav>
      <div class="sidebar-divider"></div>
      <div class="sidebar-section-label"><span>列</span><button class="icon-button" data-action="add-column" title="新增列">${icon('plus')}</button></div>
      <nav class="column-nav" aria-label="看板列">
        ${columns.map((column, index) => `<button class="nav-link" data-action="focus-column" data-column-id="${escapeHtml(column.id)}"><span class="column-swatch" style="--column-color:${COLUMN_COLORS[index % COLUMN_COLORS.length]}"></span><span>${escapeHtml(column.title)}</span><span class="nav-count">${column.cards.length}</span></button>`).join('')}
      </nav>
      <div class="sidebar-divider"></div>
      <nav class="nav-list">
        ${navLink('search', 'search', '搜索全部卡片', cards.length, state.activeView === 'search')}
        <button class="nav-link" data-action="open-trash">${icon('archive-restore')}<span>回收站</span></button>
      </nav>
      <div class="sidebar-bottom">
        <button class="nav-link" data-action="open-shortcuts">${icon('command')}<span>快捷键</span><span class="kbd">?</span></button>
        <div class="user-row"><span class="user-avatar">${escapeHtml(initials(localStorage.getItem('ripple:name') || '我'))}</span><div><div class="user-name">${escapeHtml(localStorage.getItem('ripple:name') || '我的工作区')}</div><div class="user-device">${escapeHtml(state.doc.node)}</div></div></div>
      </div>
    </aside>`;
}

function navLink(view, iconName, label, count, active) {
  return `<button class="nav-link ${active ? 'active' : ''}" data-action="set-view" data-view="${view}">${icon(iconName)}<span>${label}</span>${count !== null ? `<span class="nav-count">${count}</span>` : ''}</button>`;
}

function renderToolbar(view) {
  const activeTitle = ({ board: '看板', list: '列表', calendar: '日历', stats: '统计', search: '搜索' })[state.activeView] || '看板';
  return `<div class="view-toolbar">
    <h1 class="view-heading">${activeTitle}</h1>
    <span class="view-subtitle">${state.activeView === 'board' ? '拖动卡片以重新排列' : '保持工作清晰可见'}</span>
    <span class="toolbar-spacer"></span>
    <label class="search-box" title="搜索卡片">
      ${icon('search')}<input data-search-input value="${escapeHtml(state.search)}" placeholder="搜索标题、标签或备注" aria-label="搜索卡片" />
    </label>
    <div class="view-tabs" role="tablist" aria-label="视图切换">
      ${toolbarTab('board', 'layout-dashboard', '看板')}
      ${toolbarTab('list', 'list', '列表')}
      ${toolbarTab('calendar', 'calendar-days', '日历')}
      ${toolbarTab('stats', 'chart-no-axes-combined', '统计')}
    </div>
    <button class="button primary" data-action="quick-add">${icon('plus')}<span>新增卡片</span></button>
  </div>`;
}

function toolbarTab(view, iconName, label) {
  return `<button class="view-tab ${state.activeView === view ? 'active' : ''}" data-action="set-view" data-view="${view}" role="tab" aria-selected="${state.activeView === view}">${icon(iconName)}<span>${label}</span></button>`;
}

function renderActiveView(view) {
  if (state.activeView === 'list') return renderListView();
  if (state.activeView === 'calendar') return renderCalendarView();
  if (state.activeView === 'stats') return renderStatsView();
  if (state.activeView === 'search') return renderSearchView();
  return renderBoardView(view);
}

function renderBoardView(view) {
  return `<div class="board-canvas" data-board-canvas>
    ${view.columns.map((column, index) => renderColumn(column, index)).join('')}
    <button class="add-column-button" data-action="add-column" title="新增列">${icon('plus')}<span>新增列</span></button>
  </div>`;
}

function renderColumn(column, index) {
  const color = COLUMN_COLORS[index % COLUMN_COLORS.length];
  const quick = state.quickAddColumn === column.id;
  return `<section class="column" data-column-id="${escapeHtml(column.id)}" data-drop-column="true" style="--column-color:${color}">
    <header class="column-header">
      <span class="column-indicator"></span>
      <button class="column-title" data-action="rename-column" data-column-id="${escapeHtml(column.id)}">${escapeHtml(column.title)}</button>
      <span class="column-count">${column.cards.length}</span>
      <span class="column-spacer"></span>
      <button class="icon-button column-menu-button" data-action="column-menu" data-column-id="${escapeHtml(column.id)}" title="列选项">${icon('more-horizontal')}</button>
    </header>
    <div class="card-list" data-card-list data-column-id="${escapeHtml(column.id)}">
      ${column.cards.map((card) => renderCard(card, index)).join('')}
    </div>
    ${quick ? renderQuickAdd(column.id) : `<button class="add-card-button" data-action="quick-add" data-column-id="${escapeHtml(column.id)}">${icon('plus')}<span>添加卡片</span></button>`}
  </section>`;
}

function renderQuickAdd(columnId) {
  return `<form class="quick-add" data-quick-form data-column-id="${escapeHtml(columnId)}">
    <textarea name="title" autofocus placeholder="卡片标题…" aria-label="卡片标题"></textarea>
    <div class="quick-add-actions"><span class="quick-add-hint">⌘ + Enter 添加</span><span><button type="button" class="button small" data-action="cancel-quick-add">取消</button> <button class="button small primary" type="submit">添加</button></span></div>
  </form>`;
}

function renderCard(card, columnIndex = 0) {
  const colorIndex = Math.abs([...card.id].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % TAG_COLORS.length;
  return `<article class="card ${card.done ? 'done' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" data-column-id="${escapeHtml(card.columnId)}">
    <div class="card-topline">
      <button class="card-check ${card.done ? 'checked' : ''}" data-action="toggle-done" data-card-id="${escapeHtml(card.id)}" title="${card.done ? '标记未完成' : '标记完成'}">${card.done ? icon('check') : ''}</button>
      <button class="card-title" data-action="open-card" data-card-id="${escapeHtml(card.id)}">${escapeHtml(card.title || '未命名卡片')}</button>
      <button class="icon-button" data-action="card-menu" data-card-id="${escapeHtml(card.id)}" title="卡片选项">${icon('more-horizontal')}</button>
    </div>
    ${card.note ? `<button class="card-note-preview" data-action="open-card" data-card-id="${escapeHtml(card.id)}">${escapeHtml(card.note)}</button>` : ''}
    ${(card.tags.length || card.due || card.comments.length) ? `<div class="card-meta">
      ${card.tags.map((tag, tagIndex) => { const pair = TAG_COLORS[(colorIndex + tagIndex) % TAG_COLORS.length]; return `<span class="tag-chip" style="--tag-bg:${pair[0]};--tag-ink:${pair[1]}">${escapeHtml(tag)}</span>`; }).join('')}
      ${card.due ? `<span class="due-chip ${isOverdue(card.due, card.done) ? 'overdue' : card.due === todayDate() ? 'today' : ''}">${icon('calendar-days')}${formatDate(card.due)}</span>` : ''}
      ${card.comments.length ? `<span class="card-action">${icon('message-square')} ${card.comments.length}</span>` : ''}
    </div>` : ''}
  </article>`;
}

function renderListView() {
  const cards = filteredCards();
  if (!cards.length) return `<div class="list-view"><div class="empty-state">${icon('inbox')}<strong>还没有匹配的卡片</strong><span>换一个搜索条件，或从看板新增卡片。</span></div></div>`;
  const columnMap = new Map(boardView(state.doc).columns.map((column) => [column.id, column]));
  return `<div class="list-view"><div class="list-table-wrap"><table class="list-table"><thead><tr><th>卡片</th><th>列</th><th>标签</th><th>截止日期</th><th class="hide-mobile">状态</th><th class="hide-mobile">备注</th></tr></thead><tbody>${cards.map((card) => `<tr><td><button class="list-title-button" data-action="open-card" data-card-id="${escapeHtml(card.id)}">${escapeHtml(card.title || '未命名卡片')}</button></td><td><span class="list-column"><span class="column-swatch" style="--column-color:${COLUMN_COLORS[Math.max(0, [...columnMap.keys()].indexOf(card.columnId)) % COLUMN_COLORS.length]}"></span>${escapeHtml(columnMap.get(card.columnId)?.title || '未分类')}</span></td><td>${card.tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join(' ') || '<span class="form-hint">无</span>'}</td><td>${card.due ? `<span class="due-chip ${isOverdue(card.due, card.done) ? 'overdue' : ''}">${formatDate(card.due)}</span>` : '<span class="form-hint">未设置</span>'}</td><td class="hide-mobile">${card.done ? '<span class="meta-chip">已完成</span>' : '<span class="meta-chip">进行中</span>'}</td><td class="hide-mobile">${card.noteLength ? `${card.noteLength} 字` : '<span class="form-hint">无</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderCalendarView() {
  const cards = allCards(state.doc).filter((card) => card.due);
  const cursor = new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const byDate = new Map();
  for (const card of cards) { const list = byDate.get(card.due) || []; list.push(card); byDate.set(card.due, list); }
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  return `<div class="calendar-view"><h2 class="calendar-month-title">${year} 年 ${month + 1} 月 <span class="form-hint">${cards.length} 个有日期的卡片</span></h2><div class="calendar-grid">${weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join('')}${days.map((day) => { const key = day.toISOString().slice(0, 10); const entries = byDate.get(key) || []; const outside = day.getMonth() !== month; return `<div class="calendar-day ${outside ? 'outside' : ''} ${key === todayDate() ? 'today' : ''}"><div class="calendar-day-number">${day.getDate()}</div>${entries.slice(0, 3).map((card) => `<button class="calendar-event ${card.done ? 'done' : ''} ${isOverdue(card.due, card.done) ? 'overdue' : ''}" data-action="open-card" data-card-id="${escapeHtml(card.id)}">${escapeHtml(card.title)}</button>`).join('')}${entries.length > 3 ? `<span class="calendar-event more">+${entries.length - 3} 个</span>` : ''}</div>`; }).join('')}</div></div>`;
}

function renderStatsView() {
  const stats = boardStats(state.doc);
  const maxCount = Math.max(1, ...stats.byColumn.map((column) => column.count));
  return `<div class="stats-view"><div class="stats-grid">
    ${statBlock('全部卡片', stats.cards, `${stats.open} 个未完成`, 'layers-3')}
    ${statBlock('已完成', stats.done, `${Math.round(stats.doneRate * 100)}% 完成率`, 'check-circle-2')}
    ${statBlock('逾期', stats.overdue, stats.overdue ? '需要关注' : '按计划进行', 'alarm-clock')}
    ${statBlock('备注字数', stats.noteChars, `${stats.comments} 条评论`, 'notebook-pen')}
  </div>
  <section class="stats-section"><h3>按列分布</h3>${stats.byColumn.map((column, index) => `<div class="bar-row"><span>${escapeHtml(column.title)}</span><span class="bar-track"><span class="bar-fill" style="width:${(column.count / maxCount) * 100}%;background:${COLUMN_COLORS[index % COLUMN_COLORS.length]}"></span></span><span class="bar-count">${column.count}</span></div>`).join('')}</section>
  <section class="stats-section"><h3>标签使用</h3><div class="tag-cloud">${stats.tags.length ? stats.tags.map((tag, index) => `<button class="tag-cloud-item" data-action="filter-tag" data-tag="${escapeHtml(tag.name)}" style="--tag-bg:${TAG_COLORS[index % TAG_COLORS.length][0]}">${escapeHtml(tag.name)} <small>${tag.count}</small></button>`).join('') : '<span class="form-hint">还没有标签</span>'}</div></section>
  <section class="stats-section"><h3>接下来要做</h3>${stats.upcoming.length ? `<div class="search-results">${stats.upcoming.map((card) => renderSearchResult(card)).join('')}</div>` : '<div class="form-hint">没有即将到期的卡片。</div>'}</section>
  </div>`;
}

function statBlock(label, value, note, iconName) {
  return `<div class="stat-block"><div class="stat-label">${icon(iconName)} ${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;
}

function renderSearchView() {
  const cards = filteredCards();
  return `<div class="search-view"><div class="search-results">${cards.length ? cards.map((card) => renderSearchResult(card)).join('') : `<div class="empty-state">${icon('search-x')}<strong>没有找到匹配的卡片</strong><span>试试标题、tag:标签、col:列名 或 due:overdue</span></div>`}</div></div>`;
}

function renderSearchResult(card) {
  return `<button class="search-result" data-action="open-card" data-card-id="${escapeHtml(card.id)}"><span class="card-check ${card.done ? 'checked' : ''}">${card.done ? icon('check') : ''}</span><span><span class="search-result-title">${escapeHtml(card.title || '未命名卡片')}</span><span class="search-result-sub">${escapeHtml(card.note || card.tags.join(' · ') || '无备注')}</span></span><span class="search-result-meta">${card.due ? formatDate(card.due) : '无日期'}</span></button>`;
}

function filteredCards() {
  const cards = allCards(state.doc);
  if (!state.search.trim()) return cards;
  return searchCards(state.doc, state.search, { today: todayDate() });
}

function bindShellEvents() {
  // Delegation is installed once below so dynamically replaced shell and modal
  // nodes share the same handlers.
}

function eventTargetAction(event) {
  return event.target.closest('[data-action]');
}

function handleClick(event) {
  const actionNode = eventTargetAction(event);
  if (!actionNode) {
    if (!event.target.closest('.popover')) closeMenu();
    return;
  }
  const action = actionNode.dataset.action;
  if (action === 'home') { event.preventDefault(); state.activeView = 'board'; state.search = ''; render(); return; }
  if (action === 'set-view') { state.activeView = actionNode.dataset.view; closeMenu(); render(); return; }
  if (action === 'focus-column') { state.activeView = 'board'; requestAnimationFrame(() => $(`[data-column-id="${CSS.escape(actionNode.dataset.columnId)}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start' })); render(); return; }
  if (action === 'quick-add') { state.quickAddColumn = actionNode.dataset.columnId || boardView(state.doc).columns[0]?.id; render(); requestAnimationFrame(() => $('[data-quick-form] textarea')?.focus()); return; }
  if (action === 'cancel-quick-add') { state.quickAddColumn = null; render(); return; }
  if (action === 'add-column') { openColumnDialog(); return; }
  if (action === 'rename-board') { openBoardDialog(); return; }
  if (action === 'rename-column') { openColumnDialog(actionNode.dataset.columnId); return; }
  if (action === 'column-menu') { toggleMenu('column', actionNode.dataset.columnId, actionNode); return; }
  if (action === 'card-menu') { toggleMenu('card', actionNode.dataset.cardId, actionNode); return; }
  if (action === 'open-card') { openCardDialog(actionNode.dataset.cardId); return; }
  if (action === 'toggle-done') { const card = cardView(state.doc, actionNode.dataset.cardId); commit(setCardDone(state.doc, card.id, !card.done)); return; }
  if (action === 'open-sync') { openSyncDialog(); return; }
  if (action === 'open-demo') { openDemoDialog(); return; }
  if (action === 'open-settings') { openSettingsDialog(); return; }
  if (action === 'open-shortcuts') { openShortcutsDialog(); return; }
  if (action === 'open-trash') { openTrashDialog(); return; }
  if (action === 'filter-tag') { state.search = `tag:${actionNode.dataset.tag}`; state.activeView = 'search'; render(); return; }
  if (action === 'menu-action') { handleMenuAction(actionNode.dataset.menuType, actionNode.dataset.menuId, actionNode.dataset.menuAction); return; }
  if (action === 'trash-restore') { restoreEntity(actionNode.dataset.entityId, actionNode.dataset.entityKind); return; }
  if (action === 'modal-close') { closeModal(); return; }
  if (action === 'save-modal') { saveModal(event); return; }
  if (action === 'delete-card') { const id = actionNode.dataset.cardId; saveCardDraft(); commit(removeCard(state.doc, id)); closeModal(); return; }
  if (action === 'clear-local') { clearLocalData(); return; }
  if (action === 'restore-entity') { restoreEntity(actionNode.dataset.entityId, actionNode.dataset.entityKind); return; }
  if (action === 'add-tag') { addTagFromDetail(actionNode.dataset.cardId); return; }
  if (action === 'remove-tag') { commit(removeTag(state.doc, actionNode.dataset.cardId, actionNode.dataset.tag)); if (state.modal?.type === 'card') renderModal(); return; }
  if (action === 'add-comment') { addCommentFromDetail(actionNode.dataset.cardId); return; }
  if (action === 'share-copy') { copyShareLink(); return; }
  if (action === 'new-key') { generateRoomKey(); return; }
  if (action === 'apply-key') { applyRoomKey(); return; }
  if (action === 'sync-now') { state.sync.syncNow(); toast('已请求同步'); return; }
  if (action === 'demo-next') { demoNext(); return; }
  if (action === 'demo-reset') { demoReset(); return; }
  if (action === 'demo-run') { demoRun(); return; }
}

function handleSubmit(event) {
  const form = event.target.closest('[data-quick-form]');
  if (form) {
    event.preventDefault();
    const title = form.elements.title.value.trim();
    if (!title) return;
    commit(addCard(state.doc, form.dataset.columnId, title));
    state.quickAddColumn = null;
    render();
    return;
  }
}

function handleInput(event) {
  if (event.target.matches('[data-search-input]')) {
    state.search = event.target.value;
    if (state.activeView === 'board' && state.search.trim()) state.activeView = 'search';
    window.clearTimeout(handleInput.timer);
    handleInput.timer = window.setTimeout(scheduleRender, 120);
  }
  if (event.target.matches('[data-dialog-title]')) {
    state.modal.draft.title = event.target.value;
  }
  if (event.target.matches('[data-dialog-note]')) {
    state.modal.draft.note = event.target.value;
  }
}

function handleChange(event) {
  const target = event.target;
  if (target.matches('[data-card-due]')) { commit(setCardDue(state.doc, target.dataset.cardId, target.value || null)); renderModal(); return; }
  if (target.matches('[data-card-assignee]')) { commit(setCardAssignee(state.doc, target.dataset.cardId, target.value.trim() || null)); renderModal(); return; }
  if (target.matches('[data-card-column]')) {
    const card = cardView(state.doc, target.dataset.cardId);
    const targetColumn = target.value;
    const index = boardView(state.doc).columns.find((column) => column.id === targetColumn)?.cards.length ?? 0;
    commit(moveCard(state.doc, card.id, targetColumn, index));
    renderModal();
  }
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('[data-search-input]')?.focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && event.target.closest('[data-quick-form]')) {
    event.preventDefault();
    event.target.closest('form').requestSubmit();
  }
  if (event.key === 'Escape') {
    if (state.modal) closeModal();
    else closeMenu();
  }
}

function handlePointerDown(event) {
  if (event.pointerType === 'mouse' || event.button !== 0) return;
  const card = event.target.closest('.card');
  if (!card || event.target.closest('button, input, textarea, select, a')) return;
  state.pointerDrag = {
    cardId: card.dataset.cardId,
    sourceColumnId: card.dataset.columnId,
    card,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
  };
  card.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.active && distance < 8) return;
  if (!drag.active) {
    drag.active = true;
    state.dragging = { cardId: drag.cardId, sourceColumnId: drag.sourceColumnId };
    drag.card.classList.add('dragging');
    drag.card.style.setProperty('--drag-x', '0px');
    drag.card.style.setProperty('--drag-y', '0px');
    document.body.classList.add('is-pointer-dragging');
  }
  event.preventDefault();
  drag.card.style.setProperty('--drag-x', `${event.clientX - drag.startX}px`);
  drag.card.style.setProperty('--drag-y', `${event.clientY - drag.startY}px`);
  const scroll = $('[data-scroll-container]');
  if (scroll) {
    const edge = 42;
    const rect = scroll.getBoundingClientRect();
    if (event.clientX < rect.left + edge) scroll.scrollLeft -= 10;
    else if (event.clientX > rect.right - edge) scroll.scrollLeft += 10;
    if (event.clientY < rect.top + edge) scroll.scrollTop -= 8;
    else if (event.clientY > rect.bottom - edge) scroll.scrollTop += 8;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (!target) return;
  handleDragOver({ target, clientY: event.clientY, preventDefault() {} });
}

function handlePointerUp(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.pointerDrag = null;
  drag.card.releasePointerCapture?.(event.pointerId);
  if (!drag.active) return;
  event.preventDefault();
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (target) handleDrop({ target, clientY: event.clientY, preventDefault() {} });
  clearDragState();
  document.body.classList.remove('is-pointer-dragging');
}

function handlePointerCancel() {
  if (!state.pointerDrag) return;
  state.pointerDrag = null;
  clearDragState();
  document.body.classList.remove('is-pointer-dragging');
}

function handleDragStart(event) {
  const card = event.target.closest('.card');
  if (!card) return;
  state.dragging = { cardId: card.dataset.cardId, sourceColumnId: card.dataset.columnId };
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.cardId);
}

function handleDragOver(event) {
  if (!state.dragging) return;
  const column = event.target.closest('[data-drop-column]');
  if (!column) return;
  event.preventDefault();
  $$('.column.drag-target').forEach((node) => node.classList.remove('drag-target'));
  column.classList.add('drag-target');
  $$('.card.drop-before, .card.drop-after').forEach((node) => node.classList.remove('drop-before', 'drop-after'));
  const card = event.target.closest('.card');
  if (card && card.dataset.cardId !== state.dragging.cardId) {
    const rect = card.getBoundingClientRect();
    card.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  }
}

function handleDragLeave(event) {
  if (!event.target.closest('.column')) return;
  if (!event.currentTarget.contains(event.relatedTarget)) clearDragState();
}

function handleDrop(event) {
  if (!state.dragging) return;
  event.preventDefault();
  const column = event.target.closest('[data-drop-column]');
  if (!column) return clearDragState();
  const cardId = state.dragging.cardId;
  const cards = boardView(state.doc).columns.find((item) => item.id === column.dataset.columnId)?.cards || [];
  const target = event.target.closest('.card');
  let index = cards.length;
  if (target && target.dataset.cardId !== cardId) {
    const found = cards.findIndex((card) => card.id === target.dataset.cardId);
    index = found < 0 ? cards.length : found + (event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? 1 : 0);
  }
  commit(moveCard(state.doc, cardId, column.dataset.columnId, index));
  clearDragState();
  render();
}

function clearDragState() {
  state.dragging = null;
  document.body.classList.remove('is-pointer-dragging');
  $$('.card.dragging, .card.drop-before, .card.drop-after').forEach((node) => {
    node.classList.remove('dragging', 'drop-before', 'drop-after');
    node.style.removeProperty('--drag-x');
    node.style.removeProperty('--drag-y');
  });
  $$('.column.drag-target').forEach((node) => node.classList.remove('drag-target'));
}

function openBoardDialog() {
  state.modal = { type: 'board', draft: { title: boardView(state.doc).title } };
  renderModal();
}

function openColumnDialog(columnId = null) {
  const column = columnId ? boardView(state.doc).columns.find((item) => item.id === columnId) : null;
  state.modal = { type: column ? 'column' : 'new-column', id: columnId, draft: { title: column?.title || '' } };
  renderModal();
}

function openCardDialog(cardId) {
  const card = cardView(state.doc, cardId);
  if (!card) return;
  state.modal = { type: 'card', id: cardId, draft: { title: card.title, note: card.note } };
  renderModal();
}

function openSyncDialog() {
  state.modal = { type: 'sync' };
  renderModal();
}

function openDemoDialog() {
  state.modal = { type: 'demo' };
  state.demo = { step: 0, running: false, timer: null, log: [] };
  renderModal();
}

function openSettingsDialog() {
  state.modal = { type: 'settings', draft: { name: localStorage.getItem('ripple:name') || '我的设备' } };
  renderModal();
}

function openShortcutsDialog() { state.modal = { type: 'shortcuts' }; renderModal(); }

function openTrashDialog() { state.modal = { type: 'trash' }; renderModal(); }

async function clearLocalData() {
  const accepted = globalThis.confirm?.('清除本机缓存？尚未同步的操作会丢失。') ?? false;
  if (!accepted) return;
  await state.sync.clearStorage();
  localStorage.removeItem(STORAGE_NAMESPACE);
  toast('本机缓存已清除；当前内存中的看板仍保持打开');
}

function restoreEntity(entityId, kind) {
  commit(kind === 'column' ? restoreColumn(state.doc, entityId) : restoreCard(state.doc, entityId));
  if (state.modal?.type === 'trash') renderModal();
}

function closeModal() {
  if (state.modal?.type === 'card') saveCardDraft();
  if (state.demo.timer) clearInterval(state.demo.timer);
  state.demo.timer = null;
  state.modal = null;
  render();
}

function renderModal() {
  let mount = $('#modal-root');
  if (!mount && state.modal) {
    document.body.insertAdjacentHTML('beforeend', '<div id="modal-root"></div>');
    mount = $('#modal-root');
  }
  if (!mount) return;
  if (!state.modal) { mount.innerHTML = ''; return; }
  mount.innerHTML = `<div class="overlay"><section class="dialog ${state.modal.type === 'card' || state.modal.type === 'demo' ? 'wide' : ''}" role="dialog" aria-modal="true" data-dialog-panel>${renderModalContent()}</section></div>`;
  refreshIcons();
  $('.overlay', mount)?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
  requestAnimationFrame(() => $('.dialog input, .dialog textarea', mount)?.focus());
}

function modalTitle(title, iconName = 'panel-top') {
  return `<div class="dialog-titlebar"><h2 class="dialog-title">${icon(iconName)}${title}</h2><button class="icon-button" data-action="modal-close" title="关闭">${icon('x')}</button></div>`;
}

function renderModalContent() {
  const modal = state.modal;
  if (modal.type === 'board') return `${modalTitle('重命名看板', 'pencil')}<div class="dialog-content"><div class="form-field"><label for="dialog-title">看板名称</label><input id="dialog-title" data-modal-input="title" value="${escapeHtml(modal.draft.title)}" autofocus /></div></div><div class="dialog-actions"><button class="button" data-action="modal-close">取消</button><button class="button primary" data-action="save-modal">保存</button></div>`;
  if (modal.type === 'new-column' || modal.type === 'column') return `${modalTitle(modal.type === 'column' ? '编辑列' : '新增列', 'columns-3')}<div class="dialog-content"><div class="form-field"><label for="dialog-title">列名称</label><input id="dialog-title" data-modal-input="title" value="${escapeHtml(modal.draft.title)}" placeholder="例如：待审核" autofocus /></div></div><div class="dialog-actions"><button class="button" data-action="modal-close">取消</button><button class="button primary" data-action="save-modal">保存</button></div>`;
  if (modal.type === 'card') return renderCardModal();
  if (modal.type === 'sync') return renderSyncModal();
  if (modal.type === 'settings') return `${modalTitle('设置', 'settings-2')}<div class="dialog-content"><div class="form-field"><label for="dialog-name">设备名称</label><input id="dialog-name" data-modal-input="name" value="${escapeHtml(modal.draft.name)}" /><span class="form-hint">这个名字会显示给同一房间的其他设备。</span></div><div class="form-field"><label>本地数据</label><button class="button" data-action="clear-local">${icon('database-zap')}清除本机缓存</button></div></div><div class="dialog-actions"><button class="button" data-action="modal-close">取消</button><button class="button primary" data-action="save-modal">保存</button></div>`;
  if (modal.type === 'shortcuts') return `${modalTitle('快捷键', 'command')}<div class="dialog-content"><div class="sync-detail"><span>搜索</span><span class="kbd">⌘ K</span></div><div class="sync-detail"><span>快速新增卡片</span><span class="kbd">⌘ Enter</span></div><div class="sync-detail"><span>关闭弹窗</span><span class="kbd">Esc</span></div><p class="form-hint">移动端使用顶部搜索、加号和长按菜单完成同样操作。</p></div>`;
  if (modal.type === 'trash') return renderTrashModal();
  if (modal.type === 'demo') return renderDemoModal();
  return '';
}

function renderCardModal() {
  const card = cardView(state.doc, state.modal.id);
  const columns = boardView(state.doc).columns;
  if (!card) return '';
  return `${modalTitle('卡片详情', 'square-kanban')}<div class="dialog-content"><div class="card-dialog-layout"><div class="card-dialog-main"><input class="dialog-card-title" data-dialog-title value="${escapeHtml(state.modal.draft.title)}" aria-label="卡片标题" /><div class="dialog-section"><h3 class="dialog-section-title">${icon('notebook-pen')}备注</h3><textarea class="note-editor" data-dialog-note placeholder="写下背景、链接或下一步…">${escapeHtml(state.modal.draft.note)}</textarea></div><div class="dialog-section"><h3 class="dialog-section-title">${icon('message-square')}评论 <span class="form-hint">${card.comments.length}</span></h3><div class="comment-list">${card.comments.map((comment) => renderComment(comment)).join('') || '<span class="form-hint">还没有评论。</span>'}</div><div class="comment-compose"><textarea data-comment-input placeholder="添加一条评论…" aria-label="评论内容"></textarea><button class="button small" data-action="add-comment" data-card-id="${escapeHtml(card.id)}">${icon('send')}发表评论</button></div></div></div><aside class="card-dialog-side"><div class="detail-field"><label>所在列</label><select data-card-column data-card-id="${escapeHtml(card.id)}">${columns.map((column) => `<option value="${escapeHtml(column.id)}" ${column.id === card.columnId ? 'selected' : ''}>${escapeHtml(column.title)}</option>`).join('')}</select></div><div class="detail-field"><label>截止日期</label><input type="date" data-card-due data-card-id="${escapeHtml(card.id)}" value="${escapeHtml(card.due || '')}" /></div><div class="detail-field"><label>负责人</label><input data-card-assignee data-card-id="${escapeHtml(card.id)}" value="${escapeHtml(card.assignee || '')}" placeholder="未分配" /></div><div class="detail-field"><label>标签</label><div class="detail-tags">${card.tags.map((tag) => `<span class="detail-tag">${escapeHtml(tag)}<button data-action="remove-tag" data-card-id="${escapeHtml(card.id)}" data-tag="${escapeHtml(tag)}" title="移除标签">${icon('x')}</button></span>`).join('') || '<span class="form-hint">无标签</span>'}</div><div class="tag-add-row"><input data-tag-input placeholder="新增标签" /><button class="icon-button" data-action="add-tag" data-card-id="${escapeHtml(card.id)}" title="添加标签">${icon('plus')}</button></div></div><div class="detail-field"><label>创建于</label><span class="form-hint">${formatStamp(card.id)}</span></div></aside></div></div><div class="dialog-actions"><button class="button danger" data-action="delete-card" data-card-id="${escapeHtml(card.id)}">${icon('trash-2')}删除</button><span class="toolbar-spacer"></span><button class="button" data-action="modal-close">完成</button></div>`;
}

function renderComment(comment) {
  return `<div class="comment"><span class="comment-avatar">${escapeHtml(initials(comment.author || ''))}</span><div class="comment-body"><div class="comment-meta">${escapeHtml(comment.author || '未知设备')}</div>${escapeHtml(comment.body)}</div></div>`;
}

function renderSyncModal() {
  const syncView = state.sync.view();
  const fragment = buildFragment({ room: state.room, key: state.roomKey });
  return `${modalTitle('同步与分享', 'share-2')}<div class="dialog-content"><div class="sync-dialog-grid"><div class="sync-panel"><h3>${icon('radio-tower')}连接状态</h3><div class="sync-detail"><span>状态</span><span>${syncLabel(syncView.status)}</span></div><div class="sync-detail"><span>房间</span><span>${escapeHtml(state.room)}</span></div><div class="sync-detail"><span>本地操作</span><span>${syncView.opCount}</span></div><div class="sync-detail"><span>待同步</span><span>${syncView.pending}</span></div><div class="sync-detail"><span>存储</span><span>${escapeHtml(state.sync.storageName)}</span></div><button class="button small" data-action="sync-now">${icon('refresh-cw')}立即同步</button></div><div class="sync-panel"><h3>${icon('key-round')}端到端加密</h3><div class="form-hint">密钥只放在分享链接片段中，不会发给同步服务器。没有密钥时仍可使用离线与普通同步。</div><div class="sync-key-row"><input data-room-key value="${escapeHtml(state.roomKey || '')}" placeholder="粘贴房间密钥" autocomplete="off" /><button class="button small" data-action="apply-key">应用</button></div><div class="sync-key-row"><button class="button small" data-action="new-key">${icon('sparkles')}生成密钥</button></div><div class="sync-warning">${icon('shield-check')}请把完整分享链接发给协作者。只发房间名无法恢复密钥。</div></div></div><div class="form-field" style="margin-top:15px"><label>分享链接</label><div class="sync-key-row"><input readonly value="${escapeHtml(location.origin + location.pathname + fragment)}" /><button class="button small" data-action="share-copy">${icon('copy')}复制</button></div></div></div><div class="dialog-actions"><button class="button" data-action="modal-close">关闭</button></div>`;
}

function renderTrashModal() {
  const deleted = state.doc.allEntities().filter((entity) => !entity.alive && (entity.kind === 'card' || entity.kind === 'column'));
  return `${modalTitle('回收站', 'archive-restore')}<div class="dialog-content">${deleted.length ? `<div class="search-results">${deleted.map((entity) => `<div class="search-result"><span>${icon(entity.kind === 'column' ? 'columns-3' : 'square-kanban')}</span><span><span class="search-result-title">${escapeHtml(state.doc.field(entity.id, 'title', '未命名'))}</span><span class="search-result-sub">${entity.kind === 'column' ? '列' : '卡片'}</span></span><button class="button small" data-action="restore-entity" data-entity-id="${escapeHtml(entity.id)}" data-entity-kind="${escapeHtml(entity.kind)}">恢复</button></div>`).join('')}</div>` : '<div class="empty-state">'+icon('archive-restore')+'<strong>回收站是空的</strong><span>删除的卡片和列会出现在这里。</span></div>'}</div>`;
}

function renderDemoModal() {
  const step = state.demo.step;
  const stages = [
    ['两台设备各自在线', '手机和电脑共享同一个看板，但操作先保存在各自本地。'],
    ['手机离线新增卡片', '手机断开网络，仍然可以新增、编辑和完成卡片。'],
    ['电脑同时改同一张卡片', '电脑在线修改同一张卡片，双方都产生自己的不可变操作。'],
    ['恢复连接自动合并', '连接恢复后，操作通过中继交换，CRDT 让两个设备达到同一状态。'],
  ];
  const current = stages[Math.min(step, stages.length - 1)];
  return `${modalTitle('双设备同步演示', 'radio-tower')}<div class="dialog-content"><div class="demo-layout"><div class="demo-stage"><div class="demo-devices"><div class="demo-device"><div class="demo-device-title"><span>手机</span><span class="demo-status ${step === 1 || step === 2 ? 'offline' : ''}"></span></div><div class="demo-mini-card ${step >= 1 ? 'changed' : ''}">${step >= 1 ? '离线新增：会议准备' : '整理用户反馈'}</div><div class="demo-mini-card">离线备注</div></div><div class="demo-link"></div><div class="demo-device laptop"><div class="demo-device-title"><span>电脑</span><span class="demo-status"></span></div><div class="demo-mini-card ${step >= 2 ? 'changed' : ''}">${step >= 2 ? '电脑修改：发布文案' : '离线同步协议'}</div></div></div></div><div class="demo-controls"><strong class="demo-step">步骤 ${Math.min(step + 1, 4)} / 4</strong><span class="form-hint">${current[0]}</span><span class="form-hint">${current[1]}</span><button class="button primary" data-action="demo-next">${step >= 3 ? '重新演示' : '下一步'} ${icon('arrow-right')}</button><button class="button" data-action="demo-run">${state.demo.running ? '暂停' : '自动播放'} ${icon(state.demo.running ? 'pause' : 'play')}</button><button class="button" data-action="demo-reset">重置</button><div class="demo-log">${(state.demo.log.length ? state.demo.log : ['等待开始…']).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div></div></div></div><div class="dialog-actions"><button class="button" data-action="modal-close">关闭</button></div>`;
}

function saveModal(event) {
  event.preventDefault();
  const modal = state.modal;
  if (modal.type === 'board') {
    const title = $('#dialog-title')?.value.trim();
    if (title) commit([state.doc.mint(OP.SET, { e: ROOT_ID, p: 'title', v: title })]);
  } else if (modal.type === 'new-column') {
    const title = $('#dialog-title')?.value.trim();
    if (title) commit(addColumn(state.doc, title));
  } else if (modal.type === 'column') {
    const title = $('#dialog-title')?.value.trim();
    if (title) commit(renameColumn(state.doc, modal.id, title));
  } else if (modal.type === 'settings') {
    const name = $('#dialog-name')?.value.trim() || '我的设备';
    localStorage.setItem('ripple:name', name);
    toast('设备名称已更新');
  }
  closeModal();
}

function addTagFromDetail(cardId) {
  const input = $('[data-tag-input]');
  const tag = input?.value.trim();
  if (!tag) return;
  commit(addTag(state.doc, cardId, tag));
  renderModal();
}

function addCommentFromDetail(cardId) {
  const input = $('[data-comment-input]');
  const body = input?.value.trim();
  if (!body) return;
  commit(addComment(state.doc, cardId, body, localStorage.getItem('ripple:name') || state.doc.node));
  renderModal();
}

function formatStamp(id) {
  const op = state.doc.allOps().find((item) => item.i === id || item.e === id);
  return op ? new Date(op.h[0]).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '本地创建';
}

function toggleMenu(type, id, anchor) {
  if (state.menu?.type === type && state.menu.id === id) { closeMenu(); return; }
  state.menu = { type, id, anchor };
  renderMenu();
}

function closeMenu() { state.menu = null; $('#menu-root')?.remove(); }

function renderMenu() {
  closeMenu();
  if (!state.menu) return;
  const { type, id, anchor } = state.menu;
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'menu-root';
  menu.className = 'popover';
  menu.style.top = `${Math.min(window.innerHeight - 220, rect.bottom + 5)}px`;
  menu.style.left = `${Math.min(window.innerWidth - 195, Math.max(8, rect.right - 185))}px`;
  if (type === 'card') {
    const card = cardView(state.doc, id);
    menu.innerHTML = `<button class="menu-item" data-action="menu-action" data-menu-type="card" data-menu-id="${escapeHtml(id)}" data-menu-action="open">${icon('pencil')}编辑卡片</button><button class="menu-item" data-action="menu-action" data-menu-type="card" data-menu-id="${escapeHtml(id)}" data-menu-action="today">${icon('calendar-plus')}设为今天</button><button class="menu-item" data-action="menu-action" data-menu-type="card" data-menu-id="${escapeHtml(id)}" data-menu-action="move">${icon('arrow-right-left')}移动到其他列</button><div class="menu-separator"></div><button class="menu-item danger" data-action="menu-action" data-menu-type="card" data-menu-id="${escapeHtml(id)}" data-menu-action="delete">${icon('trash-2')}${card?.deleted ? '彻底删除' : '移到回收站'}</button>`;
  } else {
    menu.innerHTML = `<button class="menu-item" data-action="menu-action" data-menu-type="column" data-menu-id="${escapeHtml(id)}" data-menu-action="rename">${icon('pencil')}重命名</button><button class="menu-item" data-action="menu-action" data-menu-type="column" data-menu-id="${escapeHtml(id)}" data-menu-action="add">${icon('plus')}添加卡片</button><div class="menu-separator"></div><button class="menu-item danger" data-action="menu-action" data-menu-type="column" data-menu-id="${escapeHtml(id)}" data-menu-action="delete">${icon('trash-2')}删除列</button>`;
  }
  document.body.append(menu);
  refreshIcons();
}

function handleMenuAction(type, id, action) {
  closeMenu();
  if (type === 'card') {
    if (action === 'open') openCardDialog(id);
    if (action === 'today') { commit(setCardDue(state.doc, id, todayDate())); }
    if (action === 'move') openCardDialog(id);
    if (action === 'delete') { commit(removeCard(state.doc, id)); }
  }
  if (type === 'column') {
    if (action === 'rename') openColumnDialog(id);
    if (action === 'add') { state.quickAddColumn = id; render(); }
    if (action === 'delete') { commit(removeColumn(state.doc, id)); }
  }
}

function saveCardDraft() {
  if (!state.modal || state.modal.type !== 'card') return;
  const card = cardView(state.doc, state.modal.id);
  if (!card) return;
  const title = $('[data-dialog-title]')?.value ?? state.modal.draft.title;
  const note = $('[data-dialog-note]')?.value ?? state.modal.draft.note;
  const ops = [];
  if (title !== card.title) ops.push(...setCardTitle(state.doc, card.id, title.trim() || '未命名卡片'));
  if (note !== card.note) ops.push(...setCardNote(state.doc, card.id, note, card.note));
  commit(ops, { rerender: false });
  state.modal.draft = { title, note };
}

function copyShareLink() {
  navigator.clipboard?.writeText(location.origin + location.pathname + buildFragment({ room: state.room, key: state.roomKey })).then(() => toast('分享链接已复制')).catch(() => toast('复制失败，请手动选择链接', 'error'));
}

async function generateRoomKey() {
  state.roomKey = await randomKey();
  state.sync.setKey(state.roomKey);
  renderModal();
  toast('新密钥已生成');
}

async function applyRoomKey() {
  const key = $('[data-room-key]')?.value.trim() || null;
  state.roomKey = key;
  state.sync.setKey(key);
  if (key) {
    state.room = state.room || 'ripple-demo';
    toast('加密密钥已应用，正在同步');
  } else toast('已切换为无密钥同步');
  state.sync.syncNow();
  renderModal();
}

async function demoNext() {
  if (state.demo.step >= 3) {
    demoReset();
    return;
  }
  state.demo.step += 1;
  const messages = ['两台设备共享同一个房间。', '手机进入离线状态，本地仍然可编辑。', '电脑同时产生了另一条操作。', '网络恢复，两个副本交换 op 后收敛。'];
  state.demo.log.push(`${new Date().toLocaleTimeString()}  ${messages[state.demo.step]}`);
  renderModal();
}

function demoReset() {
  if (state.demo.timer) clearInterval(state.demo.timer);
  state.demo = { step: 0, running: false, timer: null, log: [] };
  renderModal();
}

function demoRun() {
  if (state.demo.running) {
    clearInterval(state.demo.timer);
    state.demo.running = false;
    state.demo.timer = null;
  } else {
    state.demo.running = true;
    state.demo.timer = setInterval(() => {
      if (!state.modal || state.modal.type !== 'demo') return demoReset();
      demoNext();
      if (state.demo.step >= 3) {
        clearInterval(state.demo.timer);
        state.demo.running = false;
        state.demo.timer = null;
      }
    }, 1600);
  }
  renderModal();
}

function updateSyncChrome() {
  const view = state.sync?.view();
  if (!view) return;
  const status = $('[data-sync-status]');
  if (status) {
    status.className = `sync-status ${view.status}`;
    status.innerHTML = `<span class="sync-dot"></span><span class="sync-status-label">${syncLabel(view.status)}</span>${view.pending > 0 ? `<span class="sync-pending">${view.pending > 99 ? '99+' : view.pending}</span>` : ''}`;
  }
  const avatars = $('[data-avatar-stack]');
  if (avatars) avatars.innerHTML = renderAvatars(view.peers);
}

function toast(message, type = 'info') {
  const root = $('#toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : ''}`;
  node.innerHTML = `${icon(type === 'error' ? 'circle-alert' : 'check-circle-2')}<span>${escapeHtml(message)}</span>`;
  root.append(node);
  setTimeout(() => node.remove(), 3400);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('[Ripple PWA]', error));
  }
}

document.addEventListener('click', handleClick);
document.addEventListener('submit', handleSubmit);
document.addEventListener('input', handleInput);
document.addEventListener('change', handleChange);
document.addEventListener('keydown', handleKeydown);
document.addEventListener('pointerdown', handlePointerDown, { passive: true });
document.addEventListener('pointermove', handlePointerMove, { passive: false });
document.addEventListener('pointerup', handlePointerUp, { passive: false });
document.addEventListener('pointercancel', handlePointerCancel);
document.addEventListener('dragstart', handleDragStart);
document.addEventListener('dragover', handleDragOver);
document.addEventListener('dragleave', handleDragLeave);
document.addEventListener('drop', handleDrop);
document.addEventListener('dragend', clearDragState);

window.addEventListener('beforeunload', () => {
  saveCardDraft();
  state.sync?.flush();
});

window.addEventListener('hashchange', () => {
  const next = parseFragment(location.hash, { room: state.room });
  if (next.room !== state.room || next.key !== state.roomKey) {
    state.room = next.room;
    state.roomKey = next.key;
    state.sync?.setRoom(state.room);
    state.sync?.setKey(state.roomKey);
    toast('已切换分享房间');
  }
});

bootstrap().catch((error) => {
  console.error('[Ripple]', error);
  $('#app').innerHTML = `<section class="boot"><span class="brand-mark">!</span><strong>打开看板失败</strong><p>${escapeHtml(error.message || error)}</p><button class="button" data-retry>重试</button></section>`;
  $('[data-retry]')?.addEventListener('click', () => location.reload());
});
