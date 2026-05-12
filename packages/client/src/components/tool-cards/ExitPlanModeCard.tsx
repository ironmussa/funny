import type { Skill } from '@funny/shared';
import {
  Check,
  Copy,
  FileCode2,
  CheckCircle2,
  XCircle,
  Pencil,
  Send,
  Mic,
  MicOff,
  Loader2,
  Maximize2,
} from 'lucide-react';
import { Suspense, lazy, useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { PromptEditor } from '@/components/prompt-editor/PromptEditor';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDictation } from '@/hooks/use-dictation';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { remarkPlugins } from '@/lib/markdown-components';
import { cn } from '@/lib/utils';
import { useProfileStore } from '@/stores/profile-store';

import { AnnotatableContent } from './AnnotatableContent';

const LazyMarkdown = lazy(() =>
  import('react-markdown').then(({ default: ReactMarkdown }) => ({
    default: function ExitPlanMarkdown({ content }: { content: string }) {
      return <ReactMarkdown remarkPlugins={remarkPlugins}>{content}</ReactMarkdown>;
    },
  })),
);
import { PlanReviewDialog, type PlanComment } from './PlanReviewDialog';
import { useCurrentProjectPath } from './utils';

const cardLog = createClientLogger('ExitPlanMode');

export const ExitPlanModeCard = memo(function ExitPlanModeCard({
  plan,
  onRespond,
  output,
  displayTime,
}: {
  plan?: string;
  onRespond?: (answer: string) => void;
  output?: string;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const alreadyAnswered = !!output;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [planComments, setPlanComments] = useState<PlanComment[]>([]);

  const handleAddComment = useCallback((selectedText: string, comment: string) => {
    setPlanComments((prev) => [...prev, { selectedText, comment }]);
  }, []);

  const handleAddEmoji = useCallback((selectedText: string, emoji: string) => {
    setPlanComments((prev) => [...prev, { selectedText, emoji, comment: '' }]);
  }, []);

  const handleRemoveComment = useCallback((index: number) => {
    setPlanComments((prev) => prev.filter((_, i) => i !== index));
  }, []);

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
  const hasAssemblyaiKey = useProfileStore((s) => s.profile?.hasAssemblyaiKey ?? false);
  const partialTextRef = useRef('');

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

  const _handleDialogRespond = useCallback(
    (answer: string) => {
      if (!onRespond || submitted) return;
      cardLog.info('dialog response', { responsePreview: answer.slice(0, 200) });
      onRespond(answer);
      setSubmitted(true);
      setReviewOpen(false);
    },
    [onRespond, submitted],
  );

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <FileCode2 className="icon-xs flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{t('tools.plan')}</span>
        {!submitted && (
          <span className="text-muted-foreground">{t('thread.planWaitingForResponse')}</span>
        )}
        {displayTime && (
          <span className="text-[10px] tabular-nums text-muted-foreground/50">{displayTime}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {submitted && (
            <span className="flex-shrink-0 rounded bg-status-success/10 px-1.5 py-0.5 text-xs font-medium text-status-success/80">
              {t('tools.answered')}
            </span>
          )}
          {plan && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    onClick={() => setReviewOpen(true)}
                    data-testid="plan-expand-button"
                  >
                    <Maximize2 className="icon-xs text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('plan.reviewPlan', 'Review plan')}</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                onClick={handleCopy}
                data-testid="plan-copy-button"
              >
                {copied ? (
                  <Check className="icon-xs text-green-500" />
                ) : (
                  <Copy className="icon-xs text-muted-foreground" />
                )}
              </Button>
            </>
          )}
        </span>
      </div>

      {plan && (
        <AnnotatableContent
          className="max-h-[500px] overflow-y-auto border-t border-border/40 px-4 py-3 pr-14"
          planComments={planComments}
          onAddComment={handleAddComment}
          onAddEmoji={handleAddEmoji}
          onRemoveComment={handleRemoveComment}
        >
          <div className="prose prose-xs prose-invert prose-headings:text-foreground prose-headings:font-semibold prose-h1:text-xs prose-h1:mb-1.5 prose-h1:mt-0 prose-h2:text-xs prose-h2:mb-1 prose-h2:mt-2.5 prose-h3:text-sm prose-h3:mb-1 prose-h3:mt-2 prose-p:text-xs prose-p:text-muted-foreground prose-p:leading-relaxed prose-p:my-0.5 prose-li:text-sm prose-li:text-muted-foreground prose-li:leading-relaxed prose-li:my-0 prose-ul:my-0.5 prose-ol:my-0.5 prose-code:text-xs prose-code:bg-background/80 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-foreground prose-pre:bg-background/80 prose-pre:rounded prose-pre:p-2 prose-pre:my-1 prose-strong:text-foreground max-w-none">
            <Suspense
              fallback={
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                  {plan}
                </pre>
              }
            >
              <LazyMarkdown content={plan} />
            </Suspense>
          </div>
        </AnnotatableContent>
      )}

      {alreadyAnswered && (
        <div className="border-t border-border/40 px-3 py-2">
          <p className="text-xs font-medium text-primary">→ {output}</p>
        </div>
      )}

      {onRespond && !submitted && (
        <div className="border-t border-border/40">
          {/* Row 1: Approve */}
          <button
            onClick={handleAccept}
            data-testid="plan-accept"
            className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <CheckCircle2 className="size-4 flex-shrink-0 text-muted-foreground/60" />
            <span>{t('plan.approveAndStart', 'Approve plan and start coding')}</span>
          </button>

          {/* Row 2: Reject */}
          <button
            onClick={handleReject}
            data-testid="plan-reject"
            className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XCircle className="size-4 flex-shrink-0 text-muted-foreground/60" />
            <span>{t('thread.rejectPlan', 'Reject plan')}</span>
          </button>

          {/* Row 3: Custom response — single row with inline editor */}
          <div className="flex items-center gap-3 px-4 py-2.5">
            <Pencil className="size-4 flex-shrink-0 text-muted-foreground/60" />
            <div className="min-w-0 flex-1 rounded-md border border-border/40 bg-background/50 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50">
              <div className="px-2.5 py-1.5">
                <PromptEditor
                  ref={editorRef}
                  placeholder={t('plan.tellClaude', 'Tell the agent what to do instead')}
                  onSubmit={handleSubmitInput}
                  onChange={handleEditorChange}
                  cwd={cwd}
                  loadSkills={loadSkillsForEditor}
                  className="max-h-[120px] min-h-[20px] overflow-y-auto text-sm"
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
                          <Loader2 className="icon-xs animate-spin" />
                        ) : isRecording ? (
                          <MicOff className="icon-xs" />
                        ) : (
                          <Mic className="icon-xs" />
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
                      <Send className="icon-xs" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('prompt.send', 'Send')}</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {planComments.length > 0 && (
              <Button
                size="sm"
                onClick={() => {
                  const parts = planComments.map((c) => {
                    const quote =
                      c.selectedText.length > 100
                        ? c.selectedText.slice(0, 100) + '...'
                        : c.selectedText;
                    if (c.emoji && c.comment) return `> ${quote}\n${c.emoji} ${c.comment}`;
                    if (c.emoji) return `> ${quote}\n${c.emoji}`;
                    return `> ${quote}\nComment: ${c.comment}`;
                  });
                  onRespond(`Feedback on plan:\n\n${parts.join('\n\n')}`);
                  setSubmitted(true);
                }}
                data-testid="plan-send-comments"
                className="h-7 shrink-0 bg-primary px-3 text-xs"
              >
                {t('plan.sendComments', 'Send {{count}} comments', { count: planComments.length })}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Plan review dialog */}
      {plan && (
        <PlanReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          plan={plan}
          planComments={planComments}
          onAddComment={handleAddComment}
          onAddEmoji={handleAddEmoji}
          onRemoveComment={handleRemoveComment}
        />
      )}
    </div>
  );
});
