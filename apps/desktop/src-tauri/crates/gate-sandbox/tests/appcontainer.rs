//! Runs the real helper: these tests are the proof that a gate really is confined. Windows only.
#![cfg(windows)]

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_thinkrail-gate-sandbox");

struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

fn cmd_exe() -> String {
    std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
}

/// `"cmd.exe" /d /s /c "<script>"`, the way the host builds a gate command line.
fn cmdline(script: &str) -> String {
    format!("\"{}\" /d /s /c \"{script}\"", cmd_exe())
}

/// Tests share one machine-wide set of AppContainer profiles, so they take turns.
static TURN: Mutex<()> = Mutex::new(());

struct Fixture {
    _turn: MutexGuard<'static, ()>,
    root: PathBuf,
    snapshot: PathBuf,
    scratch: PathBuf,
    outside: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!(
            "helios-gate-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let snapshot = root.join("snapshot");
        let scratch = root.join("scratch");
        let outside = root.join("outside");
        for dir in [&snapshot, &scratch, &outside] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(snapshot.join("a.txt"), "original").unwrap();
        fs::create_dir_all(snapshot.join("src")).unwrap();
        fs::write(snapshot.join("src").join("b.txt"), "nested").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        Self {
            _turn: turn,
            root,
            snapshot,
            scratch,
            outside,
        }
    }

    fn base_args(&self, script: &str) -> Vec<String> {
        vec![
            "run".into(),
            "--cwd".into(),
            self.snapshot.display().to_string(),
            "--cmdline".into(),
            cmdline(script),
            "--read".into(),
            self.snapshot.display().to_string(),
            "--write".into(),
            self.scratch.display().to_string(),
        ]
    }

    fn run(&self, script: &str) -> Output {
        run_helper(&self.base_args(script))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Spawns the helper with its stdin held open (closing it is the cancel signal).
fn spawn_helper(args: &[String]) -> Child {
    Command::new(HELPER)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn collect(mut child: Child, hold_stdin: bool) -> Output {
    let stdin = child.stdin.take();
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let out_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = out.read_to_string(&mut text);
        text
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = err.read_to_string(&mut text);
        text
    });
    let status = child.wait().unwrap();
    drop(stdin);
    let _ = hold_stdin;
    Output {
        code: status.code().unwrap_or(-1),
        stdout: out_reader.join().unwrap(),
        stderr: err_reader.join().unwrap(),
    }
}

fn run_helper(args: &[String]) -> Output {
    collect(spawn_helper(args), true)
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn leftover_profiles() -> Vec<String> {
    let packages = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join("Packages");
    fs::read_dir(packages)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name.starts_with("helios.gate."))
                .collect()
        })
        .unwrap_or_default()
}

fn acl_of(path: &Path) -> String {
    let out = Command::new("icacls").arg(path).output().unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn check_reports_a_usable_sandbox() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let output = run_helper(&["check".to_string()]);
    assert_eq!(output.code, 0, "{}", output.stderr);
    assert!(output.stdout.contains("ok"));
}

#[test]
fn forwards_output_and_the_exit_code() {
    let fixture = Fixture::new("output");
    let output = fixture.run("echo to-stdout& echo to-stderr 1>&2& exit 7");
    assert_eq!(output.code, 7, "{}", output.stderr);
    assert!(output.stdout.contains("to-stdout"), "{}", output.stdout);
    assert!(output.stderr.contains("to-stderr"), "{}", output.stderr);
}

#[test]
fn the_snapshot_is_readable_but_never_writable() {
    let fixture = Fixture::new("readonly");
    let read = fixture.run("type a.txt& type src\\b.txt");
    assert_eq!(read.code, 0, "{}", read.stderr);
    assert!(read.stdout.contains("original") && read.stdout.contains("nested"));

    // Overwrite, create, delete and the X -> Y -> X dance: all of them must fail and change nothing.
    for script in [
        "echo changed> a.txt",
        "echo new> created.txt",
        "del a.txt",
        "echo changed> src\\b.txt",
        "mkdir newdir",
        "copy a.txt original.bak && echo Y> a.txt && copy original.bak a.txt",
    ] {
        let output = fixture.run(script);
        assert_ne!(output.code, 0, "`{script}` must fail inside the sandbox");
    }
    assert_eq!(read_file(&fixture.snapshot.join("a.txt")), "original");
    assert_eq!(
        read_file(&fixture.snapshot.join("src").join("b.txt")),
        "nested"
    );
    let names: Vec<_> = fs::read_dir(&fixture.snapshot)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 2, "snapshot gained or lost entries: {names:?}");
}

fn read_file(path: &Path) -> String {
    read(path)
}

#[test]
fn the_scratch_directory_is_writable() {
    let fixture = Fixture::new("scratch");
    let scratch = fixture.scratch.display().to_string();
    let output = fixture.run(&format!(
        "echo kept> \"{scratch}\\out.txt\" && type \"{scratch}\\out.txt\""
    ));
    assert_eq!(output.code, 0, "{}", output.stderr);
    assert!(read(&fixture.scratch.join("out.txt")).contains("kept"));
}

#[test]
fn files_the_user_owns_elsewhere_are_closed() {
    let fixture = Fixture::new("outside");
    let secret = fixture.outside.join("secret.txt");
    let output = fixture.run(&format!("type \"{}\"", secret.display()));
    assert_ne!(output.code, 0);
    assert!(!output.stdout.contains("secret"), "{}", output.stdout);
    assert_eq!(read(&secret), "secret");
}

#[test]
fn there_is_no_network_not_even_loopback() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut connections = 0;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    connections += 1;
                    // Read the request first: closing with unread data would reset the connection.
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.read(&mut [0u8; 1024]);
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
                    );
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        connections
    });
    let fixture = Fixture::new("network");
    let url = format!("http://127.0.0.1:{port}/");
    let curl = "C:\\Windows\\System32\\curl.exe";

    // The control: the same command outside the sandbox reaches the listener.
    let control = Command::new(curl)
        .args(["--silent", "--max-time", "5", &url])
        .output()
        .unwrap();
    assert!(
        control.status.success(),
        "curl cannot reach the listener at all"
    );

    let output = fixture.run(&format!("\"{curl}\" --silent --max-time 5 {url}"));
    assert_ne!(
        output.code, 0,
        "the sandboxed curl reached the network: {}",
        output.stdout
    );
    assert!(!output.stdout.contains("hi"), "{}", output.stdout);
    // Only the control connection ever arrived.
    assert_eq!(seen.join().unwrap(), 1);
}

#[test]
fn a_timeout_kills_the_command_and_reports_124() {
    let fixture = Fixture::new("timeout");
    let mut args = fixture.base_args("ping -n 60 127.0.0.2 > nul");
    // ping to loopback is blocked inside the container and returns at once; use a busy wait instead.
    args[4] = cmdline("for /l %i in (1,1,2147483647) do @rem");
    args.extend(["--timeout-ms".to_string(), "1500".to_string()]);
    let started = Instant::now();
    let output = run_helper(&args);
    assert_eq!(output.code, 124, "{}", output.stderr);
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(output.stderr.contains("timed out"));
}

#[test]
fn closing_stdin_cancels_the_run_and_cleans_up() {
    let fixture = Fixture::new("cancel");
    let mut args = fixture.base_args("x");
    args[4] = cmdline("for /l %i in (1,1,2147483647) do @rem");
    let mut child = spawn_helper(&args);
    std::thread::sleep(Duration::from_millis(1500));
    drop(child.stdin.take());
    let started = Instant::now();
    let output = collect(child, false);
    assert_eq!(output.code, 130, "{}", output.stderr);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn every_run_cleans_up_its_profile_and_its_access_entries() {
    let fixture = Fixture::new("cleanup");
    let before = leftover_profiles();
    let output = fixture.run("exit 0");
    assert_eq!(output.code, 0, "{}", output.stderr);
    assert_eq!(
        leftover_profiles(),
        before,
        "an AppContainer profile was left behind"
    );
    for dir in [&fixture.snapshot, &fixture.scratch] {
        let acl = acl_of(dir);
        assert!(
            !acl.contains("S-1-15-2-") && !acl.contains("helios.gate"),
            "a sandbox ACE was left on {}: {acl}",
            dir.display()
        );
    }
}

#[test]
fn refuses_to_grant_the_profile_or_a_drive_root() {
    let fixture = Fixture::new("guard");
    for forbidden in [
        std::env::var("USERPROFILE").unwrap(),
        "C:\\".to_string(),
        "relative\\path".to_string(),
    ] {
        let mut args = fixture.base_args("exit 0");
        args.extend(["--read".to_string(), forbidden.clone()]);
        let output = run_helper(&args);
        assert_eq!(output.code, 125, "{forbidden}: {}", output.stderr);
        assert!(
            output.stderr.contains("HELIOS_GATE_SANDBOX_ERROR"),
            "{}",
            output.stderr
        );
    }
}

#[test]
fn a_gate_that_exits_125_is_still_a_gate_result() {
    let fixture = Fixture::new("exit125");
    let output = fixture.run("exit 125");
    assert_eq!(output.code, 125);
    assert!(!output.stderr.contains("HELIOS_GATE_SANDBOX_ERROR"));
}

#[test]
fn the_command_gets_exactly_the_environment_it_is_given() {
    let fixture = Fixture::new("env");
    // The helper itself has a secret in its environment; the gate must never see it (cmd leaves an
    // undefined variable as its literal %NAME%).
    let mut args = fixture.base_args("echo [%HELIOS_SECRET%][%HELIOS_GIVEN%][%HOMEPATH%]& exit 0");
    for (name, value) in [
        ("SystemRoot", std::env::var("SystemRoot").unwrap()),
        ("HELIOS_GIVEN", "yes".to_string()),
    ] {
        args.extend(["--env".to_string(), format!("{name}={value}")]);
    }
    let output = collect(
        {
            let mut command = Command::new(HELPER);
            command
                .args(&args)
                .env("HELIOS_SECRET", "leaked")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            command.spawn().unwrap()
        },
        true,
    );
    assert_eq!(output.code, 0, "{}", output.stderr);
    assert!(
        output.stdout.contains("[%HELIOS_SECRET%][yes][%HOMEPATH%]"),
        "{}",
        output.stdout
    );
}

#[test]
fn the_containers_temp_directory_exists_and_is_writable() {
    let fixture = Fixture::new("temp");
    let mut args = fixture.base_args(r#"echo ok> "%TEMP%\probe.txt" && type "%TEMP%\probe.txt""#);
    args.extend([
        "--env".to_string(),
        format!("SystemRoot={}", std::env::var("SystemRoot").unwrap()),
    ]);
    let output = run_helper(&args);
    assert_eq!(output.code, 0, "{} {}", output.stdout, output.stderr);
    assert!(output.stdout.contains("ok"), "{}", output.stdout);
}

#[test]
fn a_parent_folder_grant_opens_nothing_inside_it_and_is_revoked() {
    let fixture = Fixture::new("traverse");
    let parent = fixture.root.clone();
    let mut args = fixture.base_args("exit 0");
    args.extend(["--traverse".to_string(), parent.display().to_string()]);
    let output = run_helper(&args);
    assert_eq!(output.code, 0, "{} {}", output.stdout, output.stderr);
    // The grant was for the folder only: a sibling's file stays closed, and the entry is gone again.
    let secret = fixture.outside.join("secret.txt");
    let mut closed = fixture.base_args(&format!("type \"{}\"", secret.display()));
    closed.extend(["--traverse".to_string(), parent.display().to_string()]);
    assert_ne!(run_helper(&closed).code, 0);
    let acl = acl_of(&parent);
    assert!(!acl.contains("S-1-15-2-"), "{acl}");
}
