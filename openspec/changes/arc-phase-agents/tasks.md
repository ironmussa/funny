## 1. Shared Types

- [ ] 1.1 Add `'plan'` to `ThreadPurpose` union type in `packages/shared/src/types.ts`

## 2. Arc Prompts

- [ ] 2.1 Create `getPlanPrompt(arcName)` function in `packages/runtime/src/services/arc-prompts.ts`
- [ ] 2.2 Refine `getExplorePrompt()` to focus on discovery only — remove references to producing `tasks.md` and `specs/` as primary outputs

## 3. Agent Runner Integration

- [ ] 3.1 Update purpose check in `packages/runtime/src/services/agent-runner.ts` (~line 397) to handle `'plan'` purpose with `getPlanPrompt`

## 4. Client UI

- [ ] 4.1 Add `'plan'` option to purpose `<Select>` in `packages/client/src/components/NewThreadDialog.tsx`
- [ ] 4.2 Update local-mode enforcement logic to apply for both `explore` and `plan` purposes (change `purpose === 'explore'` checks to `purpose !== 'implement'`)

## 5. Validation

- [ ] 5.1 Verify the project builds without type errors (`bun run build`)
