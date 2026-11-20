import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { RuleGraph, RuleNode, RuleEdge } from '@/src/api';
import { wouldCreateCycle } from '@/public/graph-editing.js';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { AlertDialog } from '@/components/base/modal/modal';
import { Dropdown, DropdownItem, DropdownPopover, DropdownTrigger } from '@/components/base/dropdown/dropdown';
import {
  RiAddLine,
  RiZoomInLine,
  RiZoomOutLine,
  RiFocus3Line,
  RiDeleteBinLine,
  RiCheckboxCircleLine,
  RiQuestionMark,
  RiParenthesesLine,
  RiScissorsLine,
  RiCloseLine,
  RiLinkM,
  RiPlayCircleLine,
} from '@remixicon/react';
import { removeConnection } from '@/public/graph-editing';
import { cx } from '@/utils/cx';

interface GraphCanvasProps {
  graph: RuleGraph;
  selectedNodeId: string | null;
  activeTraceNodeId?: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onUpdateGraph: (updatedGraph: RuleGraph, reason?: string) => void;
  onAddNode: (type: 'condition' | 'group' | 'outcome') => void;
  onDeleteSelectedNode: (nodeIds: string[]) => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  graph,
  selectedNodeId,
  activeTraceNodeId,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSelectNode,
  onUpdateGraph,
  onAddNode,
  onDeleteSelectedNode,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialViewSet = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Multi-touch tracking for pinch-to-zoom
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);

  // Screen reader live announcement
  const [announcement, setAnnouncement] = useState<string>('');

  // Node drag state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const dragOrigins = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    setSelectedNodes((current) => selectedNodeId && current.includes(selectedNodeId) ? current : selectedNodeId ? [selectedNodeId] : []);
  }, [selectedNodeId]);

  // Connection state: click-to-connect source
  const [connectionSource, setConnectionSource] = useState<{
    nodeId: string;
    port: 'next' | 'true' | 'false';
  } | null>(null);

  // Connection dragging state (rubberband line)
  const [connectionDraft, setConnectionDraft] = useState<{
    sourceNodeId: string;
    sourcePort: 'next' | 'true' | 'false';
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Selected edge state
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [nodePendingDelete, setNodePendingDelete] = useState<{ ids: string[]; title: string } | null>(null);

  const NODE_WIDTH = 240;
  const NODE_HEIGHT = 120;

  // Calculate port positions
  const getOutputPortPos = useCallback(
    (node: RuleNode, port: 'next' | 'true' | 'false') => {
      const x = node.x + NODE_WIDTH;
      const y = port === 'false' ? node.y + 92 : node.y + 60;
      return { x, y };
    },
    [NODE_WIDTH]
  );

  const getInputPortPos = useCallback((node: RuleNode) => {
    return { x: node.x, y: node.y + 60 };
  }, []);

  const getNodeTitle = useCallback(
    (node: RuleNode) => {
      if (node.type === 'start') return 'Start';
      if (node.type === 'outcome') return node.label || 'Outcome';
      if (node.type === 'condition') {
        const field = graph.schema.find((f) => f.id === node.fieldId);
        return field ? field.name : 'Condition';
      }
      if (node.type === 'group') {
        return `Group (${(node.operator || 'AND').toUpperCase()})`;
      }
      return node.label || 'Node';
    },
    [graph.schema]
  );

  const getNodeSubtitle = useCallback(
    (node: RuleNode) => {
      if (node.type === 'start') return 'Flow starts here';
      if (node.type === 'outcome') {
        if (typeof node.result === 'object' && node.result?.status) {
          return `Status: ${String(node.result.status).toUpperCase()}`;
        }
        return 'Terminal outcome';
      }
      if (node.type === 'condition') {
        const field = graph.schema.find((f) => f.id === node.fieldId);
        const op = node.operator || '==';
        const val = node.value !== undefined ? String(node.value) : '…';
        return `${field?.name || 'field'} ${op} ${val}`;
      }
      if (node.type === 'group') {
        const count = Array.isArray(node.terms) ? node.terms.length : 0;
        return `${count} nested ${count === 1 ? 'term' : 'terms'}`;
      }
      return '';
    },
    [graph.schema]
  );

  // Generate cubic bezier curve path
  const getEdgePath = useCallback(
    (edge: RuleEdge) => {
      const fromNode = graph.nodes.find((n) => n.id === edge.from);
      const toNode = graph.nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) return '';

      const start = getOutputPortPos(fromNode, edge.fromPort);
      const end = getInputPortPos(toNode);

      const deltaX = Math.abs(end.x - start.x) * 0.5;
      const cp1x = start.x + Math.max(deltaX, 40);
      const cp1y = start.y;
      const cp2x = end.x - Math.max(deltaX, 40);
      const cp2y = end.y;

      return `M ${start.x} ${start.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${end.x} ${end.y}`;
    },
    [graph.nodes, getOutputPortPos, getInputPortPos]
  );

  // Remove connection with undo history preservation
  const handleDeleteEdge = useCallback((edgeId: string | null) => {
    if (!edgeId) return;
    const cloned = {
      ...graph,
      edges: [...graph.edges],
    };
    if (removeConnection(cloned, edgeId)) {
      onUpdateGraph(cloned, 'delete-connection');
      setSelectedEdgeId(null);
      setAnnouncement('Connection removed');
    }
  }, [graph, onUpdateGraph]);

  const handleDeleteSelectedEdge = useCallback(() => {
    handleDeleteEdge(selectedEdgeId);
  }, [handleDeleteEdge, selectedEdgeId]);

  const requestDeleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    const node = graph.nodes.find((item) => item.id === selectedNodeId);
    if (!node) return;
    const ids = selectedNodes.length ? selectedNodes : [node.id];
    const deletable = graph.nodes.filter((item) => ids.includes(item.id) && item.type !== 'start');
    if (!deletable.length) { setAnnouncement('The Start node cannot be deleted'); return; }
    setNodePendingDelete({ ids: deletable.map((item) => item.id), title: deletable.length === 1 ? getNodeTitle(deletable[0]) : `${deletable.length} selected nodes` });
  }, [selectedNodeId, selectedNodes, graph.nodes, getNodeTitle]);

  const confirmDeleteSelectedNode = useCallback(() => {
    if (!nodePendingDelete) return;
    if (nodePendingDelete.ids.every((id) => selectedNodes.includes(id) && graph.nodes.some((node) => node.id === id))) {
      onDeleteSelectedNode(nodePendingDelete.ids);
      setSelectedNodes([]);
      setAnnouncement(`${nodePendingDelete.title} deleted`);
    } else {
      setAnnouncement('Node selection changed; nothing was deleted');
    }
    setNodePendingDelete(null);
  }, [nodePendingDelete, selectedNodes, graph.nodes, onDeleteSelectedNode]);

  // Complete connection between source port and target input port
  const completeConnection = useCallback(
    (
      fromNodeId: string,
      fromPort: 'next' | 'true' | 'false',
      toNodeId: string
    ) => {
      if (fromNodeId === toNodeId) {
        setConnectionSource(null);
        setConnectionDraft(null);
        return;
      }

      const fromNode = graph.nodes.find((n) => n.id === fromNodeId);
      const toNode = graph.nodes.find((n) => n.id === toNodeId);
      const fromTitle = fromNode ? getNodeTitle(fromNode) : 'node';
      const toTitle = toNode ? getNodeTitle(toNode) : 'node';

      // Filter out existing edge with the same source port
      const filteredEdges = graph.edges.filter(
        (edge) => !(edge.from === fromNodeId && edge.fromPort === fromPort)
      );

      if (wouldCreateCycle(filteredEdges, fromNodeId, toNodeId)) {
        setConnectionSource(null);
        setConnectionDraft(null);
        setAnnouncement('Connection rejected because it would create a cycle.');
        return;
      }

      const newEdge: RuleEdge = {
        id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        from: fromNodeId,
        fromPort: fromPort,
        to: toNodeId,
        toPort: 'in',
      };

      onUpdateGraph({ ...graph, edges: [...filteredEdges, newEdge] }, 'add-connection');
      setConnectionSource(null);
      setConnectionDraft(null);
      setAnnouncement(`Connected ${fromTitle} (${fromPort}) to ${toTitle}`);
    },
    [graph, getNodeTitle, onUpdateGraph]
  );

  // Auto-center active trace node if it is offscreen
  useEffect(() => {
    if (!activeTraceNodeId) return;
    const activeNode = graph.nodes.find((n) => n.id === activeTraceNodeId);
    if (!activeNode || !containerRef.current) return;

    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;

    const screenNodeW = NODE_WIDTH * zoom;
    const screenNodeH = NODE_HEIGHT * zoom;

    setPan((current) => {
      const screenX = activeNode.x * zoom + current.x;
      const screenY = activeNode.y * zoom + current.y;
      const isOffscreen =
        screenX < 30 ||
        screenY < 30 ||
        screenX + screenNodeW > containerWidth - 30 ||
        screenY + screenNodeH > containerHeight - 30;

      return isOffscreen ? {
        x: Math.round(containerWidth / 2 - (activeNode.x + NODE_WIDTH / 2) * zoom),
        y: Math.round(containerHeight / 2 - (activeNode.y + NODE_HEIGHT / 2) * zoom),
      } : current;
    });
  }, [activeTraceNodeId, graph.nodes, zoom, NODE_WIDTH, NODE_HEIGHT]);

  // Reset view to fit all nodes
  const handleFitView = useCallback(() => {
    if (graph.nodes.length === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const minX = Math.min(...graph.nodes.map((n) => n.x));
    const maxX = Math.max(...graph.nodes.map((n) => n.x + NODE_WIDTH));
    const minY = Math.min(...graph.nodes.map((n) => n.y));
    const maxY = Math.max(...graph.nodes.map((n) => n.y + NODE_HEIGHT));

    const isNarrowViewport = window.matchMedia('(max-width: 767px)').matches;
    const containerWidth = isNarrowViewport ? window.innerWidth : (containerRef.current?.clientWidth || 800);
    const containerHeight = containerRef.current?.clientHeight || 600;
    const padding = containerWidth < 500 ? 24 : 80;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;

    const newZoom = Math.min(1.2, Math.max(0.4, Math.min(containerWidth / width, containerHeight / height)));
    setZoom(Number(newZoom.toFixed(2)));
    setPan({
      x: Math.round((containerWidth - width * newZoom) / 2 - (minX - padding) * newZoom),
      y: Math.round((containerHeight - height * newZoom) / 2 - (minY - padding) * newZoom),
    });
    setAnnouncement('View reset to fit all nodes');
  }, [graph.nodes, NODE_WIDTH, NODE_HEIGHT]);

  useEffect(() => {
    if (initialViewSet.current || !graph.nodes.length) return;
    initialViewSet.current = true;
    if (window.matchMedia('(max-width: 767px)').matches) handleFitView();
  }, [graph.nodes.length, handleFitView]);

  // Keyboard navigation & shortcuts (Move node, Pan canvas, Delete, Backspace, Escape, Undo, Redo, Zoom)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (nodePendingDelete) return;
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
            onRedo?.();
          } else {
            onUndo?.();
          }
          return;
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          onRedo?.();
          return;
        }
      }

      // Keyboard node movement with arrow keys (10px, or 40px with Shift)
      if (selectedNodeId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 40 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const moving = graph.nodes.filter((node) => selectedNodes.includes(node.id));
        const safeDx = Math.max(dx, 20 - Math.min(...moving.map((node) => node.x)));
        const safeDy = Math.max(dy, 20 - Math.min(...moving.map((node) => node.y)));
        const updatedNodes = graph.nodes.map((n) => {
          if (selectedNodes.includes(n.id)) {
            return {
              ...n,
              x: n.x + safeDx,
              y: n.y + safeDy,
            };
          }
          return n;
        });
        onUpdateGraph({ ...graph, nodes: updatedNodes }, 'drag-node');
        return;
      }

      // Keyboard canvas pan with arrow keys when no node or edge is selected
      if (!selectedNodeId && !selectedEdgeId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const panStep = e.shiftKey ? 60 : 20;
        setPan((p) => ({
          x: e.key === 'ArrowLeft' ? p.x + panStep : e.key === 'ArrowRight' ? p.x - panStep : p.x,
          y: e.key === 'ArrowUp' ? p.y + panStep : e.key === 'ArrowDown' ? p.y - panStep : p.y,
        }));
        return;
      }

      // Zoom via keyboard (+, -, 0/f)
      if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setZoom((z) => Math.min(2.0, Number((z + 0.15).toFixed(2))));
        return;
      } else if ((e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setZoom((z) => Math.max(0.3, Number((z - 0.15).toFixed(2))));
        return;
      } else if ((e.key === '0' || e.key.toLowerCase() === 'f') && !e.ctrlKey && !e.metaKey && !selectedNodeId) {
        e.preventDefault();
        handleFitView();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          e.preventDefault();
          requestDeleteSelectedNode();
        } else if (selectedEdgeId) {
          e.preventDefault();
          handleDeleteSelectedEdge();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onSelectNode(null);
        setSelectedEdgeId(null);
        setConnectionSource(null);
        setConnectionDraft(null);
        setAnnouncement('Selection and connection cancelled');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedNodeId,
    selectedNodes,
    selectedEdgeId,
    graph,
    onDeleteSelectedNode,
    requestDeleteSelectedNode,
    nodePendingDelete,
    handleDeleteSelectedEdge,
    onSelectNode,
    onUpdateGraph,
    onUndo,
    onRedo,
    handleFitView,
  ]);

  // Pointer event handlers for panning, dragging & pinch-to-zoom (mouse + touch)
  const handlePointerDownCanvas = (e: React.PointerEvent<SVGSVGElement>) => {
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Handle 2-finger pinch start
    if (activePointersRef.current.size === 2) {
      const points = Array.from(activePointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      pinchStartZoomRef.current = zoom;
      setIsPanning(false);
      return;
    }

    if ((e.target as HTMLElement).tagName === 'svg' || (e.target as HTMLElement).id === 'canvas-bg') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      onSelectNode(null);
      setSelectedEdgeId(null);
      setConnectionSource(null);
      setConnectionDraft(null);
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // pointer capture fallback
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Handle active 2-finger pinch-to-zoom
    if (activePointersRef.current.size === 2 && pinchStartDistRef.current) {
      const points = Array.from(activePointersRef.current.values());
      const currentDist = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const scale = currentDist / pinchStartDistRef.current;
      const newZoom = Math.min(2.0, Math.max(0.3, pinchStartZoomRef.current * scale));
      setZoom(Number(newZoom.toFixed(2)));
      return;
    }

    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    if (draggingNodeId) {
      const svgRect = containerRef.current?.getBoundingClientRect();
      if (!svgRect) return;

      const pointerX = (e.clientX - svgRect.left - pan.x) / zoom;
      const pointerY = (e.clientY - svgRect.top - pan.y) / zoom;

      const anchor = dragOrigins.current.get(draggingNodeId);
      if (!anchor) return;
      const origins = [...dragOrigins.current.values()];
      const dx = Math.max(Math.round(pointerX - dragOffset.x - anchor.x), 20 - Math.min(...origins.map((item) => item.x)));
      const dy = Math.max(Math.round(pointerY - dragOffset.y - anchor.y), 20 - Math.min(...origins.map((item) => item.y)));
      const newNodes = graph.nodes.map((n) => {
        const origin = dragOrigins.current.get(n.id);
        if (origin) {
          return {
            ...n,
            x: origin.x + dx,
            y: origin.y + dy,
          };
        }
        return n;
      });

      onUpdateGraph({ ...graph, nodes: newNodes }, 'drag-node');
      return;
    }

    if (connectionDraft) {
      const svgRect = containerRef.current?.getBoundingClientRect();
      if (!svgRect) return;

      const pointerX = (e.clientX - svgRect.left - pan.x) / zoom;
      const pointerY = (e.clientY - svgRect.top - pan.y) / zoom;

      setConnectionDraft((prev) =>
        prev
          ? {
              ...prev,
              currentX: pointerX,
              currentY: pointerY,
            }
          : null
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartDistRef.current = null;
    }

    setIsPanning(false);
    setDraggingNodeId(null);
    if (connectionDraft && !connectionSource) {
      setConnectionDraft(null);
    }
  };

  // Node drag start
  const handleNodePointerDown = (e: React.PointerEvent, node: RuleNode) => {
    e.stopPropagation();
    const isToggle = e.shiftKey;
    const next = isToggle ? (selectedNodes.includes(node.id) ? selectedNodes.filter((id) => id !== node.id) : [...selectedNodes, node.id]) : selectedNodes.includes(node.id) ? selectedNodes : [node.id];
    setSelectedNodes(next);
    onSelectNode(next.includes(node.id) ? node.id : next.at(-1) ?? null);
    setSelectedEdgeId(null);
    if (!next.includes(node.id)) return;
    dragOrigins.current = new Map(graph.nodes.filter((item) => next.includes(item.id)).map((item) => [item.id, { x: item.x, y: item.y }]));

    const svgRect = containerRef.current?.getBoundingClientRect();
    if (!svgRect) return;

    const pointerX = (e.clientX - svgRect.left - pan.x) / zoom;
    const pointerY = (e.clientY - svgRect.top - pan.y) / zoom;

    setDraggingNodeId(node.id);
    setDragOffset({
      x: pointerX - node.x,
      y: pointerY - node.y,
    });

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };

  // Port connect start via drag
  const handlePortPointerDown = (
    e: React.PointerEvent,
    node: RuleNode,
    port: 'next' | 'true' | 'false'
  ) => {
    e.stopPropagation();
    const pos = getOutputPortPos(node, port);
    setConnectionSource({ nodeId: node.id, port });
    setConnectionDraft({
      sourceNodeId: node.id,
      sourcePort: port,
      startX: pos.x,
      startY: pos.y,
      currentX: pos.x,
      currentY: pos.y,
    });
    setAnnouncement(`Connecting from ${getNodeTitle(node)} (${port}) port`);
  };

  // Port click (click-to-connect toggle)
  const handlePortClick = (
    e: React.MouseEvent,
    node: RuleNode,
    port: 'next' | 'true' | 'false'
  ) => {
    e.stopPropagation();
    if (connectionSource?.nodeId === node.id && connectionSource.port === port) {
      setConnectionSource(null);
      setConnectionDraft(null);
      setAnnouncement('Connection cancelled');
    } else {
      const pos = getOutputPortPos(node, port);
      setConnectionSource({ nodeId: node.id, port });
      setConnectionDraft({
        sourceNodeId: node.id,
        sourcePort: port,
        startX: pos.x,
        startY: pos.y,
        currentX: pos.x,
        currentY: pos.y,
      });
      setAnnouncement(`Connecting from ${getNodeTitle(node)} (${port}) port. Select destination input port.`);
    }
  };

  // Input port connect complete (via drag or click)
  const handleInputPortPointerUp = (e: React.PointerEvent, targetNode: RuleNode) => {
    e.stopPropagation();
    const source = connectionDraft || connectionSource;
    if (!source) return;

    const fromNodeId = 'sourceNodeId' in source ? source.sourceNodeId : source.nodeId;
    const fromPort = 'sourcePort' in source ? source.sourcePort : source.port;

    if (fromNodeId === targetNode.id) {
      setConnectionDraft(null);
      setConnectionSource(null);
      return;
    }

    completeConnection(fromNodeId, fromPort, targetNode.id);
  };

  const handleInputPortClick = (e: React.MouseEvent, targetNode: RuleNode) => {
    e.stopPropagation();
    if (!connectionSource) return;
    completeConnection(connectionSource.nodeId, connectionSource.port, targetNode.id);
  };

  const connectingSourceNode = connectionSource
    ? graph.nodes.find((n) => n.id === connectionSource.nodeId)
    : null;

  return (
    <div
      ref={containerRef}
      style={{ touchAction: 'none' }}
      className="relative flex h-full w-full select-none flex-col overflow-hidden bg-background-full"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Screen reader ARIA live region */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* Top Contextual graph tools & Quick Add actions */}
      <div className="absolute top-3 start-3 z-10 flex max-w-[calc(100vw-24px)] flex-wrap items-center gap-1.5 rounded-2xl border border-border-button-default bg-background-primary-default/95 p-1.5 shadow-sm backdrop-blur-md">
        {/* Dropdown for Add Node */}
        <Dropdown isOpen={isAddMenuOpen} onOpenChange={setIsAddMenuOpen}>
          <DropdownTrigger
            aria-label="Add to canvas"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default bg-background-secondary-default px-2.5 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
          >
            <RiAddLine aria-hidden="true" className="h-4 w-4" />
            <span>Add Node</span>
          </DropdownTrigger>
          <DropdownPopover aria-label="Add graph node" className="w-52">
            <DropdownItem
              onSelect={() => {
                onAddNode('condition');
                setIsAddMenuOpen(false);
              }}
            >
              <RiQuestionMark aria-hidden="true" className="h-4 w-4 text-foreground-icon-secondary" />
              <span>Condition</span>
            </DropdownItem>
            <DropdownItem
              onSelect={() => {
                onAddNode('group');
                setIsAddMenuOpen(false);
              }}
            >
              <RiParenthesesLine aria-hidden="true" className="h-4 w-4 text-foreground-icon-secondary" />
              <span>Group</span>
            </DropdownItem>
            <DropdownItem
              onSelect={() => {
                onAddNode('outcome');
                setIsAddMenuOpen(false);
              }}
            >
              <RiCheckboxCircleLine aria-hidden="true" className="h-4 w-4 text-foreground-icon-secondary" />
              <span>Outcome</span>
            </DropdownItem>
          </DropdownPopover>
        </Dropdown>

        {/* Direct quick action buttons for automated testing and rapid editing */}
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiQuestionMark}
          onClick={() => onAddNode('condition')}
        >
          Add Condition
        </Button>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiParenthesesLine}
          onClick={() => onAddNode('group')}
          className="hidden sm:inline-flex"
        >
          Add Group
        </Button>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiCheckboxCircleLine}
          onClick={() => onAddNode('outcome')}
          className="hidden md:inline-flex"
        >
          Add Outcome
        </Button>

        {selectedNodeId && (
          <div className="flex items-center gap-1 border-s border-separator-border ps-1.5">
            <Button
              variant="danger"
              size="small"
              leadingIcon={RiDeleteBinLine}
              onClick={requestDeleteSelectedNode}
            >
              Delete Node
            </Button>
          </div>
        )}

        {selectedEdgeId && (
          <div className="flex items-center gap-1 border-s border-separator-border ps-1.5">
            <Button
              variant="secondary"
              size="small"
              leadingIcon={RiScissorsLine}
              onClick={handleDeleteSelectedEdge}
            >
              Remove Link
            </Button>
          </div>
        )}
      </div>

      {/* Floating Active Connection Banner */}
      {connectionSource && (
        <div className="absolute top-16 start-3 z-10 flex max-w-[calc(100vw-32px)] items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-50/95 px-3 py-1.5 text-caption-1-medium text-emerald-900 shadow-md backdrop-blur-md dark:border-emerald-700/50 dark:bg-emerald-950/90 dark:text-emerald-100">
          <RiLinkM className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate">
            Connecting from <strong>{connectingSourceNode ? getNodeTitle(connectingSourceNode) : 'node'}</strong> ({connectionSource.port}) → Select input port (or press <strong>Esc</strong>)
          </span>
          <Button
            variant="ghost"
            size="xs"
            leadingIcon={RiCloseLine}
            onClick={() => {
              setConnectionSource(null);
              setConnectionDraft(null);
              setAnnouncement('Connection cancelled');
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Bottom Floating Canvas Controls (Zoom & Fit View) */}
      <div className="absolute bottom-4 end-4 z-10 flex items-center gap-1 rounded-2xl border border-border-button-default bg-background-primary-default/95 p-1.5 shadow-sm backdrop-blur-md">
        <IconButton
          size="small"
          icon={RiZoomOutLine}
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.3, Number((z - 0.15).toFixed(2))))}
        />
        <span className="min-w-12 text-center font-mono text-body-2-medium text-text-secondary">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton
          size="small"
          icon={RiZoomInLine}
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(2.0, Number((z + 0.15).toFixed(2))))}
        />
        <div className="mx-1 h-4 w-px bg-separator-border" />
        <IconButton
          size="small"
          icon={RiFocus3Line}
          aria-label="Fit view"
          onClick={handleFitView}
        />
      </div>

      {/* SVG Canvas */}
      <svg
        id="graph-canvas"
        style={{ touchAction: 'none' }}
        className="h-full w-full cursor-grab active:cursor-grabbing outline-none"
        tabIndex={0}
        aria-label="Decision Graph Canvas. Use arrow keys to navigate or pan, + and - to zoom, Enter to select."
        onPointerDown={handlePointerDownCanvas}
      >
        <defs>
          <pattern
            id="dot-grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1.5" cy="1.5" r="1" fill="#94a3b8" opacity="0.35" />
          </pattern>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
          <marker
            id="arrow-selected"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#059669" />
          </marker>
          <marker
            id="arrow-draft"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
          </marker>
          <marker
            id="arrow-trace"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
          </marker>
        </defs>

        {/* Background Dot Grid */}
        <rect
          id="canvas-bg"
          width="100%"
          height="100%"
          fill="url(#dot-grid)"
        />

        {/* Pan and Zoom Transformation Layer */}
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Render Connections (Edges) */}
          {graph.edges.map((edge) => {
            const isSelected = selectedEdgeId === edge.id;
            const path = getEdgePath(edge);
            if (!path) return null;

            const fromNode = graph.nodes.find((n) => n.id === edge.from);
            const toNode = graph.nodes.find((n) => n.id === edge.to);
            const fromTitle = fromNode ? getNodeTitle(fromNode) : 'node';
            const toTitle = toNode ? getNodeTitle(toNode) : 'node';

            const isEdgeInActiveTrace =
              activeTraceNodeId && (edge.from === activeTraceNodeId || edge.to === activeTraceNodeId);

            return (
              <g
                key={edge.id}
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-label={`Connection from ${fromTitle} to ${toTitle}; press Enter to select, Delete to remove`}
                className="group cursor-pointer outline-none focus-visible:outline-none"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelectedEdgeId(edge.id);
                  onSelectNode(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedEdgeId(edge.id);
                    onSelectNode(null);
                    setAnnouncement(`Selected connection from ${fromTitle} to ${toTitle}`);
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteEdge(edge.id);
                  }
                }}
              >
                {/* Thick invisible click/touch target */}
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="24"
                />

                {/* Selected or Active Trace glow halo */}
                {(isSelected || isEdgeInActiveTrace) && (
                  <path
                    d={path}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth={isSelected ? '8' : '6'}
                    strokeOpacity={isSelected ? '0.35' : '0.2'}
                    className={cx(isEdgeInActiveTrace && 'canvas-trace-halo')}
                  />
                )}

                {/* Visible Edge Path */}
                <path
                  d={path}
                  fill="none"
                  stroke={
                    isSelected
                      ? '#059669'
                      : isEdgeInActiveTrace
                      ? '#10b981'
                      : '#94a3b8'
                  }
                  strokeWidth={isSelected ? '2.8' : isEdgeInActiveTrace ? '2.4' : '1.8'}
                  markerEnd={
                    isSelected
                      ? 'url(#arrow-selected)'
                      : isEdgeInActiveTrace
                      ? 'url(#arrow-trace)'
                      : 'url(#arrow)'
                  }
                  className="transition-colors group-hover:stroke-emerald-600"
                />
              </g>
            );
          })}

          {/* Render Active Connection Draft Line (Rubberband) with Halo and Animated Dash */}
          {connectionDraft && (
            <g>
              {/* Backlight halo */}
              <path
                d={`M ${connectionDraft.startX} ${connectionDraft.startY} C ${
                  connectionDraft.startX + 60
                } ${connectionDraft.startY}, ${connectionDraft.currentX - 60} ${
                  connectionDraft.currentY
                }, ${connectionDraft.currentX} ${connectionDraft.currentY}`}
                fill="none"
                stroke="#10b981"
                strokeWidth="7"
                strokeOpacity="0.25"
              />
              {/* Animated foreground dash line */}
              <path
                d={`M ${connectionDraft.startX} ${connectionDraft.startY} C ${
                  connectionDraft.startX + 60
                } ${connectionDraft.startY}, ${connectionDraft.currentX - 60} ${
                  connectionDraft.currentY
                }, ${connectionDraft.currentX} ${connectionDraft.currentY}`}
                fill="none"
                stroke="#059669"
                strokeWidth="2.5"
                className="canvas-dash-draft"
                markerEnd="url(#arrow-draft)"
              />
            </g>
          )}

          {/* Render Nodes */}
          {graph.nodes.map((node) => {
            const isSelected = selectedNodes.includes(node.id);
            const isTraceActive = activeTraceNodeId === node.id;
            const nodeTitle = getNodeTitle(node);
            const nodeSubtitle = getNodeSubtitle(node);

            const isConnecting = Boolean(connectionDraft || connectionSource);
            const isCurrentSourceNode =
              connectionSource?.nodeId === node.id || connectionDraft?.sourceNodeId === node.id;

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                tabIndex={0}
                role="group"
                aria-label={`${node.type.toUpperCase()} node: ${nodeTitle}`}
                className="cursor-move outline-none focus-visible:outline-none"
                onPointerDown={(e) => handleNodePointerDown(e, node)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const next = e.shiftKey ? (selectedNodes.includes(node.id) ? selectedNodes.filter((id) => id !== node.id) : [...selectedNodes, node.id]) : [node.id];
                    setSelectedNodes(next);
                    onSelectNode(next.includes(node.id) ? node.id : next.at(-1) ?? null);
                    setSelectedEdgeId(null);
                    setAnnouncement(`${next.length} ${next.length === 1 ? 'node' : 'nodes'} selected`);
                  } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    e.stopPropagation();
                    requestDeleteSelectedNode();
                  }
                }}
              >
                {/* Active Trace Glowing Halo */}
                {isTraceActive && (
                  <rect
                    x="-6"
                    y="-6"
                    width={NODE_WIDTH + 12}
                    height={NODE_HEIGHT + 12}
                    rx="20"
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="2.5"
                    className="canvas-trace-halo"
                  />
                )}

                {/* Selected Node Halo */}
                {isSelected && !isTraceActive && (
                  <rect
                    x="-4"
                    y="-4"
                    width={NODE_WIDTH + 8}
                    height={NODE_HEIGHT + 8}
                    rx="18"
                    fill="none"
                    stroke="#059669"
                    strokeWidth="2"
                    strokeOpacity="0.4"
                  />
                )}

                {/* Node Card Background */}
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx="14"
                  fill="#ffffff"
                  stroke={
                    isTraceActive
                      ? '#10b981'
                      : isSelected
                      ? '#059669'
                      : '#e2e8f0'
                  }
                  strokeWidth={isTraceActive ? '3' : isSelected ? '2.5' : '1'}
                  className="shadow-sm transition-all hover:shadow-md"
                />

                {/* Node Header Pill Accent */}
                <rect
                  x="12"
                  y="12"
                  width="28"
                  height="28"
                  rx="8"
                  fill={
                    node.type === 'start'
                      ? '#e0e7ff'
                      : node.type === 'condition'
                      ? '#fef3c7'
                      : node.type === 'group'
                      ? '#ede9fe'
                      : '#dcfce7'
                  }
                />

                {/* Node Header Glyph */}
                <text
                  x="26"
                  y="31"
                  textAnchor="middle"
                  fontSize="13"
                  fontWeight="bold"
                  fill={
                    node.type === 'start'
                      ? '#4338ca'
                      : node.type === 'condition'
                      ? '#b45309'
                      : node.type === 'group'
                      ? '#6d28d9'
                      : '#15803d'
                  }
                >
                  {node.type === 'start'
                    ? '↗'
                    : node.type === 'condition'
                    ? '?'
                    : node.type === 'group'
                    ? node.operator === 'or'
                      ? '∨'
                      : '∧'
                    : '✓'}
                </text>

                {/* Node Type Label */}
                <text
                  x="48"
                  y="23"
                  fontSize="10"
                  fontWeight="600"
                  letterSpacing="0.05em"
                  fill="#64748b"
                >
                  {node.type.toUpperCase()}
                </text>

                {/* Node Title */}
                <text
                  x="48"
                  y="37"
                  fontSize="13"
                  fontWeight="600"
                  fill="#0f172a"
                >
                  {nodeTitle}
                </text>

                {/* Active Trace Step Badge */}
                {isTraceActive && (
                  <g transform={`translate(${NODE_WIDTH - 84}, 12)`}>
                    <rect
                      width="72"
                      height="20"
                      rx="6"
                      fill="#dcfce7"
                      stroke="#86efac"
                      strokeWidth="1"
                    />
                    <text
                      x="36"
                      y="14"
                      textAnchor="middle"
                      fontSize="9"
                      fontWeight="bold"
                      fill="#166534"
                    >
                      TRACE STEP
                    </text>
                  </g>
                )}

                {/* Divider Line */}
                <line
                  x1="12"
                  y1="50"
                  x2={NODE_WIDTH - 12}
                  y2="50"
                  stroke="#f1f5f9"
                  strokeWidth="1"
                />

                {/* Node Subtitle */}
                <text
                  x="14"
                  y="74"
                  fontSize="12"
                  fontWeight="500"
                  fill="#334155"
                >
                  {nodeSubtitle}
                </text>

                {/* ========================================================
                    INPUT PORT (all nodes except Start)
                   ======================================================== */}
                {node.type !== 'start' && (
                  <g className="group">
                    {/* Pulsing invitation target when connecting from an eligible other node */}
                    {isConnecting && !isCurrentSourceNode && (
                      <circle
                        cx="0"
                        cy="60"
                        r="12"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="2"
                        strokeDasharray="3 3"
                        className="canvas-target-invitation"
                      />
                    )}

                    {/* Visible Input Port Circle */}
                    <circle
                      cx="0"
                      cy="60"
                      r="7"
                      tabIndex={0}
                      role="button"
                      aria-label={`Connect into ${nodeTitle}`}
                      fill={isConnecting && !isCurrentSourceNode ? '#ecfdf5' : '#ffffff'}
                      stroke={
                        isConnecting && !isCurrentSourceNode
                          ? '#059669'
                          : isCurrentSourceNode
                          ? '#cbd5e1'
                          : '#64748b'
                      }
                      strokeWidth={isConnecting && !isCurrentSourceNode ? '2.5' : '2'}
                      opacity={isCurrentSourceNode ? '0.35' : '1'}
                      className={cx(
                        'cursor-crosshair transition-transform focus:outline-none focus:stroke-emerald-600',
                        !isCurrentSourceNode && 'hover:scale-125 hover:stroke-emerald-600'
                      )}
                      onPointerUp={(e) => handleInputPortPointerUp(e, node)}
                      onClick={(e) => handleInputPortClick(e, node)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (connectionSource) {
                            completeConnection(
                              connectionSource.nodeId,
                              connectionSource.port,
                              node.id
                            );
                          }
                        }
                      }}
                    />

                    {/* Large transparent touch hit target (WCAG AAA 40px touch zone) */}
                    <circle
                      cx="0"
                      cy="60"
                      r="20"
                      fill="transparent"
                      className="cursor-crosshair"
                      pointerEvents="all"
                      onPointerUp={(e) => handleInputPortPointerUp(e, node)}
                      onClick={(e) => handleInputPortClick(e, node)}
                    />
                  </g>
                )}

                {/* ========================================================
                    OUTPUT PORT: START (Next)
                   ======================================================== */}
                {node.type === 'start' && (
                  <g className="group cursor-crosshair">
                    {/* Animated ping ring when connection from this port is active */}
                    {connectionSource?.nodeId === node.id && connectionSource.port === 'next' && (
                      <circle
                        cx={NODE_WIDTH}
                        cy="60"
                        r="7"
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="2"
                        className="canvas-port-pulse"
                      />
                    )}

                    {/* Visible Port Circle */}
                    <circle
                      cx={NODE_WIDTH}
                      cy="60"
                      r="7"
                      tabIndex={0}
                      role="button"
                      aria-label="Connect from start"
                      fill={
                        connectionSource?.nodeId === node.id && connectionSource.port === 'next'
                          ? '#dcfce7'
                          : '#ffffff'
                      }
                      stroke={
                        connectionSource?.nodeId === node.id && connectionSource.port === 'next'
                          ? '#059669'
                          : '#4338ca'
                      }
                      strokeWidth="2.5"
                      className="transition-transform hover:scale-125 focus:outline-none focus:stroke-emerald-600"
                      onPointerDown={(e) => handlePortPointerDown(e, node, 'next')}
                      onClick={(e) => handlePortClick(e, node, 'next')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handlePortClick(e as any, node, 'next');
                        }
                      }}
                    />

                    {/* Large touch hit area */}
                    <circle
                      cx={NODE_WIDTH}
                      cy="60"
                      r="20"
                      fill="transparent"
                      pointerEvents="all"
                      onPointerDown={(e) => handlePortPointerDown(e, node, 'next')}
                      onClick={(e) => handlePortClick(e, node, 'next')}
                    />
                  </g>
                )}

                {/* ========================================================
                    OUTPUT PORTS: CONDITION & GROUP (True / False)
                   ======================================================== */}
                {(node.type === 'condition' || node.type === 'group') && (
                  <>
                    {/* TRUE (YES) PORT */}
                    <g className="cursor-crosshair group">
                      {connectionSource?.nodeId === node.id && connectionSource.port === 'true' && (
                        <circle
                          cx={NODE_WIDTH}
                          cy="60"
                          r="7"
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          className="canvas-port-pulse"
                        />
                      )}

                      <circle
                        cx={NODE_WIDTH}
                        cy="60"
                        r="7"
                        tabIndex={0}
                        role="button"
                        aria-label={`Connect true branch from ${nodeTitle}`}
                        fill={
                          connectionSource?.nodeId === node.id && connectionSource.port === 'true'
                            ? '#dcfce7'
                            : '#ffffff'
                        }
                        stroke={
                          connectionSource?.nodeId === node.id && connectionSource.port === 'true'
                            ? '#059669'
                            : '#16a34a'
                        }
                        strokeWidth="2.5"
                        className="transition-transform group-hover:scale-125 focus:outline-none focus:stroke-emerald-600"
                        onPointerDown={(e) => handlePortPointerDown(e, node, 'true')}
                        onClick={(e) => handlePortClick(e, node, 'true')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handlePortClick(e as any, node, 'true');
                          }
                        }}
                      />

                      {/* Large touch hit target */}
                      <circle
                        cx={NODE_WIDTH}
                        cy="60"
                        r="20"
                        fill="transparent"
                        pointerEvents="all"
                        onPointerDown={(e) => handlePortPointerDown(e, node, 'true')}
                        onClick={(e) => handlePortClick(e, node, 'true')}
                      />

                      <text
                        x={NODE_WIDTH - 12}
                        y="64"
                        textAnchor="end"
                        fontSize="10"
                        fontWeight="600"
                        fill="#16a34a"
                      >
                        Yes
                      </text>
                    </g>

                    {/* FALSE (NO) PORT */}
                    <g className="cursor-crosshair group">
                      {connectionSource?.nodeId === node.id && connectionSource.port === 'false' && (
                        <circle
                          cx={NODE_WIDTH}
                          cy="92"
                          r="7"
                          fill="none"
                          stroke="#ef4444"
                          strokeWidth="2"
                          className="canvas-port-pulse"
                        />
                      )}

                      <circle
                        cx={NODE_WIDTH}
                        cy="92"
                        r="7"
                        tabIndex={0}
                        role="button"
                        aria-label={`Connect false branch from ${nodeTitle}`}
                        fill={
                          connectionSource?.nodeId === node.id && connectionSource.port === 'false'
                            ? '#fee2e2'
                            : '#ffffff'
                        }
                        stroke={
                          connectionSource?.nodeId === node.id && connectionSource.port === 'false'
                            ? '#dc2626'
                            : '#dc2626'
                        }
                        strokeWidth="2.5"
                        className="transition-transform group-hover:scale-125 focus:outline-none focus:stroke-rose-600"
                        onPointerDown={(e) => handlePortPointerDown(e, node, 'false')}
                        onClick={(e) => handlePortClick(e, node, 'false')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handlePortClick(e as any, node, 'false');
                          }
                        }}
                      />

                      {/* Large touch hit target */}
                      <circle
                        cx={NODE_WIDTH}
                        cy="92"
                        r="20"
                        fill="transparent"
                        pointerEvents="all"
                        onPointerDown={(e) => handlePortPointerDown(e, node, 'false')}
                        onClick={(e) => handlePortClick(e, node, 'false')}
                      />

                      <text
                        x={NODE_WIDTH - 12}
                        y="96"
                        textAnchor="end"
                        fontSize="10"
                        fontWeight="600"
                        fill="#dc2626"
                      >
                        No
                      </text>
                    </g>
                  </>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <AlertDialog
        data-testid="confirm-delete-rule-node"
        isOpen={nodePendingDelete !== null}
        onOpenChange={(isOpen) => { if (!isOpen) setNodePendingDelete(null); }}
        title="Delete rule node?"
        description={nodePendingDelete ? `“${nodePendingDelete.title}” will be removed from this rule set. Connected links and evaluation paths may change.` : undefined}
        confirmLabel="Delete node"
        onConfirm={confirmDeleteSelectedNode}
      />
    </div>
  );
};
