//! 確認のダイアログ。`TaskDialogIndirect` の薄い包み。
//!
//! 既定のボタンを選べ、Esc と×を決まった答えへ写せる。別のスレッドで動かし、親に主窓を渡す。
//! JS の待ちを持たないので、レンダラが固まっていても出る。

use serde::Deserialize;

/// ボタンの ID の始まり。`IDCANCEL` などの標準の ID と重ならない値。
const FIRST_BUTTON_ID: i32 = 100;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub title: String,
    pub body: String,
    pub level: Level,
    pub buttons: Vec<String>,
    pub default: usize,
    pub cancel: usize,
}

/// 押されたボタンの ID を添字へ写す。ボタン以外の答えは `cancel`。
fn chosen_index(button_id: i32, button_count: usize, cancel: usize) -> usize {
    usize::try_from(button_id - FIRST_BUTTON_ID)
        .ok()
        .filter(|index| *index < button_count)
        .unwrap_or(cancel)
}

/// 主窓を親にして出し、押されたボタンの添字を返す。出せなければ `cancel` を返す。
/// 確認を得られないまま進めないためである。
pub fn show(parent: isize, request: &AskRequest) -> usize {
    match imp::show(parent, request) {
        Some(button_id) => chosen_index(button_id, request.buttons.len(), request.cancel),
        None => request.cancel,
    }
}

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, transmute, zeroed};
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TD_ERROR_ICON, TD_INFORMATION_ICON, TD_WARNING_ICON,
        TDF_ALLOW_DIALOG_CANCELLATION, TDF_POSITION_RELATIVE_TO_WINDOW,
    };
    use windows_sys::core::{BOOL, HRESULT, PCWSTR};

    use super::{AskRequest, FIRST_BUTTON_ID, Level};

    type TaskDialogIndirect = unsafe extern "system" fn(
        *const TASKDIALOGCONFIG,
        *mut i32,
        *mut i32,
        *mut BOOL,
    ) -> HRESULT;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 実行時に探す。この関数は comctl32 の v6 にしか無く、静的につなぐと manifest の無い
    /// 試験の実行ファイルが起動できない。
    fn task_dialog_indirect() -> Option<TaskDialogIndirect> {
        let library = wide("comctl32.dll");
        // SAFETY: 終端付きの文字列を渡す。取れた関数の型は上の宣言のとおり。
        unsafe {
            let module = LoadLibraryW(library.as_ptr());
            if module.is_null() {
                return None;
            }
            GetProcAddress(module, c"TaskDialogIndirect".as_ptr().cast())
                .map(|function| transmute::<_, TaskDialogIndirect>(function))
        }
    }

    fn icon(level: Level) -> PCWSTR {
        match level {
            Level::Info => TD_INFORMATION_ICON,
            Level::Warning => TD_WARNING_ICON,
            Level::Error => TD_ERROR_ICON,
        }
    }

    pub fn show(parent: isize, request: &AskRequest) -> Option<i32> {
        let task_dialog = task_dialog_indirect()?;

        let title = wide(&request.title);
        let body = wide(&request.body);
        let labels: Vec<Vec<u16>> = request.buttons.iter().map(|label| wide(label)).collect();
        let buttons: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .zip(FIRST_BUTTON_ID..)
            .map(|(label, id)| TASKDIALOG_BUTTON {
                nButtonID: id,
                pszButtonText: label.as_ptr(),
            })
            .collect();

        // SAFETY: 全部 0 は TASKDIALOGCONFIG の有効な既定値。参照先はこの関数の終わりまで生きる。
        unsafe {
            let mut config: TASKDIALOGCONFIG = zeroed();
            config.cbSize = size_of::<TASKDIALOGCONFIG>() as u32;
            config.hwndParent = parent as HWND;
            config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
            config.pszWindowTitle = title.as_ptr();
            config.pszContent = body.as_ptr();
            config.Anonymous1.pszMainIcon = icon(request.level);
            config.cButtons = buttons.len() as u32;
            config.pButtons = buttons.as_ptr();
            config.nDefaultButton = FIRST_BUTTON_ID + request.default as i32;

            let mut pressed = 0;
            let result = task_dialog(&config, &mut pressed, null_mut(), null_mut());
            (result >= 0).then_some(pressed)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::AskRequest;

    pub fn show(_parent: isize, _request: &AskRequest) -> Option<i32> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREE_BUTTONS: usize = 3;
    const CANCEL: usize = 2;
    /// ボタンを押さずに閉じたときの答え。
    const IDCANCEL: i32 = 2;

    #[test]
    fn a_pressed_button_maps_to_its_index() {
        assert_eq!(
            chosen_index(FIRST_BUTTON_ID + 1, THREE_BUTTONS, CANCEL),
            1
        );
    }

    #[test]
    fn escape_and_the_close_box_map_to_the_cancel_index() {
        assert_eq!(chosen_index(IDCANCEL, THREE_BUTTONS, CANCEL), CANCEL);
    }

    #[test]
    fn an_unknown_answer_maps_to_the_cancel_index() {
        let beyond = FIRST_BUTTON_ID + THREE_BUTTONS as i32;
        assert_eq!(chosen_index(beyond, THREE_BUTTONS, CANCEL), CANCEL);
    }

    #[test]
    fn the_request_reads_the_shape_the_screen_sends() {
        let request: AskRequest = serde_json::from_str(
            r#"{"title":"t","body":"b","level":"warning","buttons":["a","b"],"default":1,"cancel":1}"#,
        )
        .expect("request");
        assert_eq!(request.level, Level::Warning);
        assert_eq!(request.default, 1);
    }
}
