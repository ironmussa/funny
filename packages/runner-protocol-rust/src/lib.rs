#![forbid(unsafe_code)]

pub mod runner {
    pub mod v2 {
        include!("generated/runner/v2/runner.v2.rs");
    }
}
