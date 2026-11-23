use std::path::{Path, PathBuf};

use gix::worktree::remove::{Force, Options};

use crate::repo_cache::evict_repo;

/// Threads deleting files at once. A worktree with `node_modules` holds
/// hundreds of thousands of files; leave cores for the agents.
const DELETE_THREADS: usize = 4;

fn reason(context: &str, e: impl std::fmt::Display) -> napi::Error {
  napi::Error::from_reason(format!("{context}: {e}"))
}

/// One spelling for two paths of one folder (symlinks resolved when it exists).
fn comparable(path: &Path) -> PathBuf {
  std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn remove(cwd: &str, worktree_path: &str) -> napi::Result<()> {
  let repo = gix::open(cwd).map_err(|e| reason("Failed to open repo", e))?;
  let wanted = Path::new(worktree_path);
  if !wanted.is_absolute() {
    return Err(napi::Error::from_reason("The worktree path must be absolute"));
  }
  let target = repo
    .prepare_remove_worktree(wanted)
    .map_err(|e| reason("Failed to find the worktree", e))?;
  // `prepare_remove_worktree` also matches a suffix of path components:
  // remove only the worktree registered at exactly this path.
  if comparable(target.base()) != comparable(wanted) {
    return Err(napi::Error::from_reason(format!(
      "{} is not the worktree registered at {}",
      target.base().display(),
      wanted.display()
    )));
  }
  target
    .options(Options {
      thread_limit: Some(DELETE_THREADS),
      ..Options::default()
    })
    // Like `git worktree remove -f`: discard changes, respect a lock.
    .remove(Force::DiscardChanges, gix::progress::Discard)
    .map_err(|e| reason("Failed to remove worktree", e))
}

/// Remove the linked worktree at `worktree_path` and its registration, like
/// `git worktree remove -f`, without spawning git. The branch is kept.
#[napi]
pub async fn remove_worktree(cwd: String, worktree_path: String) -> napi::Result<()> {
  let result = remove(&cwd, &worktree_path);
  evict_repo(&cwd);
  evict_repo(&worktree_path);
  result
}
