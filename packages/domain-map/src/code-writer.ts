import type { SyncAction } from './types.js';

const JSDOC_BLOCK_REGEX = /\/\*\*[\s\S]*?\*\//g;
const DOMAIN_TAG_REGEX = /@domain\s+([\w-]+)\s*:\s*(.+)/;

/**
 * Apply yaml-to-code sync actions to source files.
 * Returns a map of filePath → modified content (only files that changed).
 */
export function applyActionsToCode(
  fileContents: Map<string, string>,
  actions: SyncAction[],
): Map<string, string> {
  const result = new Map<string, string>();

  // Group actions by target file
  const actionsByFile = new Map<string, SyncAction[]>();
  for (const action of actions) {
    if (action.direction !== 'yaml-to-code') continue;
    if (action.kind === 'notify-unannotated') continue; // Informational only

    const existing = actionsByFile.get(action.target) ?? [];
    existing.push(action);
    actionsByFile.set(action.target, existing);
  }

  for (const [filePath, fileActions] of actionsByFile) {
    const content = fileContents.get(filePath);
    if (!content) continue;

    let modified = content;

    for (const action of fileActions) {
      switch (action.kind) {
        case 'update-subdomain-type':
          modified = patchSubdomainType(modified, action);
          break;
        case 'add-context':
          modified = patchContext(modified, action);
          break;
      }
    }

    if (modified !== content) {
      result.set(filePath, modified);
    }
  }

  return result;
}

// ── Patchers ────────────────────────────────────────────────────

function patchSubdomainType(content: string, action: SyncAction): string {
  const { newType } = action.payload as { newType: string };

  return replaceInDomainBlock(content, (block) => {
    // Check this block belongs to the right subdomain
    if (!hasDomainTag(block)) return block;

    const typeTag = `@domain subdomain-type: ${newType}`;

    // Replace existing subdomain-type tag
    if (block.includes('@domain subdomain-type:')) {
      return block.replace(
        /@domain\s+subdomain-type\s*:\s*.+/,
        `@domain subdomain-type: ${newType}`,
      );
    }

    // Insert after @domain subdomain line
    return block.replace(/(@domain\s+subdomain\s*:\s*.+)/, `$1\n * ${typeTag}`);
  });
}

function patchContext(content: string, action: SyncAction): string {
  const { context } = action.payload as { context: string };

  return replaceInDomainBlock(content, (block) => {
    if (!hasDomainTag(block)) return block;
    if (block.includes('@domain context:')) return block;

    const contextTag = `@domain context: ${context}`;

    // Insert after subdomain-type line, or after subdomain line
    if (block.includes('@domain subdomain-type:')) {
      return block.replace(/(@domain\s+subdomain-type\s*:\s*.+)/, `$1\n * ${contextTag}`);
    }

    return block.replace(/(@domain\s+subdomain\s*:\s*.+)/, `$1\n * ${contextTag}`);
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function hasDomainTag(block: string): boolean {
  return DOMAIN_TAG_REGEX.test(block);
}

/**
 * Find the first JSDoc block containing @domain tags and apply a transform.
 */
function replaceInDomainBlock(content: string, transform: (block: string) => string): string {
  return content.replace(JSDOC_BLOCK_REGEX, (block) => {
    if (!hasDomainTag(block)) return block;
    return transform(block);
  });
}
