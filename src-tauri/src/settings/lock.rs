//! 設定ファイルの読み直しと書き込みを、別の EXE と重ねないためのロック。
//!
//! 名前付きミューテックスを使う。プロセスが落ちても OS が放す。

use std::path::Path;
use std::time::Duration;

use crate::file::{sha256, to_hex};

/// `Local\` は同じログオンのセッションの内。別の利用者の設定は同じパスでも別の話である。
const NAME_PREFIX: &str = "Local\\JsonGridder.settings.";

/// 大文字小文字だけ違うパスは同じファイルなので、同じ名前にする。
fn lock_name(path: &Path) -> String {
    let folded = path.to_string_lossy().to_lowercase();
    format!("{NAME_PREFIX}{}", to_hex(&sha256(folded.as_bytes())))
}

#[cfg(windows)]
pub struct FileLock(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl FileLock {
    /// 取れなければ `None`。呼び出し側は書くのを 1 回飛ばす。
    pub fn acquire(path: &Path, timeout: Duration) -> Option<Self> {
        use std::ptr::null;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

        let name: Vec<u16> = lock_name(path).encode_utf16().chain(Some(0)).collect();
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: 名前は NUL で終わる UTF-16 の列で、呼び出しの間生きている。
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: 上で作った有効なハンドルを渡す。
        let waited = unsafe { WaitForSingleObject(handle, millis) };
        // 前の持ち主が落ちたときは WAIT_ABANDONED で渡される。自分の物として扱ってよい
        if waited == WAIT_OBJECT_0 || waited == WAIT_ABANDONED {
            Some(Self(handle))
        } else {
            // SAFETY: 所有していないハンドルを閉じるだけである。
            unsafe { CloseHandle(handle) };
            None
        }
    }
}

#[cfg(windows)]
impl Drop for FileLock {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;

        // SAFETY: このスレッドが所有するハンドルを放し、閉じる。値は `FileLock` の外へ出ない。
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
pub struct FileLock;

#[cfg(not(windows))]
impl FileLock {
    pub fn acquire(path: &Path, _timeout: Duration) -> Option<Self> {
        let _ = lock_name(path);
        Some(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_name_ignores_case_and_differs_by_path() {
        assert_eq!(
            lock_name(Path::new("C:\\App\\s.json")),
            lock_name(Path::new("c:\\app\\S.JSON"))
        );
        assert_ne!(
            lock_name(Path::new("C:\\a\\s.json")),
            lock_name(Path::new("C:\\b\\s.json"))
        );
    }
}
