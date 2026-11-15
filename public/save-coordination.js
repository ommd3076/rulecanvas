export function applySaveSuccess({
  state,
  targetRulesetId,
  targetProjectId,
  savedGeneration,
  newRevision,
  serverGraph,
}) {
  if (state.view !== 'editor' || !state.ruleset || state.ruleset.id !== targetRulesetId) {
    return { shouldRerunSave: false, applied: false, viewChanged: true };
  }

  state.revision = newRevision;

  if (state.editGeneration === savedGeneration) {
    state.graph = structuredClone(serverGraph);
    state.dirty = false;
    state.saveState = 'saved';
    state.recovered = false;
    return { shouldRerunSave: false, applied: true, viewChanged: false };
  }

  state.saveState = 'unsaved';
  return { shouldRerunSave: true, applied: false, viewChanged: false };
}
