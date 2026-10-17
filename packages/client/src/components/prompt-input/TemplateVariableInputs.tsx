import type { TemplateVariable } from '@funny/shared';

import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface TemplateVariableInputsProps {
  show: boolean;
  variables: readonly TemplateVariable[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}

/** Deep Agent template variable inputs shown under the editor (new threads). */
export function TemplateVariableInputs({
  show,
  variables,
  values,
  onChange,
}: TemplateVariableInputsProps) {
  if (!show || variables.length === 0) return null;
  return (
    <div className="border-t px-3 py-2">
      <div className="flex flex-wrap gap-2">
        {variables.map((v) => (
          <div key={v.name} className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  htmlFor={`template-variable-${v.name}`}
                  className="text-muted-foreground text-[10px] font-medium"
                >
                  {v.name}
                </label>
              </TooltipTrigger>
              <TooltipContent>{v.description || v.name}</TooltipContent>
            </Tooltip>
            <Input
              id={`template-variable-${v.name}`}
              value={values[v.name] ?? v.defaultValue ?? ''}
              onChange={(e) => onChange(v.name, e.target.value)}
              placeholder={v.description || v.name}
              className="h-6 w-40 text-xs"
              data-testid={`prompt-template-var-${v.name}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
