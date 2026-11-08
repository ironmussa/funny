use crate::repo_cache::with_repo;

/// One entry of `git worktree list --porcelain`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct WorktreeEntry {
  pub path: String,
  /// Commit `HEAD` resolves to; empty when it cannot be read (unborn branch,
  /// worktree whose git dir is gone).
  pub commit: String,
  /// Short branch name; `None` when `HEAD` is detached.
  pub branch: Option<String>,
}

/// Read `HEAD` of an opened repository as (commit, short branch name).
fn head_of(repo: &gix::Repository) -> (String, Option<String>) {
  let commit = repo.head_id().map(|id| id.to_string()).unwrap_or_default();
  let branch = repo
    .head_name()
    .ok()
    .flatten()
    .filter(|name| name.as_bstr().starts_with(b"refs/heads/"))
    .map(|name| name.shorten().to_string());
  (commit, branch)
}

/// List the main worktree followed by every linked worktree (sorted by path),
/// like `git worktree list --porcelain`, without spawning git. Linked worktrees
/// whose directory is gone are still listed, as git does.
#[napi]
pub async fn list_worktrees(cwd: String) -> napi::Result<Vec<WorktreeEntry>> {
  with_repo(&cwd, |repo| {
    // Always enumerate from the main repository, even when `cwd` is a linked worktree.
    let main = repo
      .main_repo()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open main repo: {e}")))?;

    let mut entries = Vec::new();
    if let Some(workdir) = main.workdir() {
      let path = std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf());
      let (commit, branch) = head_of(&main);
      entries.push(WorktreeEntry {
        path: path.to_string_lossy().into_owned(),
        commit,
        branch,
      });
    }

    let proxies = main
      .worktrees()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list worktrees: {e}")))?;
    let mut linked = Vec::with_capacity(proxies.len());
    for proxy in proxies {
      // Fail rather than skip: a caller pruning orphan directories would
      // treat a silently omitted worktree as orphaned and delete it.
      let base = proxy.base().map_err(|e| {
        napi::Error::from_reason(format!("Failed to read worktree {}: {e}", proxy.git_dir().display()))
      })?;
      let (commit, branch) = proxy
        .into_repo_with_possibly_inaccessible_worktree()
        .map(|r| head_of(&r))
        .unwrap_or_default();
      linked.push(WorktreeEntry {
        path: base.to_string_lossy().into_owned(),
        commit,
        branch,
      });
    }
    linked.sort_by(|a, b| a.path.cmp(&b.path));
    entries.extend(linked);
    Ok(entries)
  })
}
