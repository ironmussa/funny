/**
 * The thread a request is made for. The client sends it on every request it
 * makes from a thread's view; the server routes on it (`runner-resolver`) so
 * the request runs where the thread runs — its own sandbox runner, or the
 * machine holding its checkout — instead of wherever the project lives.
 */
export const THREAD_CONTEXT_HEADER = 'X-Funny-Thread-Id';
