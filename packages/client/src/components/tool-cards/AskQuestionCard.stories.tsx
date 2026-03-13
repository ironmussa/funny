import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import '@/i18n/config';
import { AskQuestionCard } from './AskQuestionCard';

/* -------------------------------------------------------------------------- */
/*  Sample question data                                                      */
/* -------------------------------------------------------------------------- */

const SINGLE_QUESTION = {
  questions: [
    {
      question: 'Which database should we use for this project?',
      header: 'Database',
      options: [
        { label: 'PostgreSQL', description: 'Relational DB with strong ACID compliance' },
        { label: 'SQLite', description: 'Lightweight, file-based, zero config' },
        { label: 'MongoDB', description: 'Document-oriented NoSQL database' },
      ],
      multiSelect: false,
    },
  ],
};

const MULTI_QUESTION = {
  questions: [
    {
      question: 'Which authentication method should we implement?',
      header: 'Auth method',
      options: [
        { label: 'JWT', description: 'Stateless token-based authentication' },
        { label: 'Session cookies', description: 'Server-side session with HTTP-only cookies' },
        { label: 'OAuth 2.0', description: 'Delegated auth via third-party providers' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which CSS framework should we use for styling?',
      header: 'Styling',
      options: [
        { label: 'Tailwind CSS', description: 'Utility-first CSS framework' },
        { label: 'CSS Modules', description: 'Scoped CSS with module imports' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which testing libraries do you want to enable?',
      header: 'Testing',
      options: [
        { label: 'Vitest', description: 'Fast Vite-native unit testing' },
        { label: 'Playwright', description: 'End-to-end browser testing' },
        { label: 'Testing Library', description: 'DOM testing utilities for React' },
      ],
      multiSelect: true,
    },
  ],
};

const MULTISELECT_QUESTION = {
  questions: [
    {
      question: 'Which features do you want to enable?',
      header: 'Features',
      options: [
        { label: 'Dark mode', description: 'Support light and dark color schemes' },
        { label: 'Notifications', description: 'Push and in-app notification system' },
        { label: 'Analytics', description: 'Usage tracking and dashboards' },
        { label: 'i18n', description: 'Multi-language support with translations' },
      ],
      multiSelect: true,
    },
  ],
};

const TWO_OPTIONS_QUESTION = {
  questions: [
    {
      question: 'Should we use strict TypeScript mode?',
      header: 'TypeScript',
      options: [
        { label: 'Yes (Recommended)', description: 'Enable strict mode for better type safety' },
        { label: 'No', description: 'Use default tsconfig settings' },
      ],
      multiSelect: false,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/*  Pre-answered output strings                                               */
/* -------------------------------------------------------------------------- */

const ANSWERED_SINGLE_OUTPUT = `[Database] Which database should we use for this project?
→ SQLite — Lightweight, file-based, zero config`;

const ANSWERED_MULTI_OUTPUT = `[Auth method] Which authentication method should we implement?
→ JWT — Stateless token-based authentication

[Styling] Which CSS framework should we use for styling?
→ Tailwind CSS — Utility-first CSS framework

[Testing] Which testing libraries do you want to enable?
→ Vitest — Fast Vite-native unit testing
→ Playwright — End-to-end browser testing`;

const ANSWERED_WITH_OTHER_OUTPUT = `[Database] Which database should we use for this project?
→ Other — We should use DuckDB for analytical queries`;

const RAW_ANSWER_OUTPUT =
  'I think we should use PostgreSQL because our team has the most experience with it.';

/* -------------------------------------------------------------------------- */
/*  Interactive wrapper for stories that need onRespond                       */
/* -------------------------------------------------------------------------- */

function InteractiveWrapper({
  parsed,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
}) {
  const [output, setOutput] = useState<string | undefined>(undefined);

  return (
    <div className="space-y-3">
      <AskQuestionCard
        parsed={parsed}
        onRespond={(answer) => {
          setOutput(answer);
          // eslint-disable-next-line no-console -- storybook demo
        }}
        output={output}
        hideLabel={hideLabel}
      />
      {output && (
        <div className="rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            Submitted answer
          </div>
          <pre className="whitespace-pre-wrap text-xs text-foreground">{output}</pre>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Storybook meta                                                            */
/* -------------------------------------------------------------------------- */

const meta = {
  title: 'ToolCards/AskQuestionCard',
  component: AskQuestionCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof AskQuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/* -------------------------------------------------------------------------- */
/*  Stories                                                                    */
/* -------------------------------------------------------------------------- */

/** Single question with three options — interactive */
export const SingleQuestion: Story = {
  name: 'Single Question — Interactive',
  args: {
    parsed: SINGLE_QUESTION,
  },
  render: () => <InteractiveWrapper parsed={SINGLE_QUESTION} />,
};

/** Multiple questions with tabs — interactive */
export const MultipleQuestions: Story = {
  name: 'Multiple Questions — Interactive',
  args: {
    parsed: MULTI_QUESTION,
  },
  render: () => <InteractiveWrapper parsed={MULTI_QUESTION} />,
};

/** Multi-select question (checkboxes) — interactive */
export const MultiSelect: Story = {
  name: 'Multi-Select — Interactive',
  args: {
    parsed: MULTISELECT_QUESTION,
  },
  render: () => <InteractiveWrapper parsed={MULTISELECT_QUESTION} />,
};

/** Simple yes/no style question — interactive */
export const TwoOptions: Story = {
  name: 'Two Options — Interactive',
  args: {
    parsed: TWO_OPTIONS_QUESTION,
  },
  render: () => <InteractiveWrapper parsed={TWO_OPTIONS_QUESTION} />,
};

/** Already answered — single question */
export const AnsweredSingle: Story = {
  name: 'Answered — Single Question',
  args: {
    parsed: SINGLE_QUESTION,
    output: ANSWERED_SINGLE_OUTPUT,
  },
};

/** Already answered — multiple questions */
export const AnsweredMultiple: Story = {
  name: 'Answered — Multiple Questions',
  args: {
    parsed: MULTI_QUESTION,
    output: ANSWERED_MULTI_OUTPUT,
  },
};

/** Already answered — with "Other" option */
export const AnsweredWithOther: Story = {
  name: 'Answered — Other Option',
  args: {
    parsed: SINGLE_QUESTION,
    output: ANSWERED_WITH_OTHER_OUTPUT,
  },
};

/** Raw text answer fallback (output doesn't match any option) */
export const RawAnswerFallback: Story = {
  name: 'Answered — Raw Text Fallback',
  args: {
    parsed: SINGLE_QUESTION,
    output: RAW_ANSWER_OUTPUT,
  },
};

/** Without the label header (used inside ToolCallGroup) */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: SINGLE_QUESTION,
  },
  render: () => <InteractiveWrapper parsed={SINGLE_QUESTION} hideLabel />,
};
