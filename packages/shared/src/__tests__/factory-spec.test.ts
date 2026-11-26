import { describe, expect, test } from 'bun:test';

import {
  factoryRunSpecSchema,
  factorySpecResultSchema,
  factoryTriageResultSchema,
  isRepositoryRelativePath,
  pendingSpecDraft,
  triageResultSchemaFor,
} from '../contracts/factory.js';

const DRAFT = {
  summary: 'Add a logout button',
  decisions: [{ question: 'Where does it live?', answer: 'In the user menu' }],
  validation: ['Log out ends the session'],
  contract: { acceptanceCriteria: ['A user can log out'] },
};

describe('factorySpecResultSchema (openspec factory-spec-stage)', () => {
  test('accepts a draft and fills the lists it leaves out', () => {
    const parsed = factorySpecResultSchema.parse({ status: 'draft', spec: DRAFT });
    expect(parsed).toMatchObject({
      status: 'draft',
      spec: { behavior: [], approach: [], outOfScope: [], validation: DRAFT.validation },
    });
  });

  test('refuses a draft without a validation checklist', () => {
    const { validation: _left, ...noChecklist } = DRAFT;
    expect(factorySpecResultSchema.safeParse({ status: 'draft', spec: noChecklist }).success).toBe(
      false,
    );
    expect(
      factorySpecResultSchema.safeParse({ status: 'draft', spec: { ...DRAFT, validation: [] } })
        .success,
    ).toBe(false);
  });

  test('questions: at least one, at most ten, each with at most six options', () => {
    const question = (n: number) => ({ question: `Question ${n}?` });
    const many = (count: number) => Array.from({ length: count }, (_, n) => question(n));
    expect(factorySpecResultSchema.safeParse({ status: 'questions', questions: [] }).success).toBe(
      false,
    );
    expect(
      factorySpecResultSchema.safeParse({ status: 'questions', questions: many(10) }).success,
    ).toBe(true);
    expect(
      factorySpecResultSchema.safeParse({ status: 'questions', questions: many(11) }).success,
    ).toBe(false);
    const sevenOptions = { question: 'Where?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
    expect(
      factorySpecResultSchema.safeParse({ status: 'questions', questions: [sevenOptions] }).success,
    ).toBe(false);
  });

  test('only a draft is a draft to approve', () => {
    const spec = factoryRunSpecSchema.parse({
      revision: 1,
      latest: { status: 'draft', spec: DRAFT },
    });
    expect(pendingSpecDraft(spec)?.summary).toBe(DRAFT.summary);
    expect(
      pendingSpecDraft(
        factoryRunSpecSchema.parse({
          revision: 2,
          latest: { status: 'questions', questions: [{ question: 'Where?' }] },
        }),
      ),
    ).toBeNull();
  });
});

describe('the needs_spec triage answer', () => {
  const answer = {
    decision: 'needs_spec',
    decisions: [{ question: 'Where does it live?', options: ['Menu', 'Header'] }],
    findings: ['The session store is src/auth/session.ts'],
  };

  test('is valid only while the Spec stage is on', () => {
    expect(triageResultSchemaFor(true).safeParse(answer).success).toBe(true);
    expect(triageResultSchemaFor(false).safeParse(answer).success).toBe(false);
    expect(
      triageResultSchemaFor(false).safeParse({ decision: 'needs_info', questions: ['Why?'] })
        .success,
    ).toBe(true);
  });

  test('names at least one open decision', () => {
    expect(factoryTriageResultSchema.safeParse({ ...answer, decisions: [] }).success).toBe(false);
  });
});

describe('isRepositoryRelativePath', () => {
  test('a folder inside the repository', () => {
    expect(isRepositoryRelativePath('docs/specs')).toBe(true);
    expect(isRepositoryRelativePath('specs')).toBe(true);
  });

  test('absolute, home, drive and climbing paths are refused', () => {
    for (const path of ['/etc', '~/x', 'C:/x', '../x', 'docs/../../x', 'docs\\x']) {
      expect(isRepositoryRelativePath(path)).toBe(false);
    }
  });
});
