/**
 * Reverse runner link (change thread-sandboxes): for a server the sandbox
 * cannot reach (a laptop on localhost), the SERVER dials into the sandbox.
 *
 * Inside the sandbox a relay listens on two ports:
 *   - `REVERSE_LINK_INGRESS_PORT` (all interfaces), published by the provider
 *     as an HTTPS URL. The server keeps a few idle "spare" WebSockets open on
 *     `REVERSE_LINK_PATH`, each carrying `REVERSE_LINK_SECRET_HEADER`.
 *   - `REVERSE_LINK_LOOPBACK_PORT` (loopback only), the runner's
 *     `TEAM_SERVER_URL`. Each TCP connection accepted there takes one spare;
 *     the relay sends the text frame `REVERSE_LINK_OPEN` on it, and from then
 *     on the socket is a raw byte pipe (binary frames) between that TCP
 *     connection and a fresh connection the server opens to itself.
 *
 * So the runner speaks plain HTTP + the gRPC WebSocket carrier to a loopback
 * address, unchanged, and nothing in the sandbox needs a public server URL.
 * The relay parses nothing above the frame level.
 */

export const REVERSE_LINK_PATH = '/_funny/reverse-link';

/** Header with the per-sandbox secret the relay requires on every spare. */
export const REVERSE_LINK_SECRET_HEADER = 'x-funny-reverse-link';

/** Text frame the relay sends when it hands a spare to a runner connection. */
export const REVERSE_LINK_OPEN = 'open';

/** Port the provider publishes (InstaBox needs ≥ 1024). */
export const REVERSE_LINK_INGRESS_PORT = 7810;

/** Loopback port the sandbox runner uses as its server origin. */
export const REVERSE_LINK_LOOPBACK_PORT = 7811;

/** Idle spares the server keeps open per sandbox. */
export const REVERSE_LINK_SPARES = 2;

/** Upper bound on spares the relay accepts at once. */
export const REVERSE_LINK_MAX_SPARES = 8;

/** Bytes either end may hold for a slow peer before closing the pipe. */
export const REVERSE_LINK_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Env of the sandbox runner that turns the relay on. */
export const REVERSE_LINK_SECRET_ENV = 'FUNNY_REVERSE_LINK_SECRET';
