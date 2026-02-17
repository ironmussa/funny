# Plan: Persist draft text per thread

## Problem
When switching between threads, two things are lost:
1. **PromptInput**: The text typed in the prompt textarea (plus images and file references) disappears
2. **ReviewPane**: The commit title and commit body fields are cleared when `gitContextKey` changes

Both use local `useState` with no per-thread persistence.

## Approach: Zustand drafts store

Create a new lightweight Zustand store (`draft-store.ts`) that holds a `Record<threadId, DraftState>` in memory. No localStorage or server persistence — drafts only need to survive within a session.

### 1. New store: `packages/client/src/stores/draft-store.ts`

```ts
interface ThreadDraft {
  prompt?: string;
  images?: ImageAttachment[];
  selectedFiles?: string[];
  commitTitle?: string;
  commitBody?: string;
}

interface DraftState {
  drafts: Record<string, ThreadDraft>;
  setPromptDraft: (threadId: string, prompt: string, images: ImageAttachment[], selectedFiles: string[]) => void;
  setCommitDraft: (threadId: string, title: string, body: string) => void;
  clearPromptDraft: (threadId: string) => void;
  clearCommitDraft: (threadId: string) => void;
}
```

### 2. Changes to `PromptInput.tsx`

- Import `useDraftStore`
- Use a `useRef` to track the previous `selectedThreadId`
- On thread switch (`selectedThreadId` changes): save current prompt/images/selectedFiles to the **old** thread's draft, then restore from the **new** thread's draft
- On submit: call `clearPromptDraft(threadId)` to clean up
- Initialize `prompt` state from the draft if one exists for the current thread

### 3. Changes to `ReviewPane.tsx`

- Import `useDraftStore`
- When `gitContextKey` changes and state is reset: restore `commitTitle`/`commitBody` from the draft for the current `effectiveThreadId`
- Sync `commitTitle`/`commitBody` to the draft store on every change (simple — these are short strings)
- On successful commit action: call `clearCommitDraft(threadId)`

### Files to create/modify

| File | Action |
|------|--------|
| `packages/client/src/stores/draft-store.ts` | **Create** |
| `packages/client/src/components/PromptInput.tsx` | **Edit** |
| `packages/client/src/components/ReviewPane.tsx` | **Edit** |
