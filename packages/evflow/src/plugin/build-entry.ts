/**
 * Post-build script: creates plugin/index.cjs that re-exports the init
 * function as module.exports (the format TS Language Service expects).
 *
 * Bun's CJS bundler wraps exports in __toCommonJS which puts them under
 * .init instead of directly on module.exports. The TS server expects
 * `module.exports = function init(modules) { ... }`.
 *
 * We use .cjs extension because the package has "type": "module",
 * which would make Node treat .js files as ESM.
 */
const entry = `// TS Language Service Plugin entry point
// Re-exports the bundled init function as module.exports
const path = require('path');
const bundle = require(path.join(__dirname, 'bundle.cjs'));
module.exports = bundle.init;
`;

await Bun.write('plugin/index.cjs', entry);
process.stdout.write('plugin/index.cjs written\n');
