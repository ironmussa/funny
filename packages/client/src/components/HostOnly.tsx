import type { ComponentProps } from 'react';

import { OpenInEditorSubmenu } from '@/components/OpenInEditorSubmenu';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useOpenThreadOnHost } from '@/hooks/use-open-thread-on-host';

/**
 * Affordances that open a path on the user's own machine (external editor,
 * file manager). They render nothing while the open thread runs in a sandbox,
 * whose checkout is not on this machine (`canOpenOnHost`).
 */
export function HostDropdownMenuItem(props: ComponentProps<typeof DropdownMenuItem>) {
  return useOpenThreadOnHost() ? <DropdownMenuItem {...props} /> : null;
}

export function HostOpenInEditorSubmenu(props: ComponentProps<typeof OpenInEditorSubmenu>) {
  return useOpenThreadOnHost() ? <OpenInEditorSubmenu {...props} /> : null;
}
