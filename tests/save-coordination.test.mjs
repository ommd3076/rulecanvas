import test from 'node:test';
import assert from 'node:assert/strict';
import { applySaveSuccess, SaveCoordinator } from '../public/save-coordination.js';
import { createSaveCoordinatorAdapter } from '../src/useSaveCoordinator.ts';

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

/* ------------------------------------------------------------------ Regression tests for in-flight save & flush coordination */

test('flushPendingDraft awaits in-flight save and executes second save when edit occurs during flight', async () => {
  let state = {
    view: 'editor',
    rulesetId: 'ruleset-alpha',
    projectId: 'proj-alpha',
    name: 'Alpha Ruleset',
    revision: 1,
    editGeneration: 1,
    graph: { schema: [], nodes: [{ id: 'start' }], edges: [] },
    dirty: true,
    saveState: 'unsaved',
  };

  const saveCalls = [];
  let resolveSave1;
  const save1Promise = new Promise((resolve) => {
    resolveSave1 = resolve;
  });

  let resolveSave2;
  const save2Promise = new Promise((resolve) => {
    resolveSave2 = resolve;
  });

  const coordinator = new SaveCoordinator({
    getState: () => state,
    setState: (updates) => {
      state = { ...state, ...updates };
    },
    saveFn: async (params) => {
      saveCalls.push(params);
      if (saveCalls.length === 1) {
        await save1Promise;
        return { ruleset: { id: params.rulesetId, revision: 2 } };
      } else {
        await save2Promise;
        return { ruleset: { id: params.rulesetId, revision: 3 } };
      }
    },
  });

  // Step 1: Start save 1 (now in-flight)
  const save1Invocation = coordinator.executeSave(false);
  assert.equal(state.saveState, 'saving');
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].revision, 1);

  // Step 2: User makes an edit while save 1 is in-flight!
  state.editGeneration = 2;
  state.graph = {
    schema: [],
    nodes: [{ id: 'start' }, { id: 'condition_new' }],
    edges: [],
  };
  state.dirty = true;

  // Step 3: flushPendingDraft is called (e.g. from navigation, test run, or version publication)
  let flushResolved = false;
  let flushedRevision = null;
  const flushPromise = coordinator.flushPendingDraft().then((res) => {
    flushResolved = true;
    flushedRevision = res.revision;
  });

  // flushPendingDraft must NOT resolve yet because save 1 has not resolved, and edits are still pending
  assert.equal(flushResolved, false);

  // Step 4: Resolve save 1
  resolveSave1();
  await save1Invocation;

  // Save 1 finished, base revision updated to 2, but state remains dirty because editGeneration is 2!
  assert.equal(state.revision, 2);
  assert.equal(state.dirty, true);

  // Step 5: Coordinator must have launched save 2 with the updated graph and revision 2!
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[1].revision, 2);
  assert.equal(saveCalls[1].graph.nodes.length, 2);

  // flushPendingDraft must STILL not be resolved because save 2 is in-flight
  assert.equal(flushResolved, false);

  // Step 6: Resolve save 2
  resolveSave2();
  await flushPromise;

  // Step 7: Fully clean!
  assert.equal(flushResolved, true);
  assert.equal(flushedRevision, 3);
  assert.equal(state.revision, 3);
  assert.equal(state.dirty, false);
  assert.equal(state.saveState, 'saved');
});

test('navigation is blocked and user remains in editor when draft save fails', async () => {
  let timerCleared = false;
  let state = {
    view: 'editor',
    rulesetId: 'ruleset-fail',
    projectId: 'proj-fail',
    name: 'Failing Ruleset',
    revision: 1,
    editGeneration: 1,
    graph: { schema: [], nodes: [{ id: 'start' }], edges: [] },
    dirty: true,
    saveState: 'unsaved',
  };

  const coordinator = new SaveCoordinator({
    getState: () => state,
    setState: (updates) => {
      state = { ...state, ...updates };
    },
    saveFn: async () => {
      const err = new Error('Network connection aborted (500)');
      err.status = 500;
      throw err;
    },
    clearTimer: () => {
      timerCleared = true;
    },
  });

  let navigatedTarget = null;
  const mockNavigate = (target) => {
    navigatedTarget = target;
  };

  const result = await coordinator.navigateAway('dashboard', mockNavigate);

  // Navigation MUST be blocked!
  assert.equal(result.allowed, false);
  assert.equal(result.error.message, 'Network connection aborted (500)');
  assert.equal(navigatedTarget, null);

  // User state MUST remain in editor with dirty flag and error state preserved!
  assert.equal(state.view, 'editor');
  assert.equal(state.dirty, true);
  assert.equal(state.saveState, 'error');

  // Retry timer must NOT have been cleared by navigation!
  assert.notEqual(coordinator.autosaveTimer, null);
  if (coordinator.autosaveTimer) clearTimeout(coordinator.autosaveTimer);
});

test('evaluation awaits in-flight save and newer edits, evaluating only the latest graph', async () => {
  let state = {
    view: 'editor',
    rulesetId: 'ruleset-eval',
    projectId: 'proj-eval',
    name: 'Evaluation Ruleset',
    revision: 1,
    editGeneration: 1,
    graph: { schema: [], nodes: [{ id: 'start' }], edges: [] },
    dirty: true,
    saveState: 'unsaved',
  };

  let resolveSave1;
  const save1Promise = new Promise((resolve) => {
    resolveSave1 = resolve;
  });
  let resolveSave2;
  const save2Promise = new Promise((resolve) => {
    resolveSave2 = resolve;
  });

  let saveCount = 0;
  const coordinator = new SaveCoordinator({
    getState: () => state,
    setState: (updates) => {
      state = { ...state, ...updates };
    },
    saveFn: async () => {
      saveCount++;
      if (saveCount === 1) {
        await save1Promise;
        return { ruleset: { id: 'ruleset-eval', revision: 2 } };
      } else {
        await save2Promise;
        return { ruleset: { id: 'ruleset-eval', revision: 3 } };
      }
    },
  });

  // Start initial save
  coordinator.executeSave(false);

  // Newer edit happens during flight
  state.editGeneration = 2;
  state.dirty = true;
  state.graph = {
    schema: [],
    nodes: [{ id: 'start' }, { id: 'cond_1' }],
    edges: [],
  };

  // Evaluation requested
  let evaluatedRevision = null;
  const evalPromise = (async () => {
    const flushRes = await coordinator.flushPendingDraft();
    evaluatedRevision = flushRes.revision;
  })();

  // Resolve save 1
  resolveSave1();
  await new Promise((r) => setTimeout(r, 10));

  // Evaluated revision must not be set yet (save 2 is running)
  assert.equal(evaluatedRevision, null);

  // Resolve save 2
  resolveSave2();
  await evalPromise;

  // Evaluation evaluated against revision 3, not the obsolete snapshot revision 2!
  assert.equal(evaluatedRevision, 3);
  assert.equal(state.dirty, false);
});

test('save version publishes against latest revision after flushing in-flight edit', async () => {
  let state = {
    view: 'editor',
    rulesetId: 'ruleset-ver',
    projectId: 'proj-ver',
    name: 'Version Ruleset',
    revision: 1,
    editGeneration: 1,
    graph: { schema: [], nodes: [{ id: 'start' }], edges: [] },
    dirty: true,
    saveState: 'unsaved',
  };

  let resolveSave1;
  const save1Promise = new Promise((resolve) => {
    resolveSave1 = resolve;
  });
  let resolveSave2;
  const save2Promise = new Promise((resolve) => {
    resolveSave2 = resolve;
  });

  let saveCount = 0;
  const coordinator = new SaveCoordinator({
    getState: () => state,
    setState: (updates) => {
      state = { ...state, ...updates };
    },
    saveFn: async () => {
      saveCount++;
      if (saveCount === 1) {
        await save1Promise;
        return { ruleset: { id: 'ruleset-ver', revision: 2 } };
      } else {
        await save2Promise;
        return { ruleset: { id: 'ruleset-ver', revision: 3 } };
      }
    },
  });

  // In-flight save 1
  coordinator.executeSave(false);

  // User adds another node before save 1 resolves
  state.editGeneration = 2;
  state.dirty = true;
  state.graph = {
    schema: [],
    nodes: [{ id: 'start' }, { id: 'node_b' }],
    edges: [],
  };

  // User clicks Save Version
  let publishedTargetRevision = null;
  const versionPromise = (async () => {
    const { revision } = await coordinator.flushPendingDraft();
    publishedTargetRevision = revision;
  })();

  resolveSave1();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(publishedTargetRevision, null);

  resolveSave2();
  await versionPromise;

  // Published version used revision 3, not the stale revision 2!
  assert.equal(publishedTargetRevision, 3);
});

test('timer-triggered save rejection does not cause unhandled promise rejection while manual callers receive failure', async () => {
  let unhandledRejections = 0;
  const onUnhandled = () => {
    unhandledRejections++;
  };
  process.on('unhandledRejection', onUnhandled);

  let timerCallback = null;
  let state = {
    view: 'editor',
    rulesetId: 'ruleset-timer-err',
    projectId: 'proj-timer',
    name: 'Timer Ruleset',
    revision: 1,
    editGeneration: 1,
    graph: { schema: [], nodes: [{ id: 'start' }], edges: [] },
    dirty: true,
    saveState: 'unsaved',
  };

  const coordinator = new SaveCoordinator({
    getState: () => state,
    setState: (updates) => {
      state = { ...state, ...updates };
    },
    saveFn: async () => {
      const err = new Error('503 Service Unavailable');
      err.status = 503;
      throw err;
    },
    scheduleTimer: (cb) => {
      timerCallback = cb;
      return 123;
    },
  });

  // Schedule autosave via timer
  coordinator.scheduleAutosave(5000);
  assert.notEqual(timerCallback, null);

  // Trigger timer callback
  timerCallback();
  await new Promise((r) => setTimeout(r, 20));

  // No unhandled promise rejection was emitted!
  assert.equal(unhandledRejections, 0);
  assert.equal(state.saveState, 'error');

  // But manual callers awaiting executeSave or flushPendingDraft MUST receive the failure
  await assert.rejects(
    async () => {
      await coordinator.flushPendingDraft();
    },
    { message: '503 Service Unavailable' }
  );

  process.removeListener('unhandledRejection', onUnhandled);
});

/* ------------------------------------------------------------------ Tests exercising the production React save coordinator adapter (src/useSaveCoordinator.ts) */

test('React adapter createSaveCoordinatorAdapter synchronizes live refs and updates React state setters on clean save', async () => {
  const viewRef = { current: 'editor' };
  const currentRulesetRef = { current: { id: 'ruleset-react-1', name: 'React Ruleset' } };
  const currentProjectRef = { current: { id: 'proj-react-1' } };
  const graphRef = { current: { schema: [], nodes: [{ id: 'start' }], edges: [] } };
  const activeRevisionRef = { current: 1 };
  const isDirtyRef = { current: true };
  const editGenerationRef = { current: 1 };
  const saveStateRef = { current: 'unsaved' };

  let revisionState = 1;
  let dirtyState = true;
  let saveStateVal = 'unsaved';

  const setters = {
    setRevision: (r) => { revisionState = r; },
    setDirty: (d) => { dirtyState = d; },
    setSaveState: (s) => { saveStateVal = s; },
  };

  const adapter = createSaveCoordinatorAdapter(
    {
      viewRef,
      currentRulesetRef,
      currentProjectRef,
      graphRef,
      saveFn: async ({ rulesetId, revision }) => {
        return { ruleset: { id: rulesetId, revision: revision + 1 } };
      },
    },
    setters,
    {
      activeRevisionRef,
      isDirtyRef,
      editGenerationRef,
      saveStateRef,
    }
  );

  assert.equal(saveStateRef.current, 'unsaved');
  assert.equal(saveStateVal, 'unsaved');

  const res = await adapter.executeSave(false);
  assert.equal(res.revision, 2);

  // Both the live refs AND the React state setters must have received the updates!
  assert.equal(activeRevisionRef.current, 2);
  assert.equal(revisionState, 2);

  assert.equal(isDirtyRef.current, false);
  assert.equal(dirtyState, false);

  assert.equal(saveStateRef.current, 'saved');
  assert.equal(saveStateVal, 'saved');
});

test('React adapter flushPendingDraft awaits in-flight save and newer edits made during flight, updating React state and refs', async () => {
  const viewRef = { current: 'editor' };
  const currentRulesetRef = { current: { id: 'ruleset-react-loop', name: 'React Loop Ruleset' } };
  const currentProjectRef = { current: { id: 'proj-react-loop' } };
  const graphRef = { current: { schema: [], nodes: [{ id: 'start' }], edges: [] } };
  const activeRevisionRef = { current: 1 };
  const isDirtyRef = { current: true };
  const editGenerationRef = { current: 1 };
  const saveStateRef = { current: 'unsaved' };

  let revisionState = 1;
  let dirtyState = true;
  let saveStateVal = 'unsaved';

  const setters = {
    setRevision: (r) => { revisionState = r; },
    setDirty: (d) => { dirtyState = d; },
    setSaveState: (s) => { saveStateVal = s; },
  };

  let resolveSave1;
  const save1Promise = new Promise((resolve) => { resolveSave1 = resolve; });
  let resolveSave2;
  const save2Promise = new Promise((resolve) => { resolveSave2 = resolve; });
  let saveCount = 0;

  const adapter = createSaveCoordinatorAdapter(
    {
      viewRef,
      currentRulesetRef,
      currentProjectRef,
      graphRef,
      saveFn: async ({ rulesetId, revision }) => {
        saveCount++;
        if (saveCount === 1) {
          await save1Promise;
          return { ruleset: { id: rulesetId, revision: 2 } };
        } else {
          await save2Promise;
          return { ruleset: { id: rulesetId, revision: 3 } };
        }
      },
    },
    setters,
    {
      activeRevisionRef,
      isDirtyRef,
      editGenerationRef,
      saveStateRef,
    }
  );

  // Start in-flight save 1
  adapter.executeSave(false);
  assert.equal(saveStateRef.current, 'saving');
  assert.equal(saveStateVal, 'saving');

  // Edit occurs while save 1 is in-flight!
  editGenerationRef.current = 2;
  isDirtyRef.current = true;
  dirtyState = true;
  graphRef.current = { schema: [], nodes: [{ id: 'start' }, { id: 'cond_added' }], edges: [] };

  // Call flushPendingDraft
  let flushResolved = false;
  let flushedRevision = null;
  const flushPromise = adapter.flushPendingDraft().then((res) => {
    flushResolved = true;
    flushedRevision = res.revision;
  });

  assert.equal(flushResolved, false);

  // Resolve save 1
  resolveSave1();
  await new Promise((r) => setTimeout(r, 10));

  // State advances revision to 2, but dirty remains true
  assert.equal(activeRevisionRef.current, 2);
  assert.equal(revisionState, 2);
  assert.equal(isDirtyRef.current, true);
  assert.equal(flushResolved, false);

  // Resolve save 2
  resolveSave2();
  await flushPromise;

  assert.equal(flushResolved, true);
  assert.equal(flushedRevision, 3);
  assert.equal(activeRevisionRef.current, 3);
  assert.equal(revisionState, 3);
  assert.equal(isDirtyRef.current, false);
  assert.equal(dirtyState, false);
  assert.equal(saveStateRef.current, 'saved');
  assert.equal(saveStateVal, 'saved');
});

test('React adapter navigateAway blocks navigation and preserves retry timer when draft save fails', async () => {
  const viewRef = { current: 'editor' };
  const currentRulesetRef = { current: { id: 'ruleset-fail-react', name: 'Fail React' } };
  const currentProjectRef = { current: { id: 'proj-fail-react' } };
  const graphRef = { current: { schema: [], nodes: [{ id: 'start' }], edges: [] } };
  const activeRevisionRef = { current: 1 };
  const isDirtyRef = { current: true };
  const editGenerationRef = { current: 1 };
  const saveStateRef = { current: 'unsaved' };

  let revisionState = 1;
  let dirtyState = true;
  let saveStateVal = 'unsaved';

  const setters = {
    setRevision: (r) => { revisionState = r; },
    setDirty: (d) => { dirtyState = d; },
    setSaveState: (s) => { saveStateVal = s; },
  };

  const adapter = createSaveCoordinatorAdapter(
    {
      viewRef,
      currentRulesetRef,
      currentProjectRef,
      graphRef,
      saveFn: async () => {
        const err = new Error('500 Internal Server Error');
        err.status = 500;
        throw err;
      },
    },
    setters,
    {
      activeRevisionRef,
      isDirtyRef,
      editGenerationRef,
      saveStateRef,
    }
  );

  let navigated = false;
  const result = await adapter.navigateAway('dashboard', () => { navigated = true; });

  assert.equal(result.allowed, false);
  assert.equal(navigated, false);
  assert.equal(isDirtyRef.current, true);
  assert.equal(dirtyState, true);
  assert.equal(saveStateRef.current, 'error');
  assert.equal(saveStateVal, 'error');
  assert.notEqual(adapter.autosaveTimer, null);

  if (adapter.autosaveTimer) clearTimeout(adapter.autosaveTimer);
});
