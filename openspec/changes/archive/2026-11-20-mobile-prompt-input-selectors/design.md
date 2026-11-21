## Context

See proposal.md for motivation. `PromptInputUI.tsx` renders mode and template with Radix Select and model/effort with nested DropdownMenu controls. Branch controls arrive through the caller-provided context bar. `SearchablePicker.tsx` includes filtering and virtualized rows and is reused outside the prompt. `useIsMobile` already defines mobile as below 768px. The client has Sheet and Command primitives but no Drawer primitive.

## Goals / Non-Goals

**Goals:** Share mobile presentation and dismissal behavior while preserving existing domain callbacks and availability rules. Keep one active presentation mounted and avoid expanding the large prompt component with duplicated selector logic.

**Non-Goals:** Global changes to Select, DropdownMenu, or Popover; redesigning project/repository selection, attachments, send actions, or other prompt controls; changing settings screens or GPU renderer UI.

## Decisions

### Use a shared shadcn Drawer shell

Add the Radix-compatible shadcn Drawer primitive and its required dependency, then a small prompt selection shell accepting a title, controlled open state, trigger, and content. Reuse it for each mobile selector. Existing Sheet with bottom placement is a viable lower-dependency alternative, but Drawer matches the agreed mobile interaction, including swipe dismissal. Do not wrap an open Select or DropdownMenu inside Drawer: render mobile content directly to avoid competing focus traps and portals.

Use `useIsMobile` for conditional presentation; retain existing desktop branches. Close transient selection state on breakpoint transitions without committing pending values. Adapt shared branch pickers through an explicit opt-in from the prompt context so other consumers keep their current behavior.

### Separate shell from selection content

Mode and template use simple selectable rows. Model content retains provider groups and disabled reasons. Branch content reuses current filtering, virtualized list, loading/error/empty states, special entries, and action semantics instead of introducing a second filtering engine. Command is available for searchable lists but is not required where the existing picker already supplies search and keyboard behavior.

### Stage model selection until effort is chosen

For models with an effort choice, tapping a model navigates to effort rows inside the same drawer with a Back control. Keep the model as local pending state. Selecting effort calls the existing model and effort callbacks as one completed user interaction and closes. Back or dismissal discards pending choices. Models without an effort step commit immediately. Existing provider configuration actions remain available according to existing rules; close the picker before opening setup UI to avoid modal stacking.

### Size and focus for touch

Use full-width bottom placement, content-sized height capped near `85dvh`, safe-area bottom padding, a fixed title/close area, and a scrollable body. Mobile triggers, option rows, Back, and Close have at least 48px touch targets; adapt toolbar wrapping as needed. Show current selection and expose it accessibly. Focus a non-input element on open so branch search does not summon the keyboard automatically. Keep search usable with the keyboard visible and restore focus to the originating trigger on close. Translate new labels in English and Spanish.

## Risks / Trade-offs

- Larger controls can crowd the prompt toolbar → allow mobile wrapping and verify narrow widths without horizontal overflow.
- Drawer gestures can compete with list scrolling → verify long lists on touch devices and keep the header outside the scroll body.
- Taller virtualized rows can overlap if estimates stay compact → update mobile measurements and test scrolling to the last branch.
- Model/effort callbacks can produce partial changes → reuse the existing completion path and test cancellation, Back, and single callback invocation.
- Shared picker changes can affect settings → opt in only at prompt call sites and add an outside-prompt regression case.
- Keyboard, nested prompt dialogs, and breakpoint changes can disrupt focus → verify each context and resize with an open drawer; discard pending values on presentation changes.

## Migration Plan

Implement shell, migrate the four selector families, and run focused tests plus repository lint/typecheck and mobile/desktop browser checks. No data migration is needed. Rollback consists of reverting these UI integrations and removing the new primitive/dependency if unused.
