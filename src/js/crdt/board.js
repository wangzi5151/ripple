/**
 * 看板领域层：把通用 CRDT 引擎包成「列 / 卡片 / 标签 / 评论」的 API。
 *
 * 约定：
 *  - 只有一个根实体 ROOT_ID = 'board'；
 *  - 列是 board 的子实体，卡片是列的子实体、可以跨列移动（改 parent + order）；
 *  - 备注与评论正文各自是一份 RGA 文本，id 约定为 `${实体id}/note`、`${实体id}/body`；
 *  - 标签是卡片实体上的 OR-Set，集合名 'tags'。
 *
 * 所有写操作都返回新产生的 op，方便调用方立即入离线队列 / 发给服务器。
 */

import { OP } from './ops.js';
import { after, before, between, compareOrder, isValidOrderKey } from './fractional.js';
import { applyTextDiff } from './text.js';

export const ROOT_ID = 'board';
export const TAG_SET = 'tags';

export const CARD_FIELDS = {
  TITLE: 'title',
  ORDER: 'order',
  DONE: 'done',
  DUE: 'due',
  ASSIGNEE: 'assignee',
  CREATED_AT: 'createdAt',
};

export function noteDocId(entityId) {
  return `${entityId}/note`;
}

export function bodyDocId(entityId) {
  return `${entityId}/body`;
}

/* ------------------------------------------------------------------ */
/* 读                                                                   */
/* ------------------------------------------------------------------ */

/** 看板整体视图（UI 与测试都用它，纯函数、无副作用）。 */
export function boardView(doc, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const columns = orderedChildren(doc, ROOT_ID, 'column', includeDeleted).map((col) => {
    const cards = orderedChildren(doc, col.id, 'card', includeDeleted).map((card) => cardView(doc, card));
    return {
      id: col.id,
      title: doc.field(col.id, CARD_FIELDS.TITLE, '未命名列'),
      order: doc.field(col.id, CARD_FIELDS.ORDER, null),
      cards,
    };
  });
  const totalCards = columns.reduce((sum, col) => sum + col.cards.length, 0);
  return {
    id: ROOT_ID,
    title: doc.field(ROOT_ID, CARD_FIELDS.TITLE, 'Ripple 看板'),
    columns,
    totalCards,
  };
}

export function cardView(doc, card) {
  const id = card.id ?? card;
  const note = doc.text(noteDocId(id));
  return {
    id,
    columnId: doc.getEntity(id)?.parent ?? null,
    title: doc.field(id, CARD_FIELDS.TITLE, ''),
    order: doc.field(id, CARD_FIELDS.ORDER, null),
    done: doc.field(id, CARD_FIELDS.DONE, false) === true,
    due: doc.field(id, CARD_FIELDS.DUE, null),
    assignee: doc.field(id, CARD_FIELDS.ASSIGNEE, null),
    tags: doc.setMembers(id, TAG_SET),
    note,
    noteLength: [...note].length,
    comments: commentsOf(doc, id),
    deleted: !doc.isAlive(id),
  };
}

export function commentsOf(doc, cardId) {
  return doc
    .childrenOf(cardId, (ent) => ent.kind === 'comment')
    .map((ent) => ({
      id: ent.id,
      body: doc.text(bodyDocId(ent.id)),
      author: doc.field(ent.id, 'author', null),
      createdAt: doc.field(ent.id, 'createdAt', null),
    }));
}

export function listCards(doc) {
  return doc.childrenOf(ROOT_ID, (ent) => ent.kind === 'card').map((card) => cardView(doc, card));
}

export function allCards(doc) {
  const out = [];
  for (const ent of doc.allEntities()) {
    if (doc.isAlive(ent.id) && ent.kind === 'card') out.push(cardView(doc, ent.id));
  }
  return out;
}

export function tags(doc) {
  const counter = new Map();
  for (const card of allCards(doc)) {
    for (const tag of card.tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* 写                                                                   */
/* ------------------------------------------------------------------ */

/** 幂等初始化：看板不存在时才创建。 */
export function ensureBoard(doc, title = 'Ripple 看板') {
  const ops = [];
  if (!doc.isAlive(ROOT_ID)) {
    ops.push(doc.mint(OP.MAKE, { e: ROOT_ID, k: 'board' }));
    ops.push(doc.mint(OP.SET, { e: ROOT_ID, p: CARD_FIELDS.TITLE, v: title }));
  }
  return ops;
}

export function ensureDefaultColumns(doc, names = ['待办', '进行中', '已完成']) {
  const ops = [];
  if (doc.childrenOf(ROOT_ID, (ent) => ent.kind === 'column').length > 0) return ops;
  for (const name of names) ops.push(...addColumn(doc, name));
  return ops;
}

export function addColumn(doc, title = '新列') {
  const id = newId(doc, 'col');
  const siblings = doc.childrenOf(ROOT_ID, (ent) => ent.kind === 'column');
  const lastOrder = siblings.length ? siblings[siblings.length - 1].fields.get(CARD_FIELDS.ORDER)?.v ?? null : null;
  return [
    doc.mint(OP.MAKE, { e: id, k: 'column', parent: ROOT_ID }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.TITLE, v: title }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.ORDER, v: lastOrder === null ? between(null, null) : after(lastOrder) }),
  ];
}

export function renameColumn(doc, columnId, title) {
  return [doc.mint(OP.SET, { e: columnId, p: CARD_FIELDS.TITLE, v: title })];
}

export function removeColumn(doc, columnId) {
  const ops = [doc.mint(OP.REMOVE, { e: columnId })];
  for (const card of doc.childrenOf(columnId, (ent) => ent.kind === 'card')) {
    ops.push(doc.mint(OP.REMOVE, { e: card.id }));
  }
  return ops;
}

export function restoreColumn(doc, columnId) {
  const ops = [doc.mint(OP.RESTORE, { e: columnId })];
  for (const ent of doc.allEntities()) {
    if (ent.parent === columnId && ent.kind === 'card' && !ent.alive) {
      ops.push(doc.mint(OP.RESTORE, { e: ent.id }));
    }
  }
  return ops;
}

/**
 * 在列中新增卡片。
 * @param {object} doc
 * @param {string} columnId
 * @param {string} title
 * @param {{atIndex?: number, tags?: string[], due?: string|null, note?: string}} [options]
 */
export function addCard(doc, columnId, title = '', options = {}) {
  const id = options.id ?? newId(doc, 'card');
  const ordered = doc.childrenOf(columnId, (ent) => ent.kind === 'card');
  const index = options.atIndex ?? ordered.length;
  const orderKey = orderKeyAt(ordered, index);
  const ops = [
    doc.mint(OP.MAKE, { e: id, k: 'card', parent: columnId }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.TITLE, v: title }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.ORDER, v: orderKey }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.DONE, v: false }),
  ];
  if (options.due) ops.push(doc.mint(OP.SET, { e: id, p: CARD_FIELDS.DUE, v: options.due }));
  for (const tag of options.tags ?? []) {
    ops.push(doc.mint(OP.SET_ADD, { e: id, s: TAG_SET, m: tag }));
  }
  if (options.note) {
    const { ops: textOps } = applyTextDiff(doc, noteDocId(id), '', options.note);
    ops.push(...textOps);
  }
  return ops;
}

/** 把卡片移动到某列的第 index 位。 */
export function moveCard(doc, cardId, targetColumnId, index) {
  const siblings = doc.childrenOf(targetColumnId, (ent) => ent.kind === 'card' && ent.id !== cardId);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  const orderKey = orderKeyAt(siblings, clamped);
  const ops = [doc.mint(OP.SET, { e: cardId, p: CARD_FIELDS.ORDER, v: orderKey })];
  if (doc.getEntity(cardId)?.parent !== targetColumnId) {
    // parent 是 LWW：重新 mk 一次即可搬迁，卡片 id 不变，评论与标签都跟着走。
    ops.push(doc.mint(OP.MAKE, { e: cardId, k: 'card', parent: targetColumnId }));
  }
  return ops;
}

export function moveColumn(doc, columnId, index) {
  const siblings = doc.childrenOf(ROOT_ID, (ent) => ent.kind === 'column' && ent.id !== columnId);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  return [doc.mint(OP.SET, { e: columnId, p: CARD_FIELDS.ORDER, v: orderKeyAt(siblings, clamped) })];
}

export function setCardTitle(doc, cardId, title) {
  return [doc.mint(OP.SET, { e: cardId, p: CARD_FIELDS.TITLE, v: title })];
}

export function setCardDone(doc, cardId, done) {
  return [doc.mint(OP.SET, { e: cardId, p: CARD_FIELDS.DONE, v: Boolean(done) })];
}

export function setCardDue(doc, cardId, due) {
  return [doc.mint(OP.SET, { e: cardId, p: CARD_FIELDS.DUE, v: due ?? null })];
}

export function setCardAssignee(doc, cardId, assignee) {
  return [doc.mint(OP.SET, { e: cardId, p: CARD_FIELDS.ASSIGNEE, v: assignee ?? null })];
}

export function removeCard(doc, cardId) {
  const ops = [doc.mint(OP.REMOVE, { e: cardId })];
  for (const comment of doc.childrenOf(cardId, (ent) => ent.kind === 'comment')) {
    ops.push(doc.mint(OP.REMOVE, { e: comment.id }));
  }
  return ops;
}

export function restoreCard(doc, cardId) {
  const ops = [doc.mint(OP.RESTORE, { e: cardId })];
  for (const ent of doc.allEntities()) {
    if (ent.parent === cardId && ent.kind === 'comment' && !ent.alive) {
      ops.push(doc.mint(OP.RESTORE, { e: ent.id }));
    }
  }
  return ops;
}

export function addTag(doc, cardId, tag) {
  const name = String(tag).trim();
  if (!name) return [];
  // 不显式给 tag：引擎用 op id 作为 tag，全局唯一，remove 时观察它即可。
  return [doc.mint(OP.SET_ADD, { e: cardId, s: TAG_SET, m: name })];
}

export function removeTag(doc, cardId, tag) {
  const observed = doc.setAddTags(cardId, TAG_SET, tag);
  if (observed.length === 0) return [];
  return [doc.mint(OP.SET_REMOVE, { e: cardId, s: TAG_SET, m: tag, r: observed })];
}

/** 卡片备注：把整段文本从 prev 改成 next（走 RGA diff）。 */
export function setCardNote(doc, cardId, nextText, prevText = null) {
  const prev = prevText === null ? doc.text(noteDocId(cardId)) : prevText;
  return applyTextDiff(doc, noteDocId(cardId), prev, nextText).ops;
}

export function addComment(doc, cardId, body, author = doc.node) {
  const id = newId(doc, 'cmt');
  const siblings = doc.childrenOf(cardId, (ent) => ent.kind === 'comment');
  const lastOrder = siblings.length ? siblings[siblings.length - 1].fields.get(CARD_FIELDS.ORDER)?.v ?? null : null;
  const ops = [
    doc.mint(OP.MAKE, { e: id, k: 'comment', parent: cardId }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.ORDER, v: lastOrder === null ? between(null, null) : after(lastOrder) }),
    doc.mint(OP.SET, { e: id, p: CARD_FIELDS.CREATED_AT, v: new Date().toISOString() }),
    doc.mint(OP.SET, { e: id, p: 'author', v: author }),
  ];
  ops.push(...applyTextDiff(doc, bodyDocId(id), '', body).ops);
  return ops;
}

export function editComment(doc, commentId, nextText) {
  return applyTextDiff(doc, bodyDocId(commentId), doc.text(bodyDocId(commentId)), nextText).ops;
}

export function removeComment(doc, commentId) {
  return [doc.mint(OP.REMOVE, { e: commentId })];
}

/* ------------------------------------------------------------------ */
/* 排序辅助                                                             */
/* ------------------------------------------------------------------ */

/** 在已有的有序兄弟中找到第 index 个位置应使用的排序键。 */
export function orderKeyAt(orderedSiblings, index) {
  const clamped = Math.max(0, Math.min(index, orderedSiblings.length));
  const prev = clamped > 0 ? orderOf(orderedSiblings[clamped - 1]) : null;
  const next = clamped < orderedSiblings.length ? orderOf(orderedSiblings[clamped]) : null;
  if (prev !== null && next !== null) return between(prev, next);
  if (prev !== null) return after(prev);
  if (next !== null) return before(next);
  return between(null, null);
}

/** 按 order 字段排序的兄弟列表；includeDeleted 时含墓碑（回收站视图用）。 */
function orderedChildren(doc, parentId, kind, includeDeleted = false) {
  const list = includeDeleted
    ? doc.allEntities().filter((ent) => ent.parent === parentId && ent.kind === kind)
    : doc.childrenOf(parentId, (ent) => ent.kind === kind);
  return [...list].sort((a, b) => compareOrder(orderOf(a), orderOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function orderOf(entity) {
  const key = entity?.fields?.get?.(CARD_FIELDS.ORDER)?.v ?? entity?.order ?? null;
  return isValidOrderKey(key) ? key : null;
}

export { compareOrder };

/* ------------------------------------------------------------------ */
/* 统计与搜索                                                           */
/* ------------------------------------------------------------------ */

export function boardStats(doc, options = {}) {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const cards = allCards(doc);
  const done = cards.filter((card) => card.done).length;
  const overdue = cards.filter((card) => !card.done && card.due && card.due < today);
  const upcoming = cards
    .filter((card) => !card.done && card.due && card.due >= today)
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  const byColumn = boardView(doc).columns.map((col) => ({
    id: col.id,
    title: col.title,
    count: col.cards.length,
    done: col.cards.filter((card) => card.done).length,
  }));
  const noteChars = cards.reduce((sum, card) => sum + card.noteLength, 0);
  return {
    cards: cards.length,
    done,
    open: cards.length - done,
    doneRate: cards.length === 0 ? 0 : done / cards.length,
    overdue: overdue.length,
    overdueCards: overdue,
    upcoming: upcoming.slice(0, 5),
    byColumn,
    comments: cards.reduce((sum, card) => sum + card.comments.length, 0),
    noteChars,
    tags: tags(doc),
    opCount: doc.opCount,
  };
}

/**
 * 极简查询语法（手机上没有键盘负担）：
 *   `tag:紧急`、`col:进行中`、`done:true`、`due:overdue`、`-tag:杂事`、自由文本
 */
export function parseQuery(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  const filters = [];
  const free = [];
  for (const token of tokens) {
    const negated = token.startsWith('-') && token.length > 1;
    const body = negated ? token.slice(1) : token;
    const match = /^(tag|col|done|due|is):(.*)$/i.exec(body);
    if (match) filters.push({ field: match[1].toLowerCase(), value: match[2], negated });
    else free.push(negated ? { value: body.slice(1), negated: true } : { value: body, negated: false });
  }
  return { filters, free };
}

export function cardMatches(doc, card, query, options = {}) {
  const { filters, free } = typeof query === 'string' ? parseQuery(query) : query;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const columnTitle = doc.field(card.columnId, CARD_FIELDS.TITLE, '');
  const haystack = `${card.title} ${card.note} ${card.tags.join(' ')}`.toLowerCase();

  let ok = true;
  for (const filter of filters) {
    let hit;
    switch (filter.field) {
      case 'tag':
        hit = card.tags.some((tag) => tag.toLowerCase().includes(filter.value.toLowerCase()));
        break;
      case 'col':
        hit = columnTitle.toLowerCase().includes(filter.value.toLowerCase());
        break;
      case 'done':
        hit = String(card.done) === filter.value.toLowerCase();
        break;
      case 'due':
        if (filter.value === 'overdue') hit = Boolean(card.due) && card.due < today && !card.done;
        else if (filter.value === 'today') hit = card.due === today;
        else if (filter.value === 'none') hit = !card.due;
        else hit = card.due === filter.value;
        break;
      case 'is':
        hit = filter.value === 'open' ? !card.done : filter.value === 'done' ? card.done : true;
        break;
      default:
        hit = true;
    }
    ok = ok && (filter.negated ? !hit : hit);
  }
  for (const term of free) {
    const hit = haystack.includes(term.value.toLowerCase());
    ok = ok && (term.negated ? !hit : hit);
  }
  return ok;
}

export function searchCards(doc, query, options = {}) {
  const parsed = typeof query === 'string' ? parseQuery(query) : query;
  return allCards(doc).filter((card) => cardMatches(doc, card, parsed, options));
}

/* ------------------------------------------------------------------ */

let counter = 0;

/** 本地唯一的实体 id：节点名 + 单调计数（离线也要唯一）。 */
export function newId(doc, prefix = 'e') {
  counter += 1;
  const rand = Math.floor(Math.random() * 46_656).toString(36).padStart(3, '0');
  return `${prefix}-${doc.node}-${doc.seq + counter}-${rand}`;
}

export function resetIdCounter() {
  counter = 0;
}
