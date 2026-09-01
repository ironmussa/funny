import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const presenceState = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('motion/react', async () => {
  const React = await import('react');
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    { children?: React.ReactNode; className?: string }
  >(({ children, className }, ref) => (
    <div ref={ref} className={className}>
      {children}
    </div>
  ));
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => {
      React.useEffect(() => {
        presenceState.mounts += 1;
        return () => {
          presenceState.unmounts += 1;
        };
      }, []);
      return <>{children}</>;
    },
    m: { div: MotionDiv },
    useReducedMotion: () => true,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/tool-cards/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/tool-cards/utils')>();
  return {
    ...actual,
    useCurrentProjectId: () => undefined,
    useCurrentProjectPath: () => undefined,
    useCurrentThreadProviderModel: () => ({ provider: undefined, model: undefined }),
  };
});

vi.mock('@/hooks/use-dictation', () => ({
  useDictation: () => ({
    isRecording: false,
    isConnecting: false,
    start: vi.fn(),
    toggle: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-push-to-talk', () => ({ usePushToTalk: vi.fn() }));
vi.mock('@/hooks/use-slash-skills', () => ({
  useSlashSkills: () => ({
    slashSkills: [],
    slashSkillsLoading: false,
    ensureSlashSkills: vi.fn(),
  }),
}));
vi.mock('@/stores/profile-store', () => ({
  useProfileStore: (selector: (state: { profile: null }) => unknown) => selector({ profile: null }),
}));

import { AskQuestionCard } from '@/components/tool-cards/AskQuestionCard';

const parsed = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      options: [{ label: 'SQLite', description: 'Local database' }],
      multiSelect: false,
    },
  ],
};

describe('AskQuestionCard', () => {
  test('keeps AnimatePresence mounted when switching from raw output to the question', () => {
    presenceState.mounts = 0;
    presenceState.unmounts = 0;
    const { rerender, unmount } = render(
      <AskQuestionCard parsed={parsed} output="A free-form answer" />,
    );

    expect(screen.getByText('A free-form answer')).toBeInTheDocument();
    expect(presenceState.mounts).toBe(1);

    rerender(<AskQuestionCard parsed={parsed} />);

    expect(screen.getByText('Which database?')).toBeInTheDocument();
    expect(presenceState.mounts).toBe(1);
    expect(presenceState.unmounts).toBe(0);

    unmount();
    expect(presenceState.unmounts).toBe(1);
  });
});
