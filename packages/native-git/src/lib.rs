#[macro_use]
extern crate napi_derive;

mod repo_cache;
mod status_summary;
mod diff_summary;
mod branch;
mod log;
mod file_diff;
mod commit_info;
mod reset;
mod list_files;
mod stash;
mod stage_helpers;
mod branch_summary;

pub use status_summary::*;
pub use diff_summary::*;
pub use branch::*;
pub use log::*;
pub use file_diff::*;
pub use commit_info::*;
pub use reset::*;
pub use list_files::*;
pub use stash::*;
pub use stage_helpers::*;
pub use branch_summary::*;

/// Simple ping function to verify the native module loads correctly.
#[napi]
pub fn ping() -> String {
  "pong".to_string()
}
