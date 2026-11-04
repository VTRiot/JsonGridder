//! 殻のコマンド。パスは Rust が許可してから `Open` で画面へ渡す。
//! 画面から許可を増やす口を作らない。

pub mod args;
pub mod external;
pub mod task_dialog;
pub mod unsaved;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, CloseRequestApi, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::dict::t;
use crate::file::session::FileState;
use crate::settings;
use crate::settings::store::{Change, Settings, Store};
use crate::window::save_placement;
use task_dialog::{AskRequest, CheckedAnswer, CheckedAskRequest, Level};
use unsaved::{Choice, DocumentReport, Effect, Intent, UnsavedState};

const JSON_EXTENSIONS: [&str; 1] = ["json"];
const ALL_EXTENSIONS: [&str; 1] = ["*"];
const MAIN_WINDOW: &str = "main";
/// 閉じたのにプロセスが残るときの猶予。レンダラの固まりで `destroy` が返らない場合に使う。
const EXIT_GRACE: Duration = Duration::from_secs(5);
const STUCK_WAIT: usize = 0;
const STUCK_CLOSE: usize = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ShellEvent {
    Open {
        path: String,
        discard_confirmed: bool,
    },
    Notice {
        key: String,
    },
    /// 閉じる確認で「保存」が選ばれた。`save_finished` で答える。
    SaveAndContinue {
        id: u64,
    },
}

#[derive(Default)]
pub struct ShellState {
    channel: Mutex<Option<Channel<ShellEvent>>>,
    unsaved: Mutex<UnsavedState>,
}

impl ShellState {
    fn send(&self, event: ShellEvent) {
        let channel = self.channel.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(channel) = channel.as_ref() {
            let _ = channel.send(event);
        }
    }

    fn unsaved(&self) -> MutexGuard<'_, UnsavedState> {
        self.unsaved.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn notice(key: &str) -> ShellEvent {
    ShellEvent::Notice { key: key.into() }
}

pub fn send_notice(shell: &ShellState, key: &str) {
    shell.send(notice(key));
}

/// 確認のボタン。既定は「保存」、保存できないときは「キャンセル」。
fn unsaved_request(choices: &[Choice]) -> AskRequest {
    unsaved_request_with(&t, choices)
}

/// 文言の引き方を渡せる形。試験は言語を替えずに両方の言語を確かめる。
fn unsaved_request_with(t: &dyn Fn(&str) -> String, choices: &[Choice]) -> AskRequest {
    let label = |choice: &Choice| match choice {
        Choice::Save => t("app.dialog.save"),
        Choice::Discard => t("app.dialog.dontSave"),
        Choice::Cancel => t("app.dialog.cancel"),
    };
    let cancel = choices.len() - 1;
    let can_save = choices.contains(&Choice::Save);
    AskRequest {
        title: t("app.dialog.unsavedTitle"),
        body: t(if can_save {
            "app.dialog.unsavedBody"
        } else {
            "app.dialog.unsavedBlockedBody"
        }),
        level: Level::Warning,
        buttons: choices.iter().map(label).collect(),
        default: if can_save { 0 } else { cancel },
        cancel,
    }
}

fn stuck_request() -> AskRequest {
    AskRequest {
        title: t("app.dialog.stuckTitle"),
        body: t("app.dialog.stuckBody"),
        level: Level::Warning,
        buttons: vec![t("app.dialog.wait"), t("app.dialog.closeWithoutSaving")],
        default: STUCK_WAIT,
        cancel: STUCK_WAIT,
    }
}

/// 主窓を親にして別のスレッドで聞く。メインスレッドとレンダラを待たせない。
fn ask_then(app: &AppHandle, request: AskRequest, answered: impl FnOnce(&AppHandle, usize) + Send + 'static) {
    let parent = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|window| window.hwnd().ok())
        .map_or(0, |handle| handle.0 as isize);
    let handle = app.clone();
    thread::spawn(move || {
        let index = task_dialog::show(parent, &request);
        answered(&handle, index);
    });
}

/// `destroy` がレンダラの固まりで返らなくても、プロセスを残さない。
fn arm_exit_fallback() {
    thread::spawn(|| {
        thread::sleep(EXIT_GRACE);
        std::process::exit(0);
    });
}

fn run_effect(app: &AppHandle, effect: Effect) {
    let shell = app.state::<ShellState>();
    match effect {
        Effect::None => {}
        Effect::Close => {
            arm_exit_fallback();
            save_placement(app);
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.destroy();
            }
        }
        Effect::Open {
            path,
            discard_confirmed,
        } => shell.send(ShellEvent::Open {
            path,
            discard_confirmed,
        }),
        Effect::Save { id } => shell.send(ShellEvent::SaveAndContinue { id }),
        Effect::OpenBusy => shell.send(notice("app.notice.openBlockedBusy")),
        Effect::Ask { choices } => {
            ask_then(app, unsaved_request(choices), move |app, index| {
                let shell = app.state::<ShellState>();
                let effect = shell.unsaved().answer(choices[index]);
                run_effect(app, effect);
            });
        }
        Effect::AskStuck => {
            ask_then(app, stuck_request(), |app, index| {
                let shell = app.state::<ShellState>();
                let effect = shell.unsaved().answer_stuck(index == STUCK_CLOSE);
                run_effect(app, effect);
            });
        }
    }
}

/// ×、Alt+F4、タスクバーの閉じる、File→Exit の全部がここへ来る。
pub fn handle_close_request(app: &AppHandle, api: &CloseRequestApi) {
    let effect = app.state::<ShellState>().unsaved().request(Intent::Close);
    if effect == Effect::Close {
        // 止めないのでそのまま閉じる
        arm_exit_fallback();
        save_placement(app);
    } else {
        api.prevent_close();
        run_effect(app, effect);
    }
}

/// 許可を足してから画面へ渡す。全部の入口がここを通る。
fn offer_file(app: &AppHandle, path: &Path) {
    let shell = app.state::<ShellState>();
    match app.state::<FileState>().grants.grant(path) {
        Ok(granted) => {
            let intent = Intent::Open(granted.display().to_owned());
            let effect = shell.unsaved().request(intent);
            run_effect(app, effect);
        }
        Err(_) => shell.send(notice("app.notice.denied")),
    }
}

/// 開くのは先頭の 1 件だけ。2 件以上なら知らせる。
fn dropped_file(paths: &[PathBuf]) -> (Option<&PathBuf>, bool) {
    (paths.first(), paths.len() > 1)
}

pub fn handle_drop(app: &AppHandle, paths: &[PathBuf]) {
    let (first, several) = dropped_file(paths);
    if several {
        app.state::<ShellState>()
            .send(notice("app.notice.dropOneFile"));
    }
    if let Some(path) = first {
        offer_file(app, path);
    }
}

/// 起動引数に文書のパスがあるか。ある起動（関連付けで開く）では起動画面を出さない。
pub fn has_startup_document() -> bool {
    std::env::current_dir()
        .map(|cwd| args::startup_path(std::env::args_os(), &cwd).is_some())
        .unwrap_or(false)
}

/// 窓を出した後に呼ぶ。見張りの時間に読み込みを含めない。
pub fn open_startup_file(app: &AppHandle) {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    if let Some(path) = args::startup_path(std::env::args_os(), &cwd) {
        offer_file(app, &path);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    version: String,
    theme: String,
    language: String,
    recent: Vec<String>,
    splash_ceremony: bool,
    splash_ceremony_unlocked: bool,
    wrap_lines: bool,
    hide_targets_in_tree: bool,
    /// 翻訳が有効か（設定ファイルの値）。画面の項目を出すかの目安だけで、通信の可否は
    /// 翻訳の仕事を始めるときに Rust が設定ファイルを読み直して決める。キーの有無は載せない。
    translation_enabled: bool,
}

#[tauri::command]
pub fn get_startup(app: AppHandle) -> Startup {
    let Settings {
        theme,
        language,
        recent,
        splash_ceremony,
        splash_ceremony_unlocked,
        wrap_lines,
        hide_targets_in_tree,
        translation,
        ..
    } = app.state::<Store>().snapshot();
    Startup {
        version: app.package_info().version.to_string(),
        theme,
        language,
        recent,
        splash_ceremony,
        splash_ceremony_unlocked,
        wrap_lines,
        hide_targets_in_tree,
        translation_enabled: translation.enabled,
    }
}

#[tauri::command]
pub fn shell_subscribe(state: tauri::State<'_, ShellState>, channel: Channel<ShellEvent>) {
    *state.channel.lock().unwrap_or_else(PoisonError::into_inner) = Some(channel);
    state.unsaved().page_loaded();
}

/// ファイルのダイアログ。選ばれたら `Open` で届く。取り消しなら何も起きない。
#[tauri::command]
pub fn pick_open(app: AppHandle, window: WebviewWindow) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter(t("app.dialog.filterJson"), &JSON_EXTENSIONS)
        .add_filter(t("app.dialog.filterAll"), &ALL_EXTENSIONS)
        .pick_file(move |picked| {
            if let Some(path) = picked.and_then(|file| file.into_path().ok()) {
                offer_file(&handle, &path);
            }
        });
}

/// 保存先のダイアログ。上書きの確認はダイアログに任せる。選ばれたパスは許可して返す。
#[tauri::command]
pub async fn pick_save(
    app: AppHandle,
    window: WebviewWindow,
    suggested: Option<String>,
) -> Result<Option<String>, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter(t("app.dialog.filterJson"), &JSON_EXTENSIONS)
        .add_filter(t("app.dialog.filterAll"), &ALL_EXTENSIONS);
    if let Some(suggested) = suggested.as_deref().map(Path::new) {
        if let Some(folder) = suggested.parent() {
            dialog = dialog.set_directory(folder);
        }
        if let Some(name) = suggested.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
    }
    dialog.save_file(move |picked| {
        let _ = sender.try_send(picked);
    });

    let picked = receiver.recv().await.flatten();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(None);
    };
    let granted = app
        .state::<FileState>()
        .grants
        .grant(&path)
        .map_err(|error| format!("{error:?}"))?;
    Ok(Some(granted.display().to_owned()))
}

#[tauri::command]
pub async fn ask(window: WebviewWindow, request: AskRequest) -> Result<usize, String> {
    let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || task_dialog::show(parent, &request))
        .await
        .map_err(|error| error.to_string())
}

/// `ask` にチェックボックスを 1 つ添えた確認（翻訳の確かめの「今後表示しない」）。
#[tauri::command]
pub async fn ask_checked(window: WebviewWindow, request: CheckedAskRequest) -> Result<CheckedAnswer, String> {
    let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || task_dialog::show_checked(parent, &request))
        .await
        .map_err(|error| error.to_string())
}

/// 印とタイトルを 1 回で受ける。`*` と印が食い違わない。同期のコマンドで順に処理する。
#[tauri::command]
pub fn set_document_state(
    window: WebviewWindow,
    state: tauri::State<'_, ShellState>,
    report: DocumentReport,
) -> Result<(), String> {
    if state.unsaved().report(&report) {
        window
            .set_title(&report.title)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// `SaveAndContinue` の答え。印の到着順に頼らないよう、印も一緒に受ける。
#[tauri::command]
pub fn save_finished(app: AppHandle, id: u64, ok: bool, report: DocumentReport) {
    let shell = app.state::<ShellState>();
    let effect = {
        let mut unsaved = shell.unsaved();
        unsaved.report(&report);
        unsaved.save_finished(id, ok)
    };
    run_effect(&app, effect);
}

/// 画面が開く処理の中で未保存を見つけた。確定して初めて分かる入力がある。
#[tauri::command]
pub fn request_open(app: AppHandle, path: String, report: DocumentReport) {
    let shell = app.state::<ShellState>();
    let effect = {
        let mut unsaved = shell.unsaved();
        unsaved.report(&report);
        unsaved.request(Intent::Open(path))
    };
    run_effect(&app, effect);
}

#[derive(Debug, PartialEq, Eq)]
enum RecentStep {
    /// 一覧に無い。画面が渡すパスは信じない。
    Refuse,
    Forget,
    Offer,
}

fn recent_step(listed: bool, exists: Option<bool>) -> RecentStep {
    match (listed, exists) {
        (false, _) => RecentStep::Refuse,
        (true, Some(false)) => RecentStep::Forget,
        // 確かめられないときは開く処理に理由を出させる
        (true, _) => RecentStep::Offer,
    }
}

/// Open Recent の項目。ファイルを読み直した一覧と完全に一致するパスだけを許可する。
#[tauri::command]
pub async fn open_recent(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listed = app.state::<Store>().snapshot().recent.contains(&path);
        let shell = app.state::<ShellState>();
        match recent_step(listed, Path::new(&path).try_exists().ok()) {
            RecentStep::Refuse => shell.send(notice("app.notice.denied")),
            RecentStep::Forget => {
                settings::record(&app, Change::RemoveRecent(path));
                shell.send(notice("app.notice.recentMissing"));
            }
            RecentStep::Offer => offer_file(&app, Path::new(&path)),
        }
    })
    .await
    .map_err(|error| error.to_string())
}

/// File→Exit。×を押したときと同じ経路で閉じる。
#[tauri::command]
pub fn exit_app(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_outside_the_list_is_refused_even_when_the_file_exists() {
        assert_eq!(recent_step(false, Some(true)), RecentStep::Refuse);
        assert_eq!(recent_step(false, Some(false)), RecentStep::Refuse);
    }

    #[test]
    fn a_listed_file_that_is_gone_is_forgotten() {
        assert_eq!(recent_step(true, Some(false)), RecentStep::Forget);
    }

    #[test]
    fn a_listed_file_is_offered_when_it_exists_or_cannot_be_checked() {
        assert_eq!(recent_step(true, Some(true)), RecentStep::Offer);
        assert_eq!(recent_step(true, None), RecentStep::Offer);
    }

    #[test]
    fn only_the_first_dropped_file_opens_and_several_are_reported() {
        let paths = [PathBuf::from("a.json"), PathBuf::from("b.json")];
        assert_eq!(dropped_file(&paths), (paths.first(), true));
    }

    #[test]
    fn a_single_dropped_file_is_not_reported() {
        let paths = [PathBuf::from("a.json")];
        assert_eq!(dropped_file(&paths), (paths.first(), false));
    }

    #[test]
    fn an_empty_drop_opens_nothing() {
        assert_eq!(dropped_file(&[]), (None, false));
    }

    #[test]
    fn the_unsaved_question_defaults_to_save_and_escape_cancels() {
        let request = unsaved_request(&unsaved::WITH_SAVE);
        assert_eq!(request.buttons.len(), unsaved::WITH_SAVE.len());
        assert_eq!(unsaved::WITH_SAVE[request.default], Choice::Save);
        assert_eq!(unsaved::WITH_SAVE[request.cancel], Choice::Cancel);
    }

    #[test]
    fn the_unsaved_choices_follow_the_language() {
        let english = unsaved_request_with(&|key| crate::dict::t_in("en", key), &unsaved::WITH_SAVE);
        assert_eq!(english.buttons, ["Save", "Don't Save", "Cancel"]);
        assert_eq!(english.title, "Unsaved changes");
        let japanese = unsaved_request_with(&|key| crate::dict::t_in("ja", key), &unsaved::WITH_SAVE);
        assert_eq!(japanese.buttons, ["保存", "保存しない", "キャンセル"]);
        assert_eq!(japanese.title, "未保存の変更");
    }

    #[test]
    fn a_stopped_save_defaults_to_cancel() {
        let request = unsaved_request(&unsaved::WITHOUT_SAVE);
        assert_eq!(unsaved::WITHOUT_SAVE[request.default], Choice::Cancel);
        assert_eq!(unsaved::WITHOUT_SAVE[request.cancel], Choice::Cancel);
    }

    #[test]
    fn the_stuck_question_defaults_to_waiting() {
        let request = stuck_request();
        assert_eq!(request.default, STUCK_WAIT);
        assert_eq!(request.cancel, STUCK_WAIT);
        assert_eq!(request.buttons[STUCK_CLOSE], t("app.dialog.closeWithoutSaving"));
    }

    #[test]
    fn the_save_event_has_the_shape_the_screen_reads() {
        assert_eq!(
            serde_json::to_string(&ShellEvent::SaveAndContinue { id: 7 }).expect("event"),
            r#"{"kind":"SaveAndContinue","id":7}"#
        );
    }

    #[test]
    fn the_open_event_has_the_shape_the_screen_reads() {
        let event = ShellEvent::Open {
            path: "a.json".into(),
            discard_confirmed: false,
        };
        assert_eq!(
            serde_json::to_string(&event).expect("event"),
            r#"{"kind":"Open","path":"a.json","discardConfirmed":false}"#
        );
    }
}
