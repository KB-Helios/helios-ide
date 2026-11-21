//! Command line of the gate sandbox helper. Pure and cross-platform so it is unit tested everywhere.
//!
//! ```text
//! thinkrail-gate-sandbox check
//! thinkrail-gate-sandbox cleanup
//! thinkrail-gate-sandbox run --cwd <dir> --cmdline <raw command line>
//!     [--read <path>]... [--read-optional <path>]... [--write <path>]... [--traverse <path>]... [--env NAME=VALUE]...
//!     [--timeout-ms <n>]
//! ```
//!
//! `--cmdline` is handed to `CreateProcessW` verbatim (the caller builds
//! `"C:\\Windows\\System32\\cmd.exe" /d /s /c "<gate command>"`), so the helper never re-parses or
//! re-quotes a gate command. With one or more `--env` the command gets exactly those variables (the
//! helper's own environment, which the host controls, never leaks into a gate); with none it inherits.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// Create and delete a profile and run a trivial command inside it: "is the sandbox usable here?".
    Check,
    /// Delete AppContainer profiles left behind by helper runs that were killed outright.
    Cleanup,
    Run(RunSpec),
}

#[derive(Debug, PartialEq, Eq, Default)]
pub struct RunSpec {
    pub cwd: PathBuf,
    pub cmdline: OsString,
    /// Granted read+execute; a failed grant aborts the run (the checkout, its dependency links).
    pub read: Vec<PathBuf>,
    /// Granted read+execute when possible; a failed grant is only reported (toolchain folders the
    /// gate may or may not need).
    pub read_optional: Vec<PathBuf>,
    /// Granted read+write; the one private scratch directory.
    pub write: Vec<PathBuf>,
    /// Granted list/traverse on the folder itself only (not what is in it); best effort. Some tools (Bun) open
    /// every parent folder of their working directory and fail when one cannot be listed.
    pub traverse: Vec<PathBuf>,
    /// `NAME=VALUE` entries that are the command's whole environment; empty means "inherit".
    pub env: Vec<OsString>,
    pub timeout_ms: Option<u64>,
}

/// Parses everything after the program name.
pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Command, String> {
    let mut args = args.into_iter();
    match args.next().as_deref().and_then(|a| a.to_str()) {
        Some("check") => match args.next() {
            None => Ok(Command::Check),
            Some(extra) => Err(format!("unexpected argument {extra:?} after `check`")),
        },
        Some("cleanup") => match args.next() {
            None => Ok(Command::Cleanup),
            Some(extra) => Err(format!("unexpected argument {extra:?} after `cleanup`")),
        },
        Some("run") => parse_run(args).map(Command::Run),
        Some(other) => Err(format!(
            "unknown command `{other}` (want `run`, `check` or `cleanup`)"
        )),
        None => Err("missing command (want `run`, `check` or `cleanup`)".to_string()),
    }
}

fn parse_run(mut args: impl Iterator<Item = OsString>) -> Result<RunSpec, String> {
    let mut spec = RunSpec::default();
    let mut cwd = None;
    let mut cmdline = None;
    while let Some(flag) = args.next() {
        let name = flag.to_string_lossy().into_owned();
        let mut value = |what: &str| args.next().ok_or_else(|| format!("{name} needs {what}"));
        match name.as_str() {
            "--cwd" => cwd = Some(PathBuf::from(value("a directory")?)),
            "--cmdline" => cmdline = Some(value("a command line")?),
            "--read" => spec.read.push(PathBuf::from(value("a path")?)),
            "--read-optional" => spec.read_optional.push(PathBuf::from(value("a path")?)),
            "--write" => spec.write.push(PathBuf::from(value("a path")?)),
            "--traverse" => spec.traverse.push(PathBuf::from(value("a path")?)),
            "--env" => {
                let entry = value("NAME=VALUE")?;
                if !entry.to_string_lossy().contains('=') {
                    return Err(format!("--env wants NAME=VALUE, got {entry:?}"));
                }
                spec.env.push(entry);
            }
            "--timeout-ms" => {
                let raw = value("a number of milliseconds")?;
                let parsed = raw
                    .to_string_lossy()
                    .parse::<u64>()
                    .ok()
                    .filter(|ms| *ms > 0)
                    .ok_or_else(|| format!("--timeout-ms wants a positive integer, got {raw:?}"))?;
                spec.timeout_ms = Some(parsed);
            }
            other => return Err(format!("unknown flag `{other}`")),
        }
    }
    spec.cwd = cwd.ok_or("--cwd is required")?;
    let cmdline = cmdline.ok_or("--cmdline is required")?;
    if cmdline.is_empty() {
        return Err("--cmdline must not be empty".to_string());
    }
    spec.cmdline = cmdline;
    Ok(spec)
}

/// Why `path` may not be granted to the sandbox, or `None` when it is fine. A grant is applied to a
/// whole tree, so the folders that hold the user's own files (a drive root, the profile, anything
/// above it) are never acceptable, and a relative path would mean the caller's cwd.
pub fn forbidden_grant(path: &Path, home: Option<&Path>) -> Option<String> {
    if !path.is_absolute() {
        return Some("is not an absolute path".to_string());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Some("contains `..`".to_string());
    }
    let depth = path
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if depth == 0 {
        return Some("is a drive or filesystem root".to_string());
    }
    if let Some(home) = home {
        if home.starts_with(path) {
            return Some("is the user profile or one of its parents".to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_check() {
        assert_eq!(parse(os(&["check"])), Ok(Command::Check));
        assert!(parse(os(&["check", "--read"])).is_err());
    }

    #[test]
    fn parses_a_full_run() {
        let command = parse(os(&[
            "run",
            "--cwd",
            "C:\\work\\snap",
            "--cmdline",
            "\"C:\\Windows\\System32\\cmd.exe\" /d /s /c \"bun run test\"",
            "--read",
            "C:\\work\\snap",
            "--read",
            "C:\\repo\\node_modules",
            "--read-optional",
            "C:\\bun",
            "--write",
            "C:\\scratch",
            "--env",
            r"PATH=C:\bun",
            "--timeout-ms",
            "60000",
        ]))
        .unwrap();
        let Command::Run(spec) = command else {
            panic!("expected a run")
        };
        assert_eq!(spec.cwd, PathBuf::from("C:\\work\\snap"));
        assert_eq!(
            spec.cmdline,
            OsString::from("\"C:\\Windows\\System32\\cmd.exe\" /d /s /c \"bun run test\"")
        );
        assert_eq!(spec.read.len(), 2);
        assert_eq!(spec.read_optional, vec![PathBuf::from("C:\\bun")]);
        assert_eq!(spec.write, vec![PathBuf::from("C:\\scratch")]);
        assert_eq!(spec.env, vec![OsString::from(r"PATH=C:\bun")]);
        assert_eq!(spec.timeout_ms, Some(60_000));
    }

    #[test]
    fn rejects_malformed_runs() {
        for bad in [
            os(&[]),
            os(&["frobnicate"]),
            os(&["run"]),
            os(&["run", "--cwd", "x"]),
            os(&["run", "--cmdline", "x"]),
            os(&["run", "--cwd", "x", "--cmdline", ""]),
            os(&["run", "--cwd", "x", "--cmdline", "y", "--timeout-ms", "0"]),
            os(&[
                "run",
                "--cwd",
                "x",
                "--cmdline",
                "y",
                "--timeout-ms",
                "soon",
            ]),
            os(&["run", "--cwd", "x", "--cmdline", "y", "--network"]),
            os(&["run", "--cwd", "x", "--cmdline", "y", "--read"]),
            os(&["run", "--cwd", "x", "--cmdline", "y", "--env", "NOEQUALS"]),
        ] {
            assert!(parse(bad.clone()).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn grants_refuse_roots_the_profile_and_relative_paths() {
        let home = Path::new(if cfg!(windows) {
            "C:\\Users\\kevin"
        } else {
            "/home/kevin"
        });
        let (root, users, nested, relative) = if cfg!(windows) {
            (
                "C:\\",
                "C:\\Users",
                "C:\\Users\\kevin\\.bun\\bin",
                "work\\snap",
            )
        } else {
            ("/", "/home", "/home/kevin/.bun/bin", "work/snap")
        };
        assert!(forbidden_grant(Path::new(root), Some(home)).is_some());
        assert!(forbidden_grant(Path::new(users), Some(home)).is_some());
        assert!(forbidden_grant(home, Some(home)).is_some());
        assert!(forbidden_grant(Path::new(relative), Some(home)).is_some());
        assert!(forbidden_grant(Path::new(nested), Some(home)).is_none());
        let dotdot = if cfg!(windows) {
            "C:\\work\\..\\Users"
        } else {
            "/work/../home"
        };
        assert!(forbidden_grant(Path::new(dotdot), Some(home)).is_some());
    }
}
