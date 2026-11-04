//! ファイルの実体（ボリュームのシリアル番号と、そのボリュームの中のファイルの番号）。
//!
//! ハードリンクは別のパスでも同じ実体になる。パスの文字で比べると同じファイルを別と見なすので、
//! 同じファイルかの判定はここで実体を比べる。

use std::path::Path;

/// 両方の実体が取れれば、同じかどうかを返す。片方でも取れなければ `None`（呼び出し側が別の比べ方へ戻る）。
pub fn same_identity(a: &Path, b: &Path) -> Option<bool> {
    Some(imp::of(a)? == imp::of(b)?)
}

#[cfg(windows)]
mod imp {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle,
    };

    #[derive(Debug, PartialEq, Eq)]
    pub struct FileIdentity {
        volume: u32,
        index: u64,
    }

    /// 開けない、情報が取れないときは `None`。中身は読まない（属性だけの開き方）。
    pub fn of(path: &Path) -> Option<FileIdentity> {
        // 0 の権限で開く（属性を読むだけ）。実行中の EXE や他の窓が開いているファイルでも開ける
        let file = OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .ok()?;
        // SAFETY: 0 は全部の欄が数の構造体として正しい
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: file はこの呼び出しの間開いている。info は書き込める領域
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return None;
        }
        Some(FileIdentity {
            volume: info.dwVolumeSerialNumber,
            index: (u64::from(info.nFileIndexHigh) << u32::BITS) | u64::from(info.nFileIndexLow),
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    #[derive(Debug, PartialEq, Eq)]
    pub struct FileIdentity;

    pub fn of(_path: &Path) -> Option<FileIdentity> {
        None
    }
}
