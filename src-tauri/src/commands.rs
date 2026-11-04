//! 画面から呼ぶファイルのコマンド。パスの許可は [`FileState`] の入口で確かめる。
//! 許可を与えるコマンドは作らない。
//!
//! ファイルの処理は待ちが長いので、作業用のスレッドで行う。本文は枠で渡す。

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

use crate::file::frame::{pack, unpack};
use crate::file::open::Accept;
use crate::file::replace::SystemReplacer;
use crate::file::scan::{Problem, ScanResult, diagnose, scan};
use crate::file::session::{DiskStatus, FileState, SaveReply, SaveRequest};
use crate::settings;
use crate::shell::external::{self, SystemLauncher, TextEditorReply};
use crate::settings::store::Change;

async fn on_worker<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&FileState) -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(app.state::<FileState>().inner()))
        .await
        .map_err(|error| error.to_string())
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err("expected a binary body".into()),
    }
}

/// 戻り値は枠。メタは `OpenReply`、本文は UTF-8 のテキスト。
#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    path: String,
    accept: Accept,
) -> Result<Response, String> {
    on_worker(app, move |state| {
        let (reply, text) = state.open(&path, &accept);
        let meta = serde_json::to_vec(&reply).map_err(|error| error.to_string())?;
        Ok(Response::new(pack(&meta, &text)))
    })
    .await?
}

#[tauri::command]
pub async fn commit_open(app: AppHandle, revision: u64) -> Result<bool, String> {
    let handle = app.clone();
    on_worker(app, move |state| {
        let committed = state.commit_open_path(revision);
        // 履歴のパスは Rust の基準から取る。画面の値を信じない
        if let Some(path) = &committed {
            settings::record(&handle, Change::AddRecent(path.clone()));
        }
        committed.is_some()
    })
    .await
}

/// 引数は枠。メタは `SaveRequest`、本文は UTF-8 のテキスト。
#[tauri::command]
pub async fn save_document(app: AppHandle, request: Request<'_>) -> Result<SaveReply, String> {
    let (meta, body) = unpack(raw_body(&request)?).ok_or("malformed frame")?;
    let save: SaveRequest = serde_json::from_slice(&meta).map_err(|error| error.to_string())?;
    let text = String::from_utf8(body).map_err(|error| error.to_string())?;
    on_worker(app, move |state| state.save(&save, &text, &SystemReplacer)).await
}

#[tauri::command]
pub async fn save_baseline_as(
    app: AppHandle,
    request: SaveRequest,
) -> Result<SaveReply, String> {
    on_worker(app, move |state| state.save_baseline_as(&request, &SystemReplacer)).await
}

/// 編集中のテキストを検査する。引数は UTF-8 の本文そのもの。
#[tauri::command]
pub async fn scan_text(app: AppHandle, request: Request<'_>) -> Result<ScanResult, String> {
    let text = raw_body(&request)?;
    on_worker(app, move |_| scan(&text)).await
}

/// 開いているファイルが外で変わったか（窓に戻ったときの見張り、D5）。聞くかどうかの判断にだけ使う。
#[tauri::command]
pub async fn disk_status(app: AppHandle, revision: u64) -> Result<DiskStatus, String> {
    on_worker(app, move |state| state.disk_status(revision)).await
}

/// 基準のファイルを Windows の既定のテキストエディタで開く（D5）。パスは画面から受けない。
#[tauri::command]
pub async fn open_in_text_editor(app: AppHandle, revision: u64) -> Result<TextEditorReply, String> {
    on_worker(app, move |state| {
        let own = std::env::current_exe().ok();
        external::open_in_text_editor(state, revision, &SystemLauncher, own.as_deref())
    })
    .await
}

/// 表とツリーに入れない最初の理由と位置（警告の帯に出す）。引数は UTF-8 の本文そのもの。
/// 表示の切り替えの判定には使わない（判定は `scan_text` と画面の門番が持つ）。
#[tauri::command]
pub async fn diagnose_text(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Option<Problem>, String> {
    let text = raw_body(&request)?;
    on_worker(app, move |_| diagnose(&text)).await
}
