use std::path::PathBuf;

use gix::bstr::ByteSlice;

use crate::repo_cache::with_repo;

/// Default context lines around changes (matches git default).
const CONTEXT_LINES: u32 = 3;

/// Maximum file size to diff (10 MB). Larger files return empty string.
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Check first 8KB for null bytes (binary detection).
fn is_binary(data: &[u8]) -> bool {
  if data.is_empty() {
    return false;
  }
  let check_len = data.len().min(8192);
  data[..check_len].contains(&0)
}

/// Sink that collects change ranges for later formatting.
struct UnifiedDiffCollector {
  changes: Vec<(std::ops::Range<u32>, std::ops::Range<u32>)>,
}

impl UnifiedDiffCollector {
  fn new() -> Self {
    Self {
      changes: Vec::new(),
    }
  }
}

impl gix::diff::blob::Sink for UnifiedDiffCollector {
  type Out = Vec<(std::ops::Range<u32>, std::ops::Range<u32>)>;

  fn process_change(&mut self, before: std::ops::Range<u32>, after: std::ops::Range<u32>) {
    self.changes.push((before, after));
  }

  fn finish(self) -> Self::Out {
    self.changes
  }
}

/// Split byte data into lines (preserving content, splitting on \n).
fn split_lines(data: &[u8]) -> Vec<&[u8]> {
  if data.is_empty() {
    return Vec::new();
  }
  let mut lines: Vec<&[u8]> = Vec::new();
  let mut start = 0;
  for (i, &b) in data.iter().enumerate() {
    if b == b'\n' {
      lines.push(&data[start..i]);
      start = i + 1;
    }
  }
  if start < data.len() {
    lines.push(&data[start..]);
  }
  lines
}

/// Format changes as unified diff hunks with context lines.
/// Output matches `git diff` format so the client-side parser works.
fn format_unified_diff(
  old_lines: &[&[u8]],
  new_lines: &[&[u8]],
  changes: &[(std::ops::Range<u32>, std::ops::Range<u32>)],
  old_path: &str,
  new_path: &str,
  is_new_file: bool,
  is_deleted: bool,
  context_lines: u32,
) -> String {
  if changes.is_empty() {
    return String::new();
  }

  let mut output = String::new();

  // Header
  output.push_str(&format!("diff --git a/{} b/{}\n", old_path, new_path));
  if is_new_file {
    output.push_str("new file mode 100644\n");
    output.push_str("--- /dev/null\n");
    output.push_str(&format!("+++ b/{}\n", new_path));
  } else if is_deleted {
    output.push_str("deleted file mode 100644\n");
    output.push_str(&format!("--- a/{}\n", old_path));
    output.push_str("+++ /dev/null\n");
  } else {
    output.push_str(&format!("--- a/{}\n", old_path));
    output.push_str(&format!("+++ b/{}\n", new_path));
  }

  let old_total = old_lines.len() as u32;
  let new_total = new_lines.len() as u32;

  // Group changes into hunks (merge changes within context_lines * 2 of each other)
  let mut hunks: Vec<Vec<usize>> = Vec::new();
  for (i, _) in changes.iter().enumerate() {
    if hunks.is_empty() {
      hunks.push(vec![i]);
    } else {
      let last_hunk = hunks.last().unwrap();
      let prev_idx = *last_hunk.last().unwrap();
      let prev_change = &changes[prev_idx];
      let curr_change = &changes[i];
      let gap_old = curr_change.0.start.saturating_sub(prev_change.0.end);
      let gap_new = curr_change.1.start.saturating_sub(prev_change.1.end);
      if gap_old <= context_lines * 2 || gap_new <= context_lines * 2 {
        hunks.last_mut().unwrap().push(i);
      } else {
        hunks.push(vec![i]);
      }
    }
  }

  // Format each hunk
  for hunk_indices in &hunks {
    let first = &changes[hunk_indices[0]];
    let last = &changes[*hunk_indices.last().unwrap()];

    let ctx_before = context_lines.min(first.0.start).min(first.1.start);
    let old_start = first.0.start - ctx_before;
    let new_start = first.1.start - ctx_before;
    let ctx_after = context_lines
      .min(old_total.saturating_sub(last.0.end))
      .min(new_total.saturating_sub(last.1.end));
    let old_end = last.0.end + ctx_after;
    let new_end = last.1.end + ctx_after;

    let old_count = old_end - old_start;
    let new_count = new_end - new_start;

    output.push_str(&format!(
      "@@ -{},{} +{},{} @@\n",
      old_start + 1,
      old_count,
      new_start + 1,
      new_count,
    ));

    // Interleave context and change lines
    let mut old_pos = old_start;
    let mut new_pos = new_start;

    for &ci in hunk_indices {
      let (ref before, ref after) = changes[ci];

      // Context lines before this change
      while old_pos < before.start && new_pos < after.start {
        if let Some(line) = old_lines.get(old_pos as usize) {
          output.push(' ');
          output.push_str(&line.to_str_lossy());
          output.push('\n');
        }
        old_pos += 1;
        new_pos += 1;
      }

      // Removed lines
      for i in before.start..before.end {
        if let Some(line) = old_lines.get(i as usize) {
          output.push('-');
          output.push_str(&line.to_str_lossy());
          output.push('\n');
        }
      }
      old_pos = before.end;

      // Added lines
      for i in after.start..after.end {
        if let Some(line) = new_lines.get(i as usize) {
          output.push('+');
          output.push_str(&line.to_str_lossy());
          output.push('\n');
        }
      }
      new_pos = after.end;
    }

    // Trailing context
    while old_pos < old_end && new_pos < new_end {
      if let Some(line) = old_lines.get(old_pos as usize) {
        output.push(' ');
        output.push_str(&line.to_str_lossy());
        output.push('\n');
      }
      old_pos += 1;
      new_pos += 1;
    }
  }

  output
}

/// Compute diff between two byte slices and format as unified diff.
fn compute_and_format(
  old: &[u8],
  new: &[u8],
  path: &str,
  is_new: bool,
  is_deleted: bool,
) -> String {
  compute_and_format_with_context(old, new, path, is_new, is_deleted, CONTEXT_LINES)
}

/// Compute diff with configurable context lines. Use u32::MAX for full-file context.
fn compute_and_format_with_context(
  old: &[u8],
  new: &[u8],
  path: &str,
  is_new: bool,
  is_deleted: bool,
  context_lines: u32,
) -> String {
  if is_binary(old) || is_binary(new) {
    return format!(
      "diff --git a/{f} b/{f}\nBinary files differ\n",
      f = path
    );
  }

  let old_lines = split_lines(old);
  let new_lines = split_lines(new);

  let input = gix::diff::blob::intern::InternedInput::new(old, new);
  let collector = UnifiedDiffCollector::new();
  let changes =
    gix::diff::blob::diff(gix::diff::blob::Algorithm::Histogram, &input, collector);

  format_unified_diff(&old_lines, &new_lines, &changes, path, path, is_new, is_deleted, context_lines)
}

#[napi]
pub async fn get_single_file_diff(
  cwd: String,
  file_path: String,
  staged: bool,
) -> napi::Result<String> {
  diff_file_with_context(&cwd, &file_path, staged, CONTEXT_LINES)
}

/// Full-context diff (equivalent to git diff -U99999). Shows all lines of the file.
#[napi]
pub async fn get_full_context_file_diff(
  cwd: String,
  file_path: String,
  staged: bool,
) -> napi::Result<String> {
  diff_file_with_context(&cwd, &file_path, staged, u32::MAX)
}

fn diff_file_with_context(
  cwd: &str,
  file_path: &str,
  staged: bool,
  context_lines: u32,
) -> napi::Result<String> {
  with_repo(cwd, |repo| {
    let worktree_path = PathBuf::from(cwd);

    if staged {
      return diff_staged_file_ctx(repo, file_path, context_lines);
    }

    // Check if file is tracked via index
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;

    let is_tracked = index
      .entries()
      .iter()
      .any(|entry| entry.path(&index).to_str_lossy() == file_path);

    if !is_tracked {
      return diff_untracked_file_ctx(&worktree_path, file_path, context_lines);
    }

    diff_unstaged_file_ctx(repo, &worktree_path, file_path, &index, context_lines)
  })
}

fn diff_staged_file(repo: &gix::Repository, file_path: &str) -> napi::Result<String> {
  diff_staged_file_ctx(repo, file_path, CONTEXT_LINES)
}

fn diff_staged_file_ctx(repo: &gix::Repository, file_path: &str, context_lines: u32) -> napi::Result<String> {
  // Get blob from HEAD tree
  let old_data: Option<Vec<u8>> = (|| {
    let head = repo.head_commit().ok()?;
    let tree = head.tree().ok()?;
    let entry = tree.lookup_entry_by_path(file_path).ok()??;
    Some(entry.object().ok()?.detach().data)
  })();

  // Get blob from index
  let index = repo
    .open_index()
    .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;
  let new_data: Option<Vec<u8>> = index
    .entries()
    .iter()
    .find(|e| e.path(&index).to_str_lossy() == file_path)
    .and_then(|entry| repo.find_object(entry.id).ok().map(|obj| obj.detach().data));

  let old = old_data.as_deref().unwrap_or(b"");
  let new = new_data.as_deref().unwrap_or(b"");

  if old == new {
    return Ok(String::new());
  }

  Ok(compute_and_format_with_context(
    old,
    new,
    file_path,
    old_data.is_none(),
    new_data.is_none(),
    context_lines,
  ))
}

fn diff_unstaged_file(
  repo: &gix::Repository,
  worktree_path: &PathBuf,
  file_path: &str,
  index: &gix::index::File,
) -> napi::Result<String> {
  diff_unstaged_file_ctx(repo, worktree_path, file_path, index, CONTEXT_LINES)
}

fn diff_unstaged_file_ctx(
  repo: &gix::Repository,
  worktree_path: &PathBuf,
  file_path: &str,
  index: &gix::index::File,
  context_lines: u32,
) -> napi::Result<String> {
  // Get blob from index
  let old_data: Option<Vec<u8>> = index
    .entries()
    .iter()
    .find(|e| e.path(index).to_str_lossy() == file_path)
    .and_then(|entry| repo.find_object(entry.id).ok().map(|obj| obj.detach().data));

  // Read file from disk
  let disk_path = worktree_path.join(file_path);

  // Size guard
  if let Ok(meta) = std::fs::metadata(&disk_path) {
    if meta.len() > MAX_FILE_SIZE {
      return Ok(String::new());
    }
  }

  let new_data = std::fs::read(&disk_path).ok();

  let old = old_data.as_deref().unwrap_or(b"");
  let new = new_data.as_deref().unwrap_or(b"");

  if old == new {
    return Ok(String::new());
  }

  Ok(compute_and_format_with_context(
    old,
    new,
    file_path,
    false,
    new_data.is_none(),
    context_lines,
  ))
}

fn diff_untracked_file(worktree_path: &PathBuf, file_path: &str) -> napi::Result<String> {
  diff_untracked_file_ctx(worktree_path, file_path, CONTEXT_LINES)
}

fn diff_untracked_file_ctx(worktree_path: &PathBuf, file_path: &str, context_lines: u32) -> napi::Result<String> {
  let disk_path = worktree_path.join(file_path);

  // Size guard
  if let Ok(meta) = std::fs::metadata(&disk_path) {
    if meta.len() > MAX_FILE_SIZE {
      return Ok(String::new());
    }
  }

  let data = std::fs::read(&disk_path)
    .map_err(|e| napi::Error::from_reason(format!("Failed to read file: {e}")))?;

  if data.is_empty() {
    return Ok(String::new());
  }

  Ok(compute_and_format_with_context(b"", &data, file_path, true, false, context_lines))
}

#[napi]
pub async fn get_commit_file_diff(
  cwd: String,
  hash: String,
  file_path: String,
) -> napi::Result<String> {
  with_repo(&cwd, |repo| commit_file_diff_inner(repo, &hash, &file_path))
}

pub(crate) fn commit_file_diff_inner(
  repo: &gix::Repository,
  hash: &str,
  file_path: &str,
) -> napi::Result<String> {
  let commit_id = repo
    .rev_parse_single(hash)
    .map_err(|e| napi::Error::from_reason(format!("Failed to parse revision: {e}")))?;
  let commit = commit_id
    .object()
    .map_err(|e| napi::Error::from_reason(format!("Failed to read object: {e}")))?
    .try_into_commit()
    .map_err(|e| napi::Error::from_reason(format!("Not a commit: {e}")))?;

  let commit_tree = commit
    .tree()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get tree: {e}")))?;

  // Get parent tree blob for this file (first parent, or empty for root commits)
  let parent_blob: Option<Vec<u8>> = commit
    .parent_ids()
    .next()
    .and_then(|pid| pid.object().ok())
    .and_then(|obj| obj.try_into_commit().ok())
    .and_then(|pc| pc.tree().ok())
    .and_then(|tree| tree.lookup_entry_by_path(file_path).ok().flatten())
    .and_then(|entry| entry.object().ok())
    .map(|obj| obj.detach().data);

  // Get blob from commit tree
  let commit_blob: Option<Vec<u8>> = commit_tree
    .lookup_entry_by_path(file_path)
    .ok()
    .flatten()
    .and_then(|entry| entry.object().ok())
    .map(|obj| obj.detach().data);

  let old = parent_blob.as_deref().unwrap_or(b"");
  let new = commit_blob.as_deref().unwrap_or(b"");

  if old.is_empty() && new.is_empty() {
    return Ok(String::new());
  }
  if old == new {
    return Ok(String::new());
  }

  Ok(compute_and_format(
    old,
    new,
    file_path,
    parent_blob.is_none(),
    commit_blob.is_none(),
  ))
}
