// Which external dependencies a change to `bun.lock` / the root `package.json`
// touches, so the pre-push hook can select only the packages using them instead
// of every suite.
//
// The answer is a set of npm package names: the entries whose resolution
// changed, plus every package that depends on one of them (transitively), since
// a new version of a transitive dependency changes the code its dependents run.
// `null` means "cannot tell": the caller then treats the change as global.

/** One side of the change. `null` when the file does not exist on that side. */
export interface DependencySnapshot {
  lock: string | null;
  rootManifest: string | null;
}

type LockEntry = unknown[];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Root manifest fields that cannot change a package suite's result. Anything
 * else (workspaces, overrides, patched/trusted dependencies…) is global.
 */
const INERT_ROOT_FIELDS = new Set<string>([...DEPENDENCY_FIELDS, 'scripts']);

/** `bun.lock` is JSON with trailing commas. */
function parseLoose(text: string): any {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function tryParse(text: string | null): { ok: true; value: any } | { ok: false } {
  if (text === null) return { ok: true, value: null };
  try {
    return { ok: true, value: parseLoose(text) };
  } catch {
    return { ok: false };
  }
}

/** `name` from a lock entry's `name@version` (scoped names keep their `@`). */
function entryName(key: string, entry: LockEntry): string {
  const spec = typeof entry[0] === 'string' ? entry[0] : '';
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : key;
}

function entryDeps(entry: LockEntry): string[] {
  const meta = entry.find((part) => part && typeof part === 'object' && !Array.isArray(part)) as
    | Record<string, Record<string, string> | undefined>
    | undefined;
  if (!meta) return [];
  return DEPENDENCY_FIELDS.flatMap((field) => Object.keys(meta[field] ?? {}));
}

function declared(manifest: any): Map<string, string> {
  const specs = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
      specs.set(name, `${field}:${spec}`);
    }
  }
  return specs;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Names whose declared spec differs between two manifests (added, removed or changed). */
function changedDeclarations(before: any, after: any): string[] {
  const a = declared(before);
  const b = declared(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name));
}

const keysOf = (...objects: any[]) => new Set(objects.flatMap((o) => Object.keys(o ?? {})));

/** Whether two objects differ in a key `ignored` does not cover. */
function differsOutside(a: any, b: any, ignored: ReadonlySet<string>): boolean {
  return [...keysOf(a, b)].some((key) => !ignored.has(key) && !sameJson(a?.[key], b?.[key]));
}

const LOCK_SECTIONS = new Set(['packages', 'workspaces']);

/** Names whose declared spec differs in a workspace manifest recorded in the lock. */
function changedWorkspaceSpecs(a: any, b: any): string[] {
  const [workspacesA = {}, workspacesB = {}] = [a.workspaces, b.workspaces];
  return [...keysOf(workspacesA, workspacesB)].flatMap((dir) =>
    changedDeclarations(workspacesA[dir], workspacesB[dir]),
  );
}

/** Names whose resolved entry was added, removed or changed. */
function changedResolutions(a: Record<string, LockEntry>, b: Record<string, LockEntry>): string[] {
  return [...keysOf(a, b)]
    .filter((key) => !sameJson(a[key], b[key]))
    .map((key) => entryName(key, b[key] ?? a[key]));
}

/** Adds to `changed` every package depending on one in it, transitively. */
function addDependents(changed: Set<string>, packages: Record<string, LockEntry>): void {
  const dependents = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(packages)) {
    for (const dep of entryDeps(entry)) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), entryName(key, entry)]);
    }
  }
  const stack = [...changed];
  while (stack.length > 0) {
    for (const parent of dependents.get(stack.pop()!) ?? []) {
      if (!changed.has(parent)) {
        changed.add(parent);
        stack.push(parent);
      }
    }
  }
}

/**
 * External dependency names whose installed code can differ between `before`
 * and `after`, or null when that cannot be determined: a file does not parse,
 * a root field outside the dependency lists changed, a lock section other than
 * the resolved packages and workspace manifests changed, or a changed
 * dependency is declared by the root manifest but by no workspace package
 * (`workspaceDeclared`), so it reaches the packages only through hoisting.
 */
export function changedDependencies(
  before: DependencySnapshot,
  after: DependencySnapshot,
  workspaceDeclared: ReadonlySet<string>,
): Set<string> | null {
  const parsed = [before.lock, after.lock, before.rootManifest, after.rootManifest].map(tryParse);
  if (parsed.some((result) => !result.ok)) return null;
  const [lockA = {}, lockB = {}, rootA, rootB] = parsed.map((result) =>
    result.ok ? (result.value ?? undefined) : undefined,
  );

  // Root manifest fields beyond the dependency lists, and lock sections beyond
  // the resolved packages and workspace manifests, can change anything.
  if (differsOutside(rootA, rootB, INERT_ROOT_FIELDS)) return null;
  if (differsOutside(lockA, lockB, LOCK_SECTIONS)) return null;

  const changed = new Set([
    ...changedWorkspaceSpecs(lockA, lockB),
    ...changedResolutions(lockA.packages ?? {}, lockB.packages ?? {}),
  ]);
  for (const name of changedDeclarations(rootA, rootB)) changed.add(name);
  addDependents(changed, lockB.packages ?? {});

  // A root dependency no workspace package declares reaches the packages only
  // through hoisting: there is no package to select, so every suite runs.
  const rootDeclared = new Set([...declared(rootA).keys(), ...declared(rootB).keys()]);
  const hoistedOnly = [...changed].some(
    (name) => rootDeclared.has(name) && !workspaceDeclared.has(name),
  );
  return hoistedOnly ? null : changed;
}
