import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useReducer,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { reduceQuestionTab } from '@/components/tool-cards/question-tab-state';
import { useEditorDictation } from '@/hooks/use-editor-dictation';
import { createClientLogger } from '@/lib/client-logger';

import type { Question } from './utils';

const cardLog = createClientLogger('AskUserQuestion');

// Special index to represent "Other" option
export const OTHER_INDEX = -1;

/**
 * Parse the output string back into selections and otherTexts maps
 * by matching answer lines against the original question options.
 * Output format:
 *   [Header] Question text
 *   → Option Label — Option Description
 *   → Other — free text
 */
function parseOutputToSelections(
  output: string,
  questions: Question[],
): { selections: Map<number, Set<number>>; otherTexts: Map<number, string> } {
  const selections = new Map<number, Set<number>>();
  const otherTexts = new Map<number, string>();

  // Split output into question blocks (separated by blank lines)
  const blocks = output.split('\n\n');

  blocks.forEach((block) => {
    const lines = block.split('\n');
    if (lines.length === 0) return;

    // First line is "[Header] Question text" — match to a question by header
    const headerMatch = lines[0].match(/^\[(.+?)\]/);
    if (!headerMatch) return;
    const header = headerMatch[1];
    const qIndex = questions.findIndex((q) => q.header === header);
    if (qIndex === -1) return;

    const q = questions[qIndex];
    const selected = new Set<number>();

    // Remaining lines are "→ Label — Description"
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].replace(/^→\s*/, '');
      if (!line) continue;

      // Try to match against known options by label
      const dashIdx = line.indexOf('—');
      const label = dashIdx !== -1 ? line.substring(0, dashIdx).trim() : line.trim();
      const optIndex = q.options.findIndex((opt) => opt.label === label);
      if (optIndex !== -1) {
        selected.add(optIndex);
      } else {
        // Unrecognized option — treat as "Other" answer (locale-independent)
        const otherText = dashIdx !== -1 ? line.substring(dashIdx + 1).trim() : line;
        selected.add(OTHER_INDEX);
        otherTexts.set(qIndex, otherText);
      }
    }

    if (selected.size > 0) {
      selections.set(qIndex, selected);
    }
  });

  return { selections, otherTexts };
}

/** A question is answered once something is selected; "Other" alone also needs text. */
function isAnswered(sel: Set<number> | undefined, otherText: string | undefined): boolean {
  if (!sel || sel.size === 0) return false;
  // If "Other" is the only selection, require text
  if (sel.has(OTHER_INDEX) && sel.size === 1) {
    return (otherText?.trim().length ?? 0) > 0;
  }
  return true;
}

/** The answer text sent back to the agent, one block per answered question. */
function formatAnswer(
  questions: Question[],
  selections: Map<number, Set<number>>,
  otherTexts: Map<number, string>,
  otherLabel: string,
): string {
  const parts: string[] = [];
  questions.forEach((q, qi) => {
    const selected = selections.get(qi);
    if (selected && selected.size > 0) {
      const answers = Array.from(selected).flatMap((i) => {
        if (i === OTHER_INDEX) {
          const text = otherTexts.get(qi)?.trim();
          return text ? [`${otherLabel} — ${text}`] : [];
        }
        const opt = q.options[i];
        return opt ? [`${opt.label} — ${opt.description}`] : [];
      });
      parts.push(`[${q.header}] ${q.question}\n→ ${answers.join('\n→ ')}`);
    }
  });
  return parts.join('\n\n');
}

/** Calculate max height needed across all tabs (including "Other" option and textarea). */
function useMaxContentHeight(questions: Question[], selections: Map<number, Set<number>>) {
  return useMemo(() => {
    return questions.reduce((max, q, qIndex) => {
      // Base height: options + "Other" button
      const optionsCount = q.options.length + 1; // +1 for "Other"
      let height = optionsCount * 40; // approximate height per option (py-1.5 + gap)

      // Add height for "Other" textarea if selected for this question
      const qSelections = selections.get(qIndex);
      if (qSelections?.has(OTHER_INDEX)) {
        height += 70; // textarea min-height + margins
      }

      return Math.max(max, height);
    }, 0);
  }, [questions, selections]);
}

/** Restored (read-only) answer state from an existing tool output. */
function useRestoredAnswers(questions: Question[], output: string | undefined) {
  const alreadyAnswered = !!output;
  // Parse existing output back into selections for read-only display
  const restoredState = useMemo(() => {
    if (!alreadyAnswered) return null;
    return parseOutputToSelections(output!, questions);
  }, [alreadyAnswered, output, questions]);

  // When output exists but nothing could be parsed back into selections,
  // show the raw answer text as a fallback (e.g. user typed directly in chat input).
  const rawAnswerFallback = useMemo(() => {
    if (!alreadyAnswered) return null;
    if (restoredState && restoredState.selections.size > 0) return null;
    return output!;
  }, [alreadyAnswered, restoredState, output]);

  return { alreadyAnswered, restoredState, rawAnswerFallback };
}

/** The "Other" editor's text per tab, kept in sync with the mini PromptEditor. */
function useOtherEditor(
  initialTexts: Map<number, string> | undefined,
  activeTab: number,
  otherEditorRef: RefObject<PromptEditorHandle | null>,
) {
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(
    () => initialTexts ?? new Map(),
  );

  // Sync editor content → otherTexts state
  const handleOtherEditorChange = useCallback(() => {
    const text = otherEditorRef.current?.getText() ?? '';
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(activeTab, text);
      return next;
    });
  }, [activeTab, otherEditorRef]);

  // Restore editor content on mount via callback ref. The PromptEditor lives
  // inside an AnimatePresence(mode="wait") subtree keyed by activeTab, so it
  // remounts on every tab switch — a regular effect would run before the new
  // editor exists. The callback is recreated for committed tab state, so it
  // never depends on mutating refs during render.
  const handleOtherEditorRef = useCallback(
    (handle: PromptEditorHandle | null) => {
      otherEditorRef.current = handle;
      if (!handle) return;
      const savedText = otherTexts.get(activeTab) || '';
      if (savedText) handle.setContent(savedText);
    },
    [activeTab, otherTexts, otherEditorRef],
  );

  return { otherTexts, setOtherTexts, handleOtherEditorChange, handleOtherEditorRef };
}

/** Selection, tab and submission state of an AskUserQuestion card. */
export function useQuestionAnswers(
  questions: Question[],
  output: string | undefined,
  onRespond: ((answer: string) => void) | undefined,
) {
  const { t } = useTranslation();
  const { alreadyAnswered, restoredState, rawAnswerFallback } = useRestoredAnswers(
    questions,
    output,
  );

  const [{ activeTab, slideDirection }, goToTab] = useReducer(reduceQuestionTab, {
    activeTab: 0,
    slideDirection: 0,
  });
  const [selections, setSelections] = useState<Map<number, Set<number>>>(
    () => restoredState?.selections ?? new Map(),
  );
  const [submitted, setSubmitted] = useState(alreadyAnswered);
  const otherEditorRef = useRef<PromptEditorHandle>(null);
  const otherEditorContainerRef = useRef<HTMLDivElement>(null);
  const { otherTexts, setOtherTexts, handleOtherEditorChange, handleOtherEditorRef } =
    useOtherEditor(restoredState?.otherTexts, activeTab, otherEditorRef);

  // ── Dictation (real-time voice-to-text via AssemblyAI) ──
  const dictation = useEditorDictation(otherEditorRef, otherEditorContainerRef);

  const toggleOption = (qIndex: number, optIndex: number, multiSelect: boolean) => {
    if (submitted) return;
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIndex) || []);
      if (multiSelect) {
        if (current.has(optIndex)) current.delete(optIndex);
        else current.add(optIndex);
      } else {
        current.clear();
        current.add(optIndex);
      }
      next.set(qIndex, current);
      return next;
    });

    if (optIndex === OTHER_INDEX) {
      // Always move caret into the input when "Other" is pressed
      setTimeout(() => otherEditorRef.current?.focus(), 0);
      return;
    }

    // Auto-advance to next question if:
    // - Not multi-select (single selection)
    // - Not on the last question
    if (!multiSelect && qIndex < questions.length - 1) {
      // Use setTimeout to ensure state update completes before advancing
      setTimeout(() => goToTab(qIndex + 1), 150);
    }
  };

  // Focus the editor when "Other" is selected
  useEffect(() => {
    const activeSelections = selections.get(activeTab);
    if (activeSelections?.has(OTHER_INDEX) && otherEditorRef.current) {
      otherEditorRef.current.focus();
    }
  }, [selections, activeTab]);

  const handleSubmit = () => {
    if (submitted || !onRespond) return;
    if (dictation.isRecording) dictation.stopRecording();
    const answer = formatAnswer(questions, selections, otherTexts, t('tools.other'));
    if (answer.length > 0) {
      cardLog.info('response submitted', { answerPreview: answer.slice(0, 200) });
      onRespond(answer);
      setSubmitted(true);
    }
  };

  const isLastTab = activeTab === questions.length - 1;
  const maxContentHeight = useMaxContentHeight(questions, selections);

  const handleOtherSubmit = () => {
    // Flush editor text to state before submitting
    const text = otherEditorRef.current?.getText() ?? '';
    setOtherTexts((prev) => {
      const next = new Map(prev);
      next.set(activeTab, text);
      return next;
    });
    if (isLastTab || questions.length === 1) {
      // Use setTimeout to let state update flush before handleSubmit reads it
      setTimeout(handleSubmit, 0);
    } else {
      goToTab(activeTab + 1);
    }
  };

  return {
    rawAnswerFallback,
    activeTab,
    slideDirection,
    goToTab,
    selections,
    submitted,
    otherTexts,
    otherEditorRef,
    otherEditorContainerRef,
    handleOtherEditorChange,
    handleOtherEditorRef,
    handleOtherSubmit,
    dictation,
    toggleOption,
    handleSubmit,
    isLastTab,
    maxContentHeight,
    allAnswered: questions.every((_, i) => isAnswered(selections.get(i), otherTexts.get(i))),
    currentTabAnswered: isAnswered(selections.get(activeTab), otherTexts.get(activeTab)),
  };
}
