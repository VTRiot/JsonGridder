//! ファイルの置き換えの OS の呼び出し。試験は失敗の状態を作る偽物へ差し替える。
//!
//! `ReplaceFileW` は ACL、別のデータの流れ、属性、作成日時を残す。`rename` は残さない。
//! flags は 0 で呼ぶ。ACL のエラーを無視する flags は ACL を黙って落とすことがある。

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// `ReplaceFileW` はファイルの書き込み権を見ないので、中身の書き込み権を別に確かめる。
/// 属性や追記の拒否は中身の書き換えを止めないので見ない。
/// 書かず、切り詰めず、他のプログラムの共有は妨げない。
pub fn open_for_write_check(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_DATA,
        };
        options.access_mode(FILE_WRITE_DATA);
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    #[cfg(not(windows))]
    options.write(true);
    options.open(path)
}

pub const ERROR_FILE_NOT_FOUND: u32 = 2;
pub const ERROR_ACCESS_DENIED: u32 = 5;
pub const ERROR_SHARING_VIOLATION: u32 = 32;
pub const ERROR_FILE_EXISTS: u32 = 80;
pub const ERROR_ALREADY_EXISTS: u32 = 183;
/// 元は退避名に居る。一時ファイルは元の名前のまま。
///
/// ほかの置き換えの失敗（1175、1176）は、退避名を渡していれば元も一時ファイルも元の名前の
/// ままなので、個別の処理が要らない。
pub const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: u32 = 1177;

pub trait Replacer {
    /// `target` を `replacement` で置き換える。元は `backup` の名前を通る。
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32>;

    /// 上書きせずに移す。`to` があれば失敗する。
    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32>;

    /// 一時ファイルを閉じた直後に呼ばれる。試験が読み直しの検証を確かめる口。
    fn temp_written(&self, _temp: &Path) {}
}

pub struct SystemReplacer;

#[cfg(windows)]
impl Replacer for SystemReplacer {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        use std::ptr::null;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        let (target, replacement, backup) = (wide(target), wide(replacement), wide(backup));
        // SAFETY: 3 つとも NUL で終わる UTF-16 の列で、呼び出しの間生きている。
        let done = unsafe {
            ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                backup.as_ptr(),
                0,
                null(),
                null(),
            )
        };
        if done != 0 { Ok(()) } else { Err(last_error()) }
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

        let (from, to) = (wide(from), wide(to));
        // SAFETY: 2 つとも NUL で終わる UTF-16 の列で、呼び出しの間生きている。
        let done = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if done != 0 { Ok(()) } else { Err(last_error()) }
    }
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn last_error() -> u32 {
    // SAFETY: 引数が無く、スレッドの値を読むだけである。
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

#[cfg(not(windows))]
impl Replacer for SystemReplacer {
    fn replace(&self, _target: &Path, _replacement: &Path, _backup: &Path) -> Result<(), u32> {
        Err(ERROR_CALL_NOT_IMPLEMENTED)
    }

    fn move_new(&self, _from: &Path, _to: &Path) -> Result<(), u32> {
        Err(ERROR_CALL_NOT_IMPLEMENTED)
    }
}

#[cfg(not(windows))]
const ERROR_CALL_NOT_IMPLEMENTED: u32 = 120;
