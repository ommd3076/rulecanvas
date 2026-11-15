export function createHistory(limit = 60) {
  return { undo: [], redo: [], group: null, lastAt: 0, limit };
}

export function saveSnapshot(history, graph, group = null, now = Date.now()) {
  if (group && history.group === group && now - history.lastAt < 700) {
    history.lastAt = now;
    return false;
  }
  history.undo.push(structuredClone(graph));
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo = [];
  history.group = group;
  history.lastAt = now;
  return true;
}

export function restoreSnapshot(history, graph, direction) {
  const from = direction === 'undo' ? history.undo : history.redo;
  const to = direction === 'undo' ? history.redo : history.undo;
  if (!from.length) return null;
  to.push(structuredClone(graph));
  history.group = null;
  return structuredClone(from.pop());
}
