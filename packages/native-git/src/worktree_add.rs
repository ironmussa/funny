use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::refs::{Category, FullName, Target};

use crate::repo_cache::evict_repo;

/// What `add_worktree` should check out.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AddWorktreeOptions {
  /// Short name of the branch the worktree checks out.
  pub branch: String,
  /// Create `branch` from this revision (`HEAD` when absent), like
  /// `git worktree add -b <branch> <path> <start>`. When false the branch
  /// must already exist, like `git worktree add <path> <branch>`.
  pub create_branch: bool,
  pub start_point: Option<String>,
}

/// `created` is false when the request needs something only the git CLI does
/// (hooks, upstream tracking); `unsupported_reason` then says what, and
/// nothing was written, so the caller can run `git worktree add` instead.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AddWorktreeOutcome {
  pub created: bool,
  pub unsupported_reason: Option<String>,
}

fn unsupported(reason: impl Into<String>) -> napi::Result<AddWorktreeOutcome> {
  Ok(AddWorktreeOutcome {
    created: false,
    unsupported_reason: Some(reason.into()),
  })
}

fn reason(context: &str, e: impl std::fmt::Display) -> napi::Error {
  napi::Error::from_reason(format!("{context}: {e}"))
}

/// Hooks git would run while adding a worktree. gitoxide runs no hooks, so a
/// repository with any of them must go through the CLI.
const HOOKS_RUN_BY_WORKTREE_ADD: &[&str] = &["post-checkout", "reference-transaction"];

#[cfg(unix)]
fn is_runnable_hook(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  std::fs::metadata(path)
    .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_runnable_hook(path: &Path) -> bool {
  path.is_file()
}

/// The hooks directory git would use, or `None` when it cannot be decided
/// without the CLI (a relative `core.hooksPath` resolves against the NEW
/// worktree, whose files do not exist yet).
fn hooks_dir(repo: &gix::Repository) -> Option<PathBuf> {
  let config = repo.config_snapshot();
  match config.string("core.hooksPath") {
    None => Some(repo.common_dir().join("hooks")),
    Some(raw) => {
      let raw = raw.to_string();
      let expanded = match raw.strip_prefix("~/") {
        Some(rest) => gix::path::env::home_dir()?.join(rest),
        None => PathBuf::from(raw),
      };
      expanded.is_absolute().then_some(expanded)
    }
  }
}

/// Why this repository or start point needs the git CLI, if it does.
fn cli_only_reason(
  repo: &gix::Repository,
  options: &AddWorktreeOptions,
) -> napi::Result<Option<String>> {
  let Some(dir) = hooks_dir(repo) else {
    return Ok(Some("relative core.hooksPath".into()));
  };
  if let Some(hook) = HOOKS_RUN_BY_WORKTREE_ADD
    .iter()
    .find(|hook| is_runnable_hook(&dir.join(hook)))
  {
    return Ok(Some(format!("{hook} hook")));
  }

  if !options.create_branch {
    return Ok(None);
  }
  // `git branch` sets an upstream for the new branch from these; gitoxide
  // does not, and the status counts read `<branch>@{upstream}`.
  let auto_setup = repo
    .config_snapshot()
    .string("branch.autoSetupMerge")
    .map(|v| v.to_string().to_ascii_lowercase());
  if matches!(auto_setup.as_deref(), Some("always") | Some("inherit")) {
    return Ok(Some(format!("branch.autoSetupMerge={}", auto_setup.unwrap())));
  }
  let start = options.start_point.as_deref().unwrap_or("HEAD");
  if let Some(reference) = repo
    .try_find_reference(start)
    .map_err(|e| reason("Failed to look up the start point", e))?
  {
    if reference.name().category() == Some(Category::RemoteBranch) {
      return Ok(Some("remote-tracking start point".into()));
    }
  }
  Ok(None)
}

fn delete_created_branch(repo: &gix::Repository, name: FullName, id: gix::ObjectId) {
  let _ = repo.edit_reference(RefEdit {
    change: Change::Delete {
      expected: PreviousValue::MustExistAndMatch(Target::Object(id)),
      log: RefLog::AndReference,
    },
    name,
    deref: false,
  });
}

fn add(cwd: &str, destination: &str, options: &AddWorktreeOptions) -> napi::Result<AddWorktreeOutcome> {
  // A fresh handle: the cached ones may be up to `CACHE_TTL` behind the refs.
  let repo = gix::open(cwd).map_err(|e| reason("Failed to open repo", e))?;

  if let Some(why) = cli_only_reason(&repo, options)? {
    return unsupported(why);
  }

  let name = FullName::try_from(format!("refs/heads/{}", options.branch))
    .map_err(|e| reason("Invalid branch name", e))?;

  let created = if options.create_branch {
    let start = options.start_point.as_deref().unwrap_or("HEAD");
    let commit = repo
      .rev_parse_single(start)
      .map_err(|e| reason(&format!("Invalid start point '{start}'"), e))?
      .object()
      .map_err(|e| reason("Failed to read the start point", e))?
      .peel_to_commit()
      .map_err(|e| reason("The start point is not a commit", e))?
      .id;
    repo
      .edit_reference(RefEdit {
        change: Change::Update {
          log: LogChange {
            mode: RefLog::AndReference,
            force_create_reflog: false,
            message: format!("branch: Created from {start}").into(),
          },
          expected: PreviousValue::MustNotExist,
          new: Target::Object(commit),
        },
        name: name.clone(),
        deref: false,
      })
      .map_err(|e| reason(&format!("Failed to create branch '{}'", options.branch), e))?;
    Some(commit)
  } else {
    None
  };

  let interrupt = AtomicBool::new(false);
  let result = repo.add_worktree(
    destination,
    gix::worktree::add::Head::Attached(name.clone()),
    gix::progress::Discard,
    &interrupt,
  );
  match result {
    Ok(_) => Ok(AddWorktreeOutcome {
      created: true,
      unsupported_reason: None,
    }),
    Err(e) => {
      // `add_worktree` already removed the registration and files it made;
      // the branch is ours to remove, and only if this call created it.
      if let Some(id) = created {
        delete_created_branch(&repo, name, id);
      }
      Err(reason("Failed to add worktree", e))
    }
  }
}

/// Add a linked worktree at `destination`, like `git worktree add`, without
/// spawning git. See `AddWorktreeOutcome` for the cases left to the CLI.
#[napi]
pub async fn add_worktree(
  cwd: String,
  destination: String,
  options: AddWorktreeOptions,
) -> napi::Result<AddWorktreeOutcome> {
  let result = add(&cwd, &destination, &options);
  evict_repo(&cwd);
  result
}
