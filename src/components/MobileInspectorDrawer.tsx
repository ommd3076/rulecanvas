import React from 'react';
import { IconButton } from '@/components/base/buttons/icon-button';
import { SegmentedControl, SegmentedControlItem } from '@/components/base/segmented-control/segmented-control';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { NodeInspector } from './NodeInspector';
import { SchemaEditor } from './SchemaEditor';
import { TestRunner } from './TestRunner';
import type { RuleNode, SchemaField, EvaluationResult } from '@/src/api';
import { RiCloseLine } from '@remixicon/react';

interface MobileInspectorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: 'properties' | 'schema' | 'test';
  onChangeTab: (tab: 'properties' | 'schema' | 'test') => void;
  selectedNode: RuleNode | null;
  schema: SchemaField[];
  onUpdateNode: (node: RuleNode) => void;
  onUpdateSchema: (schema: SchemaField[]) => void;
  onRunTest: (inputs: Record<string, any>) => Promise<EvaluationResult>;
  onHighlightNode?: (nodeId: string | null) => void;
  initialInputValues?: Record<string, any>;
  guideText?: string;
}

export const MobileInspectorDrawer: React.FC<MobileInspectorDrawerProps> = ({
  isOpen,
  onClose,
  activeTab,
  onChangeTab,
  selectedNode,
  schema,
  onUpdateNode,
  onUpdateSchema,
  onRunTest,
  onHighlightNode,
  initialInputValues,
  guideText,
}) => (
  <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent
      side="bottom"
      showCloseButton={false}
      className="max-h-[88dvh] w-full gap-0 overflow-hidden rounded-t-3xl border-t border-border-button-default bg-background-primary-default text-text-primary shadow-xl"
    >
      <SheetHeader className="gap-3 border-b border-separator-border px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-4 pe-1">
          <div className="min-w-0">
            <SheetTitle className="text-title-3-semibold text-text-primary">Inspector</SheetTitle>
            <SheetDescription className="mt-1 text-body-2-regular text-text-secondary">
              Properties, schema, and test run.
            </SheetDescription>
          </div>
          <SheetClose render={<IconButton icon={RiCloseLine} size="small" aria-label="Close inspector" />} />
        </div>
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-label="Inspector tabs"
            selectedKeys={[activeTab]}
            onSelectionChange={(keys) => {
              const key = Array.from(keys)[0];
              if (key) onChangeTab(String(key) as 'properties' | 'schema' | 'test');
            }}
          >
            <SegmentedControlItem id="properties">Properties</SegmentedControlItem>
            <SegmentedControlItem id="schema">Schema ({schema.length})</SegmentedControlItem>
            <SegmentedControlItem id="test">Test Run</SegmentedControlItem>
          </SegmentedControl>
        </div>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === 'properties' && (
          selectedNode ? (
            <NodeInspector node={selectedNode} schema={schema} onUpdateNode={onUpdateNode} />
          ) : (
            <div className="py-10 text-center">
              <p className="text-body-medium text-text-primary">No node selected</p>
              <p className="mt-1 text-body-regular text-text-secondary">Select a node on the canvas to edit its properties.</p>
            </div>
          )
        )}
        {activeTab === 'schema' && <SchemaEditor schema={schema} onChange={onUpdateSchema} />}
        {activeTab === 'test' && <TestRunner schema={schema} onRunTest={onRunTest} onHighlightNode={onHighlightNode} initialInputValues={initialInputValues} guideText={guideText} />}
      </div>
    </SheetContent>
  </Sheet>
);
