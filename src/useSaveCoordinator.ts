import { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { SaveCoordinator } from '../public/save-coordination.js';
import type { RuleGraph, ProjectDetail, RulesetDetail } from './api';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict';

export interface SaveCoordinatorAdapterOptions {
  viewRef: MutableRefObject<string>;
  currentRulesetRef: MutableRefObject<RulesetDetail | null>;
  currentProjectRef: MutableRefObject<ProjectDetail | null>;
  graphRef: MutableRefObject<RuleGraph>;
  saveFn: (payload: {
    rulesetId: string;
    projectId?: string | null;
    revision: number;
    graph: RuleGraph;
    name?: string;
  }) => Promise<{ ruleset: { id: string; revision: number; graph?: RuleGraph } }>;
  onSaveSuccess?: (savedRuleset: { id: string; revision: number }, isCleanManual: boolean) => void;
  onSaveError?: (err: any) => void;
  scheduleTimer?: (cb: () => void, ms: number) => any;
  clearTimer?: (id: any) => void;
}

export interface AdapterSetters {
  setRevision: (rev: number) => void;
  setDirty: (dirty: boolean) => void;
  setSaveState: (state: SaveState) => void;
}

export interface AdapterRefs {
  activeRevisionRef: MutableRefObject<number>;
  isDirtyRef: MutableRefObject<boolean>;
  editGenerationRef: MutableRefObject<number>;
  saveStateRef: MutableRefObject<SaveState>;
}

/**
 * Pure adapter connecting live React-style refs and state setters to the SaveCoordinator.
 * Can be exercised directly in unit tests and consumed by the useSaveCoordinator hook.
 */
export function createSaveCoordinatorAdapter(
  options: SaveCoordinatorAdapterOptions,
  setters: AdapterSetters,
  refs: AdapterRefs
): SaveCoordinator {
  return new SaveCoordinator({
    getState: () => ({
      view: options.viewRef.current,
      rulesetId: options.currentRulesetRef.current?.id || null,
      projectId: options.currentProjectRef.current?.id || null,
      name: options.currentRulesetRef.current?.name || '',
      revision: refs.activeRevisionRef.current,
      editGeneration: refs.editGenerationRef.current,
      graph: options.graphRef.current,
      dirty: refs.isDirtyRef.current,
      saveState: refs.saveStateRef.current,
    }),
    setState: (updates: any) => {
      if ('revision' in updates) {
        refs.activeRevisionRef.current = updates.revision;
        setters.setRevision(updates.revision);
      }
      if ('editGeneration' in updates) {
        refs.editGenerationRef.current = updates.editGeneration;
      }
      if ('dirty' in updates) {
        refs.isDirtyRef.current = updates.dirty;
        setters.setDirty(updates.dirty);
      }
      if ('saveState' in updates) {
        refs.saveStateRef.current = updates.saveState;
        setters.setSaveState(updates.saveState);
      }
    },
    saveFn: options.saveFn,
    scheduleTimer: options.scheduleTimer,
    clearTimer: options.clearTimer,
    onSaveSuccess: options.onSaveSuccess,
    onSaveError: options.onSaveError,
  });
}

/**
 * Production React hook integrating SaveCoordinator with React state and live refs.
 */
export function useSaveCoordinator(options: SaveCoordinatorAdapterOptions) {
  const [activeRevision, setActiveRevision] = useState(1);
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');

  const activeRevisionRef = useRef(activeRevision);
  activeRevisionRef.current = activeRevision;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const saveStateRef = useRef<SaveState>(saveState);
  saveStateRef.current = saveState;

  const editGenerationRef = useRef(0);

  const coordinatorRef = useRef<SaveCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createSaveCoordinatorAdapter(
      options,
      {
        setRevision: setActiveRevision,
        setDirty: setIsDirty,
        setSaveState,
      },
      {
        activeRevisionRef,
        isDirtyRef,
        editGenerationRef,
        saveStateRef,
      }
    );
  }

  // Clear autosave timer on unmount
  useEffect(() => {
    return () => {
      if (coordinatorRef.current?.autosaveTimer) {
        clearTimeout(coordinatorRef.current.autosaveTimer);
      }
    };
  }, []);

  const executeSaveDraft = useCallback((isManual = false) => {
    return coordinatorRef.current!.executeSave(isManual);
  }, []);

  const flushPendingDraft = useCallback(() => {
    return coordinatorRef.current!.flushPendingDraft();
  }, []);

  const scheduleAutosave = useCallback((delayMs = 5000) => {
    coordinatorRef.current!.scheduleAutosave(delayMs);
  }, []);

  const navigateAway = useCallback(
    (targetView: 'dashboard' | 'project', onNavigate: (target: string) => Promise<void> | void) => {
      return coordinatorRef.current!.navigateAway(targetView, onNavigate);
    },
    []
  );

  const resetCoordinator = useCallback((newRevision = 1) => {
    if (coordinatorRef.current) {
      if (coordinatorRef.current.autosaveTimer) {
        clearTimeout(coordinatorRef.current.autosaveTimer);
        coordinatorRef.current.autosaveTimer = null;
      }
      coordinatorRef.current.inFlightPromise = null;
      coordinatorRef.current.inFlightMeta = null;
    }
    editGenerationRef.current = 0;
    activeRevisionRef.current = newRevision;
    setActiveRevision(newRevision);
    isDirtyRef.current = false;
    setIsDirty(false);
    saveStateRef.current = 'saved';
    setSaveState('saved');
  }, []);

  return {
    activeRevision,
    setActiveRevision,
    isDirty,
    setIsDirty,
    saveState,
    setSaveState,
    activeRevisionRef,
    isDirtyRef,
    saveStateRef,
    editGenerationRef,
    coordinatorRef,
    executeSaveDraft,
    flushPendingDraft,
    scheduleAutosave,
    navigateAway,
    resetCoordinator,
  };
}
