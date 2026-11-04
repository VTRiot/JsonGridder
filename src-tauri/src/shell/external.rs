//! 開いているファイルを Windows の既定のテキストエディタで開く（Edit の「テキストで開く」、D5）。
//!
//! パスは画面から受けず、[`FileState`] の今の基準から取る。`.txt` の関連付けで開き、`.json` の
//! 関連付け（JsonGridder 自身のことがある）を使わない。シェルの文字列は組み立てない。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::file::identity::same_identity;
use crate::file::session::FileState;

/// 関連付けを引く種類。Windows の既定のテキストエディタ（ストアのメモ帳も含む）。
pub const TEXT_CLASS: &str = ".txt";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum TextEditorReply {
    Opened,
    /// `.txt` の関連付けが JsonGridder 自身。起動しない。
    SelfAssociated,
    /// ファイルが無い。
    Missing,
    /// 文書が無い（無題）か、`revision` が今の基準でない。
    Stale,
    /// 起動に失敗した。`code` は OS のエラーコード。
    Failed { code: u32 },
}

/// 起動の口。試験は記録だけの偽物へ差し替える。
pub trait TextEditorLauncher {
    /// `.txt` を開く実行ファイル。取れないとき（ストアのアプリなど）は `None`。
    fn text_executable(&self) -> Option<PathBuf>;
    /// `.txt` の関連付けで `path` を開く。
    fn launch(&self, path: &str) -> Result<(), u32>;
}

/// `revision` の基準のファイルを `.txt` の関連付けで開く。関連付けが自分の EXE なら開かない。
pub fn open_in_text_editor(
    state: &FileState,
    revision: u64,
    launcher: &dyn TextEditorLauncher,
    own_exe: Option<&Path>,
) -> TextEditorReply {
    let Some(path) = state.current_display_path(revision) else {
        return TextEditorReply::Stale;
    };
    if !Path::new(&path).is_file() {
        return TextEditorReply::Missing;
    }
    if let (Some(executable), Some(own)) = (launcher.text_executable(), own_exe) {
        if same_file(&executable, own) {
            return TextEditorReply::SelfAssociated;
        }
    }
    match launcher.launch(&path) {
        Ok(()) => TextEditorReply::Opened,
        Err(code) => TextEditorReply::Failed { code },
    }
}

/// 同じファイルか。両方の実体（ボリュームの番号とファイルの番号）が取れればそれで比べる。
/// ハードリンクは別のパスでも同じ実体になる。実体が取れなければ解決したパスで、それも取れなければ
/// 文字（大文字小文字を区別しない）で比べる。
fn same_file(a: &Path, b: &Path) -> bool {
    if let Some(same) = same_identity(a, b) {
        return same;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy()),
    }
}

/// 本物の起動。`AssocQueryStringW` と `ShellExecuteExW`。
pub struct SystemLauncher;

#[cfg(windows)]
mod imp {
    use std::ffi::OsString;
    use std::mem::size_of;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::PathBuf;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{GetLastError, RPC_E_CHANGED_MODE};
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::{
        ASSOCF_NOTRUNCATE, ASSOCSTR_EXECUTABLE, AssocQueryStringW, SEE_MASK_CLASSNAME,
        SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::{SystemLauncher, TEXT_CLASS, TextEditorLauncher};

    /// 拡張長のパスの最大の長さ（UTF-16 の単位、終端を含む）。
    const MAX_PATH_UNITS: usize = 32_768;
    const VERB_OPEN: &str = "open";

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text).encode_wide().chain(Some(0)).collect()
    }

    impl TextEditorLauncher for SystemLauncher {
        fn text_executable(&self) -> Option<PathBuf> {
            let class = wide(TEXT_CLASS);
            let verb = wide(VERB_OPEN);
            let mut buffer = vec![0u16; MAX_PATH_UNITS];
            let mut length = MAX_PATH_UNITS as u32;
            // SAFETY: 文字列は終端付きで呼び出しの間生きている。length はバッファの長さ
            let result = unsafe {
                AssocQueryStringW(
                    ASSOCF_NOTRUNCATE,
                    ASSOCSTR_EXECUTABLE,
                    class.as_ptr(),
                    verb.as_ptr(),
                    buffer.as_mut_ptr(),
                    &mut length,
                )
            };
            if result != 0 {
                return None;
            }
            let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
            if end == 0 {
                return None;
            }
            Some(PathBuf::from(OsString::from_wide(&buffer[..end])))
        }

        fn launch(&self, path: &str) -> Result<(), u32> {
            // 関連付けの先はシェルの拡張のことがある。COM をこのスレッドで用意し、終わったら戻す
            // SAFETY: 予約の引数は null。成功（S_OK、S_FALSE）のときだけ対になる CoUninitialize を呼ぶ
            let initialized = unsafe {
                CoInitializeEx(null_mut(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32)
            };
            let result = execute(path);
            if initialized >= 0 && initialized != RPC_E_CHANGED_MODE {
                // SAFETY: 上の CoInitializeEx が成功したときの対
                unsafe { CoUninitialize() };
            }
            result
        }
    }

    fn execute(path: &str) -> Result<(), u32> {
        let file = wide(path);
        let class = wide(TEXT_CLASS);
        let verb = wide(VERB_OPEN);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            // 拡張子でなく `.txt` の関連付けを使う。失敗は画面の文言で知らせるので、シェルの窓を出さない
            fMask: SEE_MASK_CLASSNAME | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            lpClass: class.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..Default::default()
        };
        // SAFETY: info の文字列は終端付きで、呼び出しの間生きている
        let ok = unsafe { ShellExecuteExW(&mut info) };
        if ok != 0 {
            Ok(())
        } else {
            // SAFETY: 直前の呼び出しのエラーを読むだけ
            Err(unsafe { GetLastError() })
        }
    }
}

#[cfg(not(windows))]
impl TextEditorLauncher for SystemLauncher {
    fn text_executable(&self) -> Option<PathBuf> {
        None
    }

    fn launch(&self, _path: &str) -> Result<(), u32> {
        Err(0)
    }
}
