import React from 'react';
import type { SchemaField } from '@/src/api';
import { Input } from '@/components/base/input/input';
import { Select, SelectItem } from '@/components/base/select/select';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { Button } from '@/components/base/buttons/button';
import { IconButton } from '@/components/base/buttons/icon-button';
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';

interface SchemaEditorProps {
  schema: SchemaField[];
  onChange: (updatedSchema: SchemaField[]) => void;
}

export const SchemaEditor: React.FC<SchemaEditorProps> = ({ schema, onChange }) => {
  const handleAddField = () => {
    const newField: SchemaField = {
      id: `field_${Date.now()}`,
      name: `field_${schema.length + 1}`,
      type: 'string',
      required: false,
    };
    onChange([...schema, newField]);
  };

  const handleUpdateField = (index: number, patch: Partial<SchemaField>) => {
    const next = [...schema];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const handleDeleteField = (index: number) => {
    const next = [...schema];
    next.splice(index, 1);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-title-3-semibold text-text-primary">Input Schema</h3>
          <p className="text-body-2-regular text-text-secondary">
            Declared typed parameters available to conditions in this ruleset.
          </p>
        </div>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiAddLine}
          onClick={handleAddField}
        >
          Add Field
        </Button>
      </div>

      {schema.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-button-default bg-background-primary-default p-6 text-center">
          <p className="text-body-2-regular text-text-tertiary">
            No fields declared. Rule evaluation will run without typed inputs.
          </p>
          <div className="mt-3">
            <Button
              variant="ghost"
              size="small"
              leadingIcon={RiAddLine}
              onClick={handleAddField}
            >
              Add first field
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {schema.map((field, idx) => (
            <div
              key={field.id}
              className="flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-xs"
            >
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Input
                    aria-label={`Field ${idx + 1} name`}
                    placeholder="Field name (e.g. amount)"
                    value={field.name}
                    onChange={(val) => handleUpdateField(idx, { name: val })}
                  />
                </div>
                <div className="w-32">
                  <Select
                    aria-label="Field type"
                    selectedKey={field.type}
                    onSelectionChange={(key) =>
                      handleUpdateField(idx, {
                        type: key as SchemaField['type'],
                        options: key === 'enum' ? (field.options || ['STANDARD', 'EXPRESS']) : undefined,
                      })
                    }
                  >
                    <SelectItem id="string">string</SelectItem>
                    <SelectItem id="number">number</SelectItem>
                    <SelectItem id="boolean">boolean</SelectItem>
                    <SelectItem id="date">date</SelectItem>
                    <SelectItem id="enum">enum</SelectItem>
                  </Select>
                </div>
                <IconButton
                  size="small"
                  icon={RiDeleteBinLine}
                  aria-label="Remove field"
                  onClick={() => handleDeleteField(idx)}
                />
              </div>

              <div className="flex items-center justify-between ps-1 pe-2">
                <Checkbox
                  isSelected={field.required ?? false}
                  onChange={(isSelected) => handleUpdateField(idx, { required: isSelected })}
                  size="sm"
                >
                  Required field
                </Checkbox>
                <span className="font-mono text-caption-1-regular text-text-tertiary">
                  ID: {field.id}
                </span>
              </div>

              {field.type === 'enum' && (
                <div className="mt-1">
                  <Input
                    label="Enum Choices (comma-separated)"
                    placeholder="CHOICE_A, CHOICE_B, CHOICE_C"
                    value={(field.options || []).join(', ')}
                    onChange={(val) =>
                      handleUpdateField(idx, {
                        options: val
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
