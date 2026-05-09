use std::time::SystemTime;

use gix::bstr::ByteSlice;

use crate::repo_cache::with_repo;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct GitLogEntry {
  pub hash: String,
  pub short_hash: String,
  pub author: String,
  pub relative_date: String,
  pub message: String,
}

/// Format a timestamp as a relative date string (e.g. "2 hours ago", "3 days ago").
pub(crate) fn format_relative_date(seconds_since_epoch: i64) -> String {
  let now = SystemTime::now()
    .duration_since(SystemTime::UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0);

  let diff = now - seconds_since_epoch;
  if diff < 0 {
    return "just now".to_string();
  }

  let diff = diff as u64;
  if diff < 60 {
    return format!("{} seconds ago", diff);
  }
  let minutes = diff / 60;
  if minutes < 60 {
    if minutes == 1 {
      return "1 minute ago".to_string();
    }
    return format!("{} minutes ago", minutes);
  }
  let hours = minutes / 60;
  if hours < 24 {
    if hours == 1 {
      return "1 hour ago".to_string();
    }
    return format!("{} hours ago", hours);
  }
  let days = hours / 24;
  if days < 30 {
    if days == 1 {
      return "1 day ago".to_string();
    }
    return format!("{} days ago", days);
  }
  let months = days / 30;
  if months < 12 {
    if months == 1 {
      return "1 month ago".to_string();
    }
    return format!("{} months ago", months);
  }
  let years = months / 12;
  if years == 1 {
    return "1 year ago".to_string();
  }
  format!("{} years ago", years)
}

#[napi]
pub async fn get_log(cwd: String, limit: Option<u32>) -> napi::Result<Vec<GitLogEntry>> {
  with_repo(&cwd, |repo| {
    let head_commit = repo
      .head_commit()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD commit: {e}")))?;

    let max = limit.unwrap_or(20) as usize;
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(max);

    let walk = repo.rev_walk([head_commit.id()]);
    let iter = walk
      .all()
      .map_err(|e| napi::Error::from_reason(format!("Failed to start rev walk: {e}")))?;

    for commit_info in iter {
      if entries.len() >= max {
        break;
      }
      let info = commit_info
        .map_err(|e| napi::Error::from_reason(format!("Rev walk error: {e}")))?;

      let commit = info
        .object()
        .map_err(|e| napi::Error::from_reason(format!("Failed to read commit: {e}")))?;

      let hash = commit.id().to_string();
      let short_hash = hash[..7.min(hash.len())].to_string();

      let author_sig = commit.author().ok();

      let author_name = author_sig
        .as_ref()
        .map(|a| a.name.to_string())
        .unwrap_or_default();

      let time_seconds = author_sig
        .as_ref()
        .and_then(|a| a.time().ok())
        .map(|t| t.seconds)
        .unwrap_or(0);

      let relative_date = format_relative_date(time_seconds);

      // message_raw_sloppy returns &BStr, use ByteSlice::lines()
      let raw_message = commit.message_raw_sloppy();
      let message = raw_message
        .lines()
        .next()
        .map(|l| l.to_str_lossy().to_string())
        .unwrap_or_default();

      entries.push(GitLogEntry {
        hash,
        short_hash,
        author: author_name,
        relative_date,
        message,
      });
    }

    Ok(entries)
  })
}

#[napi]
pub async fn get_commit_body(cwd: String, hash: String) -> napi::Result<String> {
  with_repo(&cwd, |repo| {
    let commit_id = repo
      .rev_parse_single(hash.as_str())
      .map_err(|e| napi::Error::from_reason(format!("Failed to parse revision '{}': {e}", hash)))?;

    let commit = commit_id
      .object()
      .map_err(|e| napi::Error::from_reason(format!("Failed to read object: {e}")))?
      .try_into_commit()
      .map_err(|e| napi::Error::from_reason(format!("Object is not a commit: {e}")))?;

    let raw = commit.message_raw_sloppy();
    let full = raw.to_str_lossy();
    let body = match full.find('\n') {
      Some(idx) => full[idx + 1..].trim().to_string(),
      None => String::new(),
    };

    Ok(body)
  })
}

#[napi]
pub async fn get_unpushed_hashes(cwd: String) -> napi::Result<Vec<String>> {
  with_repo(&cwd, |repo| {
    let head_commit = match repo.head_commit() {
      Ok(c) => c,
      Err(_) => return Ok(Vec::new()),
    };

    // Collect all remote ref commit IDs
    let refs = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;
    let remote_refs = match refs.remote_branches() {
      Ok(r) => r,
      Err(_) => return Ok(Vec::new()),
    };

    let mut remote_tips: Vec<gix::ObjectId> = Vec::new();
    for r in remote_refs {
      if let Ok(r) = r {
        if let Ok(peeled) = r.into_fully_peeled_id() {
          remote_tips.push(peeled.detach());
        }
      }
    }

    // Use with_hidden to mark remote tips as "uninteresting" — gix will
    // walk from HEAD and automatically exclude commits reachable from
    // remote tips. This is equivalent to `git rev-list HEAD --not --remotes`.
    // The old approach used two separate walks with a shared MAX_WALK=1000
    // budget, which broke on repos with many remote branches (the budget
    // was exhausted visiting unique commits across branches).
    const MAX_UNPUSHED: usize = 1000;
    let mut unpushed = Vec::new();
    let walk = repo.rev_walk([head_commit.id()]).with_hidden(remote_tips);
    if let Ok(iter) = walk.all() {
      for ci in iter {
        if unpushed.len() >= MAX_UNPUSHED { break; }
        if let Ok(info) = ci {
          unpushed.push(info.id.to_string());
        }
      }
    }

    Ok(unpushed)
  })
}
