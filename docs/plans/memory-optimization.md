# Plan: Frontend Memory Optimization

## Goal

Reduce memory, DOM, listener, animation, and compositor pressure in the client during long-running development sessions and dense thread views.

## Priority Backlog

1. [x] **Remove `tw-fade` usage**
   - Removed the `tw-fade` package from the client and evflow viewer.
   - Replaced scroll masks with opt-in overlay edge fades.
   - Kept long lists, diffs, and tool outputs off mask-based fades.

2. [x] **Reduce animations in thread view**
   - Paused `D4CAnimation` intervals when reduced motion is enabled, the tab is hidden, or the caller disables animation.
   - Disabled decorative thread animations for hidden tabs and dense loaded threads.
   - Removed pulse/thinking CSS animations from status tail and todo panel when animation is disabled.

3. [ ] **Add reduced motion / performance mode**
   - Add internal setting: `funny:performanceMode`.
   - In this mode:
     - Disable optional edge fade overlays.
     - Reduce `motion` usage.
     - Disable decorative animations.
     - Disable transitions in tool cards.

4. [ ] **Virtualize or collapse heavy tool cards**
   - Focus on long tool outputs: Bash, ReadFile, WriteFile, GenericToolCard.
   - Avoid rendering full content while a card is collapsed.
   - For large outputs, render a preview plus an expand button.

5. [ ] **Audit global listeners**
   - `usePushToTalk` has already been fixed.
   - Review other hooks using `addEventListener`.
   - Add tests or a simple lint rule to detect mismatched `addEventListener('x')` / `removeEventListener('y')`.

6. [ ] **Review Dockview panel duplication**
   - CDP showed many `dv-react-part` nodes.
   - Check whether restored layouts leave duplicate panels or hidden live panels.
   - Clean persisted layout if it contains obsolete panels.

7. [ ] **Limit active cards in thread**
   - In long threads, keep only N cards around the viewport mounted.
   - Or use more aggressive virtualization in `MessageStream`.

8. [ ] **Add automated frontend profiling**
   - Create `scripts/profile-client.ts`.
   - Measure:
     - JS heap.
     - DOM nodes.
     - Event listeners.
     - 10s CPU trace.
   - Use this to compare before and after changes.

9. [ ] **Optimize Chrome GPU / compositor load**
   - GPU usage was around 17%.
   - Investigate masks, blur, `backdrop-filter`, and animations.
   - Reduce `backdrop-blur`, masks, and animated transforms in dense views.

10. [ ] **Control frontend runtime memory**
    - Warn in dev when renderer RSS passes a threshold, for example 1.5 GB.
    - Show a dev console warning suggesting reload or performance mode.

11. [ ] **Finish full reaper coverage**
    - Move `buildAgentChildEnv` to `BaseAgentProcess`.
    - Cover SDK Claude and DeepAgent, not only ACP.
    - This closes subprocess leaks for all providers.

12. [ ] **Change root `dev:runtime`**
    - Avoid `bun --watch`.
    - Use `packages/runtime/src/dev-watch.ts` from the root script.
    - This prevents the dev agent leak from returning.

## Verification

- For code changes, run `bun run lint` and `bun run typecheck`.
- Add or update tests when a task changes behavior, fixes a bug, or introduces meaningful regression risk.
- Use `scripts/profile-client.ts` once available to capture before/after memory and CPU data.
