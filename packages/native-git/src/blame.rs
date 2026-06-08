use std::collections::HashMap;
use std::path::PathBuf;

use gix::bstr::{BStr, ByteSlice};
use gix::ObjectId;

use crate::log::format_relative_date;

/// One contiguous run of lines in the blamed file that share the same source
/// commit. Lines are 1-based and refer to the file *as of HEAD* (see the note
/// on `blame_file` for how this maps to a working-tree view).
#[napi(object)]
#[derive(Debug, Clone)]
pub struct BlameHunk {
  /// First line of the hunk, 1-based.
  pub start_line: u32,
  /// Number of consecutive lines this hunk spans.
  pub line_count: u32,
  pub commit_hash: String,
  pub short_hash: String,
  pub author: String,
  pub relative_date: String,
  /// First line of the commit message (subject).
  pub summary: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BlameResult {
  pub hunks: Vec<BlameHunk>,
  /// Number of lines in the blamed (HEAD) version of the file. The client uses
  /// this to detect working-tree lines that extend past what was committed.
  pub blamed_line_count: u32,
}

/// Resolved commit metadata, cached per blame run so a commit that introduced
/// many hunks is only decoded once.
#[derive(Clone)]
struct CommitMeta {
  short_hash: String,
  author: String,
  relative_date: String,
  summary: String,
}

fn resolve_commit_meta(repo: &gix::Repository, id: ObjectId) -> CommitMeta {
  let hash = id.to_string();
  let short_hash = hash[..7.min(hash.len())].to_string();

  let commit = match repo.find_commit(id) {
    Ok(c) => c,
    Err(_) => {
      return CommitMeta {
        short_hash,
        author: String::new(),
        relative_date: String::new(),
        summary: String::new(),
      };
    }
  };

  let author_sig = commit.author().ok();
  let author = author_sig
    .as_ref()
    .map(|a| a.name.to_string())
    .unwrap_or_default();
  let time_seconds = author_sig
    .as_ref()
    .and_then(|a| a.time().ok())
    .map(|t| t.seconds)
    .unwrap_or(0);
  let relative_date = format_relative_date(time_seconds);

  let raw = commit.message_raw_sloppy();
  let summary = raw.to_str_lossy().lines().next().unwrap_or("").trim().to_string();

  CommitMeta {
    short_hash,
    author,
    relative_date,
    summary,
  }
}

/// Count the lines in a blob the same way the editor would: every `\n` ends a
/// line, plus a trailing partial line if the blob does not end in a newline.
fn count_lines(blob: &[u8]) -> u32 {
  if blob.is_empty() {
    return 0;
  }
  let newlines = blob.iter().filter(|&&b| b == b'\n').count();
  let trailing = if blob.last() == Some(&b'\n') { 0 } else { 1 };
  (newlines + trailing) as u32
}

/// Blame the file at the absolute path `file_path` against the current HEAD
/// commit and return per-hunk attribution.
///
/// The repository is discovered by walking up from the file's directory, so the
/// caller does not need to know the repo / worktree root — only a canonical
/// absolute path (which the route has already scope-checked).
///
/// **Working-tree caveat:** gix blames the file as it exists at HEAD, not the
/// working copy. When the open file has uncommitted edits, line numbers can
/// drift and freshly added lines have no entry. Callers should treat lines past
/// `blamed_line_count` (or unmatched lines) as "not committed yet".
#[napi]
pub async fn blame_file(file_path: String) -> napi::Result<BlameResult> {
  let abs = PathBuf::from(&file_path);
  let dir = abs
    .parent()
    .ok_or_else(|| napi::Error::from_reason("File path has no parent directory".to_string()))?;

  let repo = gix::discover(dir)
    .map_err(|e| napi::Error::from_reason(format!("Failed to discover repo: {e}")))?;

  let workdir = repo
    .workdir()
    .ok_or_else(|| napi::Error::from_reason("Repository has no working tree".to_string()))?;
  // Align symlink/canonicalization differences between the route-supplied
  // realpath and gix's discovered workdir before computing the relative path.
  let workdir = workdir.canonicalize().unwrap_or_else(|_| workdir.to_path_buf());
  let abs = abs.canonicalize().unwrap_or(abs);

  let rel = abs
    .strip_prefix(&workdir)
    .map_err(|_| napi::Error::from_reason("File is outside the repository worktree".to_string()))?;
  let rel = rel.to_string_lossy().replace('\\', "/");
  let path_bstr: &BStr = BStr::new(rel.as_bytes());

  let head = repo
    .head_commit()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD commit: {e}")))?;
  let suspect = head.id().detach();

  let outcome = repo
    .blame_file(path_bstr, suspect, Default::default())
    .map_err(|e| napi::Error::from_reason(format!("Failed to blame '{}': {e}", rel)))?;

  let blamed_line_count = count_lines(&outcome.blob);

  let mut meta_cache: HashMap<ObjectId, CommitMeta> = HashMap::new();
  let mut hunks: Vec<BlameHunk> = Vec::with_capacity(outcome.entries.len());

  for entry in &outcome.entries {
    let id = entry.commit_id;
    let meta = meta_cache
      .entry(id)
      .or_insert_with(|| resolve_commit_meta(&repo, id))
      .clone();

    hunks.push(BlameHunk {
      start_line: entry.start_in_blamed_file + 1,
      line_count: entry.len.get(),
      commit_hash: id.to_string(),
      short_hash: meta.short_hash,
      author: meta.author,
      relative_date: meta.relative_date,
      summary: meta.summary,
    });
  }

  Ok(BlameResult {
    hunks,
    blamed_line_count,
  })
}
