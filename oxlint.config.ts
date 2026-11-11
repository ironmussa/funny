import gdp from '@gdp-ts/core/lint/oxlint';

const existing = {
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    perf: 'warn',
    pedantic: 'off',
    style: 'off',
    nursery: 'off',
  },
  plugins: ['typescript', 'react', 'import', 'oxc'],
  jsPlugins: ['eslint-plugin-zod'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/capitalized-calls': 'error',
    'react/error-boundaries': 'error',
    'react/exhaustive-effect-dependencies': 'warn',
    'react/globals': 'error',
    'react/hooks': 'error',
    'react/immutability': 'warn',
    'react/incompatible-library': 'warn',
    'react/invariant': 'warn',
    'react/memo-dependencies': 'warn',
    'react/no-deriving-state-in-effects': 'error',
    'react/preserve-manual-memoization': 'warn',
    'react/purity': 'error',
    'react/refs': 'warn',
    'react/rule-suppression': 'warn',
    'react/set-state-in-effect': 'warn',
    'react/set-state-in-render': 'error',
    'react/static-components': 'error',
    'react/syntax': 'error',
    'react/todo': 'warn',
    'react/unsupported-syntax': 'error',
    'react/use-memo': 'error',
    'react/void-use-memo': 'error',
    'no-unused-vars': 'warn',
    'no-shadow': 'off',
    'no-await-in-loop': 'off',
    'no-constant-condition': 'warn',
    'no-constant-binary-expression': 'warn',
    'react-hooks/exhaustive-deps': 'warn',
    // Only names we do not choose are allowed; our own private members use `#x`
    // or a plain name instead of a leading underscore.
    'no-underscore-dangle': [
      'warn',
      {
        allow: [
          // neverthrow's test-only unwrappers.
          '_unsafeUnwrap',
          '_unsafeUnwrapErr',
          // Node / Tauri host globals.
          '__dirname',
          '__filename',
          '__TAURI_INTERNALS__',
          // Framework internals the browser annotator reads to name components.
          '__vue__',
          '__vueParentComponent',
          '__vue_app__',
          '__VUE__',
          '__name',
          '__ngContext__',
          '__svelte_meta',
          '__NUXT__',
          '__NEXT_DATA__',
          '_reactRootContainer',
          // xterm.js private internals patched in terminal/xterm-utils.ts.
          '_core',
          '_renderService',
          '_isPaused',
          '_handleIntersectionChange',
          // MCP protocol metadata field.
          '_meta',
          // Build-time defines (Vite `define`, Bun `--define`).
          '__BUILD_INFO__',
          '__PREVIEW_MODE__',
          // Deliberate globalThis / window keys. They must not collide with page
          // or library names, and several are contracts: console APIs documented
          // for users (__funnyLog, __funnyMemory), keys a restarted process reads
          // back (__funnyActiveAgentSnapshot, __bunServer), the plugin import-map
          // shims in client/public/vendor (__FUNNY_*), the page scripts injected
          // by the runner browser and the extension, and e2e/benchmark probes.
          '__funnyActiveAgents',
          '__funnyActiveAgentSnapshot',
          '__funnyIdleReaperSchedule',
          '__funnyAudio',
          '__funnyMemory',
          '__funnyLog',
          '__funnyAnnotatorActive',
          '__funnyBridgeInjected',
          '__funnyBridgeLoaded',
          '__paletteOpenTs',
          '__bunServer',
          '__bunCleanup',
          '__FUNNY_HOST__',
          '__FUNNY_PLUGIN_SDK__',
          '__FUNNY_REACT__',
          '__FUNNY_REACT_DOM__',
          '__FUNNY_REACT_JSX_RUNTIME__',
          '__FUNNY_MARKDOWN_WASM_BENCHMARK__',
          '__playwright_ws_instances',
        ],
      },
    ],
    'oxc/no-map-spread': 'off',
    'import/no-unassigned-import': 'off',
    'import/no-named-as-default': 'off',
    'import/no-named-as-default-member': 'off',
    'react/no-array-index-key': 'off',
    'no-new': 'off',
    'react/iframe-missing-sandbox': 'off',
    'no-unmodified-loop-condition': 'off',
    'zod/no-any-schema': 'error',
    'zod/no-coerce-boolean': 'error',
    'zod/no-duplicate-schema-methods': 'error',
    'zod/no-empty-custom-schema': 'error',
    'zod/no-optional-and-default-together': 'error',
    'zod/no-throw-in-refine': 'error',
    'zod/no-transform-in-record-key': 'error',
    'max-lines': [
      'warn',
      {
        max: 800,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    'max-lines-per-function': [
      'warn',
      {
        max: 250,
        skipBlankLines: true,
        skipComments: true,
        IIFEs: true,
      },
    ],
  },
  overrides: [
    {
      files: ['**/__tests__/**', '**/*.test.*', '**/*.spec.*'],
      rules: {
        'no-constant-condition': 'off',
        'no-constant-binary-expression': 'off',
        'max-lines': 'off',
        'max-lines-per-function': 'off',
      },
    },
    {
      // evflow event models are declarative specs: one builder whose commands,
      // events and slices reference each other as locals, so their length is
      // the size of the modelled domain, not of a function to split.
      files: ['packages/evflow/models/**/*.model.ts'],
      rules: {
        'max-lines': 'off',
        'max-lines-per-function': 'off',
      },
    },
    {
      // Vendored napi-rs WASI glue (see its THIRD_PARTY.md): not ours to edit.
      files: ['packages/client/vendor/satteri-wasm32-wasi/**'],
      rules: {
        'no-eval': 'off',
        'no-underscore-dangle': 'off',
        'no-unused-vars': 'off',
      },
    },
  ],
  // packages/evflow/plugin/bundle.cjs is `bun build` output (evflow `build:plugin`).
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '.funny-worktrees/',
    'src-tauri/',
    'packages/evflow/plugin/bundle.cjs',
  ],
  settings: {
    react: {
      version: '19',
    },
  },
};

const proofs = [
  'packages/server/src/modules/threads/domain/proofs/thread-owned-by.ts',
  'packages/server/src/services/runner-access/runner-for.ts',
];
const preset = gdp({
  proofs,
  proofImports: [
    '(^|/)proofs(/|$)',
    '(^|/)modules/threads(/index(\\.[cm]?[jt]s)?)?$',
    '(^|/)services/runner-access(/|$)',
  ],
});

export default {
  ...existing,
  jsPlugins: [...existing.jsPlugins, ...preset.jsPlugins],
  overrides: [
    ...existing.overrides,
    ...preset.overrides,
    {
      files: [
        'packages/server/src/modules/threads/domain/fork-input.ts',
        'packages/server/src/modules/threads/application/fork-thread.ts',
        'packages/server/src/services/runner-access/authorized-runner-requests.ts',
        'packages/server/src/services/runner-access/index.ts',
      ],
      rules: { 'gdp-ts/no-type-assertion': 'error', 'gdp-ts/no-any': 'error' },
    },
  ],
};
