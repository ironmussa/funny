import type ts from 'typescript/lib/tsserverlibrary';

import { getEvflowCompletions } from './completions.js';
import { getEvflowDiagnostics } from './diagnostics.js';
import { buildProjectRegistry } from './registry.js';

function init(modules: { typescript: typeof ts }) {
  const tsModule = modules.typescript;

  function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const oldLS = info.languageService;
    const proxy = Object.create(null) as ts.LanguageService;

    // Pass through all methods by default
    for (const k in oldLS) {
      const x = oldLS[k as keyof ts.LanguageService];
      (proxy as any)[k] = typeof x === 'function' ? (...args: any[]) => x.apply(oldLS, args) : x;
    }

    info.project.projectService.logger.info('[evflow] Plugin loaded');

    // ── Diagnostics ──────────────────────────────────────────

    proxy.getSemanticDiagnostics = (fileName: string): ts.Diagnostic[] => {
      const original = oldLS.getSemanticDiagnostics(fileName);
      const program = oldLS.getProgram();
      if (!program) return original;

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile) return original;
      if (fileName.includes('node_modules')) return original;

      try {
        const registry = buildProjectRegistry(tsModule, program);
        if (registry.size === 0) return original;

        const evflowDiags = getEvflowDiagnostics(tsModule, sourceFile, registry);
        return [...original, ...evflowDiags];
      } catch (e) {
        info.project.projectService.logger.info(`[evflow] Error in getSemanticDiagnostics: ${e}`);
        return original;
      }
    };

    // ── Completions ──────────────────────────────────────────

    proxy.getCompletionsAtPosition = (
      fileName: string,
      position: number,
      options: ts.GetCompletionsAtPositionOptions | undefined,
      formattingSettings?: ts.FormatCodeSettings,
    ): ts.WithMetadata<ts.CompletionInfo> | undefined => {
      const original = oldLS.getCompletionsAtPosition(
        fileName,
        position,
        options,
        formattingSettings,
      );
      const program = oldLS.getProgram();
      if (!program) return original;

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile) return original;

      try {
        const registry = buildProjectRegistry(tsModule, program);
        if (registry.size === 0) return original;

        const evflowEntries = getEvflowCompletions(tsModule, sourceFile, position, registry);
        if (!evflowEntries) return original;

        if (original) {
          return {
            ...original,
            entries: [...evflowEntries, ...original.entries],
          };
        }

        return {
          isGlobalCompletion: false,
          isMemberCompletion: false,
          isNewIdentifierLocation: false,
          entries: evflowEntries,
        };
      } catch (e) {
        info.project.projectService.logger.info(`[evflow] Error in getCompletionsAtPosition: ${e}`);
        return original;
      }
    };

    return proxy;
  }

  return { create };
}

export { init };
