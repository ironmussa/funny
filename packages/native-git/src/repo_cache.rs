use std::cell::RefCell;
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

use lru::LruCache;

/// Maximum number of cached repository handles per libuv worker thread.
const CACHE_CAPACITY: usize = 8;

/// Time-to-live for cached handles. After this duration, `Repository::reload()`
/// is called to pick up external changes (e.g. refs modified by CLI git).
const CACHE_TTL: Duration = Duration::from_secs(10);

struct CachedRepo {
    repo: gix::Repository,
    opened_at: Instant,
}

thread_local! {
    static REPO_CACHE: RefCell<LruCache<String, CachedRepo>> =
        RefCell::new(LruCache::new(NonZeroUsize::new(CACHE_CAPACITY).unwrap()));
}

/// Execute a closure with a cached `gix::Repository` handle.
///
/// If a handle for `cwd` exists in this thread's cache and its TTL has not
/// expired, it is reused. When expired, `Repository::reload()` refreshes config
/// and drops caches without a full re-open. Otherwise, `gix::open(cwd)` is
/// called and the result is stored in the LRU cache.
///
/// The closure receives a shared `&gix::Repository` reference. Because the
/// entire call happens inside `REPO_CACHE.with()`, the borrow is scoped
/// and safe — no reference escapes the closure.
///
/// **Warning**: Do NOT nest `with_repo` calls — the inner call will panic
/// on `borrow_mut()` re-entrancy. Use sequential calls instead.
pub(crate) fn with_repo<T>(
    cwd: &str,
    f: impl FnOnce(&gix::Repository) -> napi::Result<T>,
) -> napi::Result<T> {
    REPO_CACHE.with(|cache| {
        let mut map = cache.borrow_mut();

        if let Some(entry) = map.get_mut(cwd) {
            if entry.opened_at.elapsed() >= CACHE_TTL {
                entry
                    .repo
                    .reload()
                    .map_err(|e| napi::Error::from_reason(format!("Failed to reload repo: {e}")))?;
                entry.opened_at = Instant::now();
            }
        } else {
            let repo = gix::open(cwd)
                .map_err(|e| napi::Error::from_reason(format!("Failed to open repo: {e}")))?;
            map.put(
                cwd.to_string(),
                CachedRepo {
                    repo,
                    opened_at: Instant::now(),
                },
            );
        }

        let cached = map.get(cwd).unwrap();
        f(&cached.repo)
    })
}

/// Evict a repository handle from this thread's cache.
///
/// Call after write operations (e.g. `reset_soft`) to ensure the next
/// read gets a fresh handle that sees the updated refs.
pub(crate) fn evict_repo(cwd: &str) {
    REPO_CACHE.with(|cache| {
        cache.borrow_mut().pop(cwd);
    });
}
