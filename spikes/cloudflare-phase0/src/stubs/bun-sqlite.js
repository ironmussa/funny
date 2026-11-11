// Probe-only stand-in: the Workers host never opens SQLite (Postgres via Hyperdrive).
// A function, not a class, so `new Database()` throws without an empty class shell.
export function Database() {
  throw new Error('bun:sqlite is not available on Workers');
}
export default { Database };
