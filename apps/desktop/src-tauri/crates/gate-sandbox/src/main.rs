//! `thinkrail-gate-sandbox`: runs one factory gate command inside an OS sandbox.
//!
//! Windows is the only platform with a native helper (an AppContainer, see `win.rs`); Linux uses
//! bubblewrap and macOS `sandbox-exec` straight from the host (`packages/server/src/agent/factory/
//! sandbox.ts`). Elsewhere this binary reports that no sandbox exists and exits with
//! [`EXIT_SANDBOX_ERROR`], so a caller that finds it can never mistake that for a gate result.

mod cli;
#[cfg(windows)]
mod win;

use std::process::ExitCode;

/// The helper itself could not set up (or is unsupported): the gate command never ran. The message
/// is on stderr after [`ERROR_MARKER`]; the host treats the pair as "sandbox unavailable", never as a
/// gate failure. A gate that happens to exit 125 without the marker is an ordinary failure.
pub const EXIT_SANDBOX_ERROR: u8 = 125;
pub const ERROR_MARKER: &str = "HELIOS_GATE_SANDBOX_ERROR";

fn fail(message: &str) -> ExitCode {
    eprintln!("{ERROR_MARKER}: {message}");
    ExitCode::from(EXIT_SANDBOX_ERROR)
}

#[cfg(windows)]
fn main() -> ExitCode {
    match cli::parse(std::env::args_os().skip(1)) {
        Err(message) => fail(&message),
        Ok(cli::Command::Check) => match win::check() {
            Ok(()) => {
                println!("ok");
                ExitCode::SUCCESS
            }
            Err(message) => fail(&message),
        },
        Ok(cli::Command::Cleanup) => {
            println!("removed {}", win::cleanup());
            ExitCode::SUCCESS
        }
        Ok(cli::Command::Run(spec)) => match win::run(&spec) {
            // Exit codes are 32-bit on Windows; ExitCode only carries 8, so exit directly.
            Ok(code) => std::process::exit(code),
            Err(message) => fail(&message),
        },
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    if let Err(message) = cli::parse(std::env::args_os().skip(1)) {
        return fail(&message);
    }
    fail("this platform has no native gate sandbox helper (Linux uses bubblewrap, macOS sandbox-exec)")
}
