use std::path::{Path, PathBuf};

use gix::bstr::{BString, ByteSlice};
use gix::worktree::stack::state::attributes::Source as AttrSource;

use crate::repo_cache::with_repo;

const MAX_UNTRACKED_TO_COUNT: usize = 200;
const MAX_UNTRACKED_FILE_SIZE: u64 = 512 * 1024; // 512 KB

#[napi(object)]
#[derive(Debug, Clone)]
pub struct GitStatusSummary {
  pub dirty_file_count: u32,
  pub unpushed_commit_count: u32,
  pub unpulled_commit_count: u32,
  pub has_remote_branch: bool,
  pub is_merged_into_base: bool,
  pub lines_added: u32,
  pub lines_deleted: u32,
}

/// Count newlines in a file, skipping binary files (null bytes in first 8KB).
fn count_file_lines(path: &Path) -> u32 {
  let data = match std::fs::read(path) {
    Ok(d) => d,
    Err(_) => return 0,
  };
  if data.is_empty() {
    return 0;
  }
  let check_len = data.len().min(8192);
  for &b in &data[..check_len] {
    if b == 0 {
      return 0; // binary file
    }
  }
  let mut n: u32 = 0;
  for &b in &data {
    if b == 0x0a {
      n += 1;
    }
  }
  if !data.is_empty() && data[data.len() - 1] != 0x0a {
    n += 1;
  }
  n
}

/// Count added/deleted lines for a single tracked, modified file by comparing
/// the old blob (from HEAD's tree) against the worktree file on disk.
fn count_lines_for_entry(
  _repo: &gix::Repository,
  worktree_path: &Path,
  rel_path_str: &str,
  head_tree: &gix::Tree<'_>,
) -> (u32, u32) {
  let disk_path = worktree_path.join(rel_path_str);

  // Read old blob from HEAD tree
  let old_data: Option<Vec<u8>> = (|| {
    let entry = head_tree.lookup_entry_by_path(rel_path_str).ok()??;
    let object = entry.object().ok()?;
    Some(object.detach().data)
  })();

  // Read new file from disk
  let new_data = std::fs::read(&disk_path).ok();

  let old_bytes = old_data.as_deref().unwrap_or(b"");
  let new_bytes = new_data.as_deref().unwrap_or(b"");

  // Quick binary check (null bytes in first 8KB)
  let is_binary = |data: &[u8]| -> bool {
    let check_len = data.len().min(8192);
    data[..check_len].contains(&0)
  };

  if is_binary(old_bytes) || is_binary(new_bytes) {
    return (0, 0);
  }

  // Use imara-diff for accurate line counting
  let input = gix::diff::blob::intern::InternedInput::new(old_bytes, new_bytes);
  let counter = LineCounter::default();
  gix::diff::blob::diff(gix::diff::blob::Algorithm::Histogram, &input, counter)
}

/// Sink for imara-diff that counts added and deleted lines.
#[derive(Default)]
pub(crate) struct LineCounter {
  pub(crate) added: u32,
  pub(crate) deleted: u32,
}

impl gix::diff::blob::Sink for LineCounter {
  type Out = (u32, u32);

  fn process_change(&mut self, before: std::ops::Range<u32>, after: std::ops::Range<u32>) {
    self.deleted += before.end - before.start;
    self.added += after.end - after.start;
  }

  fn finish(self) -> Self::Out {
    (self.added, self.deleted)
  }
}

/// Check `.gitattributes` to determine if a file should be treated as binary.
/// Returns true if `binary` is Set or `diff` is Unset (i.e. `-diff`).
fn is_binary_by_attr(
  attr_stack: &mut gix::worktree::Stack,
  outcome: &mut gix::attrs::search::Outcome,
  rel_path: &str,
  objects: &dyn gix::objs::Find,
) -> bool {
  let platform = match attr_stack.at_entry(rel_path.as_bytes().as_bstr(), None, objects) {
    Ok(p) => p,
    Err(_) => return false,
  };

  if !platform.matching_attributes(outcome) {
    return false;
  }

  for m in outcome.iter() {
    match m.assignment.name.as_str() {
      "binary" => {
        if matches!(m.assignment.state, gix::attrs::StateRef::Set) {
          return true;
        }
      }
      "diff" => {
        if matches!(m.assignment.state, gix::attrs::StateRef::Unset) {
          return true;
        }
      }
      _ => {}
    }
  }

  false
}

/// True if the nested git repo at `nested_path` reports any uncommitted changes.
/// Used to surface dirtiness for stranded gitlinks (entries with mode 160000
/// that aren't registered in `.gitmodules`), which gix's submodule status
/// machinery skips entirely.
fn is_nested_repo_dirty_status(nested_path: &Path) -> bool {
  std::process::Command::new("git")
    .args(["status", "--porcelain"])
    .current_dir(nested_path)
    .output()
    .ok()
    .map(|o| o.status.success() && !o.stdout.is_empty())
    .unwrap_or(false)
}

/// Count commits between two refs using `git rev-list --count <range>`.
/// Falls back to 0 on any error.
fn rev_list_count(cwd: &Path, range: &str) -> u32 {
  std::process::Command::new("git")
    .args(["rev-list", "--count", range])
    .current_dir(cwd)
    .output()
    .ok()
    .and_then(|o| {
      if o.status.success() {
        String::from_utf8(o.stdout).ok()?.trim().parse::<u32>().ok()
      } else {
        None
      }
    })
    .unwrap_or(0)
}

/// Count commits in HEAD that are not reachable from any remote ref.
/// Mirrors `getUnpushedHashes` (used by the History tab) so the Changes badge agrees.
fn rev_list_count_unpushed(cwd: &Path) -> u32 {
  std::process::Command::new("git")
    .args(["rev-list", "--count", "HEAD", "--not", "--remotes"])
    .current_dir(cwd)
    .output()
    .ok()
    .and_then(|o| {
      if o.status.success() {
        String::from_utf8(o.stdout).ok()?.trim().parse::<u32>().ok()
      } else {
        None
      }
    })
    .unwrap_or(0)
}

/// Intermediate result from the main status scan (Phase 1 + 2a).
struct StatusPhaseResult {
  dirty_file_count: u32,
  unpushed_commit_count: u32,
  unpulled_commit_count: u32,
  has_remote_branch: bool,
  lines_added: u32,
  lines_deleted: u32,
  branch_name: Option<String>,
}

#[napi]
pub async fn get_status_summary(
  worktree_cwd: String,
  base_branch: Option<String>,
  project_cwd: Option<String>,
) -> napi::Result<GitStatusSummary> {
  // Phase 1 + 2a: status scan, line counting, branch analysis — all from worktree repo
  let phase1 = with_repo(&worktree_cwd, |repo| {
    let worktree_path = PathBuf::from(&worktree_cwd);

    // Get HEAD reference
    let head_ref = repo.head_ref()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD ref: {e}")))?;

    let branch_name = head_ref.as_ref().map(|r| {
      r.name().shorten().to_string()
    });

    // Get HEAD commit and tree for diffing (optional — may not exist for new repos)
    let head_tree = repo.head_commit().ok().and_then(|c| c.tree().ok());

    // ── Set up attribute stack for .gitattributes binary detection ──
    let (mut attr_stack, mut attr_outcome) = match repo.open_index() {
      Ok(index) => {
        match repo.attributes_only(&index, AttrSource::WorktreeThenIdMapping) {
          Ok(attr_handle) => {
            let outcome = attr_handle.selected_attribute_matches(["binary", "diff"]);
            let stack = attr_handle.detach();
            (Some(stack), Some(outcome))
          }
          Err(_) => (None, None),
        }
      }
      Err(_) => (None, None),
    };

    // ── Phase 1: Status (dirty files, untracked, line counting) ──

    let status_platform = repo
      .status(gix::progress::Discard)
      .map_err(|e| napi::Error::from_reason(format!("Failed to create status: {e}")))?
      .untracked_files(gix::status::UntrackedFiles::Files)
      // Force submodule dirtiness checks — see diff_summary.rs for rationale.
      .index_worktree_submodules(gix::status::Submodule::Given {
        ignore: gix::submodule::config::Ignore::None,
        check_dirty: true,
      });

    let empty_patterns: Vec<BString> = Vec::new();
    let status_iter = status_platform
      .into_index_worktree_iter(empty_patterns)
      .map_err(|e| napi::Error::from_reason(format!("Failed to iterate status: {e}")))?;

    let mut dirty_file_count: u32 = 0;
    let mut untracked_paths: Vec<PathBuf> = Vec::new();
    let mut untracked_rel_paths: Vec<String> = Vec::new();
    let mut modified_rel_paths: Vec<String> = Vec::new();
    let mut lines_added: u32 = 0;
    let mut lines_deleted: u32 = 0;
    let mut worktree_changed_paths = std::collections::HashSet::new();

    for entry in status_iter {
      let entry = entry
        .map_err(|e| napi::Error::from_reason(format!("Status iteration error: {e}")))?;

      dirty_file_count += 1;

      match &entry {
        gix::status::index_worktree::Item::Modification { rela_path, .. } => {
          let rel_str = rela_path.to_string();
          worktree_changed_paths.insert(rel_str.clone());
          modified_rel_paths.push(rel_str);
        }
        gix::status::index_worktree::Item::DirectoryContents { entry: dir_entry, .. } => {
          let rel_str = dir_entry.rela_path.to_string();
          worktree_changed_paths.insert(rel_str.clone());
          untracked_paths.push(worktree_path.join(&rel_str));
          untracked_rel_paths.push(rel_str);
        }
        gix::status::index_worktree::Item::Rewrite { dirwalk_entry, .. } => {
          worktree_changed_paths.insert(dirwalk_entry.rela_path.to_string());
        }
      }
    }

    // Count staged files that differ from HEAD (or all index entries if no HEAD)
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;

    let mut staged_new_paths: Vec<PathBuf> = Vec::new();
    let mut staged_new_rel_paths: Vec<String> = Vec::new();
    let mut staged_modified_rel_paths: Vec<String> = Vec::new();

    for idx_entry in index.entries().iter() {
      let path_str = idx_entry.path(&index).to_str_lossy().to_string();
      if worktree_changed_paths.contains(&path_str) {
        continue;
      }

      match &head_tree {
        Some(tree) => match tree.lookup_entry_by_path(&path_str) {
          Ok(Some(tree_entry)) => {
            if tree_entry.object_id() != idx_entry.id {
              // Staged modification: file exists in HEAD but index differs — needs a real diff
              dirty_file_count += 1;
              staged_modified_rel_paths.push(path_str);
            }
          }
          _ => {
            // Staged new file: not in HEAD tree — count all lines as additions
            dirty_file_count += 1;
            staged_new_paths.push(worktree_path.join(&path_str));
            staged_new_rel_paths.push(path_str);
          }
        },
        None => {
          // No HEAD commit — everything is new
          dirty_file_count += 1;
          staged_new_paths.push(worktree_path.join(&path_str));
          staged_new_rel_paths.push(path_str);
        }
      };
    }

    // Count lines for modified tracked files (only when HEAD exists)
    // This includes both worktree modifications AND staged modifications
    // (files where the index differs from HEAD but the worktree matches the index).
    if let Some(ref tree) = head_tree {
      for rel_path_str in modified_rel_paths.iter().chain(staged_modified_rel_paths.iter()) {
        if let (Some(ref mut stack), Some(ref mut outcome)) = (&mut attr_stack, &mut attr_outcome) {
          if is_binary_by_attr(stack, outcome, rel_path_str, &repo.objects) {
            continue;
          }
        }
        let (added, deleted) = count_lines_for_entry(repo, &worktree_path, rel_path_str, tree);
        lines_added += added;
        lines_deleted += deleted;
      }
    }

    // Count lines for untracked files and staged new files (both are new content)
    let all_new_paths = untracked_paths.iter().chain(staged_new_paths.iter());
    let all_new_rel_paths = untracked_rel_paths.iter().chain(staged_new_rel_paths.iter());
    for (i, (path, rel_path)) in all_new_paths.zip(all_new_rel_paths).enumerate() {
      if i >= MAX_UNTRACKED_TO_COUNT {
        break;
      }
      if let (Some(ref mut stack), Some(ref mut outcome)) = (&mut attr_stack, &mut attr_outcome) {
        if is_binary_by_attr(stack, outcome, rel_path, &repo.objects) {
          continue;
        }
      }
      if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() == 0 || meta.len() > MAX_UNTRACKED_FILE_SIZE {
          continue;
        }
      } else {
        continue;
      }
      lines_added += count_file_lines(path);
    }

    // ── Phase 1c: stranded gitlinks (gitlinks without `.gitmodules`) ──
    // Mirrors the Phase 3 logic in diff_summary.rs: gix only inspects
    // submodules listed in `.gitmodules`, so detect dirty bare gitlinks
    // by scanning the index for COMMIT-mode entries.
    for idx_entry in index.entries().iter() {
      if !idx_entry.mode.is_submodule() {
        continue;
      }
      let path_str = idx_entry.path(&index).to_str_lossy().to_string();
      if worktree_changed_paths.contains(&path_str) {
        continue;
      }
      let nested = worktree_path.join(&path_str);
      if !nested.join(".git").exists() {
        continue;
      }
      if !is_nested_repo_dirty_status(&nested) {
        continue;
      }
      worktree_changed_paths.insert(path_str);
      dirty_file_count += 1;
    }

    // ── Phase 2a: Branch analysis ──

    let branch = match &branch_name {
      Some(b) => b.clone(),
      None => {
        return Ok(StatusPhaseResult {
          dirty_file_count,
          unpushed_commit_count: 0,
          unpulled_commit_count: 0,
          has_remote_branch: false,
          lines_added,
          lines_deleted,
          branch_name: None,
        });
      }
    };

    // Check for upstream/remote branch
    let upstream_ref_name = format!("refs/remotes/origin/{}", branch);
    let has_remote_branch = repo.find_reference(&upstream_ref_name).is_ok();

    // Count unpushed and unpulled commits using git rev-list --count.
    // The gix rev_walk approach breaks with merge commits because
    // topological traversal may reach the merge-base before visiting
    // all commits on side branches, producing incorrect counts.
    let mut unpushed_commit_count: u32 = 0;
    let mut unpulled_commit_count: u32 = 0;

    if has_remote_branch {
      // Match the History tab: commits not on any remote ref.
      unpushed_commit_count = rev_list_count_unpushed(&worktree_path);
      unpulled_commit_count = rev_list_count(&worktree_path, &format!("HEAD..origin/{}", branch));
    } else if let Some(ref base_b) = base_branch {
      unpushed_commit_count = rev_list_count(&worktree_path, &format!("{}..HEAD", base_b));
    }

    Ok(StatusPhaseResult {
      dirty_file_count,
      unpushed_commit_count,
      unpulled_commit_count,
      has_remote_branch,
      lines_added,
      lines_deleted,
      branch_name: Some(branch),
    })
  })?;

  // Phase 2b: merge-base check — may use a different repo path (project root vs worktree)
  // This is a SEPARATE with_repo() call to avoid RefCell re-entrancy panic.
  let is_merged_into_base = if let (Some(ref base_b), Some(ref branch)) = (&base_branch, &phase1.branch_name) {
    let project_path = project_cwd.as_deref().unwrap_or(&worktree_cwd);
    with_repo(project_path, |project_repo| {
      let base_ref_name = format!("refs/heads/{}", base_b);
      if let Ok(base_ref) = project_repo.find_reference(&base_ref_name) {
        if let Ok(base_id) = base_ref.into_fully_peeled_id() {
          let branch_ref_name = format!("refs/heads/{}", branch);
          if let Ok(branch_ref) = project_repo.find_reference(&branch_ref_name) {
            if let Ok(branch_id) = branch_ref.into_fully_peeled_id() {
              if let Ok(mb_id) = project_repo.merge_base(base_id, branch_id) {
                return Ok(mb_id != branch_id.detach());
              }
            }
          }
        }
      }
      Ok(false)
    })?
  } else {
    false
  };

  Ok(GitStatusSummary {
    dirty_file_count: phase1.dirty_file_count,
    unpushed_commit_count: phase1.unpushed_commit_count,
    unpulled_commit_count: phase1.unpulled_commit_count,
    has_remote_branch: phase1.has_remote_branch,
    is_merged_into_base,
    lines_added: phase1.lines_added,
    lines_deleted: phase1.lines_deleted,
  })
}
