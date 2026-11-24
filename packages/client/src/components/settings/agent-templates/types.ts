import type { AgentTemplate, CreateAgentTemplateRequest } from '@funny/shared';

export interface TemplateSectionProps {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}
