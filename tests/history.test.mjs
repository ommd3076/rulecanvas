import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, restoreSnapshot, saveSnapshot } from '../public/history.js';

test('undoes and redoes graph edits without sharing mutable snapshot objects', () => {
  const history = createHistory();
  const original = { nodes: [{ id: 'a', x: 10 }], edges: [] };
  const edited = structuredClone(original);
  edited.nodes[0].x = 44;
  assert.equal(saveSnapshot(history, original, null, 1000), true);
  const afterUndo = restoreSnapshot(history, edited, 'undo');
  assert.deepEqual(afterUndo, original);
  afterUndo.nodes[0].x = 99;
  const afterRedo = restoreSnapshot(history, original, 'redo');
  assert.deepEqual(afterRedo, edited);
});

test('groups rapid field typing into one undo step and separates edits after a pause', () => {
  const history = createHistory();
  const first = { schema: [{ id: 'name', value: '' }] };
  const second = { schema: [{ id: 'name', value: 'A' }] };
  const third = { schema: [{ id: 'name', value: 'AB' }] };
  saveSnapshot(history, first, 'field-name:name', 1000);
  assert.equal(saveSnapshot(history, second, 'field-name:name', 1300), false);
  assert.equal(saveSnapshot(history, third, 'field-name:name', 2100), true);
  assert.equal(history.undo.length, 2);
});

test('clears redo history when a new branch edit is made', () => {
  const history = createHistory();
  const base = { edges: [] };
  const first = { edges: [{ id: 'e1' }] };
  saveSnapshot(history, base);
  const undone = restoreSnapshot(history, first, 'undo');
  assert.deepEqual(undone, base);
  saveSnapshot(history, { edges: [{ id: 'e2' }] });
  assert.equal(history.redo.length, 0);
});
