//! The Windows implementation: one gate command inside a throwaway AppContainer.
//!
//! What the process gets, and nothing else:
//! * the AppContainer package identity of a profile created for this run only (no capabilities, so no
//!   `internetClient`/`privateNetwork`: it has no network at all, loopback included);
//! * read+execute on the paths named with `--read`/`--read-optional` (the snapshot checkout, its
//!   dependency folders, the toolchain), through an ACE for the profile's SID;
//! * read+write on the paths named with `--write` (one private scratch directory);
//! * whatever Windows already grants to `ALL APPLICATION PACKAGES` (the system folders, so `cmd.exe`
//!   and the runtimes start). The user's profile and everything else is closed to it.
//!
//! The process runs in a kill-on-close job object, so the whole tree dies with the helper, on the
//! timeout, or when the caller closes the helper's stdin (the control channel: stdin is never handed to
//! the gate, which gets `NUL`). Every ACE granted is revoked and the profile deleted on the way out.

use std::ffi::{c_void, OsStr, OsString};
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, HANDLE, HANDLE_FLAG_INHERIT,
    HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT,
    TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{
    FreeSid, InitializeSecurityDescriptor, SetKernelObjectSecurity, SetSecurityDescriptorDacl, ACL,
    DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SECURITY_CAPABILITIES, SECURITY_DESCRIPTOR, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateEventW, CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, SetEvent, UpdateProcThreadAttribute,
    WaitForMultipleObjects, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::cli::{forbidden_grant, RunSpec};

/// The exit code of a run that timed out (the convention of GNU `timeout`).
pub const EXIT_TIMEOUT: i32 = 124;
/// The exit code of a run the caller cancelled by closing the control channel.
pub const EXIT_CANCELLED: i32 = 130;

const WRITE_MASK: u32 = FILE_GENERIC_READ.0
    | FILE_GENERIC_WRITE.0
    | FILE_GENERIC_EXECUTE.0
    | 0x0001_0000 /* DELETE */
    | 0x0040 /* FILE_DELETE_CHILD */;
/// Read and execute, plus `FILE_WRITE_ATTRIBUTES`: Bun asks for it on every file it opens, even to read, and
/// fails with EPERM without it. It lets a command touch a timestamp or an attribute flag, never content, so
/// the snapshot's bytes (and its git tree) stay exactly what was tested.
/// List and traverse one folder: enough to open it and see its entries' names, nothing more.
const TRAVERSE_MASK: u32 = 0x0001 /* FILE_LIST_DIRECTORY */
    | 0x0020 /* FILE_TRAVERSE */
    | 0x0080 /* FILE_READ_ATTRIBUTES */
    | 0x0008 /* FILE_READ_EA */
    | 0x0002_0000 /* READ_CONTROL */
    | 0x0010_0000 /* SYNCHRONIZE */;
const READ_MASK: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0 | 0x0100 /* FILE_WRITE_ATTRIBUTES */;

/// Diagnostics for best-effort steps stay quiet (a gate's output is read by people and models) unless asked for.
fn verbose(message: &str) {
    if std::env::var_os("THINKRAIL_GATE_SANDBOX_VERBOSE").is_some() {
        eprintln!("thinkrail-gate-sandbox: {message}");
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn win32(error: WIN32_ERROR, what: &str) -> Result<(), String> {
    if error.0 == 0 {
        Ok(())
    } else {
        Err(format!("{what} failed (Win32 error {})", error.0))
    }
}

/// The per-run AppContainer profile; deleted on drop.
struct Profile {
    /// The profile (and Packages folder) name.
    label: String,
    name: HSTRING,
    sid: PSID,
}

impl Profile {
    fn create() -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        // 64 characters at most; the pid + clock make the name (hence the SID) unique per run.
        let label = format!("helios.gate.{}.{:x}", std::process::id(), nanos);
        let name = HSTRING::from(label.as_str());
        let display = HSTRING::from("Helios gate sandbox");
        let sid = match unsafe { CreateAppContainerProfile(&name, &display, &display, None) } {
            Ok(sid) => sid,
            Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => {
                unsafe { DeriveAppContainerSidFromAppContainerName(&name) }
                    .map_err(|e| format!("could not derive the AppContainer SID: {e}"))?
            }
            Err(error) => {
                return Err(format!(
                    "could not create the AppContainer profile: {error}"
                ))
            }
        };
        Ok(Self { label, name, sid })
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            if let Err(error) = DeleteAppContainerProfile(&self.name) {
                eprintln!(
                    "thinkrail-gate-sandbox: could not delete the AppContainer profile: {error}"
                );
            }
            FreeSid(self.sid);
        }
    }
}

/// Adds or removes the profile's non-inherited ACE on one folder, through a handle: unlike
/// `SetNamedSecurityInfoW` that never walks the folder's subtree, so it is safe on a parent such as the
/// user's profile, where a tree-wide propagation could take minutes.
fn change_acl_here(path: &Path, sid: PSID, mask: u32, grant: bool) -> Result<(), String> {
    let name = wide(path.as_os_str());
    unsafe {
        let handle = CreateFileW(
            PCWSTR(name.as_ptr()),
            0x0002_0000 | 0x0004_0000, // READ_CONTROL | WRITE_DAC
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            HANDLE::default(),
        )
        .map(OwnedHandle)
        .map_err(|e| {
            format!(
                "{}: could not open it to change its ACL: {e}",
                path.display()
            )
        })?;
        let mut old: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        win32(
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old),
                None,
                Some(&mut descriptor),
            ),
            "reading the ACL",
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: if grant { mask } else { 0 },
            grfAccessMode: if grant { GRANT_ACCESS } else { REVOKE_ACCESS },
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0 as *mut u16),
            },
        };
        let mut merged: *mut ACL = std::ptr::null_mut();
        let applied = win32(
            SetEntriesInAclW(Some(&[entry]), Some(old), &mut merged),
            "building the ACL",
        )
        .and_then(|()| {
            // SetKernelObjectSecurity writes this one object's DACL; unlike SetSecurityInfo it never walks
            // (and rewrites) the folder's whole subtree, which on a parent such as AppData takes minutes.
            let mut descriptor = SECURITY_DESCRIPTOR::default();
            let pointer = PSECURITY_DESCRIPTOR(&mut descriptor as *mut _ as *mut c_void);
            InitializeSecurityDescriptor(pointer, 1 /* SECURITY_DESCRIPTOR_REVISION */)
                .and_then(|()| SetSecurityDescriptorDacl(pointer, true, Some(merged), false))
                .and_then(|()| {
                    SetKernelObjectSecurity(handle.0, DACL_SECURITY_INFORMATION, pointer)
                })
                .map_err(|e| format!("writing the ACL failed: {e}"))
        });
        if !merged.is_null() {
            let _ = LocalFree(HLOCAL(merged as *mut c_void));
        }
        let _ = LocalFree(HLOCAL(descriptor.0));
        applied.map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Adds (`grant`) or removes (`!grant`) the profile's ACE on `path`; with `inherit`, it is inherited by
/// everything below it (and propagated through the existing tree).
fn change_acl(path: &Path, sid: PSID, mask: u32, inherit: bool, grant: bool) -> Result<(), String> {
    if !inherit {
        return change_acl_here(path, sid, mask, grant);
    }
    let name = wide(path.as_os_str());
    let object = PCWSTR(name.as_ptr());
    unsafe {
        let mut old: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        win32(
            GetNamedSecurityInfoW(
                object,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old),
                None,
                &mut descriptor,
            ),
            "reading the ACL",
        )?;
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: if grant { mask } else { 0 },
            grfAccessMode: if grant { GRANT_ACCESS } else { REVOKE_ACCESS },
            grfInheritance: if inherit {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: PWSTR(sid.0 as *mut u16),
            },
        };
        let mut merged: *mut ACL = std::ptr::null_mut();
        let built = win32(
            SetEntriesInAclW(Some(&[entry]), Some(old), &mut merged),
            "building the ACL",
        );
        let applied = built.and_then(|()| {
            win32(
                // Not PROTECTED: the new ACE propagates to every child that inherits.
                SetNamedSecurityInfoW(
                    object,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    PSID::default(),
                    PSID::default(),
                    Some(merged),
                    None,
                ),
                "writing the ACL",
            )
        });
        if !merged.is_null() {
            let _ = LocalFree(HLOCAL(merged as *mut c_void));
        }
        let _ = LocalFree(HLOCAL(descriptor.0));
        applied.map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// ACEs granted so far; revoked on drop, newest first, never failing the run.
struct Grants<'a> {
    sid: PSID,
    done: Vec<(&'a Path, u32, bool)>,
}

impl<'a> Grants<'a> {
    fn add(&mut self, path: &'a Path, mask: u32, inherit: bool) -> Result<(), String> {
        change_acl(path, self.sid, mask, inherit, true)?;
        self.done.push((path, mask, inherit));
        Ok(())
    }
}

impl Drop for Grants<'_> {
    fn drop(&mut self) {
        for (path, mask, inherit) in self.done.drain(..).rev() {
            // A path the caller already deleted (the checkout, the scratch) has nothing to revoke.
            if path.exists() {
                if let Err(error) = change_acl(path, self.sid, mask, inherit, false) {
                    eprintln!("thinkrail-gate-sandbox: could not revoke access: {error}");
                }
            }
        }
    }
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn inheritable(handle: HANDLE) -> Result<HANDLE, String> {
    use windows::Win32::Foundation::SetHandleInformation;
    unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
            .map_err(|e| format!("could not make a standard handle inheritable: {e}"))?;
    }
    Ok(handle)
}

/// An inheritable handle to `NUL`, for a standard stream the helper does not have.
fn nul(read: bool) -> Result<OwnedHandle, String> {
    let name = wide(OsStr::new("NUL"));
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: true.into(),
    };
    let access = if read {
        FILE_GENERIC_READ.0
    } else {
        FILE_GENERIC_WRITE.0
    };
    unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            Some(&attributes),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            HANDLE::default(),
        )
    }
    .map(OwnedHandle)
    .map_err(|e| format!("could not open NUL: {e}"))
}

fn output_handle(id: windows::Win32::System::Console::STD_HANDLE) -> Result<HANDLE, String> {
    match unsafe { GetStdHandle(id) } {
        Ok(handle) if !handle.is_invalid() && handle.0 as usize != 0 => inheritable(handle),
        _ => Ok(nul(false)?.into_raw()),
    }
}

impl OwnedHandle {
    /// Leaks the handle on purpose: it lives as long as the helper does.
    fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

fn guard(path: &Path) -> Result<(), String> {
    match forbidden_grant(path, home_dir().as_deref()) {
        Some(why) => Err(format!(
            "refusing to grant access to {}: it {why}",
            path.display()
        )),
        None => Ok(()),
    }
}

/// Runs the gate and returns the process exit code (or `EXIT_TIMEOUT` / `EXIT_CANCELLED`).
pub fn run(spec: &RunSpec) -> Result<i32, String> {
    for path in spec
        .read
        .iter()
        .chain(&spec.read_optional)
        .chain(&spec.write)
    {
        guard(path)?;
    }
    cleanup();
    let profile = Profile::create()?;
    let mut grants = Grants {
        sid: profile.sid,
        done: Vec::new(),
    };
    for path in &spec.read {
        grants.add(path, READ_MASK, true)?;
    }
    for path in &spec.read_optional {
        if let Err(error) = grants.add(path, READ_MASK, true) {
            verbose(&format!("skipped an optional read grant: {error}"));
        }
    }
    for path in &spec.write {
        grants.add(path, WRITE_MASK, true)?;
    }
    for path in &spec.traverse {
        if let Err(error) = grants.add(path, TRAVERSE_MASK, false) {
            verbose(&format!("skipped a traverse grant: {error}"));
        }
    }
    precreate_temp(spec, &profile);
    let code = launch(spec, &profile);
    // Revoke before the profile goes (the drop order is the reverse of declaration).
    drop(grants);
    code
}

/// Whether a process with this id is still running (a reused id only makes cleanup more cautious).
fn process_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let handle = OwnedHandle(handle);
                let mut code = 0u32;
                GetExitCodeProcess(handle.0, &mut code).map_or(true, |()| code == 259)
            }
            // No such process, or one we may not even query: only the former is "gone".
            Err(error) => error.code() == ERROR_ACCESS_DENIED.to_hresult(),
        }
    }
}

/// Deletes the profiles (named `helios.gate.<pid>.<nonce>`) of helper runs that no longer exist. A run
/// killed outright cannot clean up after itself, so every run starts by doing it for its predecessors.
pub fn cleanup() -> usize {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(PathBuf::from(local).join("Packages")) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("helios.gate.") else {
            continue;
        };
        let Some(pid) = rest.split('.').next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        if pid == std::process::id() || process_alive(pid) {
            continue;
        }
        if unsafe { DeleteAppContainerProfile(&HSTRING::from(name.as_str())) }.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Windows points the command's TEMP at `<LOCALAPPDATA>Packages<profile>ACTemp` but only creates the
/// `AC` folder, so a tool that writes to its temp directory would fail. Create it here, inside the scratch
/// directory, where the command may write.
fn precreate_temp(spec: &RunSpec, profile: &Profile) {
    let local = spec
        .env
        .iter()
        .find_map(|entry| {
            let text = entry.to_string_lossy();
            text.to_uppercase()
                .starts_with("LOCALAPPDATA=")
                .then(|| PathBuf::from(&text["LOCALAPPDATA=".len()..]))
        })
        .or_else(|| spec.write.first().cloned());
    if let Some(local) = local {
        let _ = std::fs::create_dir_all(
            local
                .join("Packages")
                .join(&profile.label)
                .join("AC")
                .join("Temp"),
        );
    }
}

/// The reason `check` fails, or `Ok` when a trivial command ran inside a fresh AppContainer.
pub fn check() -> Result<(), String> {
    let comspec =
        std::env::var_os("ComSpec").unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into());
    let mut cmdline = OsString::from("\"");
    cmdline.push(&comspec);
    cmdline.push("\" /d /c exit 0");
    let spec = RunSpec {
        cwd: PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())),
        cmdline,
        timeout_ms: Some(30_000),
        ..RunSpec::default()
    };
    match run(&spec)? {
        0 => Ok(()),
        code => Err(format!(
            "a trivial command exited with {code} inside the AppContainer"
        )),
    }
}

/// The command's whole environment as a UTF-16 block (sorted, doubly NUL-terminated), or `None` to inherit.
fn environment_block(entries: &[OsString], local_app_data: Option<&Path>) -> Option<Vec<u16>> {
    if entries.is_empty() {
        return None;
    }
    let mut entries = entries.to_vec();
    // Windows builds the container's own `Packages<profile>AC` folders (and points TEMP at them) under
    // the environment's LOCALAPPDATA, and refuses to start the process without one. Default it to the
    // scratch directory so those folders stay inside the one place the command may write.
    let has_local = entries.iter().any(|e| {
        e.to_string_lossy()
            .to_uppercase()
            .starts_with("LOCALAPPDATA=")
    });
    if !has_local {
        if let Some(dir) = local_app_data {
            let mut entry = OsString::from("LOCALAPPDATA=");
            entry.push(dir);
            entries.push(entry);
        }
    }
    let mut sorted: Vec<&OsString> = entries.iter().collect();
    sorted.sort_by_key(|entry| entry.to_string_lossy().to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for entry in sorted {
        block.extend(entry.encode_wide());
        block.push(0);
    }
    block.push(0);
    Some(block)
}

fn launch(spec: &RunSpec, profile: &Profile) -> Result<i32, String> {
    let stdin = nul(true)?;
    let stdout = output_handle(STD_OUTPUT_HANDLE)?;
    let stderr = output_handle(STD_ERROR_HANDLE)?;
    let mut inherited = vec![stdin.0, stdout, stderr];
    inherited.dedup();
    inherited.sort_by_key(|h| h.0 as usize);
    inherited.dedup();

    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid,
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };

    let job = unsafe { CreateJobObjectW(None, None) }
        .map(OwnedHandle)
        .map_err(|e| format!("could not create the job object: {e}"))?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|e| format!("could not configure the job object: {e}"))?;

    // The attribute list: the AppContainer identity, and exactly the handles the gate may inherit.
    let mut size = 0usize;
    unsafe {
        let _ = InitializeProcThreadAttributeList(
            LPPROC_THREAD_ATTRIBUTE_LIST::default(),
            2,
            0,
            &mut size,
        );
    }
    let mut buffer = vec![0u8; size];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
    unsafe {
        InitializeProcThreadAttributeList(list, 2, 0, &mut size)
            .map_err(|e| format!("could not initialize the attribute list: {e}"))?;
        let attached = UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&mut capabilities as *mut _ as *const c_void),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .and_then(|()| {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(inherited.as_ptr() as *const c_void),
                inherited.len() * std::mem::size_of::<HANDLE>(),
                None,
                None,
            )
        });
        if let Err(error) = attached {
            DeleteProcThreadAttributeList(list);
            return Err(format!(
                "could not attach the sandbox to the process: {error}"
            ));
        }
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.0;
    startup.StartupInfo.hStdOutput = stdout;
    startup.StartupInfo.hStdError = stderr;
    startup.lpAttributeList = list;

    let environment = environment_block(&spec.env, spec.write.first().map(PathBuf::as_path));
    let mut cmdline = wide(&spec.cmdline);
    let cwd = wide(spec.cwd.as_os_str());
    let mut info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline.as_mut_ptr()),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT,
            environment
                .as_ref()
                .map(|block| block.as_ptr() as *const c_void),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    unsafe { DeleteProcThreadAttributeList(list) };
    created.map_err(|e| format!("could not start the command in the sandbox: {e}"))?;
    let process = OwnedHandle(info.hProcess);
    let thread = OwnedHandle(info.hThread);

    // In the job before it runs a single instruction, so nothing it spawns can escape the kill.
    if let Err(error) = unsafe { AssignProcessToJobObject(job.0, process.0) } {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process.0, 1);
        }
        return Err(format!(
            "could not put the command in its job object: {error}"
        ));
    }
    unsafe { ResumeThread(thread.0) };

    // The control channel: the caller closing our stdin means "stop now".
    let stop = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map(OwnedHandle)
        .map_err(|e| format!("could not create the stop event: {e}"))?;
    let stop_raw = stop.0 .0 as usize;
    std::thread::spawn(move || {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        unsafe {
            let _ = SetEvent(HANDLE(stop_raw as *mut c_void));
        }
    });

    let timeout = spec
        .timeout_ms
        .map(|ms| ms.min(u32::MAX as u64 - 1) as u32)
        .unwrap_or(u32::MAX);
    let waited = unsafe { WaitForMultipleObjects(&[process.0, stop.0], false, timeout) };
    let outcome = if waited == WAIT_OBJECT_0 {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(process.0, &mut code) }
            .map_err(|e| format!("could not read the exit code: {e}"))?;
        code as i32
    } else if waited == WAIT_TIMEOUT {
        eprintln!(
            "thinkrail-gate-sandbox: the command timed out after {} ms and was killed",
            spec.timeout_ms.unwrap_or_default()
        );
        EXIT_TIMEOUT
    } else if waited.0 == WAIT_OBJECT_0.0 + 1 {
        EXIT_CANCELLED
    } else {
        return Err("waiting for the command failed".to_string());
    };
    // Whatever is still alive in the job (the shell's children, a stray daemon) goes with it.
    unsafe {
        let _ = TerminateJobObject(job.0, 1);
    }
    let _ = INVALID_HANDLE_VALUE;
    Ok(outcome)
}
