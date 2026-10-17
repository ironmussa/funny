import type { AgentTemplate } from '@funny/shared';
import { Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  ModeSelect,
  ModelSelect,
  TemplateSelect,
  type ModelSelectGroup,
} from '@/components/PromptSelectors';
import { Button } from '@/components/ui/button';

import { BacklogToggle, DictationButton, SendOrStopButton } from './PromptToolbarButtons';

export interface PromptToolbarProps {
  // Model / mode / template selectors
  unifiedModel: string;
  effort?: string;
  onUnifiedModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
  modelGroups: ModelSelectGroup[];
  projectId?: string;
  showTemplates: boolean;
  templates: AgentTemplate[];
  selectedTemplateId?: string;
  onTemplateChange: (v: string | undefined) => void;
  mode: string;
  onModeChange: (v: string) => void;
  modes: { value: string; label: string }[];
  // Backlog
  showBacklog: boolean;
  sendToBacklog: boolean;
  onSendToBacklogChange?: (v: boolean) => void;
  // Attach / dictation / send
  onAttach: () => void;
  hasDictation: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  onToggleRecording?: () => void;
  loading: boolean;
  running: boolean;
  editorEmpty: boolean;
  isQueueMode: boolean;
  onStop?: () => void;
  onSend: () => void;
}

/** Bottom toolbar inside the prompt box. Wraps touch-sized selectors on mobile. */
export function PromptToolbar(props: PromptToolbarProps) {
  const { t } = useTranslation();
  const { loading, running } = props;
  return (
    <div className="px-2 py-2.5">
      <div className="no-scrollbar flex min-h-[48px] flex-wrap items-center gap-1 px-px md:h-9 md:min-h-0 md:flex-nowrap md:overflow-x-auto">
        <ModelSelect
          value={props.unifiedModel}
          effort={props.effort}
          onChange={props.onUnifiedModelChange}
          onEffortChange={props.onEffortChange}
          groups={props.modelGroups}
          projectId={props.projectId}
        />
        {props.showTemplates && (
          <TemplateSelect
            value={props.selectedTemplateId}
            onChange={props.onTemplateChange}
            templates={props.templates}
          />
        )}
        <ModeSelect value={props.mode} onChange={props.onModeChange} modes={props.modes} />
        {props.showBacklog && (
          <BacklogToggle
            sendToBacklog={props.sendToBacklog}
            onSendToBacklogChange={props.onSendToBacklogChange}
          />
        )}
        {/* Attachment + dictation + send — always visible, pushed right */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            data-testid="prompt-attach"
            onClick={props.onAttach}
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-label={t('prompt.attach')}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="icon-base" />
          </Button>
          {props.hasDictation && (
            <DictationButton
              isRecording={props.isRecording}
              isTranscribing={props.isTranscribing}
              loading={loading}
              onToggleRecording={props.onToggleRecording}
            />
          )}
          <SendOrStopButton
            showStop={running && props.editorEmpty}
            loading={loading}
            queueLabel={running && props.isQueueMode}
            onStop={props.onStop}
            onSend={props.onSend}
          />
        </div>
      </div>
    </div>
  );
}
