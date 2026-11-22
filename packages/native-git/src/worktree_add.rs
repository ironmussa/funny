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
/// (hooks, some upstream setups); `unsupported_reason` then says what, and
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
  // Upstreams from a local branch (`always`) or copied from the start point
  // (`inherit`) are left to `git branch`; `plan_upstream` handles the rest.
  let auto_setup = repo
    .config_snapshot()
    .string("branch.autoSetupMerge")
    .map(|v| v.to_string().to_ascii_lowercase());
  if matches!(auto_setup.as_deref(), Some("always") | Some("inherit")) {
    return Ok(Some(format!("branch.autoSetupMerge={}", auto_setup.unwrap())));
  }
  Ok(None)
}

/// `branch.<name>.*` git writes for a new branch, from `git branch`'s rules.
struct Upstream {
  remote: String,
  merge: String,
  rebase: bool,
}

/// How a new branch from `start` is tracked, like `git branch` with
/// `branch.autoSetupMerge` unset, `true`, `false` or `simple`: only a
/// remote-tracking start point is tracked, by the remote whose fetch refspec
/// maps a branch onto it. `Err` names a case left to the CLI (an ambiguous
/// or excluded mapping, stale `branch.<name>` config).
fn plan_upstream(
  repo: &gix::Repository,
  branch: &str,
  start: &str,
) -> napi::Result<Result<Option<Upstream>, String>> {
  let config = repo.config_snapshot();
  let mode = config
    .string("branch.autoSetupMerge")
    .map(|v| v.to_string().to_ascii_lowercase());
  let simple = mode.as_deref() == Some("simple");
  if !simple && config.boolean("branch.autoSetupMerge") == Some(false) {
    return Ok(Ok(None));
  }
  let Some(reference) = repo
    .try_find_reference(start)
    .map_err(|e| reason("Failed to look up the start point", e))?
  else {
    return Ok(Ok(None));
  };
  if reference.name().category() != Some(Category::RemoteBranch) {
    return Ok(Ok(None));
  }
  let tracking = reference.name().as_bstr().to_string();

  let mut found: Vec<(String, String)> = Vec::new();
  for remote_name in repo.remote_names() {
    let remote_name = remote_name.to_string();
    let Ok(remote) = repo.find_remote(remote_name.as_str()) else {
      return Ok(Err(format!("unreadable remote {remote_name}")));
    };
    let mut merge = None;
    for spec in remote.refspecs(gix::remote::Direction::Fetch) {
      match spec.to_ref().instruction() {
        gix::refspec::Instruction::Fetch(gix::refspec::instruction::Fetch::Exclude { .. }) => {
          return Ok(Err(format!("negative refspec on remote {remote_name}")));
        }
        gix::refspec::Instruction::Fetch(gix::refspec::instruction::Fetch::AndUpdate {
          src,
          dst,
          ..
        }) if merge.is_none() => {
          merge = reverse_map(&src.to_string(), &dst.to_string(), &tracking);
        }
        _ => {}
      }
    }
    if let Some(merge) = merge {
      found.push((remote_name, merge));
    }
  }
  if found.len() > 1 {
    return Ok(Err("ambiguous upstream".into()));
  }
  let Some((remote, merge)) = found.pop() else {
    return Ok(Ok(None));
  };
  if simple && merge != format!("refs/heads/{branch}") {
    return Ok(Ok(None));
  }
  let rebase = matches!(
    config
      .string("branch.autoSetupRebase")
      .map(|v| v.to_string().to_ascii_lowercase())
      .as_deref(),
    Some("always") | Some("remote")
  );
  Ok(Ok(Some(Upstream {
    remote,
    merge,
    rebase,
  })))
}

/// The source ref a fetch refspec `src:dst` maps onto `tracking`, like git's
/// `remote_find_tracking` (one `*` on each side, or an exact `dst`).
fn reverse_map(src: &str, dst: &str, tracking: &str) -> Option<String> {
  match (src.split_once('*'), dst.split_once('*')) {
    (Some((src_pre, src_suf)), Some((dst_pre, dst_suf))) => {
      let middle = tracking.strip_prefix(dst_pre)?.strip_suffix(dst_suf)?;
      Some(format!("{src_pre}{middle}{src_suf}"))
    }
    (None, None) if dst == tracking => Some(src.to_string()),
    _ => None,
  }
}

fn common_config(repo: &gix::Repository) -> napi::Result<gix::config::FileTransaction> {
  repo
    .config_file_mut(repo.common_dir().join("config"))
    .map_err(|e| reason("Failed to open the repository config", e))
}

fn write_upstream(repo: &gix::Repository, branch: &str, upstream: &Upstream) -> napi::Result<()> {
  let mut config = common_config(repo)?;
  let mut set = |key: &str, value: &str| {
    config
      .set_raw_value_by("branch", branch, key, value)
      .map(|_| ())
      .map_err(|e| reason(&format!("Failed to set branch.{branch}.{key}"), e))
  };
  set("remote", &upstream.remote)?;
  set("merge", &upstream.merge)?;
  if upstream.rebase {
    set("rebase", "true")?;
  }
  config
    .commit()
    .map_err(|e| reason("Failed to write the repository config", e))
}

/// Undo `write_upstream`: the section did not exist before it.
fn remove_upstream(repo: &gix::Repository, branch: &str) {
  if let Ok(mut config) = common_config(repo) {
    config.remove_section("branch", branch);
    let _ = config.commit();
  }
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

  let start = options.start_point.as_deref().unwrap_or("HEAD");
  let upstream = if options.create_branch {
    match plan_upstream(&repo, &options.branch, start)? {
      Ok(upstream) => upstream,
      Err(why) => return unsupported(why),
    }
  } else {
    None
  };
  if upstream.is_some()
    && repo
      .config_snapshot()
      .plumbing()
      .section("branch", options.branch.as_str())
      .is_ok()
  {
    return unsupported(format!("existing branch.{} config", options.branch));
  }

  let name = FullName::try_from(format!("refs/heads/{}", options.branch))
    .map_err(|e| reason("Invalid branch name", e))?;

  let created = if options.create_branch {
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
    if let Some(upstream) = &upstream {
      if let Err(e) = write_upstream(&repo, &options.branch, upstream) {
        remove_upstream(&repo, &options.branch);
        delete_created_branch(&repo, name, commit);
        return Err(e);
      }
    }
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
        if upstream.is_some() {
          remove_upstream(&repo, &options.branch);
        }
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
