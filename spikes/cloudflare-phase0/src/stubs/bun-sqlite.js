// Probe-only stand-in: the Workers host never opens SQLite (Postgres via Hyperdrive).
export class Database {
  constructor() {
    throw new Error('bun:sqlite is not available on Workers');
  }
}
export default { Database };
