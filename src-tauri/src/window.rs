//! メインの窓の作成と、起動の見張り。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Theme, WebviewWindow, WebviewWindowBuilder,
    Window,
};
use tauri::window::Color;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::dict::t;
use crate::settings;
use crate::settings::store::{Change, Placement, Store};

/// フロントエンドの初期化を待つ時間。
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// 見張りが状態を確かめる間隔。
const WATCH_INTERVAL: Duration = Duration::from_millis(200);
/// 諦めた後、メインスレッドの応答を待つ時間。応答が無ければダイアログも出せない。
const MAIN_THREAD_GRACE: Duration = Duration::from_secs(5);
/// 初期化に失敗して終わるときの終了コード。
pub const EXIT_INIT_FAILED: i32 = 3;

const PENDING: u8 = 0;
const READY: u8 = 1;
const GIVEN_UP: u8 = 2;
/// 保存した位置が、どのモニタともこれだけ重ならなければ捨てる。窓を掴めなくなるため。
const MIN_VISIBLE_OVERLAP_PX: i64 = 100;
pub const MAIN_WINDOW: &str = "main";

/// 最大化でも最小化でもないときの位置と大きさ。単位は物理ピクセル。
#[derive(Default)]
struct Bounds {
    position: Option<(i32, i32)>,
    size: Option<(u32, u32)>,
}

#[derive(Default)]
pub struct WindowMemory {
    bounds: Mutex<Bounds>,
    /// 隠したまま最大化すると窓が見えてしまうので、出す直前に行う。
    maximize_on_show: AtomicBool,
}

impl WindowMemory {
    fn with_bounds(&self, change: impl FnOnce(&mut Bounds)) {
        change(&mut self.bounds.lock().unwrap_or_else(PoisonError::into_inner));
    }

    fn placement(&self, maximized: bool) -> Option<Placement> {
        let bounds = self.bounds.lock().unwrap_or_else(PoisonError::into_inner);
        let ((x, y), (width, height)) = (bounds.position?, bounds.size?);
        Some(Placement { x, y, width, height, maximized })
    }
}

/// 最大化と最小化の間の値を覚えない。最小化の -32000 が残ると、次の起動で窓が見えなくなる。
fn is_restored(window: &Window) -> bool {
    !window.is_maximized().unwrap_or(true) && !window.is_minimized().unwrap_or(true)
}

pub fn note_moved(window: &Window, position: PhysicalPosition<i32>) {
    if is_restored(window) {
        window
            .state::<WindowMemory>()
            .with_bounds(|bounds| bounds.position = Some((position.x, position.y)));
    }
}

pub fn note_resized(window: &Window, size: PhysicalSize<u32>) {
    if is_restored(window) {
        window
            .state::<WindowMemory>()
            .with_bounds(|bounds| bounds.size = Some((size.width, size.height)));
    }
}

/// 閉じるときに 1 回だけ書く。
pub fn save_placement(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let memory = app.state::<WindowMemory>();
    let maximized = window.is_maximized().unwrap_or(false);
    if !maximized && !window.is_minimized().unwrap_or(true) {
        // 動かしていない窓にはイベントが来ていない
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            memory.with_bounds(|bounds| {
                bounds.position = Some((position.x, position.y));
                bounds.size = Some((size.width, size.height));
            });
        }
    }
    if let Some(placement) = memory.placement(maximized) {
        settings::record(app, Change::Window(placement));
    }
}

#[derive(Clone, Copy)]
struct Area {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

fn overlap(start_a: i64, length_a: i64, start_b: i64, length_b: i64) -> i64 {
    (start_a + length_a).min(start_b + length_b) - start_a.max(start_b)
}

fn is_reachable(window: Area, monitors: &[Area]) -> bool {
    monitors.iter().any(|monitor| {
        overlap(window.x, window.width, monitor.x, monitor.width) >= MIN_VISIBLE_OVERLAP_PX
            && overlap(window.y, window.height, monitor.y, monitor.height) >= MIN_VISIBLE_OVERLAP_PX
    })
}

/// 設定の位置と大きさを、隠したままの窓へ当てる。最大化は [`finish_placement`] で行う。
fn restore_placement(window: &WebviewWindow, placement: Placement, minimum: (f64, f64)) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = placement.width.max((minimum.0 * scale).ceil() as u32);
    let height = placement.height.max((minimum.1 * scale).ceil() as u32);
    let area = Area {
        x: i64::from(placement.x),
        y: i64::from(placement.y),
        width: i64::from(width),
        height: i64::from(height),
    };
    let monitors: Vec<Area> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| Area {
            x: i64::from(monitor.position().x),
            y: i64::from(monitor.position().y),
            width: i64::from(monitor.size().width),
            height: i64::from(monitor.size().height),
        })
        .collect();

    let memory = window.state::<WindowMemory>();
    if is_reachable(area, &monitors) {
        let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
        memory.with_bounds(|bounds| bounds.position = Some((placement.x, placement.y)));
    }
    let _ = window.set_size(PhysicalSize::new(width, height));
    memory.with_bounds(|bounds| bounds.size = Some((width, height)));
    memory.maximize_on_show.store(placement.maximized, Ordering::SeqCst);
}

/// 窓を出す直前に呼ぶ。
pub fn finish_placement(app: &AppHandle, window: &WebviewWindow) {
    if app.state::<WindowMemory>().maximize_on_show.swap(false, Ordering::SeqCst) {
        let _ = window.maximize();
    }
}

/// 起動の状態。準備完了と諦めのどちらか一方だけが勝つ。
#[derive(Default)]
pub struct Startup(AtomicU8);

impl Startup {
    pub fn mark_ready(&self) -> bool {
        self.transition(READY)
    }

    fn mark_given_up(&self) -> bool {
        self.transition(GIVEN_UP)
    }

    fn transition(&self, to: u8) -> bool {
        self.0
            .compare_exchange(PENDING, to, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn is_pending(&self) -> bool {
        self.0.load(Ordering::SeqCst) == PENDING
    }
}

#[derive(Debug, PartialEq)]
enum WatchStep {
    Stop,
    Wait,
    GiveUp,
}

fn watch_step(pending: bool, elapsed: Duration, timeout: Duration) -> WatchStep {
    if !pending {
        WatchStep::Stop
    } else if elapsed >= timeout {
        WatchStep::GiveUp
    } else {
        WatchStep::Wait
    }
}

/// 窓が出ないままプロセスが残らないよう、初期化の完了を見張る。
pub fn spawn_watchdog(app: AppHandle) {
    thread::spawn(move || {
        let started = Instant::now();
        loop {
            let pending = app.state::<Startup>().is_pending();
            match watch_step(pending, started.elapsed(), READY_TIMEOUT) {
                WatchStep::Stop => return,
                WatchStep::Wait => thread::sleep(WATCH_INTERVAL),
                WatchStep::GiveUp => break,
            }
        }
        if app.state::<Startup>().mark_given_up() {
            report_and_exit(app);
        }
    });
}

/// 起動の途中で続けられないと分かったときに、理由を出して終わらせる。
pub fn fail_startup(app: AppHandle) {
    thread::spawn(move || report_and_exit(app));
}

fn report_and_exit(app: AppHandle) {
    let (sender, receiver) = mpsc::channel();
    let probed = app.run_on_main_thread(move || {
        let _ = sender.send(());
    });
    if probed.is_err() || receiver.recv_timeout(MAIN_THREAD_GRACE).is_err() {
        std::process::exit(EXIT_INIT_FAILED);
    }

    let closer = app.clone();
    app.dialog()
        .message(t("app.error.initFailedBody"))
        .title(t("app.error.initFailedTitle"))
        .kind(MessageDialogKind::Error)
        .show(move |_| closer.exit(EXIT_INIT_FAILED));
}

/// 窓を作る前に起動が失敗したときの案内文。理由の詳細を添える。
fn launch_failure_text(detail: &str) -> String {
    format!("{}\n\n{}: {}", t("app.error.startFailedBody"), t("app.error.startFailedDetail"), detail)
}

/// tauri が起動に失敗した（WebView2 が無いときなど）。窓も画面も無いので、OS の素のダイアログで理由を出す。
pub fn report_launch_failure(detail: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (title, body) = (wide(&t("app.error.startFailedTitle")), wide(&launch_failure_text(detail)));
        // SAFETY: 2 つとも NUL 終端で、呼び出しの間は生きている。親の窓は無い。
        unsafe {
            MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{}", launch_failure_text(detail));
}

/// 窓は起動の状態が決まるまで見えないので、文書が消える心配があるのはその後だけ。
fn allow_navigation(guarded: bool, startup_pending: bool) -> bool {
    !guarded || startup_pending
}

/// ダークの地の色。src/shell/theme.css の `--app-bg`（ダーク）と同じ値にする。
const DARK_BACKGROUND: Color = Color(0x18, 0x15, 0x28, 0xff);
/// ライトの地の色。src/shell/theme.css の `--app-bg`（ライト）と同じ値にする。
const LIGHT_BACKGROUND: Color = Color(0xea, 0xe6, 0xf1, 0xff);

/// タイトルバーの色（地、文字、枠）。src/shell/theme.css の `--app-frame`、`--app-text`、`--app-border` と同じ値にする。
/// 枠はダークでは窓枠の色（`--app-frame`）に溶かし、ライトでは罫線の色にする。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TitleBarColors {
    caption: (u8, u8, u8),
    text: (u8, u8, u8),
    border: (u8, u8, u8),
}

const DARK_TITLE_BAR: TitleBarColors = TitleBarColors {
    caption: (0x14, 0x12, 0x1f),
    text: (0xec, 0xe6, 0xf2),
    border: (0x14, 0x12, 0x1f),
};
const LIGHT_TITLE_BAR: TitleBarColors = TitleBarColors {
    caption: (0xe0, 0xdb, 0xea),
    text: (0x2b, 0x25, 0x40),
    border: (0xc6, 0xbd, 0xd8),
};

fn title_bar_of(theme: &str) -> TitleBarColors {
    if is_dark(theme) { DARK_TITLE_BAR } else { LIGHT_TITLE_BAR }
}

/// DWM が受け取る COLORREF（0x00BBGGRR）。RGB の並びとは逆になる。
fn colorref((red, green, blue): (u8, u8, u8)) -> u32 {
    u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16)
}

/// タイトルバーの色を DWM へ渡す。Windows 11 より前など属性が効かない環境では、
/// DWM が失敗を返すだけなので結果を捨て、今までのタイトルバーのままにする。
#[cfg(windows)]
fn apply_title_bar(window: &WebviewWindow, theme: &str) {
    use windows_sys::Win32::Graphics::Dwm::{
        DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DwmSetWindowAttribute,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let colors = title_bar_of(theme);
    for (attribute, color) in [
        (DWMWA_CAPTION_COLOR, colors.caption),
        (DWMWA_TEXT_COLOR, colors.text),
        (DWMWA_BORDER_COLOR, colors.border),
    ] {
        let value = colorref(color);
        // SAFETY: hwnd はこのプロセスの有効な窓。値は u32 1 個で、サイズを一緒に渡す。
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                attribute as _,
                std::ptr::from_ref(&value).cast(),
                size_of::<u32>() as u32,
            )
        };
    }
}

#[cfg(not(windows))]
fn apply_title_bar(_window: &WebviewWindow, _theme: &str) {}

pub(crate) fn is_dark(theme: &str) -> bool {
    theme == "dark"
}

fn window_theme(theme: &str) -> Theme {
    if is_dark(theme) { Theme::Dark } else { Theme::Light }
}

fn background_of(theme: &str) -> Color {
    if is_dark(theme) { DARK_BACKGROUND } else { LIGHT_BACKGROUND }
}

/// 切り替えた後の窓の背景とタイトルバー。失敗しても画面の色は CSS が持つ。
pub fn apply_theme(app: &AppHandle, theme: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_theme(Some(window_theme(theme)));
        let _ = window.set_background_color(Some(background_of(theme)));
        apply_title_bar(&window, theme);
    }
}

/// メインの窓を作る。tauri.conf.json の窓の定義に、設定ファイルでは書けないものを足す。
pub fn create_main(app: &tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)?;
    let minimum = (
        config.min_width.unwrap_or(config.width),
        config.min_height.unwrap_or(config.height),
    );

    // 再読み込みは未保存の編集を消す。開発サーバの更新だけは通す。
    let guarded = !tauri::is_dev();
    let handle = app.handle().clone();

    // 最初の描画の前に、窓の背景とタイトルバーを保存済みのテーマへ揃える（白いちらつきを出さない）
    let theme = app.state::<Store>().snapshot().theme;
    let window = WebviewWindowBuilder::from_config(app, config)?
        .theme(Some(window_theme(&theme)))
        .background_color(background_of(&theme))
        .title(t("app.title"))
        .enable_clipboard_access()
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_navigation(move |_url| {
            allow_navigation(guarded, handle.state::<Startup>().is_pending())
        })
        .build()?;
    apply_title_bar(&window, &theme);

    if let Some(placement) = app.state::<Store>().snapshot().window {
        restore_placement(&window, placement, minimum);
    }

    #[cfg(windows)]
    {
        let handle = app.handle().clone();
        window.with_webview(move |webview| {
            if disable_browser_defaults(&webview).is_err()
                && handle.state::<Startup>().mark_given_up()
            {
                fail_startup(handle);
            }
        })?;
    }
    #[cfg(not(windows))]
    let _ = window;

    Ok(())
}

/// ブラウザのショートカット（F5、Ctrl+R など）と既定の右クリックのメニューを止める。
#[cfg(windows)]
fn disable_browser_defaults(webview: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    // SAFETY: with_webview がメインスレッドで渡す有効な controller だけを使う。
    unsafe {
        let settings = webview.controller().CoreWebView2()?.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Area = Area { x: 0, y: 0, width: 1920, height: 1080 };

    #[test]
    fn colorref_puts_blue_in_the_high_byte() {
        assert_eq!(colorref((0x14, 0x12, 0x1f)), 0x001f_1214);
        assert_eq!(colorref((0xff, 0x00, 0x00)), 0x0000_00ff);
        assert_eq!(colorref((0x00, 0x00, 0xff)), 0x00ff_0000);
    }

    #[test]
    fn the_dark_title_bar_is_the_frame_color_with_light_text() {
        let colors = title_bar_of("dark");
        assert_eq!(colorref(colors.caption), 0x001f_1214);
        assert_eq!(colorref(colors.text), 0x00f2_e6ec);
        assert_eq!(colors.border, colors.caption);
    }

    #[test]
    fn the_light_title_bar_matches_the_light_surface_with_dark_text() {
        let colors = title_bar_of("light");
        assert_eq!(colorref(colors.caption), 0x00ea_dbe0);
        assert_eq!(colorref(colors.text), 0x0040_252b);
        assert_ne!(title_bar_of("dark"), colors);
    }

    #[test]
    fn an_unknown_theme_takes_the_light_title_bar() {
        assert_eq!(title_bar_of("other"), LIGHT_TITLE_BAR);
    }

    #[test]
    fn the_launch_failure_text_names_the_runtime_and_carries_the_detail() {
        let text = launch_failure_text("HRESULT 0x80070002");
        assert!(text.contains("WebView2"));
        assert!(text.ends_with("HRESULT 0x80070002"));
        assert_ne!(t("app.error.startFailedTitle"), "app.error.startFailedTitle");
    }

    #[test]
    fn a_window_on_a_monitor_is_reachable() {
        let window = Area { x: 100, y: 100, width: 800, height: 600 };
        assert!(is_reachable(window, &[MONITOR]));
    }

    #[test]
    fn a_window_past_the_edge_needs_the_minimum_overlap() {
        let barely = Area { x: 1920 - MIN_VISIBLE_OVERLAP_PX, y: 0, width: 800, height: 600 };
        let outside = Area { x: barely.x + 1, ..barely };
        assert!(is_reachable(barely, &[MONITOR]));
        assert!(!is_reachable(outside, &[MONITOR]));
    }

    #[test]
    fn a_window_on_a_removed_monitor_is_not_reachable() {
        let window = Area { x: 3000, y: 0, width: 800, height: 600 };
        assert!(!is_reachable(window, &[MONITOR]));
        assert!(!is_reachable(window, &[]));
    }

    #[test]
    fn the_watchdog_waits_while_pending_within_the_timeout() {
        let timeout = Duration::from_secs(10);
        assert_eq!(
            watch_step(true, Duration::from_secs(9), timeout),
            WatchStep::Wait
        );
    }

    #[test]
    fn the_watchdog_gives_up_at_the_timeout() {
        let timeout = Duration::from_secs(10);
        assert_eq!(watch_step(true, timeout, timeout), WatchStep::GiveUp);
    }

    #[test]
    fn the_watchdog_stops_once_the_startup_is_settled() {
        let timeout = Duration::from_secs(10);
        assert_eq!(watch_step(false, timeout, timeout), WatchStep::Stop);
    }

    #[test]
    fn ready_and_given_up_exclude_each_other() {
        let ready_first = Startup::default();
        assert!(ready_first.mark_ready());
        assert!(!ready_first.mark_given_up());

        let given_up_first = Startup::default();
        assert!(given_up_first.mark_given_up());
        assert!(!given_up_first.mark_ready());
    }

    #[test]
    fn navigation_is_refused_once_the_startup_is_settled() {
        assert!(allow_navigation(true, true));
        assert!(!allow_navigation(true, false));
    }

    #[test]
    fn navigation_is_refused_from_the_moment_ready_is_marked() {
        let startup = Startup::default();
        assert!(allow_navigation(true, startup.is_pending()));
        assert!(startup.mark_ready());
        assert!(!allow_navigation(true, startup.is_pending()));
    }

    #[test]
    fn navigation_stays_open_for_the_development_server() {
        assert!(allow_navigation(false, false));
    }
}
