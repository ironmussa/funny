/** Wrap project-level instructions in the tag block the agent recognizes. */
export function projectInstructionsBlock(projectSystemPrompt: string): string {
  return `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]`;
}

function assetsBlock(assetsDir: string): string {
  return `[PREVIEWABLE ASSETS]\nWrite any images, videos, or other media you want the user to preview inline to ${assetsDir} (also available as the $FUNNY_ASSETS_DIR environment variable). Files there are served to the UI for inline preview even though they live outside the project tree. Reference them in your replies by their absolute path.\n[/PREVIEWABLE ASSETS]`;
}

/**
 * Assemble the system prefix sent alongside the prompt. Returns undefined when
 * no section applies.
 */
export function buildSystemPrefix(parts: {
  /** Deep Agent template prompt (only when the thread has a template). */
  templateSystemPrompt?: string;
  projectSystemPrompt?: string | null;
  assetsDir?: string;
  resumePrefix?: string | null;
}): string | undefined {
  const { templateSystemPrompt, projectSystemPrompt, assetsDir, resumePrefix } = parts;
  return (
    [
      templateSystemPrompt
        ? `[AGENT TEMPLATE]\n${templateSystemPrompt}\n[/AGENT TEMPLATE]`
        : undefined,
      projectSystemPrompt ? projectInstructionsBlock(projectSystemPrompt) : undefined,
      assetsDir ? assetsBlock(assetsDir) : undefined,
      resumePrefix,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined
  );
}
