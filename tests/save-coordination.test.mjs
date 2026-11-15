import test from 'node:test';
import assert from 'node:assert/strict';
import { applySaveSuccess } from '../public/save-coordination.js';

test('applies save cleanly when no edits occur while save is in flight', () => {
  const localGraph = { schema: [], nodes: [{ id: 'start' }], edges: [] };
  const serverGraph = { schema: [], nodes: [{ id: 'start' }], edges: [] };
  const state = {
    view: 'editor',
    ruleset: { id: 'ruleset-1' },
    revision: 1,
    editGeneration: 3,
    graph: localGraph,
    dirty: true,
    saveState: 'saving',
    recovered: false,
  };

  const outcome = applySaveSuccess({
    state,
    targetRulesetId: 'ruleset-1',
    targetProjectId: 'proj-1',
    savedGeneration: 3,
    newRevision: 2,
    serverGraph,
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.shouldRerunSave, false);
  assert.equal(outcome.viewChanged, false);
  assert.equal(state.revision, 2);
  assert.equal(state.dirty, false);
  assert.equal(state.saveState, 'saved');
});

test('preserves in-flight edits and schedules rerun when edits occur while save is in flight', () => {
  const localGraphWithEdit = {
    schema: [],
    nodes: [{ id: 'start' }, { id: 'new-condition-added-while-saving' }],
    edges: [],
  };
  const staleServerGraph = {
    schema: [],
    nodes: [{ id: 'start' }],
    edges: [],
  };
  const state = {
    view: 'editor',
    ruleset: { id: 'ruleset-1' },
    revision: 1,
    editGeneration: 4, // edited while in flight (was 3 when snapshot was taken)
    graph: localGraphWithEdit,
    dirty: true,
    saveState: 'saving',
    recovered: false,
  };

  const outcome = applySaveSuccess({
    state,
    targetRulesetId: 'ruleset-1',
    targetProjectId: 'proj-1',
    savedGeneration: 3,
    newRevision: 2,
    serverGraph: staleServerGraph,
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.shouldRerunSave, true);
  assert.equal(outcome.viewChanged, false);
  // Must advance revision to 2 so next save has correct base revision!
  assert.equal(state.revision, 2);
  // Must NOT overwrite the local graph containing the newer edit!
  assert.equal(state.graph.nodes.length, 2);
  assert.equal(state.graph.nodes[1].id, 'new-condition-added-while-saving');
  // Must stay dirty and unsaved!
  assert.equal(state.dirty, true);
  assert.equal(state.saveState, 'unsaved');
});

test('does not corrupt state if user navigated away while save was in flight', () => {
  const dashboardState = {
    view: 'dashboard',
    ruleset: null,
    project: null,
    graph: null,
    revision: 0,
    editGeneration: 0,
    dirty: false,
    saveState: 'saved',
  };

  const outcome = applySaveSuccess({
    state: dashboardState,
    targetRulesetId: 'ruleset-1',
    targetProjectId: 'proj-1',
    savedGeneration: 1,
    newRevision: 2,
    serverGraph: { schema: [], nodes: [], edges: [] },
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.shouldRerunSave, false);
  assert.equal(outcome.viewChanged, true);
  assert.equal(dashboardState.view, 'dashboard');
  assert.equal(dashboardState.ruleset, null);
  assert.equal(dashboardState.graph, null);
  assert.equal(dashboardState.dirty, false);
});
