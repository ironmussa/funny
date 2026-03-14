import type { Skill } from '@funny/shared';
import {
  Check,
  Copy,
  FileCode2,
  CheckCircle2,
  XCircle,
  Send,
  Mic,
  MicOff,
  Loader2,
} from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDictation } from '@/hooks/use-dictation';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';

import { useCurrentProjectPath } from './utils';

const cardLog = createClientLogger('ExitPlanMode');

export function ExitPlanModeCard({
  plan,
  onRespond,
  output,
}: {
  plan?: string;
  onRespond?: (answer: string) => void;
  output?: string;
}) {
  const { t } = useTranslation();
  cardLog.info('render', {
    hasOnRespond: String(!!onRespond),
    hasOutput: String(!!output),
    hasPlan: String(!!plan),
  });
  const [copied, setCopied] = useState(false);
  const alreadyAnswered = !!output;

  const handleCopy = async () => {
    if (!plan) return;
    await navigator.clipboard.writeText(plan);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const [submitted, setSubmitted] = useState(alreadyAnswered);
  const editorRef = useRef<PromptEditorHandle>(null);
  const cwd = useCurrentProjectPath();

  // Skills loader for slash commands
  const skillsCacheRef = useRef<Skill[] | null>(null);
  const loadSkillsForEditor = useCallback(async (): Promise<Skill[]> => {
    if (skillsCacheRef.current) return skillsCacheRef.current;
    const result = await api.listSkills(cwd);
    if (result.isOk()) {
      const allSkills = result.value.skills ?? [];
      const deduped = new Map<string, Skill>();
      for (const s of allSkills) deduped.set(s.name, s);
      skillsCacheRef.current = [...deduped.values()];
      return skillsCacheRef.current;
    }
    return [];
  }, [cwd]);

  useEffect(() => {
    skillsCacheRef.current = null;
  }, [cwd]);

  // ── Dictation (real-time voice-to-text via AssemblyAI) ──
  const [hasAssemblyaiKey, setHasAssemblyaiKey] = useState(false);
  const partialTextRef = useRef('');

  useEffect(() => {
    api.getProfile().then((result) => {
      if (result.isOk() && result.value) {
        setHasAssemblyaiKey(result.value.hasAssemblyaiKey);
      }
    });
  }, []);

  const handlePartialTranscript = useCallback((text: string) => {
    partialTextRef.current = text;
    if (text) editorRef.current?.setDictationPreview(text);
  }, []);

  const handleFinalTranscript = useCallback((text: string) => {
    if (text) editorRef.current?.commitDictation(text);
    partialTextRef.current = '';
  }, []);

  const handleDictationError = useCallback(
    (message: string) => {
      toast.error(message || t('prompt.micPermissionDenied', 'Microphone access denied'));
    },
    [t],
  );

  const {
    isRecording,
    isConnecting: isTranscribing,
    toggle: toggleRecording,
  } = useDictation({
    onPartial: handlePartialTranscript,
    onFinal: handleFinalTranscript,
    onError: handleDictationError,
  });

  // Track if editor has content for send button state
  const [hasContent, setHasContent] = useState(false);
  const handleEditorChange = useCallback(() => {
    const text = (editorRef.current?.getText() ?? '').trim();
    setHasContent(text.length > 0);
  }, []);

  useEffect(() => {
    if (onRespond && !submitted) {
      editorRef.current?.focus();
    }
  }, [onRespond, submitted]);

  const handleAccept = () => {
    if (!onRespond || submitted) return;
    cardLog.info('plan accepted');
    onRespond('Plan accepted');
    setSubmitted(true);
  };

  const handleReject = () => {
    if (!onRespond || submitted) return;
    cardLog.info('plan rejected');
    onRespond('Plan rejected. Do not proceed with this plan.');
    setSubmitted(true);
  };

  const handleSubmitInput = () => {
    const text = (editorRef.current?.getText() ?? '').trim();
    if (!text || !onRespond || submitted) return;
    cardLog.info('custom response', { responsePreview: text.slice(0, 200) });
    onRespond(text);
    setSubmitted(true);
  };

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <FileCode2 className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{t('tools.plan')}</span>
        {!submitted && (
          <span className="text-muted-foreground">{t('thread.planWaitingForResponse')}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {submitted && (
            <span className="flex-shrink-0 rounded bg-status-success/10 px-1.5 py-0.5 text-xs font-medium text-status-success/80">
              {t('tools.answered')}
            </span>
          )}
          {plan && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={handleCopy}
              data-testid="plan-copy-button"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </Button>
          )}
        </span>
      </div>

      {plan && (
        <div className="max-h-[500px] overflow-y-auto border-t border-border/40 px-4 py-3">
          <div className="prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
          </div>
        </div>
      )}

      {alreadyAnswered && (
        <div className="border-t border-border/40 px-3 py-2">
          <p className="text-xs font-medium text-primary">→ {output}</p>
        </div>
      )}

      {onRespond && !submitted && (
        <div className="space-y-2 border-t border-border/40 px-3 py-2.5">
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('tools.acceptPlan')}
            </button>
            <button
              onClick={handleReject}
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            >
              <XCircle className="h-3.5 w-3.5" />
              {t('thread.rejectPlan')}
            </button>
          </div>

          <div className="rounded-md border border-border/40 bg-background/50 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20">
            <div className="px-2.5 py-1.5">
              <PromptEditor
                ref={editorRef}
                placeholder={t('thread.waitingInputPlaceholder')}
                onSubmit={handleSubmitInput}
                onChange={handleEditorChange}
                cwd={cwd}
                loadSkills={loadSkillsForEditor}
                className="min-h-[40px] max-h-[120px] overflow-y-auto text-sm"
              />
            </div>
            <div className="flex items-center justify-end gap-1 border-t border-border/20 px-1.5 py-0.5">
              {hasAssemblyaiKey && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid="plan-dictate"
                      onClick={toggleRecording}
                      variant="ghost"
                      size="icon-sm"
                      tabIndex={-1}
                      aria-label={
                        isRecording
                          ? t('prompt.stopDictation', 'Stop dictation')
                          : t('prompt.startDictation', 'Start dictation')
                      }
                      disabled={isTranscribing}
                      className={cn(
                        'text-muted-foreground hover:text-foreground',
                        isRecording && 'text-destructive hover:text-destructive',
                      )}
                    >
                      {isTranscribing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : isRecording ? (
                        <MicOff className="h-3 w-3" />
                      ) : (
                        <Mic className="h-3 w-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isTranscribing
                      ? t('prompt.transcribing', 'Transcribing...')
                      : isRecording
                        ? t('prompt.stopDictation', 'Stop dictation')
                        : t('prompt.startDictation', 'Start dictation')}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="plan-send-feedback"
                    onClick={handleSubmitInput}
                    variant="ghost"
                    size="icon-sm"
                    tabIndex={-1}
                    disabled={!hasContent}
                    className={cn(
                      'text-muted-foreground hover:text-foreground',
                      hasContent && 'text-primary hover:text-primary',
                    )}
                  >
                    <Send className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('prompt.send', 'Send')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
