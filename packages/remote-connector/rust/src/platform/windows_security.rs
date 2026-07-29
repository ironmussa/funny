use crate::platform::isolation::IsolationFailure;

#[cfg(windows)]
use crate::platform::isolation::IdentitySnapshot;
#[cfg(windows)]
use std::path::Path;

pub fn pipe_sddl(service_sid: &str, runtime_sid: &str) -> Result<String, IsolationFailure> {
    if !valid_sid(service_sid) || !valid_sid(runtime_sid) || service_sid == runtime_sid {
        return Err(IsolationFailure::InspectionFailed);
    }
    Ok(format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{service_sid})(A;;GRGW;;;{runtime_sid})"
    ))
}

fn valid_sid(value: &str) -> bool {
    value.starts_with("S-1-")
        && value
            .split('-')
            .skip(2)
            .all(|component| !component.is_empty() && component.chars().all(|c| c.is_ascii_digit()))
}

pub fn directory_sddl_is_private(sddl: &str, service_sid: &str) -> bool {
    if !valid_sid(service_sid)
        || !sddl.starts_with(&format!("O:{service_sid}"))
        || !sddl.contains("D:P")
    {
        return false;
    }
    let mut found_service = false;
    for ace in sddl.split('(').skip(1) {
        let Some(ace) = ace.split(')').next() else {
            return false;
        };
        let fields: Vec<_> = ace.split(';').collect();
        if fields.len() != 6 || fields[0] != "A" {
            return false;
        }
        let trustee = fields[5];
        if !matches!(trustee, "SY" | "BA") && trustee != service_sid {
            return false;
        }
        found_service |= trustee == service_sid;
    }
    found_service
}

#[cfg(windows)]
pub fn inspect_directory_security(
    path: &Path,
    service_sid: &str,
) -> Result<bool, IsolationFailure> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION};

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    let result = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != ERROR_SUCCESS || descriptor.is_null() {
        return Err(IsolationFailure::InspectionFailed);
    }

    let mut sddl_ptr = ptr::null_mut();
    let mut sddl_len = 0;
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut sddl_ptr,
            &mut sddl_len,
        )
    };
    let sddl = if converted != 0 && !sddl_ptr.is_null() {
        let units = unsafe { std::slice::from_raw_parts(sddl_ptr, sddl_len as usize) };
        Some(String::from_utf16_lossy(units))
    } else {
        None
    };
    unsafe {
        if !sddl_ptr.is_null() {
            LocalFree(sddl_ptr.cast());
        }
        LocalFree(descriptor.cast());
    }
    sddl.map(|value| directory_sddl_is_private(&value, service_sid))
        .ok_or(IsolationFailure::InspectionFailed)
}

#[cfg(windows)]
pub fn current_identity() -> Result<IdentitySnapshot, IsolationFailure> {
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER, TokenElevation,
        TokenSessionId, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(IsolationFailure::InspectionFailed);
    }

    let mut user_size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut user_size);
    }
    let mut user_buffer = vec![0_u8; user_size as usize];
    if user_size == 0
        || unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                user_buffer.as_mut_ptr().cast(),
                user_size,
                &mut user_size,
            )
        } == 0
    {
        unsafe {
            CloseHandle(token);
        }
        return Err(IsolationFailure::InspectionFailed);
    }
    let token_user = unsafe { &*(user_buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid_ptr = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_ptr) } == 0
        || sid_ptr.is_null()
    {
        unsafe {
            CloseHandle(token);
        }
        return Err(IsolationFailure::InspectionFailed);
    }
    let sid_len = (0..)
        .take_while(|index| unsafe { *sid_ptr.add(*index) != 0 })
        .count();
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_ptr, sid_len) });
    unsafe {
        LocalFree(sid_ptr.cast());
    }

    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0;
    let elevation_inspected = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    let mut session_id = 1_u32;
    let session_inspected = unsafe {
        GetTokenInformation(
            token,
            TokenSessionId,
            (&mut session_id as *mut u32).cast(),
            size_of::<u32>() as u32,
            &mut returned,
        )
    };
    unsafe {
        CloseHandle(token);
    }
    if elevation_inspected == 0 || session_inspected == 0 {
        return Err(IsolationFailure::InspectionFailed);
    }

    let mut name_buffer = [0_u16; 256];
    let mut name_len = name_buffer.len() as u32;
    if unsafe { GetUserNameW(name_buffer.as_mut_ptr(), &mut name_len) } == 0 || name_len < 2 {
        return Err(IsolationFailure::InspectionFailed);
    }
    let name = String::from_utf16_lossy(&name_buffer[..name_len as usize - 1]);
    Ok(IdentitySnapshot {
        name,
        uid: 0,
        primary_group_id: 0,
        security_identifier: Some(sid),
        elevated: elevation.TokenIsElevated != 0,
        non_login: session_id == 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dacl_excludes_broad_windows_principals() {
        let sddl = pipe_sddl("S-1-5-80-100", "S-1-5-21-200").expect("valid SDDL");
        assert!(!sddl.contains(";;;WD"));
        assert!(!sddl.contains(";;;AN"));
        assert!(!sddl.contains(";;;AU"));
        assert!(sddl.contains("S-1-5-80-100"));
        assert!(sddl.contains("S-1-5-21-200"));
    }

    #[test]
    fn dacl_rejects_shared_or_invalid_identities() {
        assert!(pipe_sddl("S-1-5-80-100", "S-1-5-80-100").is_err());
        assert!(pipe_sddl("service", "S-1-5-21-200").is_err());
    }

    #[test]
    fn storage_acl_allows_only_service_and_administrators() {
        let service_sid = "S-1-5-80-100";
        assert!(directory_sddl_is_private(
            "O:S-1-5-80-100D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-80-100)",
            service_sid,
        ));
        assert!(!directory_sddl_is_private(
            "O:S-1-5-80-100D:P(A;;FA;;;SY)(A;;FR;;;WD)(A;;FA;;;S-1-5-80-100)",
            service_sid,
        ));
        assert!(!directory_sddl_is_private(
            "O:S-1-5-80-100D:AI(A;;FA;;;S-1-5-80-100)",
            service_sid,
        ));
    }
}
