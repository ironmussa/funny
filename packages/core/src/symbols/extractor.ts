import { createRequire } from 'module';
import { join, dirname } from 'path';

import { internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import type { SymbolInfo, SymbolKind } from './types.js';

// ── Lazy-loaded tree-sitter ──────────────────────────────────

type TreeSitterParserConstructor = {
  init: () => Promise<void>;
  new (): any;
  Language?: { load: (path: string) => Promise<any> };
};

let Parser: TreeSitterParserConstructor | null = null;
let LanguageLoader: { load: (path: string) => Promise<any> } | null = null;
let parserReady = false;
let parserInitPromise: Promise<TreeSitterParserConstructor> | null = null;
const languageCache = new Map<string, any>();
const requireFromCore = createRequire(import.meta.url);

async function ensureParser(): Promise<TreeSitterParserConstructor> {
  if (Parser && parserReady) return Parser;
  if (parserInitPromise) return parserInitPromise;

  parserInitPromise = (async () => {
    const mod = requireFromCore('web-tree-sitter');
    const moduleExports = mod as {
      Parser?: TreeSitterParserConstructor;
      Language?: { load: (path: string) => Promise<any> };
      default?: TreeSitterParserConstructor;
    };
    const parser =
      moduleExports.Parser ?? moduleExports.default ?? (mod as TreeSitterParserConstructor);
    await parser.init();

    Parser = moduleExports.Parser ?? moduleExports.default ?? (mod as TreeSitterParserConstructor);
    LanguageLoader = moduleExports.Language ?? Parser.Language ?? null;
    if (!LanguageLoader) {
      throw new Error('web-tree-sitter language loader is unavailable');
    }
    parserReady = true;
    return Parser;
  })().catch((error) => {
    parserInitPromise = null;
    throw error;
  });

  return parserInitPromise;
}

// ── Extension → language mapping ─────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
};

function getLanguageName(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

async function loadLanguage(langName: string): Promise<any> {
  const cached = languageCache.get(langName);
  if (cached) return cached;

  await ensureParser();

  // Resolve WASM path from tree-sitter-wasms package
  const wasmFileName = `tree-sitter-${langName}.wasm`;

  // Try to resolve from tree-sitter-wasms package
  let wasmPath: string;
  try {
    const treeSitterWasmsPath = requireFromCore.resolve('tree-sitter-wasms/package.json');
    wasmPath = join(dirname(treeSitterWasmsPath), 'out', wasmFileName);
  } catch {
    // Fallback: resolve relative to node_modules
    wasmPath = join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', wasmFileName);
  }

  const lang = await LanguageLoader!.load(wasmPath);
  languageCache.set(langName, lang);
  return lang;
}

// ── Symbol node definitions per language ─────────────────────

interface SymbolNodeDef {
  nodeType: string;
  kind: SymbolKind;
  /** Field name to extract the symbol name from (default: 'name') */
  nameField?: string;
  /** If true, walk children one level deep for nested symbols (e.g. methods in classes) */
  walkChildren?: boolean;
  /** Kind assigned to children when walkChildren is true */
  childKind?: SymbolKind;
}

const LANG_SYMBOL_DEFS: Record<string, SymbolNodeDef[]> = {
  typescript: [
    { nodeType: 'function_declaration', kind: 'function' },
    { nodeType: 'class_declaration', kind: 'class', walkChildren: true, childKind: 'method' },
    { nodeType: 'interface_declaration', kind: 'interface' },
    { nodeType: 'type_alias_declaration', kind: 'type' },
    { nodeType: 'enum_declaration', kind: 'enum' },
    { nodeType: 'lexical_declaration', kind: 'variable' },
    { nodeType: 'variable_declaration', kind: 'variable' },
  ],
  tsx: [], // Will fall back to typescript defs
  javascript: [
    { nodeType: 'function_declaration', kind: 'function' },
    { nodeType: 'class_declaration', kind: 'class', walkChildren: true, childKind: 'method' },
    { nodeType: 'lexical_declaration', kind: 'variable' },
    { nodeType: 'variable_declaration', kind: 'variable' },
  ],
  python: [
    { nodeType: 'function_definition', kind: 'function' },
    { nodeType: 'class_definition', kind: 'class', walkChildren: true, childKind: 'method' },
  ],
  go: [
    { nodeType: 'function_declaration', kind: 'function' },
    { nodeType: 'method_declaration', kind: 'method' },
    { nodeType: 'type_declaration', kind: 'type' },
  ],
  rust: [
    { nodeType: 'function_item', kind: 'function' },
    { nodeType: 'struct_item', kind: 'class' },
    { nodeType: 'enum_item', kind: 'enum' },
    { nodeType: 'trait_item', kind: 'interface' },
    { nodeType: 'impl_item', kind: 'class', walkChildren: true, childKind: 'method' },
    { nodeType: 'type_item', kind: 'type' },
  ],
  java: [
    { nodeType: 'class_declaration', kind: 'class', walkChildren: true, childKind: 'method' },
    {
      nodeType: 'interface_declaration',
      kind: 'interface',
      walkChildren: true,
      childKind: 'method',
    },
    { nodeType: 'enum_declaration', kind: 'enum' },
    { nodeType: 'method_declaration', kind: 'method' },
  ],
  c: [
    { nodeType: 'function_definition', kind: 'function' },
    { nodeType: 'struct_specifier', kind: 'class', nameField: 'name' },
    { nodeType: 'enum_specifier', kind: 'enum', nameField: 'name' },
    { nodeType: 'type_definition', kind: 'type' },
  ],
  cpp: [
    { nodeType: 'function_definition', kind: 'function' },
    { nodeType: 'class_specifier', kind: 'class', walkChildren: true, childKind: 'method' },
    { nodeType: 'struct_specifier', kind: 'class', nameField: 'name' },
    { nodeType: 'enum_specifier', kind: 'enum', nameField: 'name' },
    { nodeType: 'namespace_definition', kind: 'module' },
  ],
  c_sharp: [
    { nodeType: 'class_declaration', kind: 'class', walkChildren: true, childKind: 'method' },
    {
      nodeType: 'interface_declaration',
      kind: 'interface',
      walkChildren: true,
      childKind: 'method',
    },
    { nodeType: 'enum_declaration', kind: 'enum' },
    { nodeType: 'method_declaration', kind: 'method' },
    { nodeType: 'namespace_declaration', kind: 'module' },
  ],
  ruby: [
    { nodeType: 'method', kind: 'function' },
    { nodeType: 'class', kind: 'class', walkChildren: true, childKind: 'method' },
    { nodeType: 'module', kind: 'module', walkChildren: true, childKind: 'method' },
  ],
  php: [
    { nodeType: 'function_definition', kind: 'function' },
    { nodeType: 'class_declaration', kind: 'class', walkChildren: true, childKind: 'method' },
    {
      nodeType: 'interface_declaration',
      kind: 'interface',
      walkChildren: true,
      childKind: 'method',
    },
    { nodeType: 'method_declaration', kind: 'method' },
  ],
};

// TSX uses TypeScript defs
LANG_SYMBOL_DEFS['tsx'] = LANG_SYMBOL_DEFS['typescript'];

function getSymbolDefs(langName: string): SymbolNodeDef[] {
  return LANG_SYMBOL_DEFS[langName] ?? [];
}

// ── Name extraction helpers ──────────────────────────────────

/**
 * Try to extract a symbol name from a tree-sitter node.
 * Checks the 'name' field first, then common child patterns.
 */
function extractName(node: any, nameField = 'name'): string | null {
  // Direct named field
  const field = node.childForFieldName?.(nameField);
  if (field) return field.text;

  // For variable declarations, look for the declarator's name
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'variable_declarator') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
      }
    }
    return null;
  }

  // For type_declaration (Go), check the first type_spec child
  if (node.type === 'type_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_spec') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
      }
    }
    return null;
  }

  // For export_statement, check child declarations
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName?.('declaration');
    if (decl) return extractName(decl);
    return null;
  }

  return null;
}

/**
 * Check if a node is a method-like definition inside a class/struct/impl body.
 */
function isMethodNode(nodeType: string): boolean {
  return [
    'method_definition',
    'method_declaration',
    'function_definition',
    'function_item',
    'function',
    'method',
    'public_method_definition',
  ].includes(nodeType);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Extract symbols (functions, classes, types, etc.) from a source file.
 *
 * @param content - File source code
 * @param filePath - Path used to determine the language (by extension)
 * @returns Array of symbols found
 */
export function extractSymbols(
  content: string,
  filePath: string,
): ResultAsync<SymbolInfo[], DomainError> {
  return ResultAsync.fromPromise(extractSymbolsImpl(content, filePath), (error) =>
    internal(`Symbol extraction failed: ${error}`),
  );
}

async function extractSymbolsImpl(content: string, filePath: string): Promise<SymbolInfo[]> {
  const langName = getLanguageName(filePath);
  if (!langName) return [];

  const defs = getSymbolDefs(langName);
  if (defs.length === 0) return [];

  let language: any;
  try {
    language = await loadLanguage(langName);
  } catch {
    // Grammar not available
    return [];
  }

  const P = await ensureParser();
  const parser = new P();
  parser.setLanguage(language);

  const tree = parser.parse(content);
  const symbols: SymbolInfo[] = [];
  // web-tree-sitter >=0.25 returns Tree | null (e.g. on oversized input).
  if (!tree) return symbols;
  const defMap = new Map(defs.map((d) => [d.nodeType, d]));

  function processNode(node: any, containerName?: string) {
    const def = defMap.get(node.type);

    if (def) {
      const name = extractName(node, def.nameField);
      if (name) {
        symbols.push({
          name,
          kind: containerName && def.kind === 'function' ? 'method' : def.kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          containerName,
        });

        // Walk children for nested symbols (e.g. methods inside classes)
        if (def.walkChildren) {
          const body =
            node.childForFieldName?.('body') ??
            node.childForFieldName?.('members') ??
            node.childForFieldName?.('block');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (!child) continue;

              // Check if child is a method-like node
              if (isMethodNode(child.type)) {
                const methodName = extractName(child);
                if (methodName) {
                  symbols.push({
                    name: methodName,
                    kind: def.childKind ?? 'method',
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    containerName: name,
                  });
                }
              }
              // Also check for nested defs (e.g. static methods, properties)
              const childDef = defMap.get(child.type);
              if (childDef && !isMethodNode(child.type)) {
                const childName = extractName(child, childDef.nameField);
                if (childName) {
                  symbols.push({
                    name: childName,
                    kind: childDef.kind,
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                    containerName: name,
                  });
                }
              }
            }
          }
        }
      }
      return; // Don't recurse further into this node
    }

    // For export_statement, check if it wraps a known declaration
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName?.('declaration');
      if (decl) {
        processNode(decl, containerName);
        return;
      }
    }

    // Recurse into top-level containers we don't have defs for
    // (e.g. program, module, expression_statement wrapping arrow functions)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) processNode(child, containerName);
    }
  }

  processNode(tree.rootNode);
  parser.delete();

  return symbols;
}

/**
 * Check if a file extension is supported for symbol extraction.
 */
export function isSupportedFile(filePath: string): boolean {
  return getLanguageName(filePath) !== null;
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_LANG);
}
