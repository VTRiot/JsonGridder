//! 実ファイルの試験。一時フォルダの中だけを触る。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::lock::FileLock;
use crate::file::replace::{Replacer, SystemReplacer};

use super::store::{
    Change, NOTICE_BROKEN, NOTICE_UNWRITABLE, Placement, RECENT_LIMIT, SETTINGS_FILE, Store,
};

const CHILD_ENV: &str = "JGV_SETTINGS_CHILD_FILE";
const CHILD_TAG_ENV: &str = "JGV_SETTINGS_CHILD_TAG";
const CHILD_TEST: &str = "settings::real_file_tests::child_adds_recent_files";
/// 2 プロセスが足す数。合計が上限に収まるので、全部残るはず。
const ADDS_PER_PROCESS: usize = RECENT_LIMIT / 2;

static NEXT_FOLDER: AtomicU32 = AtomicU32::new(0);

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let number = NEXT_FOLDER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "jgv-settings-{}-{number}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("folder");
        Self(path)
    }

    fn settings(&self) -> PathBuf {
        self.0.join(SETTINGS_FILE)
    }

    fn store(&self) -> Store {
        Store::load(Some(self.settings()))
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn set_read_only(path: &Path, read_only: bool) {
    let mut permissions = fs::metadata(path).expect("metadata").permissions();
    permissions.set_readonly(read_only);
    fs::set_permissions(path, permissions).expect("permissions");
}

fn written(folder: &Folder) -> Value {
    serde_json::from_slice(&fs::read(folder.settings()).expect("settings")).expect("json")
}

fn placement() -> Placement {
    Placement { x: 10, y: 20, width: 900, height: 700, maximized: false }
}

#[test]
fn a_missing_file_gives_defaults_and_is_not_created() {
    let folder = Folder::new();
    let store = folder.store();
    let settings = store.snapshot();
    assert_eq!(settings.theme, "dark");
    assert_eq!(settings.language, "en");
    assert_eq!(settings.window, None);
    assert!(settings.recent.is_empty());
    assert_eq!(store.take_startup_notice(), None);
    assert!(!folder.settings().exists());
}

#[test]
fn hand_written_values_take_effect_even_with_a_bom() {
    let folder = Folder::new();
    let body = json!({
        "theme": "dark",
        "language": "en",
        "window": { "x": 5, "y": 6, "width": 1000, "height": 900, "maximized": true },
        "recentFiles": ["C:\\a.json"]
    });
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(serde_json::to_vec(&body).expect("json"));
    fs::write(folder.settings(), bytes).expect("write");

    let settings = folder.store().snapshot();
    assert_eq!(settings.theme, "dark");
    assert_eq!(settings.language, "en");
    assert_eq!(
        settings.window,
        Some(Placement { x: 5, y: 6, width: 1000, height: 900, maximized: true })
    );
    assert_eq!(settings.recent, ["C:\\a.json"]);
}

#[test]
fn unknown_keys_survive_a_save_in_their_order() {
    let folder = Folder::new();
    let original = r#"{"zeta":1,"theme":"light","nested":{"b":[1,2],"a":null},"window":{"note":"x"}}"#;
    fs::write(folder.settings(), original).expect("write");

    let store = folder.store();
    assert_eq!(store.update(Change::Theme("dark".into())), None);
    assert_eq!(store.update(Change::Window(placement())), None);

    let text = fs::read_to_string(folder.settings()).expect("settings");
    let value: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(value["zeta"], 1);
    assert_eq!(value["nested"], json!({ "b": [1, 2], "a": null }));
    assert_eq!(value["theme"], "dark");
    assert_eq!(value["window"]["note"], "x");
    let order: Vec<&str> = value.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(order, ["zeta", "theme", "nested", "window"]);
    assert!(text.contains("\n  \"zeta\": 1"), "読める整形で書く: {text}");
    assert!(!text.as_bytes().starts_with(&[0xEF, 0xBB, 0xBF]), "BOM なしで書く");
}

#[test]
fn a_write_rereads_the_file_and_keeps_what_another_exe_wrote() {
    let folder = Folder::new();
    let store = folder.store();
    store.update(Change::AddRecent("C:\\mine.json".into()));
    // 別の EXE か人が書いた
    fs::write(
        folder.settings(),
        r#"{"recentFiles":["C:\\theirs.json","C:\\mine.json"],"added":true}"#,
    )
    .expect("write");

    store.update(Change::Theme("dark".into()));
    let value = written(&folder);
    assert_eq!(value["added"], true);
    assert_eq!(value["recentFiles"], json!(["C:\\theirs.json", "C:\\mine.json"]));
    assert_eq!(store.snapshot().recent, ["C:\\theirs.json", "C:\\mine.json"]);
}

/// 一時ファイルを書いた直後に、ロックを取らないエディタが設定を保存する場面を作る。
struct EditedMeanwhile {
    settings: PathBuf,
    done: AtomicBool,
}

impl Replacer for EditedMeanwhile {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }

    fn temp_written(&self, _temp: &Path) {
        if !self.done.swap(true, Ordering::SeqCst) {
            fs::write(&self.settings, r#"{"typed":"by hand"}"#).expect("write");
        }
    }
}

#[test]
fn an_edit_made_during_the_write_is_read_again_and_kept() {
    let folder = Folder::new();
    fs::write(folder.settings(), r#"{"before":1}"#).expect("write");
    let store = folder.store();
    let replacer = EditedMeanwhile { settings: folder.settings(), done: AtomicBool::new(false) };

    assert_eq!(store.update_with(Change::Theme("dark".into()), &replacer), None);

    let value = written(&folder);
    assert_eq!(value["typed"], "by hand");
    assert_eq!(value["theme"], "dark");
}

#[test]
fn a_lock_held_too_long_is_told_and_the_change_is_written_afterwards() {
    let folder = Folder::new();
    let path = folder.settings();
    let store = folder.store();
    let (held_sender, held) = channel();
    let (release, released) = channel::<()>();

    let lock_path = path.as_path();
    thread::scope(|scope| {
        scope.spawn(move || {
            let lock = FileLock::acquire(lock_path, Duration::from_secs(1));
            held_sender.send(lock.is_some()).expect("send");
            let _ = released.recv();
        });
        assert!(held.recv().expect("recv"));
        assert_eq!(store.update(Change::AddRecent("C:\\a.json".into())), Some(NOTICE_UNWRITABLE));
        assert!(!path.exists());
        release.send(()).expect("send");
    });

    assert_eq!(store.update(Change::Window(placement())), None);
    let value = written(&folder);
    assert_eq!(value["recentFiles"], json!(["C:\\a.json"]));
    assert_eq!(value["window"]["width"], placement().width);
}

#[test]
fn a_broken_file_is_kept_under_a_new_name_and_the_app_starts_with_defaults() {
    let folder = Folder::new();
    fs::write(folder.settings(), "{ not json").expect("write");
    let existing = folder.0.join(format!("{SETTINGS_FILE}.broken"));
    fs::write(&existing, "older").expect("write");

    let store = folder.store();
    assert_eq!(store.snapshot().theme, "dark");
    assert_eq!(store.take_startup_notice(), Some(NOTICE_BROKEN));
    assert_eq!(store.take_startup_notice(), None, "知らせは 1 度だけ");

    assert_eq!(fs::read_to_string(&existing).expect("older"), "older", "前の退避を消さない");
    let moved = folder.0.join(format!("{SETTINGS_FILE}.broken.1"));
    assert_eq!(fs::read_to_string(moved).expect("moved"), "{ not json");
    assert!(!folder.settings().exists(), "壊れたまま残らない");

    store.update(Change::Theme("dark".into()));
    assert_eq!(written(&folder)["theme"], "dark");
}

#[test]
fn a_root_that_is_not_an_object_counts_as_broken() {
    let folder = Folder::new();
    fs::write(folder.settings(), "[1, 2]").expect("write");
    let store = folder.store();
    assert_eq!(store.take_startup_notice(), Some(NOTICE_BROKEN));
    let moved = folder.0.join(format!("{SETTINGS_FILE}.broken"));
    assert_eq!(fs::read_to_string(moved).expect("moved"), "[1, 2]");
}

#[test]
fn a_bad_value_stays_in_the_file_until_that_key_changes() {
    let folder = Folder::new();
    fs::write(folder.settings(), r#"{"theme":"purple","language":"en"}"#).expect("write");

    let store = folder.store();
    let settings = store.snapshot();
    assert_eq!(settings.theme, "dark");
    assert_eq!(settings.language, "en");

    store.update(Change::AddRecent("C:\\a.json".into()));
    assert_eq!(written(&folder)["theme"], "purple");

    store.update(Change::Theme("dark".into()));
    assert_eq!(written(&folder)["theme"], "dark");
}

#[test]
fn a_read_only_file_keeps_the_memory_settings_and_tells_once() {
    let folder = Folder::new();
    fs::write(folder.settings(), r#"{"theme":"light"}"#).expect("write");
    set_read_only(&folder.settings(), true);

    let store = folder.store();
    assert_eq!(store.update(Change::Theme("dark".into())), Some(NOTICE_UNWRITABLE));
    assert_eq!(store.update(Change::AddRecent("C:\\a.json".into())), None, "知らせは 1 度だけ");
    let settings = store.snapshot();
    assert_eq!(settings.theme, "dark");
    assert_eq!(settings.recent, ["C:\\a.json"]);
    assert_eq!(written(&folder)["theme"], "light", "ファイルは変わらない");

    // 書けるようになったら、たまった変更をまとめて書く
    set_read_only(&folder.settings(), false);
    assert_eq!(store.update(Change::Language("en".into())), None);
    let value = written(&folder);
    assert_eq!(value["theme"], "dark");
    assert_eq!(value["language"], "en");
    assert_eq!(value["recentFiles"], json!(["C:\\a.json"]));
}

#[test]
fn a_folder_that_cannot_be_written_does_not_fail() {
    let folder = Folder::new();
    let store = Store::load(Some(folder.0.join("no-such-folder").join(SETTINGS_FILE)));
    assert_eq!(store.update(Change::Theme("dark".into())), Some(NOTICE_UNWRITABLE));
    assert_eq!(store.snapshot().theme, "dark");
}

#[test]
fn no_settings_path_runs_from_memory() {
    let store = Store::load(None);
    assert_eq!(store.update(Change::Theme("dark".into())), Some(NOTICE_UNWRITABLE));
    assert_eq!(store.snapshot().theme, "dark");
}

#[test]
fn settings_writes_do_not_touch_the_documents_beside_them() {
    let folder = Folder::new();
    let document = folder.0.join("document.json");
    let bytes = b"\xEF\xBB\xBF{ \"a\" : 1.10 }\r\n";
    fs::write(&document, bytes).expect("write");
    let before = fs::metadata(&document).expect("metadata").modified().expect("time");

    let store = folder.store();
    let path = document.to_string_lossy().into_owned();
    store.update(Change::AddRecent(path.clone()));
    store.update(Change::Window(placement()));
    store.update(Change::RemoveRecent(path));
    store.update(Change::ClearRecent);

    assert_eq!(fs::read(&document).expect("document"), bytes);
    let after = fs::metadata(&document).expect("metadata").modified().expect("time");
    assert_eq!(before, after);
    let names: Vec<String> = fs::read_dir(&folder.0)
        .expect("folder")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "一時ファイルを残さない: {names:?}");
}

/// 別のプロセスの本体。環境変数が無い普段の回では何もしない。
#[test]
fn child_adds_recent_files() {
    let (Ok(file), Ok(tag)) = (std::env::var(CHILD_ENV), std::env::var(CHILD_TAG_ENV)) else {
        return;
    };
    let store = Store::load(Some(PathBuf::from(file)));
    for number in 0..ADDS_PER_PROCESS {
        assert_eq!(store.update(Change::AddRecent(format!("C:\\{tag}{number}.json"))), None);
    }
}

#[test]
fn two_processes_adding_at_once_keep_every_entry() {
    let folder = Folder::new();
    let exe = std::env::current_exe().expect("exe");
    let children: Vec<_> = ["a", "b"]
        .iter()
        .map(|tag| {
            Command::new(&exe)
                .args(["--exact", CHILD_TEST])
                .env(CHILD_ENV, folder.settings())
                .env(CHILD_TAG_ENV, tag)
                .stdout(Stdio::null())
                .spawn()
                .expect("child")
        })
        .collect();
    for mut child in children {
        assert!(child.wait().expect("wait").success());
    }

    let recent = folder.store().snapshot().recent;
    assert_eq!(recent.len(), ADDS_PER_PROCESS * 2, "{recent:?}");
    for tag in ["a", "b"] {
        for number in 0..ADDS_PER_PROCESS {
            let path = format!("C:\\{tag}{number}.json");
            assert!(recent.contains(&path), "{path} が消えた: {recent:?}");
        }
    }
}
