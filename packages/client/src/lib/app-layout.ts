export function resolveLeftPaneOpen(sidebarOpen: boolean, hideLeftPane: boolean): boolean {
  return sidebarOpen && !hideLeftPane;
}
