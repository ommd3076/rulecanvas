import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DirectionProvider } from '@/components/foundations/direction/direction';
import { Toaster, toast } from '@/components/rareui/toast';
import {
  api,
  type ProjectSummary,
  type ProjectDetail,
  type RulesetDetail,
  type RuleGraph,
  type RuleNode,
  type SchemaField,
  type VersionSummary,
  type VersionDetail,
  type AuditEvent,
  type EvaluationResult,
  type ValidationResult,
} from './api';
import {
  parseRoute,
  buildRouteUrl,
  verifyOwnership,
  createGuardedHistoryController,
  type RouteState,
  type PanelType,
} from './router';
import { RecoveryView, type RecoveryState } from './components/RecoveryView';
import { createHistory, saveSnapshot, restoreSnapshot } from '@/public/history';
import { serializeConflictCopy } from '@/public/conflict-copy';
import { useSaveCoordinator } from './useSaveCoordinator';
import { TopNav } from './components/TopNav';
import { DashboardView } from './components/DashboardView';
import { PublicHomePage } from './components/PublicHomePage';
import { TeamSettingsView } from './components/TeamSettingsView';
import { eligibilityExampleInput } from './example';
import { ProjectOverviewView } from './components/ProjectOverviewView';
import { RunsView } from './components/RunsView';
import { ReleasesView } from './components/ReleasesView';
import { GraphCanvas } from './components/GraphCanvas';
import { NodeInspector } from './components/NodeInspector';
import { SchemaEditor } from './components/SchemaEditor';
import { TestRunner } from './components/TestRunner';
import { MobileInspectorDrawer } from './components/MobileInspectorDrawer';
import {
  CreateProjectModal,
  CreateRulesetModal,
  VersionHistoryModal,
  AuditModal,
  ImportExportModal,
} from './components/Modals';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  RiLayoutRightLine,
  RiLayoutRight2Line,
  RiEqualizerLine,
  RiAlertLine,
  RiCloseLine,
  RiFocus3Line,
} from '@remixicon/react';

export function App() {
  // Navigation / Route state
  const [route, setRoute] = useState<RouteState>(() =>
    parseRoute(window.location.pathname, window.location.search)
  );
  const routeRef = useRef(route);
  routeRef.current = route;

  const [recoveryState, setRecoveryState] = useState<RecoveryState | null>(() => {
    const init = parseRoute(window.location.pathname, window.location.search);
    return init.type === 'not_found' ? { type: 'not_found', path: init.path } : null;
  });
  const navigationSeqRef = useRef(0);
  const returnRouteRef = useRef<RouteState | null>(null);

  // Data State
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectDetail | null>(null);
  const [currentRuleset, setCurrentRuleset] = useState<RulesetDetail | null>(null);
  const [guidedExampleRulesetId, setGuidedExampleRulesetId] = useState<string | null>(null);
  const [isStartingGuidedExample, setIsStartingGuidedExample] = useState(false);
  const isStartingGuidedExampleRef = useRef(false);
  const [releaseManagementAvailable, setReleaseManagementAvailable] = useState<boolean | null>(null);
  const [teamManagementAvailable, setTeamManagementAvailable] = useState<boolean | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(route.type === 'projects');
  const isHome = route.type === 'home';

  useEffect(() => {
    if (isHome) return;
    let active = true;
    api.getHealth().then((health) => {
      if (!active) return;
      setReleaseManagementAvailable(health.releaseManagement === true);
      setTeamManagementAvailable(health.teamManagement === true);
    }).catch(() => {
      if (!active) return;
      setReleaseManagementAvailable(false);
      setTeamManagementAvailable(false);
    });
    return () => { active = false; };
  }, [isHome]);

  // Derived View identifier for SaveCoordinator and TopNav
  const view: 'dashboard' | 'project' | 'runs' | 'editor' | 'releases' =
    route.type === 'project' || (route.type === 'versions' && returnRouteRef.current?.type === 'project')
      ? 'project'
      : route.type === 'runs'
      ? 'runs'
      : route.type === 'versions' && returnRouteRef.current?.type === 'runs'
      ? 'runs'
      : route.type === 'releases'
      ? 'releases'
      : route.type === 'editor' || route.type === 'versions'
      ? 'editor'
      : 'dashboard';

  // Graph and Schema
  const [graph, setGraph] = useState<RuleGraph>({ schema: [], nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTraceNodeId, setActiveTraceNodeId] = useState<string | null>(null);

  // Validation State
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  // Live Refs to prevent stale closure bugs in callbacks, timers, and navigation guards
  const viewRef = useRef(view);
  viewRef.current = view;

  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;

  const currentRulesetRef = useRef(currentRuleset);
  currentRulesetRef.current = currentRuleset;

  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Integrated production save coordinator hook with React refs/state adapter
  const {
    activeRevision,
    setActiveRevision,
    isDirty,
    setIsDirty,
    saveState,
    setSaveState,
    activeRevisionRef,
    isDirtyRef,
    editGenerationRef,
    coordinatorRef,
    executeSaveDraft,
    flushPendingDraft,
    scheduleAutosave,
    navigateAway,
    resetCoordinator,
  } = useSaveCoordinator({
    viewRef,
    currentRulesetRef,
    currentProjectRef,
    graphRef,
    saveFn: async ({ rulesetId, revision, graph: saveGraph, name }: any) => {
      return api.saveRuleset(rulesetId, revision, saveGraph, name);
    },
    onSaveSuccess: (savedRuleset: any, isCleanManual: boolean) => {
      if (isCleanManual) {
        toast.success(`Draft saved (Rev ${savedRuleset.revision})`);
      }
    },
    onSaveError: (err: any) => {
      if (err.status === 409) {
        toast.error(
          'Revision conflict: Newer changes exist on server. Download conflict copy to save your work.'
        );
      } else {
        toast.error(`Save failed: ${err.message}. Retrying in 5s…`);
      }
    },
  });

  // History (Undo / Redo)
  const historyRef = useRef(createHistory(60));
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Inspector panel
  const [inspectorTab, setInspectorTab] = useState<PanelType>('properties');
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

  // Modals
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [isCreateRulesetOpen, setIsCreateRulesetOpen] = useState(false);
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false);
  const [versionModalRuleset, setVersionModalRuleset] = useState<{ id: string; name: string } | null>(null);
  const [versionHistoryList, setVersionHistoryList] = useState<VersionSummary[]>([]);
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [auditList, setAuditList] = useState<AuditEvent[]>([]);
  const [isImportExportOpen, setIsImportExportOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const updateViewport = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  }, []);

  // Clean timers on unmount
  useEffect(() => {
    return () => {
      if (coordinatorRef.current?.autosaveTimer) {
        clearTimeout(coordinatorRef.current.autosaveTimer);
      }
    };
  }, []);

  // Beforeunload protection against accidental data loss
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Sync undo/redo availability
  const updateUndoRedoState = () => {
    setCanUndo(historyRef.current.undo.length > 0);
    setCanRedo(historyRef.current.redo.length > 0);
  };

  // Load Projects helper
  const loadProjects = async () => {
    try {
      const res = await api.getProjects();
      setProjects(res.projects || []);
      return res.projects || [];
    } catch (err: any) {
      toast.error(`Failed to load projects: ${err.message}`);
      return [];
    }
  };

  // Core Resource-Addressed Route Loader with Ownership Verification & Stale Rejection
  const loadRoute = useCallback(async (targetRoute: RouteState) => {
    const navId = ++navigationSeqRef.current;
    setRecoveryState(null);

    // Navigating away from versions clears the opener return route and closes the version modal
    if (targetRoute.type !== 'versions') {
      returnRouteRef.current = null;
      setIsVersionHistoryOpen(false);
    }

    if (targetRoute.type === 'home' || targetRoute.type === 'team') {
      setCurrentProject(null);
      currentProjectRef.current = null;
      setCurrentRuleset(null);
      currentRulesetRef.current = null;
      setRoute(targetRoute);
      return;
    }

    if (targetRoute.type === 'not_found') {
      setCurrentProject(null);
      currentProjectRef.current = null;
      setCurrentRuleset(null);
      currentRulesetRef.current = null;
      setRoute(targetRoute);
      setRecoveryState({
        type: 'not_found',
        path: targetRoute.path,
      });
      return;
    }

    if (targetRoute.type === 'projects') {
      setLoadingProjects(true);
      setCurrentProject(null);
      currentProjectRef.current = null;
      setCurrentRuleset(null);
      currentRulesetRef.current = null;
      setRoute(targetRoute);
      try {
        const { projects: list } = await api.getProjects();
        if (navigationSeqRef.current !== navId) return;
        if (!Array.isArray(list)) throw new Error('The workspace returned an invalid project list.');
        setProjects(list);
      } catch (err: any) {
        if (navigationSeqRef.current !== navId) return;
        setRecoveryState(err.status === 401 || err.status === 403 ? {
          type: 'access_error',
          forbidden: err.status === 403,
          onRetry: () => window.location.reload(),
        } : {
          type: 'network_error',
          message: err.message || 'Failed to load projects.',
          onRetry: () => loadRoute(targetRoute),
        });
      } finally {
        if (navigationSeqRef.current === navId) setLoadingProjects(false);
      }
      return;
    }

    if (targetRoute.type === 'project' || targetRoute.type === 'runs') {
      try {
        const res = await api.getProject(targetRoute.projectId);
        if (navigationSeqRef.current !== navId) return;
        setCurrentProject(res.project);
        currentProjectRef.current = res.project;
        setCurrentRuleset(null);
        currentRulesetRef.current = null;
        setRoute(targetRoute);
        // Also fetch project list in background for navigation counts
        loadProjects();
      } catch (err: any) {
        if (navigationSeqRef.current !== navId) return;
        if (err.status === 404) {
          setRecoveryState({
            type: 'project_not_found',
            projectId: targetRoute.projectId,
          });
        } else {
          setRecoveryState({
            type: 'network_error',
            message: err.message || 'Failed to load project.',
            onRetry: () => loadRoute(targetRoute),
          });
        }
      }
      return;
    }

    if (targetRoute.type === 'editor' || targetRoute.type === 'versions' || targetRoute.type === 'releases') {
      try {
        // Step 1: Verify Project Existence
        let project: ProjectDetail;
        try {
          const projRes = await api.getProject(targetRoute.projectId);
          project = projRes.project;
        } catch (projErr: any) {
          if (navigationSeqRef.current !== navId) return;
          if (projErr.status === 404) {
            setRecoveryState({
              type: 'project_not_found',
              projectId: targetRoute.projectId,
            });
          } else {
            setRecoveryState({
              type: 'network_error',
              message: projErr.message || 'Failed to load project.',
              onRetry: () => loadRoute(targetRoute),
            });
          }
          return;
        }

        // Step 2: Verify Ruleset Existence
        let ruleset: RulesetDetail;
        try {
          const ruleRes = await api.getRuleset(targetRoute.ruleId);
          ruleset = ruleRes.ruleset;
        } catch (ruleErr: any) {
          if (navigationSeqRef.current !== navId) return;
          if (ruleErr.status === 404) {
            setRecoveryState({
              type: 'rule_not_found',
              projectId: targetRoute.projectId,
              ruleId: targetRoute.ruleId,
            });
          } else {
            setRecoveryState({
              type: 'network_error',
              message: ruleErr.message || 'Failed to load rule set.',
              onRetry: () => loadRoute(targetRoute),
            });
          }
          return;
        }

        if (navigationSeqRef.current !== navId) return;

        // Step 3: Verify Ownership / Parent-Child Relationship!
        const ownership = verifyOwnership({
          project,
          ruleset,
          requestedProjectId: targetRoute.projectId,
          requestedRuleId: targetRoute.ruleId,
        });

        if (ownership.status === 'error') {
          if (ownership.reason === 'project_rule_mismatch') {
            setRecoveryState({
              type: 'project_rule_mismatch',
              projectId: targetRoute.projectId,
              ruleId: targetRoute.ruleId,
              actualProjectId: ownership.actualProjectId,
              rulesetName: ownership.rulesetName,
            });
          }
          return;
        }

        // Project and Ruleset are valid and matched
        setCurrentProject(project);
        currentProjectRef.current = project;

        // Only reset editor state if switching to a different ruleset
        if (currentRulesetRef.current?.id !== ruleset.id) {
          setCurrentRuleset(ruleset);
          currentRulesetRef.current = ruleset;
          setGraph(ruleset.graph || { schema: [], nodes: [], edges: [] });
          graphRef.current = ruleset.graph || { schema: [], nodes: [], edges: [] };
          resetCoordinator(ruleset.revision || 1);
          setValidationResult(null);
          historyRef.current = createHistory(60);
          updateUndoRedoState();
          setSelectedNodeId(null);
          setActiveTraceNodeId(null);
        }

        setRoute(targetRoute);

        // Panel synchronization
        if (targetRoute.type === 'editor') {
          setInspectorTab(targetRoute.panel ?? 'properties');
          setIsMobileDrawerOpen(Boolean(targetRoute.panel && window.matchMedia('(max-width: 767px)').matches));
          if (targetRoute.panel) setIsInspectorCollapsed(false);
        }

        // Version modal synchronization
        if (targetRoute.type === 'versions') {
          setVersionModalRuleset({ id: ruleset.id, name: ruleset.name });
          setIsVersionHistoryOpen(true);
          try {
            const vList = await api.getVersions(ruleset.id);
            if (navigationSeqRef.current === navId) {
              setVersionHistoryList(vList.versions || []);
            }
          } catch {}
        } else {
          setIsVersionHistoryOpen(false);
        }

        loadProjects();
      } catch (err: any) {
        if (navigationSeqRef.current !== navId) return;
        setRecoveryState({
          type: 'network_error',
          message: err.message || 'Failed to load workspace.',
          onRetry: () => loadRoute(targetRoute),
        });
      }
      return;
    }
  }, [resetCoordinator]);

  // Initial mount route load
  useEffect(() => {
    loadRoute(parseRoute(window.location.pathname, window.location.search));
  }, [loadRoute]);

  // Persistent Guarded Browser History Controller (tracks history index, preserves forward stack on rejection)
  const historyControllerRef = useRef<any>(null);
  if (!historyControllerRef.current) {
    historyControllerRef.current = createGuardedHistoryController({
      getHistoryState: () => (typeof window !== 'undefined' ? window.history.state : null),
      pushState: (state: any, title: string, url: string) => {
        if (typeof window !== 'undefined') window.history.pushState(state, title, url);
      },
      replaceState: (state: any, title: string, url: string) => {
        if (typeof window !== 'undefined') window.history.replaceState(state, title, url);
      },
      go: (delta: number) => {
        if (typeof window !== 'undefined') window.history.go(delta);
      },
      isDirty: () => isDirtyRef.current || !!coordinatorRef.current?.inFlightPromise,
      flushDraft: () => flushPendingDraft(),
      onSaveError: (err: any) => {
        toast.error(
          `Cannot leave editor: unsaved draft could not be saved (${err.message || 'save failed'}). Retained in editor to prevent data loss.`
        );
      },
      onNavigate: (targetRoute: RouteState) => loadRoute(targetRoute),
      parseRoute: (p: string, s: string) => parseRoute(p, s),
      isLeavingEditor: (targetRoute: RouteState) => {
        return !!(
          currentRulesetRef.current &&
          ((targetRoute.type !== 'editor' && targetRoute.type !== 'versions') ||
            (targetRoute as any).ruleId !== currentRulesetRef.current.id)
        );
      },
    });
  }

  // Guarded in-app navigation with pending draft flush
  const navigateTo = useCallback(
    async (targetRoute: RouteState, replace = false) => {
      const currentUrl = window.location.pathname + window.location.search;
      const targetUrl = buildRouteUrl(targetRoute);
      if (currentUrl === targetUrl) return;

      return historyControllerRef.current.navigateTo(targetRoute, targetUrl, replace);
    },
    []
  );

  // Guarded PopState (Browser Back / Forward)
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      historyControllerRef.current.handlePopState(
        event.state,
        window.location.pathname,
        window.location.search
      );
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Handle panel changes without losing draft or reloading editor
  const handleInspectorTabChange = (tab: PanelType) => {
    setInspectorTab(tab);
    if (routeRef.current.type === 'editor' && currentProjectRef.current && currentRulesetRef.current) {
      const updatedRoute: RouteState = {
        type: 'editor',
        projectId: currentProjectRef.current.id,
        ruleId: currentRulesetRef.current.id,
        panel: tab,
      };
      const targetUrl = buildRouteUrl(updatedRoute);
      historyControllerRef.current.replaceUrl(targetUrl);
      setRoute(updatedRoute);
    }
  };

  // Update Graph with History Snapshot
  const handleUpdateGraph = (updatedGraph: RuleGraph, reason?: string) => {
    saveSnapshot(historyRef.current, graphRef.current, reason);
    graphRef.current = updatedGraph;
    setGraph(updatedGraph);
    updateUndoRedoState();
    scheduleAutosave();
  };

  // Undo
  const handleUndo = () => {
    const prev = restoreSnapshot(historyRef.current, graphRef.current, 'undo');
    if (prev) {
      graphRef.current = prev;
      setGraph(prev);
      updateUndoRedoState();
      scheduleAutosave();
      toast.info('Undo applied');
    }
  };

  // Redo
  const handleRedo = () => {
    const next = restoreSnapshot(historyRef.current, graphRef.current, 'redo');
    if (next) {
      graphRef.current = next;
      setGraph(next);
      updateUndoRedoState();
      scheduleAutosave();
      toast.info('Redo applied');
    }
  };

  // Global Keyboard shortcuts for Undo (Ctrl+Z) and Redo (Ctrl+Y / Ctrl+Shift+Z)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.getAttribute('contenteditable') === 'true' ||
          activeEl.getAttribute('role') === 'textbox')
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          handleRedo();
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Add node
  const handleAddNode = (type: 'condition' | 'group' | 'outcome') => {
    const id = `${type}_${Date.now()}`;
    const defaultField = graphRef.current.schema[0];
    const newNode: RuleNode = {
      id,
      type,
      x: 100 + (graphRef.current.nodes.length % 5) * 40,
      y: 120 + (graphRef.current.nodes.length % 5) * 40,
      label: type === 'outcome' ? 'Approved' : undefined,
      fieldId: type === 'condition' ? defaultField?.id : undefined,
      operator: type === 'group' ? 'and' : 'eq',
      value: defaultField?.type === 'number' ? 0 : '',
      terms: type === 'group' ? [] : undefined,
      result: type === 'outcome' ? { status: 'approved' } : undefined,
    };
    handleUpdateGraph(
      { ...graphRef.current, nodes: [...graphRef.current.nodes, newNode] },
      'add-node'
    );
    setSelectedNodeId(id);
    setIsInspectorCollapsed(false);
    handleInspectorTabChange('properties');
  };

  // Delete selected node with confirmation and undo preservation
  const handleDeleteSelectedNode = (nodeIds: string[]) => {
    const selected = new Set(nodeIds);
    const removable = new Set(graphRef.current.nodes.filter((node) => selected.has(node.id) && node.type !== 'start').map((node) => node.id));
    if (!removable.size) return;
    const filteredNodes = graphRef.current.nodes.filter((n) => !removable.has(n.id));
    const filteredEdges = graphRef.current.edges.filter((e) => !removable.has(e.from) && !removable.has(e.to));
    handleUpdateGraph(
      { ...graphRef.current, nodes: filteredNodes, edges: filteredEdges },
      'delete-node'
    );
    setSelectedNodeId(null);
    toast.info(`${removable.size === 1 ? 'Node' : 'Nodes'} deleted (Undo available)`);
  };

  // Update selected node
  const handleUpdateNode = (updatedNode: RuleNode) => {
    const updatedNodes = graphRef.current.nodes.map((n) =>
      n.id === updatedNode.id ? updatedNode : n
    );
    handleUpdateGraph({ ...graphRef.current, nodes: updatedNodes }, 'update-node');
  };

  // Update schema
  const handleUpdateSchema = (updatedSchema: SchemaField[]) => {
    handleUpdateGraph({ ...graphRef.current, schema: updatedSchema }, 'update-schema');
  };

  // Validate graph
  const handleValidateGraph = async () => {
    if (!currentRulesetRef.current) return;
    try {
      const res = await api.validateGraph(currentRulesetRef.current.id, graphRef.current);
      setValidationResult(res);
      if (res.valid) {
        toast.success('Ruleset graph is valid! Ready for deterministic evaluation.');
      } else {
        toast.error(`Validation found ${res.errors.length} issue(s). See error details below.`);
      }
    } catch (err: any) {
      toast.error(`Validation error: ${err.message}`);
    }
  };

  // Save immutable version (must flush latest pending draft first and use returned revision)
  const handleSaveVersion = async () => {
    const ruleset = currentRulesetRef.current;
    if (!ruleset) return;

    try {
      let targetRevision = activeRevisionRef.current;

      // If dirty or in-flight save is active, flush draft save first
      if (isDirtyRef.current || coordinatorRef.current?.inFlightPromise) {
        const flushRes = await flushPendingDraft();
        targetRevision = flushRes.revision;
      }

      const res = await api.createVersion(ruleset.id, targetRevision);
      toast.success(
        `Version ${res.version.versionNumber} saved`
      );
      const vList = await api.getVersions(ruleset.id);
      setVersionHistoryList(vList.versions);
    } catch (err: any) {
      toast.error(`Could not save version: ${err.message}`);
    }
  };

  // Open versions modal via URL route, recording the opener route state
  const handleOpenVersions = (rulesetId?: string) => {
    const targetId = rulesetId || currentRulesetRef.current?.id;
    const pId = currentProjectRef.current?.id;
    if (targetId && pId) {
      if (routeRef.current.type === 'editor' && currentRulesetRef.current) {
        returnRouteRef.current = {
          type: 'editor',
          projectId: pId,
          ruleId: currentRulesetRef.current.id,
          panel: inspectorTab,
        };
      } else if (routeRef.current.type === 'project') {
        returnRouteRef.current = {
          type: 'project',
          projectId: pId,
        };
      }
      navigateTo({ type: 'versions', projectId: pId, ruleId: targetId });
    }
  };

  // Open audit modal
  const handleOpenAudit = async () => {
    const project = currentProjectRef.current;
    if (!project) return;
    try {
      const res = await api.getAudit(project.id);
      setAuditList(res.events || []);
      setIsAuditOpen(true);
    } catch (err: any) {
      toast.error(`Failed to fetch audit log: ${err.message}`);
    }
  };

  // Run test evaluation: flushes pending draft first so engine evaluates the active graph!
  const handleRunTest = async (inputs: Record<string, any>): Promise<EvaluationResult> => {
    const ruleset = currentRulesetRef.current;
    if (!ruleset) {
      throw new Error('No ruleset open');
    }

    if (isDirtyRef.current || coordinatorRef.current?.inFlightPromise) {
      try {
        await flushPendingDraft();
      } catch (err: any) {
        throw new Error(
          `Cannot run test: pending draft edits could not be saved (${err.message || 'save failed'}).`
        );
      }
    }

    const generation = editGenerationRef.current;
    const result = await api.evaluateGraph(ruleset.id, inputs, activeRevisionRef.current);
    if (currentRulesetRef.current?.id !== ruleset.id || editGenerationRef.current !== generation) {
      throw new Error('The draft changed during the test. Run it again to see the current result.');
    }
    return result;
  };

  const handleStartGuidedExample = async () => {
    if (isStartingGuidedExampleRef.current) return;
    isStartingGuidedExampleRef.current = true;
    setIsStartingGuidedExample(true);
    try {
      const { project, ruleset } = await api.createGuidedExample();
      setGuidedExampleRulesetId(ruleset.id);
      await loadProjects();
      await navigateTo({ type: 'editor', projectId: project.id, ruleId: ruleset.id, panel: 'test' });
    } catch (err: any) {
      toast.error(`Could not start the guided example: ${err.message || 'request failed'}`);
    } finally {
      isStartingGuidedExampleRef.current = false;
      setIsStartingGuidedExample(false);
    }
  };

  // Conflict Copy Download handler
  const handleDownloadConflictDraft = () => {
    const ruleset = currentRulesetRef.current;
    if (!ruleset) return;

    const json = serializeConflictCopy({
      rulesetId: ruleset.id,
      name: ruleset.name,
      expectedRevision: activeRevisionRef.current,
      graph: graphRef.current,
    });

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conflict-${ruleset.name.toLowerCase().replace(/\s+/g, '-')}-rev${activeRevisionRef.current}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.info('Conflict draft downloaded for manual recovery.');
  };

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) || null;

  if (isHome) {
    return (
      <DirectionProvider locale="en-US">
        <PublicHomePage onOpenWorkspace={() => window.location.assign('/projects')} />
      </DirectionProvider>
    );
  }

  return (
    <DirectionProvider locale="en-US">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background-full text-text-primary antialiased">
        {/* Top App Bar */}
        <TopNav
          view={view}
          releaseManagementAvailable={releaseManagementAvailable === true}
          projectName={currentProject?.name}
          rulesetName={currentRuleset?.name}
          activeRevision={activeRevision}
          isDirty={isDirty}
          saveState={saveState}
          canUndo={canUndo}
          canRedo={canRedo}
          onNavigateDashboard={() => navigateTo({ type: 'projects' })}
          onNavigateHome={view === 'dashboard' ? () => navigateTo({ type: 'home' }) : undefined}
          onOpenTeam={teamManagementAvailable && route.type === 'projects' ? () => navigateTo({ type: 'team' }) : undefined}
          onNavigateProject={() =>
            currentProject && navigateTo({ type: 'project', projectId: currentProject.id })
          }
          onOpenReleases={() => currentProject && currentRuleset && navigateTo({
            type: 'releases', projectId: currentProject.id, ruleId: currentRuleset.id,
          })}
          onOpenActivity={handleOpenAudit}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onValidate={handleValidateGraph}
          onSaveVersion={handleSaveVersion}
          onSaveDraft={async () => {
            try {
              const res = await flushPendingDraft();
              toast.success(`Draft saved (Rev ${res.revision})`);
            } catch (err: any) {
              toast.error(`Save draft failed: ${err.message}`);
            }
          }}
          onOpenVersions={() => handleOpenVersions()}
          onDownloadConflict={handleDownloadConflictDraft}
          onRetrySave={async () => {
            try {
              const res = await flushPendingDraft();
              toast.success(`Retry succeeded! Draft saved (Rev ${res.revision})`);
            } catch (err: any) {
              toast.error(`Retry failed: ${err.message}`);
            }
          }}
        />

        {/* Main Work Area */}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* Recovery Screens for Missing Project / Rule / Mismatch / Network */}
          {recoveryState ? (
            <RecoveryView
              state={recoveryState}
              onNavigateProjects={() => navigateTo({ type: 'projects' })}
              onNavigateProject={(pId) => navigateTo({ type: 'project', projectId: pId })}
              onNavigateRule={(pId, rId) =>
                navigateTo({ type: 'editor', projectId: pId, ruleId: rId })
              }
            />
          ) : route.type === 'not_found' ? (
            <RecoveryView
              state={{ type: 'not_found', path: route.path }}
              onNavigateProjects={() => navigateTo({ type: 'projects' })}
              onNavigateProject={(pId) => navigateTo({ type: 'project', projectId: pId })}
              onNavigateRule={(pId, rId) =>
                navigateTo({ type: 'editor', projectId: pId, ruleId: rId })
              }
            />
          ) : (
            <>
              {/* Dashboard View */}
              {route.type === 'projects' && (loadingProjects ? (
                <div role="status" className="mx-auto py-10 text-body-regular text-text-secondary">Loading projects…</div>
              ) : (
                <div className="h-full w-full overflow-y-auto">
                  <DashboardView
                    projects={projects}
                    onSelectProject={(pId) => navigateTo({ type: 'project', projectId: pId })}
                    onNewProject={() => setIsCreateProjectOpen(true)}
                    onTryExample={handleStartGuidedExample}
                    isTryingExample={isStartingGuidedExample}
                  />
                </div>
              ))}

              {route.type === 'team' && (
                <div className="h-full w-full overflow-y-auto">
                  {teamManagementAvailable === true ? (
                    <TeamSettingsView onBack={() => navigateTo({ type: 'projects' })} />
                  ) : teamManagementAvailable === null ? (
                    <p role="status" className="p-6 text-body-regular text-text-secondary">Checking team access…</p>
                  ) : (
                    <main className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-10 sm:px-6">
                      <h1 className="text-title-1-semibold text-text-primary">Team settings unavailable</h1>
                      <p className="text-body-regular text-text-secondary">Team settings require an administrator in a hosted workspace with team management enabled.</p>
                      <Button variant="secondary" size="medium" onClick={() => navigateTo({ type: 'projects' })}>Return to Projects</Button>
                    </main>
                  )}
                </div>
              )}

              {/* Project Overview View */}
              {(route.type === 'project' ||
                (route.type === 'versions' && returnRouteRef.current?.type === 'project')) &&
                currentProject && (
                  <div className="h-full w-full overflow-y-auto">
                    <ProjectOverviewView
                      project={currentProject}
                      onSelectRuleset={(rId) =>
                        navigateTo({
                          type: 'editor',
                          projectId: currentProject.id,
                          ruleId: rId,
                        })
                      }
                      onOpenVersions={(rId) => {
                        returnRouteRef.current = {
                          type: 'project',
                          projectId: currentProject.id,
                        };
                        navigateTo({
                          type: 'versions',
                          projectId: currentProject.id,
                          ruleId: rId,
                        });
                      }}
                      onOpenRuns={() => navigateTo({ type: 'runs', projectId: currentProject.id })}
                      onNewRuleset={() => setIsCreateRulesetOpen(true)}
                    />
                  </div>
                )}

              {(route.type === 'runs' || (route.type === 'versions' && returnRouteRef.current?.type === 'runs')) && currentProject && (
                <div className="h-full w-full overflow-y-auto">
                  <RunsView
                    project={currentProject}
                  onOpenVersion={(rId, versionId) => {
                    returnRouteRef.current = { type: 'runs', projectId: currentProject.id };
                    navigateTo({ type: 'versions', projectId: currentProject.id, ruleId: rId, versionId });
                  }}
                  />
                </div>
              )}

              {/* Editor Workspace View */}
              {route.type === 'releases' && currentProject && currentRuleset && (
                <div className="h-full w-full overflow-y-auto">
                  <ReleasesView
                    project={currentProject}
                    ruleset={currentRuleset}
                    isAvailable={releaseManagementAvailable}
                    onBackToEditor={() => navigateTo({ type: 'editor', projectId: currentProject.id, ruleId: currentRuleset.id })}
                  />
                </div>
              )}

              {(route.type === 'editor' ||
                (route.type === 'versions' && returnRouteRef.current?.type !== 'project' && returnRouteRef.current?.type !== 'runs')) &&
                currentRuleset && (
                <ResizablePanelGroup orientation="horizontal" className="h-full w-full overflow-hidden">
                  <ResizablePanel id="rule-canvas" defaultSize={isMobileViewport ? '100' : '68'} minSize={isMobileViewport ? 0 : 420} className="relative min-w-0">
                    {/* Canvas Area */}
                    <div className="relative h-full w-full overflow-hidden">
                    <GraphCanvas
                      key={currentRuleset?.id}
                      graph={graph}
                      selectedNodeId={selectedNodeId}
                      activeTraceNodeId={activeTraceNodeId}
                      canUndo={canUndo}
                      canRedo={canRedo}
                      onUndo={handleUndo}
                      onRedo={handleRedo}
                      onSelectNode={(id) => {
                        setSelectedNodeId(id);
                        if (id) {
                          handleInspectorTabChange('properties');
                          setIsInspectorCollapsed(false);
                        }
                      }}
                      onUpdateGraph={handleUpdateGraph}
                      onAddNode={handleAddNode}
                      onDeleteSelectedNode={handleDeleteSelectedNode}
                    />

                    {/* Validation Errors Overlay Card */}
                    {validationResult && !validationResult.valid && (
                      <div className="absolute start-4 bottom-16 z-20 max-w-lg rounded-2xl border border-status-rose-text/30 bg-background-primary-default p-4 shadow-xl">
                        <div className="flex items-center justify-between border-b border-separator-border pb-2">
                          <div className="flex items-center gap-2">
                            <RiAlertLine className="h-5 w-5 text-status-rose-text" />
                            <span className="text-body-2-bold text-text-primary">
                              Validation Issues ({validationResult.errors.length})
                            </span>
                          </div>
                          <IconButton
                            size="small"
                            icon={RiCloseLine}
                            aria-label="Dismiss errors"
                            onClick={() => setValidationResult(null)}
                          />
                        </div>
                        <div className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto pe-1">
                          {validationResult.errors.map((err, idx) => (
                            <div
                              key={idx}
                              className="flex items-start justify-between gap-2 rounded-xl bg-background-secondary-default p-2 text-caption-1-regular"
                            >
                              <div className="flex flex-col">
                                <span className="font-mono font-semibold text-text-error-primary">
                                  {err.code}
                                </span>
                                <span className="text-text-secondary">{err.message}</span>
                              </div>
                              {err.nodeId && (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  leadingIcon={RiFocus3Line}
                                  onClick={() => {
                                    setSelectedNodeId(err.nodeId!);
                                    handleInspectorTabChange('properties');
                                    setIsInspectorCollapsed(false);
                                  }}
                                >
                                  Select
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mobile tools trigger button (screens < 768px) */}
                    <div className="absolute bottom-4 start-4 z-10 md:hidden">
                      <Button
                        variant="primary"
                        size="medium"
                        leadingIcon={RiEqualizerLine}
                        onClick={() => setIsMobileDrawerOpen(true)}
                      >
                        Inspector
                      </Button>
                    </div>
                    {isInspectorCollapsed && (
                      <div className="absolute end-3 top-3 z-20">
                        <IconButton size="small" icon={RiLayoutRight2Line} aria-label="Expand inspector" onClick={() => setIsInspectorCollapsed(false)} />
                      </div>
                    )}
                    </div>
                  </ResizablePanel>
                  {!isMobileViewport && !isInspectorCollapsed && (
                    <>
                      <ResizableHandle withHandle aria-label="Resize inspector" className="z-10 bg-separator-border/60 hover:bg-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring" />
                      <ResizablePanel id="rule-inspector" defaultSize="32" minSize={280} maxSize={560} className="min-w-0 border-s border-border-button-default bg-background-primary-default">
                        <div className="flex h-full flex-col overflow-hidden">
                        {/* Header */}
                        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-separator-border px-3 py-2">
                          <SegmentedControl
                            aria-label="Inspector tabs"
                            selectedKeys={[inspectorTab]}
                            onSelectionChange={(keys) => {
                              const k = Array.from(keys)[0];
                              if (k) handleInspectorTabChange(k as PanelType);
                            }}
                          >
                            <SegmentedControlItem id="properties">
                              Properties
                            </SegmentedControlItem>
                            <SegmentedControlItem id="schema">
                              Schema ({graph.schema.length})
                            </SegmentedControlItem>
                            <SegmentedControlItem id="test">
                              Test Run
                            </SegmentedControlItem>
                          </SegmentedControl>

                          <IconButton
                            size="small"
                            icon={RiLayoutRightLine}
                            aria-label="Collapse inspector"
                            onClick={() => setIsInspectorCollapsed(true)}
                          />
                        </div>

                        {/* Scrollable Inspector Body */}
                        <div className="flex-1 overflow-y-auto p-3">
                          {inspectorTab === 'properties' &&
                            (selectedNode ? (
                              <NodeInspector
                                node={selectedNode}
                                schema={graph.schema}
                                onUpdateNode={handleUpdateNode}
                              />
                            ) : (
                              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-button-default p-8 text-center">
                                <p className="text-body-regular text-text-secondary">
                                  No node selected.
                                </p>
                                <p className="mt-1 text-caption-1-regular text-text-tertiary">
                                  Click any node on the graph canvas to inspect and configure it.
                                </p>
                              </div>
                            ))}

                          {inspectorTab === 'schema' && (
                            <SchemaEditor
                              schema={graph.schema}
                              onChange={handleUpdateSchema}
                            />
                          )}

                          {inspectorTab === 'test' && (
                            <TestRunner
                              key={currentRuleset.id}
                              schema={graph.schema}
                              onRunTest={handleRunTest}
                              scenarioRulesetId={currentRuleset.id}
                              scenarioOutcomes={graph.nodes.filter((node) => node.type === 'outcome').map((node) => ({ id: node.id, label: node.label || node.id }))}
                              onBeforeCreateScenario={flushPendingDraft}
                              onHighlightNode={(nodeId) => setActiveTraceNodeId(nodeId)}
                              initialInputValues={currentRuleset?.id === guidedExampleRulesetId ? eligibilityExampleInput : undefined}
                              guideText={currentRuleset?.id === guidedExampleRulesetId ? 'The example starts with score = 8. Run it to see the selected outcome, then step through the trace to follow each node.' : undefined}
                            />
                          )}
                        </div>
                        </div>
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              )}
            </>
          )}
        </div>

        {/* Mobile Drawer (BoardUI Drawer) */}
        <MobileInspectorDrawer
          isOpen={route.type === 'editor' && isMobileViewport && isMobileDrawerOpen}
          onClose={() => {
            setIsMobileDrawerOpen(false);
            const currentRoute = routeRef.current;
            if (currentRoute.type === 'editor' && currentRoute.panel) {
              const canvasRoute: RouteState = { ...currentRoute, panel: undefined };
              historyControllerRef.current.replaceUrl(buildRouteUrl(canvasRoute));
              setRoute(canvasRoute);
            }
          }}
          activeTab={inspectorTab}
          onChangeTab={handleInspectorTabChange}
          selectedNode={selectedNode}
          schema={graph.schema}
          onUpdateNode={handleUpdateNode}
          onUpdateSchema={handleUpdateSchema}
          onRunTest={handleRunTest}
          onHighlightNode={(nodeId) => setActiveTraceNodeId(nodeId)}
          initialInputValues={currentRuleset?.id === guidedExampleRulesetId ? eligibilityExampleInput : undefined}
          guideText={currentRuleset?.id === guidedExampleRulesetId ? 'The example starts with score = 8. Run it to see the selected outcome, then step through the trace to follow each node.' : undefined}
        />

        {/* Modals */}
        <CreateProjectModal
          isOpen={isCreateProjectOpen}
          onClose={() => setIsCreateProjectOpen(false)}
          onCreate={async (name) => {
            const res = await api.createProject(name);
            await loadProjects();
            navigateTo({ type: 'project', projectId: res.project.id });
            toast.success(`Project "${name}" created!`);
          }}
        />

        <CreateRulesetModal
          isOpen={isCreateRulesetOpen}
          onClose={() => setIsCreateRulesetOpen(false)}
          onCreate={async (name) => {
            if (!currentProjectRef.current) return;
            const res = await api.createRuleset(currentProjectRef.current.id, name);
            navigateTo({
              type: 'editor',
              projectId: currentProjectRef.current.id,
              ruleId: res.ruleset.id,
            });
            toast.success(`Rule set "${name}" created!`);
          }}
        />

        <VersionHistoryModal
          isOpen={isVersionHistoryOpen}
          rulesetId={versionModalRuleset?.id}
          rulesetName={versionModalRuleset?.name || 'Rule Set'}
          versions={versionHistoryList}
          initialVersionId={route.type === 'versions' ? route.versionId : undefined}
          onSelectVersionId={(vId) => {
            const pId = currentProject?.id || (route.type === 'versions' ? route.projectId : '');
            const rId =
              versionModalRuleset?.id || currentRuleset?.id || (route.type === 'versions' ? route.ruleId : '');
            if (pId && rId) {
              const verRoute: RouteState = {
                type: 'versions',
                projectId: pId,
                ruleId: rId,
                versionId: vId,
              };
              historyControllerRef.current.replaceUrl(buildRouteUrl(verRoute));
              setRoute(verRoute);
            }
          }}
          onClose={() => {
            setIsVersionHistoryOpen(false);
            const destination: RouteState = returnRouteRef.current || {
              type: 'editor',
              projectId: currentProject?.id || (route.type === 'versions' ? route.projectId : ''),
              ruleId:
                versionModalRuleset?.id || currentRuleset?.id || (route.type === 'versions' ? route.ruleId : ''),
              panel: inspectorTab,
            };
            returnRouteRef.current = null;
            navigateTo(destination);
          }}
          onInspectVersion={(vId) => {
            const targetId = versionModalRuleset?.id || currentRulesetRef.current?.id;
            if (!targetId) throw new Error('No ruleset specified for version inspection');
            return api.getVersion(targetId, vId).then((r) => r.version);
          }}
          onEvaluateVersion={(vId, input) => {
            const targetId = versionModalRuleset?.id || currentRulesetRef.current?.id;
            if (!targetId) throw new Error('No ruleset specified for version evaluation');
            return api.evaluateVersion(targetId, vId, input);
          }}
          onRestoreVersion={async (version) => {
            const projectId = currentProjectRef.current?.id;
            const rule = currentRulesetRef.current;
            if (!projectId || !rule || rule.id !== versionModalRuleset?.id || !versionHistoryList.some((item) => item.id === version.id)) {
              throw new Error('The selected snapshot is no longer open in this workspace.');
            }
            await flushPendingDraft();
            const verified = await api.getVersion(rule.id, version.id);
            if (verified.version.graphHash !== version.graphHash || currentRulesetRef.current?.id !== rule.id) {
              throw new Error('The rule set changed while preparing the draft.');
            }
            const destination: RouteState = { type: 'editor', projectId, ruleId: rule.id };
            const navigation = await navigateTo(destination);
            if (!navigation?.allowed || currentRulesetRef.current?.id !== rule.id) {
              throw new Error('The editor could not be opened. The draft was preserved.');
            }
            handleUpdateGraph(structuredClone(verified.version.graph), 'restore-version');
            setSelectedNodeId(null);
            setActiveTraceNodeId(null);
            setValidationResult(null);
            toast.success(`Version ${version.versionNumber} restored to draft. Undo is available.`);
          }}
        />

        <AuditModal
          isOpen={isAuditOpen}
          projectName={currentProject?.name || 'Current Project'}
          auditEvents={auditList}
          onClose={() => setIsAuditOpen(false)}
        />

        <ImportExportModal
          isOpen={isImportExportOpen}
          graph={graph}
          rulesetId={currentRuleset?.id || 'ruleset'}
          rulesetName={currentRuleset?.name || 'Rule Set'}
          revision={activeRevision}
          onClose={() => setIsImportExportOpen(false)}
          onValidateImport={(importedGraph) =>
            api.validateGraph(currentRuleset?.id || 'temp', importedGraph)
          }
          onImport={(importedGraph) => {
            handleUpdateGraph(importedGraph, 'import-graph');
            toast.success('Rule graph imported successfully!');
          }}
        />

        {/* RareUI Toaster Notification System */}
        <Toaster position="bottom-right" />
      </div>
    </DirectionProvider>
  );
}
export default App;
