/**
 * 文本编辑桥接：把「用户改了一段文本」翻译成 RGA 的 op。
 *
 * UI 拿到的永远是普通字符串（textarea / input 的值），
 * 这里负责 diff 出最小改动，并映射成「在某元素之后插入」与「删除某元素」。
 * 这样本地编辑也走 CRDT 路径，多设备离线各改一半再合并不会互相覆盖。
 */

import { OP } from './ops.js';

/** 按码点切分，避免把代理对（emoji）从中间切开。 */
export function toCodePoints(text) {
  return [...String(text ?? '')];
}

/**
 * 计算 prev → next 的最小改动（前缀/后缀裁剪后的中间段整体替换）。
 * @returns {{index:number, removeCount:number, insertText:string, noop:boolean}}
 */
export function diffStrings(prev, next) {
  const before = toCodePoints(prev);
  const after = toCodePoints(next);
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removeCount = before.length - prefix - suffix;
  const insertText = after.slice(prefix, after.length - suffix).join('');
  return {
    index: prefix,
    removeCount,
    insertText,
    noop: removeCount === 0 && insertText.length === 0,
  };
}

/** 在可编辑文本的 index 处插入字符串，返回新产生的 op。 */
export function insertAt(doc, docId, index, text) {
  const chars = toCodePoints(text);
  if (chars.length === 0) return [];
  const elems = doc.textElements(docId);
  const clamped = Math.max(0, Math.min(index, elems.length));
  let after = clamped === 0 ? null : elems[clamped - 1];
  const ops = [];
  for (const ch of chars) {
    const op = doc.mint(OP.TEXT_INSERT, { d: docId, a: after, c: ch });
    after = op.i;
    ops.push(op);
  }
  return ops;
}

/** 删除 [start, end) 区间，返回新产生的 op。 */
export function deleteRange(doc, docId, start, end) {
  const elems = doc.textElements(docId);
  const from = Math.max(0, Math.min(start, elems.length));
  const to = Math.max(from, Math.min(end, elems.length));
  const ops = [];
  for (const elemId of elems.slice(from, to)) {
    ops.push(doc.mint(OP.TEXT_DELETE, { d: docId, e: elemId }));
  }
  return ops;
}

/**
 * 把文本从 prev 改成 next：先删后插。
 * @returns {{ops: object[], diff: object}}
 */
export function applyTextDiff(doc, docId, prev, next) {
  const diff = diffStrings(prev, next);
  if (diff.noop) return { ops: [], diff };
  const ops = [];
  if (diff.removeCount > 0) ops.push(...deleteRange(doc, docId, diff.index, diff.index + diff.removeCount));
  if (diff.insertText.length > 0) ops.push(...insertAt(doc, docId, diff.index, diff.insertText));
  return { ops, diff };
}

export function textLength(doc, docId) {
  return doc.textElements(docId).length;
}

export function textSlice(doc, docId, start, end) {
  return doc.textElements(docId).slice(start, end);
}
