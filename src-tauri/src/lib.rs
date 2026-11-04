mod commands;
mod dict;
mod file;
mod settings;
mod shell;
mod splash;
mod translate;
mod window;

use file::session::FileState;
use settings::store::Store;
use shell::ShellState;
use splash::Splash;
use tauri::{DragDropEvent, Manager, WindowEvent};
use window::{Startup, WindowMemory};

/// フロントエンドの初期化が終わった合図。見張りが諦めた後なら窓を出さない。
#[tauri::command]
fn app_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    startup: tauri::State<'_, Startup>,
) -> Result<(), String> {
    if !startup.mark_ready() {
        return Err("startup already given up".into());
    }
    window::finish_placement(&app, &window);
    // 起動画面が出ている間は、最低表示時間が過ぎてから起動画面の側が主画面を出す
    if app.state::<Splash>().defer_reveal() {
        return Ok(());
    }
    present_main(&app, &window)
}

/// 主画面を出し、起動時の知らせと起動引数の文書を渡す。
fn present_main(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    if let Err(error) = window.show() {
        // 窓が出せないまま残らないよう、失敗として終わらせる
        window::fail_startup(app.clone());
        return Err(error.to_string());
    }
    if let Some(key) = app.state::<Store>().take_startup_notice() {
        shell::send_notice(app.state::<ShellState>().inner(), key);
    }
    shell::open_startup_file(app);
    Ok(())
}

/// 起動画面を閉じた後に主画面を出す。
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(window::MAIN_WINDOW) {
        let _ = present_main(app, &window);
    }
}

pub fn run() {
    // 設定を読む前に失敗しても、既定の言語で理由を出せるようにする
    dict::set_language(settings::store::DEFAULT_LANGUAGE);
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Startup::default())
        .manage(FileState::default())
        .manage(ShellState::default())
        .manage(WindowMemory::default())
        .manage(Splash::default())
        .manage(translate::TranslateState::default())
        .invoke_handler(tauri::generate_handler![
            app_ready,
            commands::open_document,
            commands::commit_open,
            commands::save_document,
            commands::save_baseline_as,
            commands::scan_text,
            commands::diagnose_text,
            commands::disk_status,
            commands::open_in_text_editor,
            shell::get_startup,
            shell::shell_subscribe,
            shell::pick_open,
            shell::pick_save,
            shell::ask,
            shell::ask_checked,
            shell::set_document_state,
            shell::save_finished,
            shell::request_open,
            shell::open_recent,
            shell::exit_app,
            settings::recent_list,
            settings::clear_recent,
            settings::forget_recent,
            settings::set_theme,
            settings::set_language,
            settings::set_splash_ceremony,
            settings::set_wrap_lines,
            settings::set_hide_targets_in_tree,
            translate::translation_settings,
            translate::set_translation_settings,
            translate::set_translation_confirm,
            translate::set_translation_machine_notice,
            translate::set_translation_key,
            translate::clear_translation_key,
            translate::move_translation_key,
            translate::translate_start,
            translate::translate_cancel
        ])
        .on_window_event(|window, event| match event {
            // 起動画面の窓の動きは、文書や窓の位置の処理に回さない
            _ if window.label() != window::MAIN_WINDOW => {}
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                shell::handle_drop(window.app_handle(), paths);
            }
            WindowEvent::CloseRequested { api, .. } => {
                shell::handle_close_request(window.app_handle(), api);
            }
            WindowEvent::Moved(position) => window::note_moved(window, *position),
            WindowEvent::Resized(size) => window::note_resized(window, *size),
            _ => {}
        })
        .setup(|app| {
            window::spawn_watchdog(app.handle().clone());
            app.manage(Store::load(settings::path_beside_exe()));
            dict::set_language(&app.state::<Store>().snapshot().language);
            // 文書を引数に起動したとき以外（直接の起動）は、起動画面を出す。
            // 主画面の準備の合図（app_ready）より先に状態を作らないと、合図が来た時点で起動画面を飛ばして出てしまう
            let snapshot = app.state::<Store>().snapshot();
            splash::begin(
                app.handle(),
                shell::has_startup_document(),
                snapshot.splash_ms,
                snapshot.splash_ceremony,
                &snapshot.theme,
                reveal_main,
            );
            window::create_main(app)?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        // 窓の無いアプリが黙って消えないよう、理由を出して終わる
        window::report_launch_failure(&error.to_string());
        std::process::exit(window::EXIT_INIT_FAILED);
    }
}
