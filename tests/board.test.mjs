import test from 'node:test';
import assert from 'node:assert/strict';

import { Doc, stableStringify } from '../src/js/crdt/doc.js';
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
  editComment,
  ensureBoard,
  ensureDefaultColumns,
  moveCard,
  moveColumn,
  parseQuery,
  removeCard,
  removeColumn,
  removeTag,
  renameColumn,
  restoreCard,
  restoreColumn,
  searchCards,
  setCardDone,
  setCardDue,
  setCardNote,
  setCardTitle,
  tags,
} from '../src/js/crdt/board.js';

function setup(node = 'phone') {
  const doc = new Doc({ node });
  ensureBoard(doc, '发布计划');
  ensureDefaultColumns(doc);
  return doc;
}

function viewHash(doc) {
  return stableStringify(boardView(doc));
}

test('初始化是幂等的，重复调用不会重复建列', () => {
  const doc = setup();
  const before = doc.opCount;
  ensureBoard(doc, '发布计划');
  ensureDefaultColumns(doc);
  assert.equal(doc.opCount, before);
  const view = boardView(doc);
  assert.equal(view.title, '发布计划');
  assert.deepEqual(view.columns.map((c) => c.title), ['待办', '进行中', '已完成']);
});

test('新增列与重命名列', () => {
  const doc = setup();
  addColumn(doc, '等待验收');
  assert.deepEqual(boardView(doc).columns.map((c) => c.title), ['待办', '进行中', '已完成', '等待验收']);
  const first = boardView(doc).columns[0].id;
  renameColumn(doc, first, '今天做');
  assert.equal(boardView(doc).columns[0].title, '今天做');
});

test('列排序：moveColumn 只写一个排序键', () => {
  const doc = setup();
  const [c1, c2, c3] = boardView(doc).columns.map((c) => c.id);
  const ops = moveColumn(doc, c3, 0);
  assert.equal(ops.length, 1, '移动列只应产生一个 op');
  assert.deepEqual(boardView(doc).columns.map((c) => c.id), [c3, c1, c2]);
  moveColumn(doc, c1, 2);
  assert.deepEqual(boardView(doc).columns.map((c) => c.id), [c3, c2, c1]);
});

test('卡片增删改与排序键', () => {
  const doc = setup();
  const todo = boardView(doc).columns[0].id;
  const a = addCard(doc, todo, 'A');
  const b = addCard(doc, todo, 'B');
  const c = addCard(doc, todo, 'C');
  assert.deepEqual(boardView(doc).columns[0].cards.map((x) => x.title), ['A', 'B', 'C']);

  // 插到最前面
  addCard(doc, todo, 'Z', { atIndex: 0 });
  assert.deepEqual(boardView(doc).columns[0].cards.map((x) => x.title), ['Z', 'A', 'B', 'C']);

  // 改标题 / 完成 / 截止
  const firstId = boardView(doc).columns[0].cards[0].id;
  setCardTitle(doc, firstId, 'Z（改）');
  setCardDone(doc, firstId, true);
  setCardDue(doc, firstId, '2026-01-31');
  const card = boardView(doc).columns[0].cards[0];
  assert.equal(card.title, 'Z（改）');
  assert.equal(card.done, true);
  assert.equal(card.due, '2026-01-31');
  assert.equal(opsCount([a, b, c]) > 0, true);
});

function opsCount(list) {
  return list.filter(Array.isArray).flat().length;
}

test('卡片跨列移动：标签、备注、评论都跟着走', () => {
  const doc = setup();
  const [todo, doing] = boardView(doc).columns.map((c) => c.id);
  addCard(doc, todo, '重构同步层', { tags: ['重构'], note: '先看协议' });
  const cardId = boardView(doc).columns[0].cards[0].id;
  addComment(doc, cardId, '这条评论不能丢');

  const ops = moveCard(doc, cardId, doing, 0);
  assert.ok(ops.length >= 1);
  const view = boardView(doc);
  assert.equal(view.columns[0].cards.length, 0);
  const moved = view.columns[1].cards[0];
  assert.equal(moved.id, cardId);
  assert.equal(moved.title, '重构同步层');
  assert.deepEqual(moved.tags, ['重构']);
  assert.equal(moved.note, '先看协议');
  assert.equal(moved.comments.length, 1);
  assert.equal(moved.comments[0].body, '这条评论不能丢');

  // 移动到同列不同位置
  const other = addCard(doc, doing, '别的任务');
  moveCard(doc, cardId, doing, 1);
  assert.deepEqual(
    boardView(doc).columns[1].cards.map((x) => x.title),
    ['别的任务', '重构同步层'],
  );
  void other;
});

test('删除与恢复：默认视图隐藏，回收站视图可见', () => {
  const doc = setup();
  const todo = boardView(doc).columns[0].id;
  addCard(doc, todo, '要删掉的');
  const cardId = boardView(doc).columns[0].cards[0].id;
  addComment(doc, cardId, '评论');
  removeCard(doc, cardId);

  assert.equal(boardView(doc).columns[0].cards.length, 0);
  const trash = boardView(doc, { includeDeleted: true }).columns[0].cards;
  assert.equal(trash.length, 1);
  assert.equal(trash[0].deleted, true);

  restoreCard(doc, cardId);
  assert.equal(boardView(doc).columns[0].cards.length, 1);
});

test('删除列会连带删除列内卡片，恢复时一并回来', () => {
  const doc = setup();
  const todo = boardView(doc).columns[0].id;
  addCard(doc, todo, '一');
  addCard(doc, todo, '二');
  removeColumn(doc, todo);
  const view = boardView(doc);
  assert.equal(view.columns.length, 2);
  assert.equal(view.columns[0].cards.length, 0);

  restoreColumn(doc, todo);
  const restored = boardView(doc).columns.find((c) => c.id === todo);
  assert.equal(restored.cards.length, 2);
});

test('标签是 OR-Set：重复添加去重，删除后消失', () => {
  const doc = setup();
  const todo = boardView(doc).columns[0].id;
  addCard(doc, todo, '任务');
  const cardId = boardView(doc).columns[0].cards[0].id;
  addTag(doc, cardId, '紧急');
  addTag(doc, cardId, '紧急');
  addTag(doc, cardId, '设计');
  // 排序按码位（UTF-16 代码单元）稳定输出，不依赖运行环境的 locale
  assert.deepEqual(boardView(doc).columns[0].cards[0].tags, ['紧急', '设计']);
  assert.deepEqual(
    tags(doc).map((t) => t.name),
    ['紧急', '设计'],
  );

  removeTag(doc, cardId, '紧急');
  assert.deepEqual(boardView(doc).columns[0].cards[0].tags, ['设计']);
  assert.equal(tags(doc).length, 1);
  assert.deepEqual(removeTag(doc, cardId, '不存在'), []);
});

test('备注与评论：走文本 CRDT，可增量编辑', () => {
  const doc = setup();
  const todo = boardView(doc).columns[0].id;
  addCard(doc, todo, '写文档', { note: '第一版' });
  const cardId = boardView(doc).columns[0].cards[0].id;
  setCardNote(doc, cardId, '第一版（已校对）');
  assert.equal(boardView(doc).columns[0].cards[0].note, '第一版（已校对）');
  setCardNote(doc, cardId, '第二版');
  assert.equal(boardView(doc).columns[0].cards[0].note, '第二版');

  addComment(doc, cardId, 'ok', '电脑');
  const commentId = boardView(doc).columns[0].cards[0].comments[0].id;
  const ops = editComment(doc, commentId, 'ok，明天给你');
  assert.ok(ops.length > 0);
  assert.equal(boardView(doc).columns[0].cards[0].comments[0].body, 'ok，明天给你');
  assert.equal(boardView(doc).columns[0].cards[0].comments[0].author, '电脑');
});

test('搜索：字段过滤、取反与自由文本', () => {
  const doc = setup();
  const [todo, doing] = boardView(doc).columns.map((c) => c.id);
  addCard(doc, todo, '修复登录', { tags: ['bug'] });
  addCard(doc, doing, '写发布说明', { tags: ['文档'], note: '包含截图' });
  addCard(doc, doing, '重构同步层');
  addCard(doc, todo, '还欠着的旧任务', { due: '2020-01-01' });
  const login = allCards(doc).find((c) => c.title === '修复登录');
  setCardDone(doc, login.id, true);

  assert.deepEqual(parseQuery('tag:bug -col:已完成 搜索'), {
    filters: [
      { field: 'tag', value: 'bug', negated: false },
      { field: 'col', value: '已完成', negated: true },
    ],
    free: [{ value: '搜索', negated: false }],
  });

  assert.deepEqual(searchCards(doc, 'tag:bug').map((c) => c.title), ['修复登录']);
  assert.deepEqual(searchCards(doc, 'col:进行中').map((c) => c.title), ['写发布说明', '重构同步层']);
  assert.deepEqual(searchCards(doc, 'done:true').map((c) => c.title), ['修复登录']);
  assert.deepEqual(searchCards(doc, 'is:open col:进行中').map((c) => c.title), ['写发布说明', '重构同步层']);
  assert.deepEqual(searchCards(doc, 'due:overdue').map((c) => c.title), ['还欠着的旧任务']);
  assert.deepEqual(searchCards(doc, 'due:none col:进行中').length, 2);
  assert.deepEqual(searchCards(doc, '截图').map((c) => c.title), ['写发布说明']);
  // 自由文本取反：只有一张卡片的备注含「截图」
  assert.deepEqual(searchCards(doc, '-截图').map((c) => c.title).length, 3);
  assert.equal(cardMatches(doc, allCards(doc)[0], parseQuery('')), true);
});

test('统计：完成率、逾期、按列分布', () => {
  const doc = setup();
  const [todo, doing, done] = boardView(doc).columns.map((c) => c.id);
  addCard(doc, todo, 'A', { due: '2020-01-01' });
  addCard(doc, todo, 'B');
  addCard(doc, doing, 'C');
  addCard(doc, done, 'D');
  const [a, , , d] = allCards(doc).sort((x, y) => (x.title < y.title ? -1 : 1));
  setCardDone(doc, d.id, true);
  setCardDue(doc, a.id, '2020-01-01');

  const stats = boardStats(doc, { today: '2026-05-17' });
  assert.equal(stats.cards, 4);
  assert.equal(stats.done, 1);
  assert.equal(stats.open, 3);
  assert.equal(stats.doneRate, 0.25);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.overdueCards[0].title, 'A');
  assert.deepEqual(stats.byColumn.map((c) => c.count), [2, 1, 1]);
});

test('看板级收敛：两台设备离线各干各的，合并后视图完全一致', () => {
  const origin = setup('origin');
  const phone = Doc.fromJSON({ ...origin.toJSON(), node: 'phone' });
  const laptop = Doc.fromJSON({ ...origin.toJSON(), node: 'laptop' });
  const [todo, doing] = boardView(phone).columns.map((c) => c.id);

  // 手机：新增卡片、打标签、写备注、把已有卡片移到进行中
  addCard(phone, todo, '手机加的', { tags: ['移动端'], note: '在路上想到的' });
  const phoneCard = allCards(phone).find((c) => c.title === '手机加的');
  addComment(phone, phoneCard.id, '别忘了同步');
  setCardDone(phone, phoneCard.id, true);

  // 电脑：新增列、新增卡片、改同一张卡片的标题、在同一张卡片上并发写备注
  addColumn(laptop, '代码评审');
  addCard(laptop, doing, '电脑加的');
  setCardNote(laptop, phoneCard.id, '在路上想到的（补：已同步）');
  addTag(laptop, phoneCard.id, '移动端');
  removeTag(laptop, phoneCard.id, '移动端');
  addTag(laptop, phoneCard.id, '重要');

  assert.notEqual(viewHash(phone), viewHash(laptop), '离线期间两边视图应当不同');

  phone.addOps(laptop.allOps());
  laptop.addOps(phone.allOps());
  assert.equal(viewHash(phone), viewHash(laptop), '合并后视图必须一致');
  assert.equal(phone.stateHash(), laptop.stateHash());

  const merged = allCards(phone).map((c) => c.title).sort();
  assert.deepEqual(merged, ['手机加的', '电脑加的']);
  const note = allCards(phone).find((c) => c.title === '手机加的').note;
  assert.ok(note.includes('在路上想到的'));
  assert.ok(note.includes('已同步'));
  assert.equal(boardView(phone).columns.length, 4);
});

test('同一张卡片被两台设备并发移到不同列：收敛到确定的列', () => {
  const origin = setup('origin');
  const [todo, doing, done] = boardView(origin).columns.map((c) => c.id);
  addCard(origin, todo, '搬来搬去');
  const cardId = boardView(origin).columns[0].cards[0].id;

  const a = Doc.fromJSON({ ...origin.toJSON(), node: 'a' });
  const b = Doc.fromJSON({ ...origin.toJSON(), node: 'b' });
  moveCard(a, cardId, doing, 0);
  moveCard(b, cardId, done, 0);
  a.addOps(b.allOps());
  b.addOps(a.allOps());

  const colOf = (doc) => boardView(doc).columns.find((c) => c.cards.some((card) => card.id === cardId)).id;
  assert.equal(colOf(a), colOf(b));
  assert.ok([doing, done].includes(colOf(a)));
  assert.equal(viewHash(a), viewHash(b));
  assert.equal(boardView(a).totalCards, 1, '移动不该把卡片复制成两张');
  void ROOT_ID;
});
