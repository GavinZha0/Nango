"use client";

/**
 * ArtifactFilterPanel — right-side resizable panel for Artifact interactive filters.
 * Renders dynamic form inputs generated from `workflow.spec.input_schema` via RJSF (@rjsf/shadcn).
 */

import { useMemo, useState, type ReactNode } from "react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { withTheme } from "@rjsf/core";
import { Theme as ShadcnTheme } from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import type { FieldTemplateProps, RJSFSchema, WidgetProps } from "@rjsf/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const Form = withTheme(ShadcnTheme);

function FilterDateWidget(props: WidgetProps): ReactNode {
  const { id, value, required, readonly, disabled, onChange, onBlur, onFocus } = props;

  return (
    <Input
      id={id}
      type="date"
      value={typeof value === "string" ? value : ""}
      required={required}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value || undefined)}
      onBlur={(e) => onBlur(id, e.target.value)}
      onFocus={(e) => onFocus(id, e.target.value)}
      className="h-8 w-full min-w-0 text-xs text-foreground bg-transparent [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:inline-flex [&::-webkit-datetime-edit]:justify-between"
    />
  );
}

function FilterFieldTemplate(props: FieldTemplateProps): ReactNode {
  const { id, label, required, displayLabel, rawErrors = [], description, children, uiSchema } = props;
  const isCheckbox = uiSchema?.["ui:widget"] === "checkbox";
  const hasError = rawErrors.length > 0;

  return (
    <div className="flex w-full flex-col gap-1 mb-3">
      {displayLabel && !isCheckbox && (
        <label
          htmlFor={id}
          className={cn("text-xs font-medium text-foreground", hasError && "text-destructive")}
        >
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </label>
      )}
      <div className="w-full [&_input]:w-full [&_select]:w-full [&_button]:w-full flex-1">
        {children}
      </div>
      {displayLabel && description && !isCheckbox && (
        <span className={cn("text-xs text-muted-foreground", hasError && "text-destructive")}>
          {description}
        </span>
      )}
    </div>
  );
}

export interface ArtifactFilterPanelProps {
  /** The workflow.spec.input_schema object describing parameters. */
  schema?: RJSFSchema | null;
  /** Current active or initial filter values (populated from value ?? default). */
  initialValues?: Record<string, unknown>;
  /** Callback triggered when user clicks [Apply]. */
  onApply: (values: Record<string, unknown>) => void;
  /** True when a refresh/apply request is in flight. */
  loading?: boolean;
}

/**
 * Prepare RJSF schema and uiSchema:
 * - Hides default submit button
 * - Sets uniqueItems: true and ui:widget = "select" for array-enum properties (e.g. Initiator)
 *   so RJSF renders a multi-select dropdown without "Add Item" or text input fallbacks.
 */
function prepareFilterForm(schema?: RJSFSchema | null): {
  preparedSchema: RJSFSchema;
  uiSchema: Record<string, unknown>;
} {
  const uiSchema: Record<string, unknown> = {
    "ui:submitButtonOptions": {
      norender: true,
    },
  };

  if (!schema || !schema.properties) {
    return { preparedSchema: (schema ?? {}) as RJSFSchema, uiSchema };
  }

  const newProperties: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    const propSchema = { ...(prop as Record<string, unknown>) };

    if (
      propSchema.type === "array" &&
      propSchema.items &&
      typeof propSchema.items === "object" &&
      Array.isArray((propSchema.items as Record<string, unknown>).enum)
    ) {
      propSchema.uniqueItems = true;
      uiSchema[key] = {
        "ui:widget": "select",
      };
    }

    newProperties[key] = propSchema;
  }

  const preparedSchema = {
    ...schema,
    properties: newProperties,
  } as RJSFSchema;

  return { preparedSchema, uiSchema };
}

export function ArtifactFilterPanel({
  schema,
  initialValues = {},
  onApply,
  loading = false,
}: ArtifactFilterPanelProps): ReactNode {
  const [formData, setFormData] = useState<Record<string, unknown>>(initialValues);
  const [schemaKey, setSchemaKey] = useState<string>(() => JSON.stringify(schema));
  const [prevInitialValues, setPrevInitialValues] = useState<string>(() => JSON.stringify(initialValues));

  const currentSchemaKey = JSON.stringify(schema);
  const currentInitialValuesKey = JSON.stringify(initialValues);

  if (currentSchemaKey !== schemaKey || currentInitialValuesKey !== prevInitialValues) {
    setSchemaKey(currentSchemaKey);
    setPrevInitialValues(currentInitialValuesKey);
    setFormData(initialValues);
  }

  const hasProperties = Boolean(
    schema?.properties && Object.keys(schema.properties).length > 0,
  );

  const { preparedSchema, uiSchema } = useMemo(() => prepareFilterForm(schema), [schema]);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col border-l bg-background">
      {/* Panel Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4 text-xs font-semibold text-foreground">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Filter</span>
        </div>
      </div>

      {/* Panel Body */}
      <ScrollArea className="flex-1 p-3">
        {hasProperties && preparedSchema ? (
          <div className="rjsf-filter-form text-xs [&_button[type=submit]]:hidden [&_input]:w-full [&_select]:w-full [&_div.form-group]:w-full [&_div.field]:w-full">
            <Form
              schema={preparedSchema}
              uiSchema={uiSchema}
              validator={validator}
              formData={formData}
              templates={{ FieldTemplate: FilterFieldTemplate }}
              widgets={{
                DateWidget: FilterDateWidget,
                date: FilterDateWidget,
              }}
              onChange={(e) => setFormData((e.formData ?? {}) as Record<string, unknown>)}
            >
              {null}
            </Form>
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-center text-xs text-muted-foreground">
            No filter parameters configured.
          </div>
        )}
      </ScrollArea>

      {/* Panel Bottom Action Bar */}
      <div className="flex shrink-0 items-center justify-end border-t p-2 bg-muted/20">
        <Button
          size="sm"
          onClick={() => onApply(formData)}
          disabled={loading || !hasProperties}
          className="h-8 gap-1.5 text-xs w-full"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Apply</span>
        </Button>
      </div>
    </div>
  );
}
