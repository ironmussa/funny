// TS Language Service Plugin entry point
// Re-exports the bundled init function as module.exports
const path = require('path');
const bundle = require(path.join(__dirname, 'bundle.cjs'));
module.exports = bundle.init;
