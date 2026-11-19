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

/**
 * Robust async save and navigation coordinator.
 * Coordinates in-flight requests, sequential draft flushing, autosave timers,
 * and view navigation guards to prevent edit loss or stale version publication.
 */
export class SaveCoordinator {
  constructor({
    getState,
    setState,
    saveFn,
    scheduleTimer = (cb, ms) => setTimeout(cb, ms),
    clearTimer = (id) => clearTimeout(id),
    onSaveSuccess,
    onSaveError,
  }) {
    this.getState = getState;
    this.setState = setState;
    this.saveFn = saveFn;
    this.scheduleTimer = scheduleTimer;
    this.clearTimer = clearTimer;
    this.onSaveSuccess = onSaveSuccess;
    this.onSaveError = onSaveError;

    this.inFlightPromise = null;
    this.inFlightMeta = null;
    this.autosaveTimer = null;
  }

  /**
   * Schedule debounced autosave.
   * Catches rejections on timer-triggered saves to prevent unhandled rejections.
   */
  scheduleAutosave(delayMs = 5000) {
    const state = this.getState();
    const nextGen = (state.editGeneration || 0) + 1;
    this.setState({
      editGeneration: nextGen,
      dirty: true,
      saveState: 'unsaved',
    });

    if (this.autosaveTimer) {
      this.clearTimer(this.autosaveTimer);
    }

    this.autosaveTimer = this.scheduleTimer(() => {
      this.executeSave(false).catch(() => {
        // Handled internally in executeSave (updates error/conflict state and schedules retry)
      });
    }, delayMs);
    if (this.autosaveTimer && typeof this.autosaveTimer.unref === 'function') {
      this.autosaveTimer.unref();
    }
  }

  /**
   * Execute draft save. If a save is already in-flight, returns that in-flight promise
   * so callers can await the in-progress network request.
   */
  executeSave(isManual = false) {
    const state = this.getState();
    if (state.view !== 'editor' || !state.rulesetId) {
      return Promise.resolve(null);
    }

    // If clean, no in-flight save, and not manual: skip
    if (!state.dirty && !isManual && !this.inFlightPromise) {
      return Promise.resolve({
        id: state.rulesetId,
        revision: state.revision,
        graph: state.graph,
      });
    }

    // If a save is already in-flight, return the active promise so awaiters wait on it!
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    const targetRulesetId = state.rulesetId;
    const targetProjectId = state.projectId;
    const targetRevision = state.revision;
    const gen = state.editGeneration;
    const snapshot = structuredClone(state.graph);
    const rulesetName = state.name;

    this.setState({ saveState: 'saving' });

    this.inFlightMeta = {
      rulesetId: targetRulesetId,
      projectId: targetProjectId,
      generation: gen,
    };

    const savePromise = (async () => {
      try {
        const res = await this.saveFn({
          rulesetId: targetRulesetId,
          projectId: targetProjectId,
          revision: targetRevision,
          graph: snapshot,
          name: rulesetName,
        });

        const currentState = this.getState();
        // If user navigated away or changed ruleset while in flight
        if (currentState.view !== 'editor' || currentState.rulesetId !== targetRulesetId) {
          return res.ruleset;
        }

        const newRevision = res.ruleset.revision;
        const updates = { revision: newRevision };

        if (currentState.editGeneration === gen) {
          // No edits were made during the save
          updates.dirty = false;
          updates.saveState = 'saved';
        } else {
          // Newer edits occurred while save was in flight!
          // State remains dirty; schedule subsequent save pass
          updates.dirty = true;
          updates.saveState = 'unsaved';
          if (this.autosaveTimer) this.clearTimer(this.autosaveTimer);
          this.autosaveTimer = this.scheduleTimer(() => {
            this.executeSave(false).catch(() => {});
          }, 5000);
          if (this.autosaveTimer && typeof this.autosaveTimer.unref === 'function') {
            this.autosaveTimer.unref();
          }
        }

        this.setState(updates);
        if (this.onSaveSuccess) {
          this.onSaveSuccess(res.ruleset, isManual && currentState.editGeneration === gen);
        }
        return res.ruleset;
      } catch (err) {
        const currentState = this.getState();
        if (currentState.view === 'editor' && currentState.rulesetId === targetRulesetId) {
          if (err.status === 409) {
            this.setState({ saveState: 'conflict' });
          } else {
            this.setState({ saveState: 'error' });
            if (this.autosaveTimer) this.clearTimer(this.autosaveTimer);
            this.autosaveTimer = this.scheduleTimer(() => {
              this.executeSave(false).catch(() => {});
            }, 5000);
            if (this.autosaveTimer && typeof this.autosaveTimer.unref === 'function') {
              this.autosaveTimer.unref();
            }
          }
        }
        if (this.onSaveError) {
          this.onSaveError(err);
        }
        throw err;
      } finally {
        this.inFlightPromise = null;
        this.inFlightMeta = null;
      }
    })();

    // Attach catch handler to prevent unhandled rejection if no caller awaits immediately
    savePromise.catch(() => {});

    this.inFlightPromise = savePromise;
    return savePromise;
  }

  /**
   * Flush all pending draft edits.
   * Awaits existing in-flight save and loops while the live generation remains dirty for this ruleset.
   * Guarantees all latest edits are fully persisted before returning.
   */
  async flushPendingDraft() {
    const initialState = this.getState();
    if (initialState.view !== 'editor' || !initialState.rulesetId) {
      return { success: true, revision: initialState.revision };
    }

    const targetRulesetId = initialState.rulesetId;

    // Clear debounced autosave timer since we are flushing immediately
    if (this.autosaveTimer) {
      this.clearTimer(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    while (true) {
      const currentState = this.getState();
      if (currentState.view !== 'editor' || currentState.rulesetId !== targetRulesetId) {
        break;
      }

      if (this.inFlightPromise) {
        // Await currently active in-flight network request
        await this.inFlightPromise;
        // Continue loop to see if edits made during that flight left dirty === true
        continue;
      }

      if (currentState.dirty) {
        // Execute a new save and await it
        await this.executeSave(false);
        // Continue loop in case another edit occurred during that save
        continue;
      }

      // Both inFlightPromise is null and dirty is false
      break;
    }

    const finalState = this.getState();
    if (finalState.view === 'editor' && finalState.rulesetId === targetRulesetId && finalState.dirty) {
      throw new Error('Unsaved changes could not be flushed');
    }

    return {
      success: true,
      revision: finalState.revision,
    };
  }

  /**
   * Safe navigation away from editor.
   * Flushes all pending draft edits. If save fails, retains user in editor with actionable error
   * and preserves retry timer.
   */
  async navigateAway(targetView, onNavigate) {
    const state = this.getState();
    if (state.view === 'editor' && (state.dirty || this.inFlightPromise)) {
      try {
        await this.flushPendingDraft();
      } catch (err) {
        // Failed save: retain in editor and keep retry timer active
        return {
          allowed: false,
          error: err,
        };
      }
    }

    // Clean up timer on successful navigation
    if (this.autosaveTimer) {
      this.clearTimer(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    if (onNavigate) {
      await onNavigate(targetView);
    }

    return { allowed: true };
  }
}
