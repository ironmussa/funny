import { useState, useMemo } from 'react';
import { ChevronRight, Wrench, Circle, CircleDot, CircleCheck, ListTodo, Terminal, MessageCircleQuestion, Check, Send, FileText, FilePen } from 'lucide-react';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
  onRespond?: (answer: string) => void;
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'Read File',
  Write: 'Write File',
  Edit: 'Edit File',
  Bash: 'Run Command',
  Glob: 'Find Files',
  Grep: 'Search Code',
  WebFetch: 'Fetch URL',
  WebSearch: 'Web Search',
  Task: 'Subagent',
  TodoWrite: 'Todos',
  NotebookEdit: 'Edit Notebook',
  AskUserQuestion: 'Question',
};

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function formatInput(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return { value: input };
    }
  }
  return input;
}

function getTodos(parsed: Record<string, unknown>): TodoItem[] | null {
  const todos = parsed.todos;
  if (!Array.isArray(todos)) return null;
  return todos as TodoItem[];
}

function getFilePath(name: string, parsed: Record<string, unknown>): string | null {
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    return parsed.file_path as string ?? null;
  }
  return null;
}

function getQuestions(parsed: Record<string, unknown>): Question[] | null {
  const questions = parsed.questions;
  if (!Array.isArray(questions)) return null;
  return questions as Question[];
}

function getSummary(name: string, parsed: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return parsed.file_path as string ?? null;
    case 'Bash':
      return parsed.command as string ?? null;
    case 'Glob':
      return parsed.pattern as string ?? null;
    case 'Grep':
      return parsed.pattern as string ?? null;
    case 'Task':
      return parsed.description as string ?? null;
    case 'TodoWrite': {
      const todos = getTodos(parsed);
      if (!todos) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} done`;
    }
    case 'AskUserQuestion': {
      const questions = getQuestions(parsed);
      if (!questions) return null;
      return `${questions.length} question${questions.length > 1 ? 's' : ''}`;
    }
    default:
      return null;
  }
}

function toVscodeUri(filePath: string): string {
  // Normalize backslashes to forward slashes for the URI
  const normalized = filePath.replace(/\\/g, '/');
  // Ensure it starts with a slash (Windows paths like C:/foo need a leading /)
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `vscode://file${withLeadingSlash}`;
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="space-y-1 py-1">
      {todos.map((todo, i) => (
        <div key={i} className="flex items-start gap-2">
          {todo.status === 'completed' ? (
            <CircleCheck className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-500" />
          ) : todo.status === 'in_progress' ? (
            <CircleDot className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-blue-400 animate-pulse" />
          ) : (
            <Circle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground/50" />
          )}
          <span
            className={cn(
              'text-xs leading-relaxed',
              todo.status === 'completed' && 'text-muted-foreground line-through',
              todo.status === 'in_progress' && 'text-foreground font-medium',
              todo.status === 'pending' && 'text-muted-foreground'
            )}
          >
            {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function AskQuestionCard({ parsed, onRespond }: { parsed: Record<string, unknown>; onRespond?: (answer: string) => void }) {
  const questions = getQuestions(parsed);
  if (!questions || questions.length === 0) return null;

  const [activeTab, setActiveTab] = useState(0);
  // selections[i] = Set of selected option indices per question
  const [selections, setSelections] = useState<Map<number, Set<number>>>(() => new Map());
  const [submitted, setSubmitted] = useState(false);

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
  };

  const handleSubmit = () => {
    if (submitted || !onRespond) return;
    // Build a structured response so the LLM knows the question + chosen answer
    const parts: string[] = [];
    questions.forEach((q, qi) => {
      const selected = selections.get(qi);
      if (selected && selected.size > 0) {
        const answers = Array.from(selected).map((i) => {
          const opt = q.options[i];
          return opt ? `${opt.label} — ${opt.description}` : '';
        }).filter(Boolean);
        parts.push(`[${q.header}] ${q.question}\n→ ${answers.join('\n→ ')}`);
      }
    });
    if (parts.length > 0) {
      onRespond(parts.join('\n\n'));
      setSubmitted(true);
    }
  };

  const activeQ = questions[activeTab];
  const activeSelections = selections.get(activeTab) || new Set<number>();
  const hasAnySelection = Array.from(selections.values()).some((s) => s.size > 0);

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <MessageCircleQuestion className="h-3 w-3 flex-shrink-0 text-blue-400" />
        <span className="font-medium text-foreground">Question</span>
        <span className="text-muted-foreground text-[11px]">
          {questions.length} question{questions.length > 1 ? 's' : ''}
        </span>
        {submitted && (
          <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 font-medium ml-auto">
            Answered
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="border-t border-border/40">
        {questions.length > 1 && (
          <div className="flex gap-0 border-b border-border/40">
            {questions.map((q, i) => (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={cn(
                  'px-3 py-1.5 text-[11px] font-medium transition-colors relative',
                  i === activeTab
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {q.header}
                {selections.get(i)?.size ? (
                  <Check className="inline h-2.5 w-2.5 ml-1 text-green-500" />
                ) : null}
                {i === activeTab && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Active question */}
        <div className="px-3 py-2 space-y-2">
          <p className="text-xs text-foreground leading-relaxed">{activeQ.question}</p>

          {/* Options */}
          <div className="space-y-1">
            {activeQ.options.map((opt, oi) => {
              const isSelected = activeSelections.has(oi);
              return (
                <button
                  key={oi}
                  onClick={() => toggleOption(activeTab, oi, activeQ.multiSelect)}
                  disabled={submitted}
                  className={cn(
                    'flex items-start gap-2 w-full text-left rounded-md px-2.5 py-1.5 transition-colors border',
                    isSelected
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-border/40 bg-background/50 hover:border-border hover:bg-accent/30',
                    submitted && 'opacity-70 cursor-default'
                  )}
                >
                  {/* Radio / Checkbox indicator */}
                  <div className={cn(
                    'mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center',
                    activeQ.multiSelect && 'rounded-sm',
                    isSelected
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/40'
                  )}>
                    {isSelected && (
                      <Check className="h-2 w-2 text-primary-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-foreground">{opt.label}</span>
                    <p className="text-[11px] text-muted-foreground leading-snug">{opt.description}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Submit button */}
          {onRespond && !submitted && (
            <div className="flex justify-end pt-1">
              <button
                onClick={handleSubmit}
                disabled={!hasAnySelection}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-colors',
                  hasAnySelection
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                <Send className="h-3 w-3" />
                Responder
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BashCard({ parsed, output }: { parsed: Record<string, unknown>; output?: string }) {
  const [expanded, setExpanded] = useState(!!output);
  const command = parsed.command as string | undefined;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <Terminal className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground flex-shrink-0">Run Command</span>
        {!expanded && command && (
          <span className="text-muted-foreground truncate font-mono text-[11px] min-w-0 flex-1">
            {command}
          </span>
        )}
      </button>
      {expanded && command && (
        <div className="border-t border-border/40 overflow-hidden px-3 py-2 space-y-2">
          {/* Command input section */}
          <div>
            <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Input</div>
            <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 font-mono text-[11px] overflow-x-auto">
              <pre className="whitespace-pre-wrap break-all text-foreground leading-relaxed">{command}</pre>
            </div>
          </div>

          {/* Command output section */}
          <div>
            <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Output</div>
            {output ? (
              <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto">
                <pre className="font-mono text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap break-all">{output}</pre>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground/50 italic py-1">
                Waiting for output...
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath;
}

function WriteFileCard({ parsed }: { parsed: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = parsed.file_path as string | undefined;
  const content = parsed.content as string | undefined;
  const ext = filePath ? getFileExtension(filePath) : '';
  const fileName = filePath ? getFileName(filePath) : 'unknown';

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground flex-shrink-0">Write File</span>
        {filePath && (
          <a
            href={toVscodeUri(filePath)}
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground truncate font-mono text-[11px] min-w-0 hover:text-primary hover:underline"
            title={`Open in VS Code: ${filePath}`}
          >
            {filePath}
          </a>
        )}
      </button>
      {expanded && content != null && (
        <div className="border-t border-border/40 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1 bg-background/50 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground">{fileName}</span>
            {ext && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                {ext}
              </span>
            )}
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <pre className="px-3 py-2 font-mono text-[11px] text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
              {content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function buildUnifiedDiff(filePath: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const name = filePath.replace(/\\/g, '/');

  let diff = `--- a/${name}\n+++ b/${name}\n`;
  diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;

  for (const line of oldLines) {
    diff += `-${line}\n`;
  }
  for (const line of newLines) {
    diff += `+${line}\n`;
  }

  return diff;
}

function EditFileCard({ parsed }: { parsed: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const filePath = parsed.file_path as string | undefined;
  const oldString = parsed.old_string as string | undefined;
  const newString = parsed.new_string as string | undefined;

  const diffHtml = useMemo(() => {
    if (!filePath || oldString == null || newString == null) return null;
    const unifiedDiff = buildUnifiedDiff(filePath, oldString, newString);
    return diff2html(unifiedDiff, {
      outputFormat: 'line-by-line',
      drawFileList: false,
      matching: 'lines',
    } as any);
  }, [filePath, oldString, newString]);

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <FilePen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground flex-shrink-0">Edit File</span>
        {filePath && (
          <a
            href={toVscodeUri(filePath)}
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground truncate font-mono text-[11px] min-w-0 hover:text-primary hover:underline"
            title={`Open in VS Code: ${filePath}`}
          >
            {filePath}
          </a>
        )}
      </button>
      {expanded && diffHtml && (
        <div className="border-t border-border/40 overflow-hidden">
          <div
            className="diff-viewer text-xs max-h-80 overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: diffHtml }}
          />
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ name, input, output, onRespond }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(name === 'TodoWrite');
  const parsed = formatInput(input);
  const label = TOOL_LABELS[name] ?? name;
  const summary = getSummary(name, parsed);

  const isTodo = name === 'TodoWrite';
  const isBash = name === 'Bash';
  const isWrite = name === 'Write';
  const isEdit = name === 'Edit';
  const isAskQuestion = name === 'AskUserQuestion';
  const todos = isTodo ? getTodos(parsed) : null;
  const filePath = getFilePath(name, parsed);

  // Specialized cards
  if (isBash) {
    return <BashCard parsed={parsed} output={output} />;
  }
  if (isWrite) {
    return <WriteFileCard parsed={parsed} />;
  }
  if (isEdit) {
    return <EditFileCard parsed={parsed} />;
  }
  if (isAskQuestion) {
    return <AskQuestionCard parsed={parsed} onRespond={onRespond} />;
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {isTodo ? (
          <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground flex-shrink-0">{label}</span>
        {summary && (
          filePath ? (
            <a
              href={toVscodeUri(filePath)}
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground truncate font-mono text-[11px] min-w-0 hover:text-primary hover:underline"
              title={`Open in VS Code: ${filePath}`}
            >
              {summary}
            </a>
          ) : (
            <span className="text-muted-foreground truncate font-mono text-[11px] min-w-0">
              {summary}
            </span>
          )
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-0 border-t border-border/40 overflow-hidden">
          {isTodo && todos ? (
            <TodoList todos={todos} />
          ) : (
            <>
              <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-all mt-1.5">
                {JSON.stringify(parsed, null, 2)}
              </pre>
              {output && (
                <div className="mt-2">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">Output</div>
                  <div className="rounded bg-background/80 border border-border/40 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto">
                    <pre className="font-mono text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap break-all">{output}</pre>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
