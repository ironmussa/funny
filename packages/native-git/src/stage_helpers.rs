use std::collections::HashSet;

use gix::bstr::ByteSlice;
use gix::worktree::stack::state::ignore::Source as IgnoreSource;

use crate::repo_cache::with_repo;

/// For each path in `paths`, return the subset that is ignored by .gitignore /
/// info/exclude / core.excludesFile. Mirrors `git check-ignore --stdin`.
///
/// Paths must be repo-relative with `/` separators. Paths that resolve to a
/// file inside an ignored directory are also reported as ignored (gix walks
/// the parent chain when matching).
#[napi]
pub async fn check_ignore(cwd: String, paths: Vec<String>) -> napi::Result<Vec<String>> {
  if paths.is_empty() {
    return Ok(Vec::new());
  }

  with_repo(&cwd, |repo| {
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;

    let mut excludes = repo
      .excludes(
        &index,
        None,
        IgnoreSource::WorktreeThenIdMappingIfNotSkipped,
      )
      .map_err(|e| napi::Error::from_reason(format!("Failed to load excludes: {e}")))?;

    let mut ignored = Vec::new();
    for path in paths {
      let platform = match excludes.at_entry(path.as_str(), None) {
        Ok(p) => p,
        Err(_) => continue,
      };
      if platform.is_excluded() {
        ignored.push(path);
      }
    }
    Ok(ignored)
  })
}

/// List repo-relative paths that have any unmerged (conflict) index entries
/// (stage 1, 2, or 3). Mirrors `git ls-files --unmerged` minus the mode /
/// hash / stage columns — callers only need the paths to drive conflict
/// resolution UI.
#[napi]
pub async fn list_unmerged_files(cwd: String) -> napi::Result<Vec<String>> {
  with_repo(&cwd, |repo| {
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    for entry in index.entries().iter() {
      if entry.stage_raw() == 0 {
        continue;
      }
      let path = entry.path(&index).to_str_lossy().to_string();
      if seen.insert(path.clone()) {
        paths.push(path);
      }
    }
    Ok(paths)
  })
}
