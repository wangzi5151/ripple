#!/usr/bin/env node
/** Reproducible multi-replica convergence fuzzer. */
import { Doc } from '../src/js/crdt/doc.js';
import { OP } from '../src/js/crdt/ops.js';
import { ensureBoard, ensureDefaultColumns, addCard, addTag, setCardDone, setCardTitle, setCardNote, moveCard, removeCard, restoreCard, boardView } from '../src/js/crdt/board.js';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const seed = Number(process.argv[2] ?? 0x5eed);
const rounds = Number(process.argv[3] ?? 80);
const random = rng(seed);
const origin = new Doc({ node: 'origin' });
ensureBoard(origin, 'Fuzz');
ensureDefaultColumns(origin, ['Todo', 'Doing', 'Done']);
addCard(origin, boardView(origin).columns[0].id, 'seed card', { note: 'initial' });
let shared = origin.allOps();

for (let round = 0; round < rounds; round += 1) {
  const replicas = ['phone', 'laptop', 'tablet'].map((node) => {
    const doc = new Doc({ node });
    doc.addOps(shared);
    return doc;
  });
  for (let index = 0; index < replicas.length; index += 1) {
    const doc = replicas[index];
    const cards = boardView(doc).columns.flatMap((column) => column.cards);
    const columns = boardView(doc).columns;
    const card = cards[Math.floor(random() * cards.length)];
    const choice = Math.floor(random() * 8);
    if (choice === 0) addCard(doc, columns[Math.floor(random() * columns.length)].id, `r${round}-${index}`);
    else if (choice === 1 && card) setCardTitle(doc, card.id, `edit-${round}-${index}`);
    else if (choice === 2 && card) setCardDone(doc, card.id, random() > 0.5);
    else if (choice === 3 && card) addTag(doc, card.id, `tag-${round % 7}`);
    else if (choice === 4 && card) setCardNote(doc, card.id, `${card.note} ${round}-${index}`);
    else if (choice === 5 && card) moveCard(doc, card.id, columns[Math.floor(random() * columns.length)].id, Math.floor(random() * 4));
    else if (choice === 6 && card && round % 5 === 0) removeCard(doc, card.id);
    else if (choice === 7 && card && !doc.isAlive(card.id)) restoreCard(doc, card.id);
  }
  const packets = replicas.flatMap((doc) => doc.allOps());
  // Adversarial delivery: deterministic shuffle, then duplicate a slice.
  for (let i = packets.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [packets[i], packets[j]] = [packets[j], packets[i]];
  }
  const wire = [...packets, ...packets.slice(0, 7)];
  for (const doc of replicas) doc.addOps(wire);
  const hashes = new Set(replicas.map((doc) => doc.stateHash()));
  if (hashes.size !== 1) {
    console.error(`DIVERGENCE seed=${seed} round=${round}`, replicas.map((doc) => ({ node: doc.node, hash: doc.stateHash(), stats: doc.stats() })));
    process.exit(1);
  }
  shared = replicas[0].allOps();
  if ((round + 1) % 20 === 0) console.log(`round ${round + 1}/${rounds}: ${shared.length} ops, state ${replicas[0].stateHash()}`);
}
console.log(`Fuzz passed: seed=${seed}, rounds=${rounds}, finalOps=${shared.length}`);
