//! EXE と同じ階層の設定ファイル。利用者の文書には触らない。

pub mod lock;
pub mod store;

#[cfg(all(test, windows))]
mod real_file_tests;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::shell::{ShellState, send_notice};
use store::{Change, SETTINGS_FILE, Store};

/// EXE の隣のパス。分からなければメモリだけで動く。
pub fn path_beside_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(SETTINGS_FILE))
}

/// 変更を書き、知らせる物があれば画面へ出す。設定の失敗で文書の処理を止めない。
pub fn record(app: &AppHandle, change: Change) {
    if let Some(key) = app.state::<Store>().update(change) {
        send_notice(app.state::<ShellState>().inner(), key);
    }
}

async fn on_worker<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(&app))
        .await
        .map_err(|error| error.to_string())
}

/// ファイルを読み直して返す。別の EXE の分も見える。
#[tauri::command]
pub async fn recent_list(app: AppHandle) -> Result<Vec<String>, String> {
    on_worker(app, |app| app.state::<Store>().snapshot().recent).await
}

#[tauri::command]
pub async fn clear_recent(app: AppHandle) -> Result<(), String> {
    on_worker(app, |app| record(app, Change::ClearRecent)).await
}

/// 減らすだけの口。一覧に無いパスを渡しても何も起きない。
#[tauri::command]
pub async fn forget_recent(app: AppHandle, path: String) -> Result<(), String> {
    on_worker(app, move |app| record(app, Change::RemoveRecent(path))).await
}

#[tauri::command]
pub async fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !store::THEMES.contains(&theme.as_str()) {
        return Err("unknown theme".into());
    }
    on_worker(app, move |app| {
        crate::window::apply_theme(app, &theme);
        record(app, Change::Theme(theme))
    })
    .await
}

/// 起動セレモニーの旗を書く。`unlock` が true なら、Options に項目を出す印も書く。
#[tauri::command]
pub async fn set_splash_ceremony(app: AppHandle, enabled: bool, unlock: bool) -> Result<(), String> {
    on_worker(app, move |app| {
        record(app, Change::SplashCeremony(enabled));
        if unlock {
            record(app, Change::SplashCeremonyUnlocked(true));
        }
    })
    .await
}

/// 右端で折り返すかを書く。表示だけの設定。
#[tauri::command]
pub async fn set_wrap_lines(app: AppHandle, wrap: bool) -> Result<(), String> {
    on_worker(app, move |app| record(app, Change::WrapLines(wrap))).await
}

#[tauri::command]
pub async fn set_language(app: AppHandle, language: String) -> Result<(), String> {
    if !store::LANGUAGES.contains(&language.as_str()) {
        return Err("unknown language".into());
    }
    on_worker(app, move |app| {
        crate::dict::set_language(&language);
        record(app, Change::Language(language))
    })
    .await
}
