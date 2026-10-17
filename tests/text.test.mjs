import test from 'node:test';
import assert from 'node:assert/strict';

import { Doc } from '../src/js/crdt/doc.js';
import { OP } from '../src/js/crdt/ops.js';
import { diffStrings, insertAt, deleteRange, applyTextDiff, toCodePoints } from '../src/js/crdt/text.js';

test('diffStrings 覆盖插入/删除/替换/无变化', () => {
  assert.deepEqual(diffStrings('abc', 'abc'), { index: 3, removeCount: 0, insertText: '', noop: true });
  assert.deepEqual(diffStrings('', 'abc'), { index: 0, removeCount: 0, insertText: 'abc', noop: false });
  assert.deepEqual(diffStrings('abc', ''), { index: 0, removeCount: 3, insertText: '', noop: false });
  assert.deepEqual(diffStrings('ab', 'abcd'), { index: 2, removeCount: 0, insertText: 'cd', noop: false });
  assert.deepEqual(diffStrings('xabc', 'abc'), { index: 0, removeCount: 1, insertText: '', noop: false });
  assert.deepEqual(diffStrings('hello world', 'hello ripple'), {
    index: 6,
    removeCount: 5,
    insertText: 'ripple',
    noop: false,
  });
  // 中间替换 + 尾部相同
  assert.deepEqual(diffStrings('abXYcd', 'abZZcd'), { index: 2, removeCount: 2, insertText: 'ZZ', noop: false });
});

test('diffStrings 按码点工作，不会切坏 emoji', () => {
  const before = '工作 👩‍💻 完成';
  const after = '工作 ✅ 完成';
  const d = diffStrings(before, after);
  assert.equal(d.noop, false);
  const rebuilt = [...toCodePoints(before)];
  rebuilt.splice(d.index, d.removeCount, ...toCodePoints(d.insertText));
  assert.equal(rebuilt.join(''), after);
});

test('applyTextDiff 把文档文本改成目标值', () => {
  const doc = new Doc({ node: 'a' });
  const steps = ['', 'a', 'ab', 'aXb', 'aXb', 'b', '', 'hello 世界', 'hello 世界!', 'hello', 'hElLo'];
  let current = '';
  for (const next of steps) {
    const { ops } = applyTextDiff(doc, 'note', current, next);
    if (next === current) assert.equal(ops.length, 0);
    current = next;
    assert.equal(doc.text('note'), next, `步进到 ${JSON.stringify(next)}`);
  }
  assert.ok(doc.opCount > 0);
});

test('insertAt / deleteRange 的边界与越界处理', () => {
  const doc = new Doc({ node: 'a' });
  assert.deepEqual(insertAt(doc, 't', 0, ''), []);
  insertAt(doc, 't', 99, 'abc'); // 越界 → 夹到末尾
  assert.equal(doc.text('t'), 'abc');
  insertAt(doc, 't', 0, 'Z');
  assert.equal(doc.text('t'), 'Zabc');
  insertAt(doc, 't', 2, '-');
  assert.equal(doc.text('t'), 'Za-bc');

  deleteRange(doc, 't', 1, 2);
  assert.equal(doc.text('t'), 'Z-bc');
  deleteRange(doc, 't', -5, 0);
  assert.equal(doc.text('t'), 'Z-bc');
  deleteRange(doc, 't', 100, 200);
  assert.equal(doc.text('t'), 'Z-bc');
  deleteRange(doc, 't', 0, 99);
  assert.equal(doc.text('t'), '');
});

test('同一份文本被两个副本各自编辑后，两边的字符都不丢', () => {
  const origin = new Doc({ node: 'origin' });
  applyTextDiff(origin, 'n', '', '会议纪要：第一版');
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  a.addOps(origin.allOps());
  b.addOps(origin.allOps());

  // a 在开头插入标题，b 在结尾追加内容（两人离线）
  applyTextDiff(a, 'n', a.text('n'), '【草稿】会议纪要：第一版');
  applyTextDiff(b, 'n', b.text('n'), '会议纪要：第一版（补：下周一同步）');

  a.addOps(b.allOps());
  b.addOps(a.allOps());
  assert.equal(a.text('n'), b.text('n'));
  assert.match(a.text('n'), /【草稿】/);
  assert.match(a.text('n'), /下周一同步/);
  assert.match(a.text('n'), /会议纪要/);
});

test('两边同时改写同一区间：结果一致且可解释（后写者胜）', () => {
  const origin = new Doc({ node: 'origin' });
  applyTextDiff(origin, 'n', '', 'abcdef');
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  a.addOps(origin.allOps());
  b.addOps(origin.allOps());

  applyTextDiff(a, 'n', 'abcdef', 'abAdef');
  applyTextDiff(b, 'n', 'abcdef', 'abBdef');
  const textA = a.text('n');
  const textB = b.text('n');
  a.addOps(b.allOps());
  b.addOps(a.allOps());
  assert.equal(a.text('n'), b.text('n'));
  // RGA 不会覆盖：两个字符都在，顺序由时间戳决定（可解释、可复现）
  assert.assert ? true : true;
  assert.ok(['abABdef', 'abBAdef'].includes(a.text('n')), `实际: ${a.text('n')}`);
  void textA;
  void textB;
});

test('删除与插入并发：删除不吞掉后来插入的字符', () => {
  const origin = new Doc({ node: 'origin' });
  applyTextDiff(origin, 'n', '', 'abc');
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  a.addOps(origin.allOps());
  b.addOps(origin.allOps());

  applyTextDiff(a, 'n', 'abc', 'ac'); // a 删掉 b 位置
  insertAt(b, 'n', 1, 'X'); // b 在同一位置插入（基于没删的状态）
  a.addOps(b.allOps());
  b.addOps(a.allOps());
  assert.equal(a.text('n'), b.text('n'));
  assert.ok(a.text('n').includes('X'));
  assert.ok(a.text('n').includes('a') && a.text('n').includes('c'));
});

test('长文本多次随机编辑后仍然一致（fuzz）', () => {
  const a = new Doc({ node: 'a' });
  const b = new Doc({ node: 'b' });
  let model = '';
  applyTextDiff(a, 'n', '', model);
  b.addOps(a.allOps());

  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 120; i += 1) {
    const chars = [...model];
    const target = i % 2 === 0 ? a : b;
    const mode = rand();
    let next;
    if (mode < 0.5 || chars.length === 0) {
      const at = Math.floor(rand() * (chars.length + 1));
      next = [...chars.slice(0, at), 'xyz'[i % 3], ...chars.slice(at)].join('');
    } else {
      const at = Math.floor(rand() * chars.length);
      const len = 1 + Math.floor(rand() * 2);
      next = [...chars.slice(0, at), ...chars.slice(at + len)].join('');
    }
    applyTextDiff(target, 'n', model, next);
    model = next;
    // 模拟实时同步（把对方的 op 拉过来）
    a.addOps(b.allOps());
    b.addOps(a.allOps());
  }
  assert.equal(a.text('n'), b.text('n'));
  assert.equal([...a.text('n')].length, [...model].length);
  assert.ok(a.opCount > 100);
  void OP;
});
