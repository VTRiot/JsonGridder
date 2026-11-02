//! 起動画面（起動セレモニー）。文書を引数に起動したときは出さず、直接の起動のときだけ出す。
//! 設定の `splashCeremony` が true のときだけ出し、出したら false を書く（初回の 1 回だけ出る）。
//! 起動前の読み込みの一覧（[`STARTUP_TASKS`]）が空でないときは、旗に関わらず出す。
//!
//! 主画面は準備ができても、最低表示時間が過ぎるまで隠したままにする。準備の合図が来なくても、
//! 時間切れで必ず主画面を出す。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::dict::t;
use crate::settings::store::{Change, Store};
use crate::window::is_dark;

/// 準備の合図が来なくても、これだけ経てば起動画面を閉じて主画面を出す。
pub const SPLASH_TIMEOUT: Duration = Duration::from_millis(8000);
/// 閉じてよいかを確かめる間隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 起動画面の窓。試験が題名で見分ける（tests/gui/input.ps1 の SPLASH_TITLE と同じ値にする）。
pub const SPLASH_TITLE: &str = "JsonGridder-splash";
const SPLASH_LABEL: &str = "splash";
const SPLASH_PAGE: &str = "splash.html";
const SPLASH_TEXT_KEY: &str = "app.splash.opening";
/// 論理ピクセル。ロゴ（ライト、ダークとも 900 x 437 の同じ形）に余白を足した大きさ。
/// ロゴを 1.7 倍にし、横の余白を詰めて幅を 816 から 690 にした。
/// ダークもライトと同じ寸法にする。splash.html の .logo の幅（612px）と揃える。
const SPLASH_WIDTH: f64 = 690.0;
const SPLASH_HEIGHT: f64 = 442.0;
/// 窓そのものは透明にする。地の色（テーマごと）と角の丸みは splash.html が持つ。
const TRANSPARENT: Color = Color(0, 0, 0, 0);

/// 起動画面を出すか、出したら旗を落とすか。
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub show: bool,
    /// 出すことにしたうえで、旗が true だった。出したら `splashCeremony` に false を書く。
    pub consume_flag: bool,
}

/// 文書を引数に起動したとき、または `splashMs` が 0 のときは出さず、旗にも触れない。
/// 旗が false でも、起動前の読み込みが残っている（`loads_pending`）ときは出す。
/// プラグインなど、起動に時間のかかる読み込みを足したとき、起動画面で待たせるための口。
pub fn plan(has_document: bool, splash_ms: u64, ceremony: bool, loads_pending: bool) -> Plan {
    let show = !has_document && splash_ms > 0 && (ceremony || loads_pending);
    Plan {
        show,
        consume_flag: show && ceremony,
    }
}

/// 出したので旗を落とす。書けなくても起動は止めない（書けない場所では毎回出る）。
fn consume(store: &Store, plan: &Plan) {
    if plan.consume_flag {
        let _ = store.update(Change::SplashCeremony(false));
    }
}

/// 起動画面の配色。設定のテーマ名から決める。知らない名前はライト（窓の色と同じ扱い）。
fn splash_theme(theme: &str) -> &'static str {
    if is_dark(theme) { "dark" } else { "light" }
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Wait,
    Close,
}

/// 閉じて主画面を出す時機か。時間切れなら合図を待たない。合図があっても最低表示時間は待つ。
fn next_step(ready: bool, elapsed: Duration, minimum: Duration, timeout: Duration) -> Step {
    if elapsed >= timeout || (ready && elapsed >= minimum) {
        Step::Close
    } else {
        Step::Wait
    }
}

#[derive(Default)]
enum Phase {
    /// 起動画面を出していない（出さない起動、または閉じた後）。
    #[default]
    Idle,
    Showing { ready: bool },
}

#[derive(Default)]
pub struct Splash {
    phase: Mutex<Phase>,
}

impl Splash {
    fn with_phase<R>(&self, f: impl FnOnce(&mut Phase) -> R) -> R {
        f(&mut self.phase.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// 主画面の準備ができた合図。起動画面が出ている間は、閉じるときに出すので true を返し、
    /// 呼び出し側は主画面を出さない。出ていなければ false（すぐ出してよい）。
    pub fn defer_reveal(&self) -> bool {
        self.with_phase(|phase| match phase {
            Phase::Showing { ready } => {
                *ready = true;
                true
            }
            Phase::Idle => false,
        })
    }

    /// 合図と読み込みの一覧の両方が済んでいて初めて、最低表示時間で閉じる。時間切れはどちらも待たない。
    fn step(&self, elapsed: Duration, minimum: Duration, tasks_done: bool) -> Step {
        self.with_phase(|phase| {
            let ready = tasks_done && matches!(phase, Phase::Showing { ready: true });
            let step = next_step(ready, elapsed, minimum, SPLASH_TIMEOUT);
            if step == Step::Close {
                *phase = Phase::Idle;
            }
            step
        })
    }
}

/// 将来の読み込みの口。起動画面を閉じる前に待つ非同期の処理をここに並べる（今は空）。
/// プラグインや大きな辞書など、起動時に時間のかかる読み込みを足すときは、ここへ足すと
/// その完了まで起動画面が出たままになる。別のスレッドで走らせ、時間切れ（[`SPLASH_TIMEOUT`]）は
/// 完了を待たないので、読み込みが固まっても主画面は必ず出る。
type StartupTask = fn(&AppHandle) -> Result<(), String>;
const STARTUP_TASKS: &[StartupTask] = &[];

/// 一覧の処理を順に済ませる。1 件の失敗で起動を止めない。
fn run_startup_tasks(app: &AppHandle, tasks: &[StartupTask]) {
    for task in tasks {
        let _ = task(app);
    }
}

/// 起動画面の窓を作る。作れなければ出さずに続ける（起動を止めない）。
fn open_window(app: &AppHandle, theme: &str) -> bool {
    let theme = splash_theme(theme);
    let text = serde_json::to_string(&t(SPLASH_TEXT_KEY)).unwrap_or_else(|_| "\"\"".into());
    WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::App(SPLASH_PAGE.into()))
        .title(SPLASH_TITLE)
        .inner_size(SPLASH_WIDTH, SPLASH_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .center()
        .background_color(TRANSPARENT)
        // テーマは最初の描画より前に html へ入れる（html 要素ができた時点で入れる）。splash.ts も同じ値を入れ直す。
        .initialization_script(format!(
            "window.__SPLASH_TEXT = {text}; window.__SPLASH_THEME = \"{theme}\"; \
             (function () {{ var apply = function () {{ if (document.documentElement) {{ \
             document.documentElement.setAttribute('data-theme', \"{theme}\"); return true; }} return false; }}; \
             if (!apply()) {{ var watcher = new MutationObserver(function () {{ if (apply()) watcher.disconnect(); }}); \
             watcher.observe(document, {{ childList: true }}); }} }})();"
        ))
        .build()
        .is_ok()
}

/// 起動画面を出し、閉じる時機に `reveal` を呼ぶ。出さないときは false を返し、何もしない。
pub fn begin(
    app: &AppHandle,
    has_document: bool,
    splash_ms: u64,
    ceremony: bool,
    theme: &str,
    reveal: impl Fn(&AppHandle) + Send + 'static,
) -> bool {
    let plan = plan(has_document, splash_ms, ceremony, !STARTUP_TASKS.is_empty());
    if !plan.show || !open_window(app, theme) {
        return false;
    }
    // 窓を出した時点で落とす。閉じる時に書くと、主画面が先に読む設定（get_startup）と食い違う
    consume(app.state::<Store>().inner(), &plan);
    let minimum = Duration::from_millis(splash_ms);
    let started = Instant::now();
    app.state::<Splash>()
        .with_phase(|phase| *phase = Phase::Showing { ready: false });
    let tasks_done = Arc::new(AtomicBool::new(false));
    let worker_app = app.clone();
    let worker_done = Arc::clone(&tasks_done);
    thread::spawn(move || {
        run_startup_tasks(&worker_app, STARTUP_TASKS);
        worker_done.store(true, Ordering::SeqCst);
    });
    let app = app.clone();
    thread::spawn(move || {
        while app
            .state::<Splash>()
            .step(started.elapsed(), minimum, tasks_done.load(Ordering::SeqCst))
            == Step::Wait
        {
            thread::sleep(POLL_INTERVAL);
        }
        if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
            let _ = window.destroy();
        }
        reveal(&app);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_millis(1500);
    const LIMIT: Duration = Duration::from_millis(8000);

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn the_splash_follows_the_saved_theme() {
        assert_eq!(splash_theme("dark"), "dark");
        assert_eq!(splash_theme("light"), "light");
        assert_eq!(splash_theme("other"), "light");
    }

    #[test]
    fn the_splash_window_is_narrower_than_before_and_holds_the_logo() {
        assert_eq!(SPLASH_WIDTH, 690.0);
        assert_eq!(SPLASH_HEIGHT, 442.0);
        // splash.html の .logo の幅（612px）が窓に収まる
        assert!(SPLASH_WIDTH > 612.0);
    }

    fn temp_store(name: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("jgv-splash-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("folder");
        let path = dir.join(crate::settings::store::SETTINGS_FILE);
        let _ = std::fs::remove_file(&path);
        (Store::load(Some(path.clone())), path)
    }

    /// 起動 1 回分: 設定を読み、決めて、出すなら旗を落とす。begin と同じ順序。
    fn launch(store: &Store, has_document: bool, splash_ms: u64, loads_pending: bool) -> bool {
        let settings = store.snapshot();
        let plan = plan(has_document, splash_ms, settings.splash_ceremony, loads_pending);
        if plan.show {
            consume(store, &plan);
        }
        plan.show
    }

    #[test]
    fn the_first_launch_shows_and_clears_the_flag_then_the_second_does_not() {
        let (store, path) = temp_store("first");
        assert!(store.snapshot().splash_ceremony, "既定は true");
        assert!(launch(&store, false, 1500, false), "初回は出す");
        assert!(!store.snapshot().splash_ceremony, "出したら false");
        let on_disk = std::fs::read_to_string(&path).expect("settings file");
        assert!(on_disk.contains("\"splashCeremony\": false"), "{on_disk}");
        let again = Store::load(Some(path));
        assert!(!launch(&again, false, 1500, false), "2 回目は出さない");
    }

    #[test]
    fn a_document_argument_shows_no_splash_and_keeps_the_flag() {
        let (store, _) = temp_store("document");
        assert!(!launch(&store, true, 1500, false));
        assert!(store.snapshot().splash_ceremony, "旗は変えない");
        assert!(launch(&store, false, 1500, false), "次の直接の起動でまだ出る");
    }

    #[test]
    fn splash_ms_zero_shows_no_splash_and_keeps_the_flag() {
        let (store, _) = temp_store("zero");
        assert!(!launch(&store, false, 0, false));
        assert!(store.snapshot().splash_ceremony);
    }

    #[test]
    fn pending_startup_loads_show_the_splash_even_when_the_flag_is_false() {
        let (store, _) = temp_store("loads");
        store.update(Change::SplashCeremony(false));
        assert!(launch(&store, false, 1500, true), "読み込みがあれば出す");
        assert!(!store.snapshot().splash_ceremony);
        assert!(!launch(&store, false, 1500, false), "読み込みが無ければ出さない");
        assert!(!launch(&store, true, 1500, true), "文書の引数のときは今のまま出さない");
        assert!(!launch(&store, false, 0, true), "splashMs 0 のときは今のまま出さない");
    }

    #[test]
    fn an_unwritable_place_does_not_crash_and_still_shows() {
        let store = Store::load(None);
        assert!(launch(&store, false, 1500, false));
        // 書けない場所でも、この起動の間は旗が落ちている（メモリ）
        assert!(!store.snapshot().splash_ceremony);
    }

    #[test]
    fn ready_early_still_waits_for_the_minimum() {
        assert_eq!(next_step(true, ms(300), MIN, LIMIT), Step::Wait);
        assert_eq!(next_step(true, ms(1500), MIN, LIMIT), Step::Close);
    }

    #[test]
    fn not_ready_keeps_waiting_until_the_timeout() {
        assert_eq!(next_step(false, ms(7999), MIN, LIMIT), Step::Wait);
    }

    #[test]
    fn the_timeout_reveals_the_main_window_without_a_ready_signal() {
        assert_eq!(next_step(false, ms(8000), MIN, LIMIT), Step::Close);
    }

    #[test]
    fn a_long_minimum_cannot_outlast_the_timeout() {
        assert_eq!(next_step(true, ms(8000), ms(60000), LIMIT), Step::Close);
    }

    #[test]
    fn unfinished_startup_tasks_hold_the_splash_until_the_timeout() {
        let splash = Splash::default();
        splash.with_phase(|phase| *phase = Phase::Showing { ready: false });
        assert!(splash.defer_reveal());
        assert_eq!(splash.step(ms(2000), MIN, false), Step::Wait);
        assert_eq!(splash.step(SPLASH_TIMEOUT, MIN, false), Step::Close);
    }

    #[test]
    fn defer_reveal_is_only_for_a_shown_splash() {
        let splash = Splash::default();
        assert!(!splash.defer_reveal(), "出していなければすぐ出す");
        splash.with_phase(|phase| *phase = Phase::Showing { ready: false });
        assert!(splash.defer_reveal());
        assert_eq!(splash.step(ms(100), MIN, true), Step::Wait);
        assert_eq!(splash.step(MIN, MIN, true), Step::Close);
        assert!(!splash.defer_reveal(), "閉じた後はすぐ出す");
    }
}
