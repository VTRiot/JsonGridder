//! 設定の読み書き。書くときはファイルを読み直し、変えたキーだけ当てる。
//!
//! 知らないキーと値が不正なキーは、ファイルの値のまま残す。書けなかった変更は `pending` に
//! 置き、メモリの設定として効かせ続け、次に書けたときにまとめて当てる。

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::lock::FileLock;
use crate::file::replace::{
    ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, Replacer, SystemReplacer,
};
use crate::file::save::{WriteFailure, write_atomically};
use crate::translate;

pub const SETTINGS_FILE: &str = "JsonGridder.settings.json";
pub const RECENT_LIMIT: usize = 10;
pub const THEMES: [&str; 2] = ["dark", "light"];
pub const LANGUAGES: [&str; 2] = ["ja", "en"];
const DEFAULT_THEME: &str = THEMES[0];
/// 設定が無い、または値が不正なときの言語。OS の表示言語に関係なく英語。
/// 日本語は設定の `"language": "ja"`（Options メニュー）で選ぶ。
pub const DEFAULT_LANGUAGE: &str = LANGUAGES[1];

const KEY_THEME: &str = "theme";
const KEY_LANGUAGE: &str = "language";
const KEY_WINDOW: &str = "window";
const KEY_RECENT: &str = "recentFiles";
const KEY_SPLASH_MS: &str = "splashMs";
const KEY_SPLASH_CEREMONY: &str = "splashCeremony";
const KEY_SPLASH_CEREMONY_UNLOCKED: &str = "splashCeremonyUnlocked";
const KEY_WRAP_LINES: &str = "wrapLines";
const KEY_HIDE_TARGETS_IN_TREE: &str = "hideTargetsInTree";
const KEY_TRANSLATION_ENABLED: &str = "translationEnabled";
const KEY_TRANSLATION_SERVICE: &str = "translationService";
const KEY_TRANSLATION_TIER: &str = "translationTier";
const KEY_TRANSLATION_MODEL: &str = "translationModel";
const KEY_TRANSLATION_FALLBACK: &str = "translationFallback";
/// 混雑のときに別のモデルへ切り替えるかの既定（既定は入）。
pub const DEFAULT_TRANSLATION_FALLBACK: bool = true;
const KEY_TRANSLATION_CONFIRM: &str = "translationConfirm";
/// 送る前に確かめるかの既定（F4。確かめを出す）。
pub const DEFAULT_TRANSLATION_CONFIRM: bool = true;
const KEY_TRANSLATION_MACHINE_NOTICE: &str = "translationMachineNotice";
/// 結果の小窓に「訳は機械の推測」の注意書きを出すかの既定（F5。出す）。
pub const DEFAULT_TRANSLATION_MACHINE_NOTICE: bool = true;

/// 起動画面の最低表示時間の既定（ミリ秒）。設定の `splashMs` で替え、0 なら起動画面を出さない。
pub const DEFAULT_SPLASH_MS: u64 = 1500;

const BROKEN_SUFFIX: &str = "broken";
/// 番号を探す上限。無限に回らないため。
const BROKEN_NAME_ATTEMPTS: u32 = 1000;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
/// 別の EXE の書き込みは短い。待ち切れなければ書くのを 1 回飛ばす。失うのは次の書き込みまでの間だけ。
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
/// 読んだ後に外から変えられたときに読み直す回数。人の保存が続けて当たることは無い。
const WRITE_ATTEMPTS: u32 = 3;

pub const NOTICE_BROKEN: &str = "app.notice.settingsBroken";
pub const NOTICE_UNWRITABLE: &str = "app.notice.settingsUnwritable";

/// 単位は物理ピクセル。`width`、`height` は窓の内側の大きさ。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Theme(String),
    Language(String),
    Window(Placement),
    AddRecent(String),
    RemoveRecent(String),
    ClearRecent,
    /// 起動画面を次の起動で出すか。直接の起動で出し終えると false になる。
    SplashCeremony(bool),
    /// 隠しコマンドが成功済みか。true になると Options に項目が出る。
    SplashCeremonyUnlocked(bool),
    /// 右端で折り返す。表示だけの設定で、文書には触らない。
    WrapLines(bool),
    /// ツリー表示のときは左ペインを出さない。表示だけの設定で、文書には触らない。
    HideTargetsInTree(bool),
    /// 翻訳の設定のキー（有効、サービス、モデル、切り替え、送る前の確かめ、小窓の注意書き）。
    /// API キーはここに無い（資格情報マネージャーに置く）。`translationTier` は書かない（F5 で使わなくなった）。
    Translation(Translation),
    /// 送る前に確かめるかだけ（確かめの「今後表示しない」）。ほかの翻訳の設定には触らない。
    TranslationConfirm(bool),
    /// 小窓の注意書きを出すかだけ（小窓の「今後表示しない」）。ほかの翻訳の設定には触らない。
    TranslationMachineNotice(bool),
}

/// 翻訳の設定。値は `crate::translate` の一覧で検査した物だけを持つ。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Translation {
    /// 翻訳を有効にするか。無いとき、真偽でないときは false（通信しない）。
    pub enabled: bool,
    pub service: String,
    /// F5 より前の「無料枠か有料か」。互換のために読むだけで、使わず、書かない
    /// （F5 からは翻訳のたびに右クリックで選び、それぞれのキーを使う）。
    pub tier: String,
    pub model: String,
    /// 選んだモデルが混雑か回数の上限で通らないとき、その仕事の間だけ別のモデルで送るか。
    /// 無いとき、真偽でないときは true。保存したモデルは替えない。
    pub fallback: bool,
    /// 送る前に件数、文字数、サービスを出して確かめるか。無いとき、真偽でないときは true。
    pub confirm: bool,
    /// 結果の小窓に「訳は機械の推測」の注意書きを出すか。無いとき、真偽でないときは true。
    pub machine_notice: bool,
}

impl Default for Translation {
    fn default() -> Self {
        Self {
            enabled: false,
            service: translate::DEFAULT_SERVICE.into(),
            tier: translate::DEFAULT_TIER.into(),
            model: translate::default_model(translate::DEFAULT_SERVICE).into(),
            fallback: DEFAULT_TRANSLATION_FALLBACK,
            confirm: DEFAULT_TRANSLATION_CONFIRM,
            machine_notice: DEFAULT_TRANSLATION_MACHINE_NOTICE,
        }
    }
}

/// 検査を通った値。不正なキーは既定の値になる。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub window: Option<Placement>,
    pub recent: Vec<String>,
    pub splash_ms: u64,
    /// 起動画面を出すか。無いとき、真偽でないときは true（初回の起動で出す）。
    pub splash_ceremony: bool,
    /// 隠しコマンドの成功済みか。無いとき、真偽でないときは false。
    pub splash_ceremony_unlocked: bool,
    /// 右端で折り返すか。無いとき、真偽でないときは false。
    pub wrap_lines: bool,
    /// ツリー表示のときは左ペインを出さないか。無いとき、真偽でないときは false（出す）。
    pub hide_targets_in_tree: bool,
    pub translation: Translation,
}

/// 同じファイルの判定に使う値。
fn folded(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn listed_value(map: &Map<String, Value>, key: &str, allowed: &[&str], fallback: &str) -> String {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .unwrap_or(fallback)
        .to_owned()
}

fn read_placement(map: &Map<String, Value>) -> Option<Placement> {
    let window = map.get(KEY_WINDOW)?.as_object()?;
    let position = |key: &str| i32::try_from(window.get(key)?.as_i64()?).ok();
    let size = |key: &str| u32::try_from(window.get(key)?.as_u64()?).ok().filter(|value| *value > 0);
    Some(Placement {
        x: position("x")?,
        y: position("y")?,
        width: size("width")?,
        height: size("height")?,
        maximized: window
            .get("maximized")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn read_recent(map: &Map<String, Value>) -> Vec<String> {
    let mut recent: Vec<String> = Vec::new();
    let entries = map.get(KEY_RECENT).and_then(Value::as_array);
    for path in entries.into_iter().flatten().filter_map(Value::as_str) {
        let seen = recent.iter().any(|entry| folded(entry) == folded(path));
        if !path.is_empty() && !seen && recent.len() < RECENT_LIMIT {
            recent.push(path.to_owned());
        }
    }
    recent
}

/// 負の数、小数、数でない値は既定に戻す。0 は「出さない」の意味で有効。
fn read_splash_ms(map: &Map<String, Value>) -> u64 {
    map.get(KEY_SPLASH_MS)
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SPLASH_MS)
}

fn read_flag(map: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

/// サービスが一覧に無ければ既定のサービス、モデルがそのサービスの一覧に無ければ既定のモデル。
fn read_translation(map: &Map<String, Value>) -> Translation {
    let service = listed_value(
        map,
        KEY_TRANSLATION_SERVICE,
        &translate::SERVICES,
        translate::DEFAULT_SERVICE,
    );
    let tier = listed_value(map, KEY_TRANSLATION_TIER, &translate::TIERS, translate::DEFAULT_TIER);
    let model = listed_value(
        map,
        KEY_TRANSLATION_MODEL,
        translate::models(&service),
        translate::default_model(&service),
    );
    // サービスかモデルが無い・一覧の外なら、既定へ戻した上で無効にする。
    // 利用者が選んでいない組（壊れた値から戻した既定のサービスやモデル）で送らない。
    // 無料枠か有料か（translationTier）は F5 から使わないので、有効かの判定に入れない
    let stored = |key: &str, allowed: &[&str]| {
        map.get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| allowed.contains(&value))
    };
    let chosen = stored(KEY_TRANSLATION_SERVICE, &translate::SERVICES)
        && stored(KEY_TRANSLATION_MODEL, translate::models(&service));
    Translation {
        enabled: chosen && read_flag(map, KEY_TRANSLATION_ENABLED, false),
        service,
        tier,
        model,
        // 有効かの判定には使わない（無い設定ファイルは F3 より前の物）
        fallback: read_flag(map, KEY_TRANSLATION_FALLBACK, DEFAULT_TRANSLATION_FALLBACK),
        // 有効かの判定には使わない（無い設定ファイルは F4 より前の物）
        confirm: read_flag(map, KEY_TRANSLATION_CONFIRM, DEFAULT_TRANSLATION_CONFIRM),
        // 有効かの判定には使わない（無い設定ファイルは F5 より前の物）
        machine_notice: read_flag(map, KEY_TRANSLATION_MACHINE_NOTICE, DEFAULT_TRANSLATION_MACHINE_NOTICE),
    }
}

/// `translationTier` は書かない（あれば元の値のまま残る。F5 より前の版が読んでも壊れない）。
fn put_translation(map: &mut Map<String, Value>, translation: &Translation) {
    map.insert(KEY_TRANSLATION_ENABLED.into(), translation.enabled.into());
    map.insert(KEY_TRANSLATION_SERVICE.into(), translation.service.as_str().into());
    map.insert(KEY_TRANSLATION_MODEL.into(), translation.model.as_str().into());
    map.insert(KEY_TRANSLATION_FALLBACK.into(), translation.fallback.into());
    map.insert(KEY_TRANSLATION_CONFIRM.into(), translation.confirm.into());
    map.insert(KEY_TRANSLATION_MACHINE_NOTICE.into(), translation.machine_notice.into());
}

fn validated(map: &Map<String, Value>) -> Settings {
    Settings {
        theme: listed_value(map, KEY_THEME, &THEMES, DEFAULT_THEME),
        language: listed_value(map, KEY_LANGUAGE, &LANGUAGES, DEFAULT_LANGUAGE),
        window: read_placement(map),
        recent: read_recent(map),
        splash_ms: read_splash_ms(map),
        splash_ceremony: read_flag(map, KEY_SPLASH_CEREMONY, true),
        splash_ceremony_unlocked: read_flag(map, KEY_SPLASH_CEREMONY_UNLOCKED, false),
        wrap_lines: read_flag(map, KEY_WRAP_LINES, false),
        hide_targets_in_tree: read_flag(map, KEY_HIDE_TARGETS_IN_TREE, false),
        translation: read_translation(map),
    }
}

fn put_recent(map: &mut Map<String, Value>, recent: Vec<String>) {
    let entries = recent.into_iter().map(Value::String).collect();
    map.insert(KEY_RECENT.into(), Value::Array(entries));
}

fn put_placement(map: &mut Map<String, Value>, placement: &Placement) {
    let mut window = match map.remove(KEY_WINDOW) {
        Some(Value::Object(window)) => window,
        _ => Map::new(),
    };
    window.insert("x".into(), placement.x.into());
    window.insert("y".into(), placement.y.into());
    window.insert("width".into(), placement.width.into());
    window.insert("height".into(), placement.height.into());
    window.insert("maximized".into(), placement.maximized.into());
    map.insert(KEY_WINDOW.into(), Value::Object(window));
}

/// 変わるキーだけに当てる。知らないキーはここを通らない。
fn apply(map: &mut Map<String, Value>, change: &Change) {
    match change {
        Change::Theme(theme) => {
            map.insert(KEY_THEME.into(), theme.as_str().into());
        }
        Change::Language(language) => {
            map.insert(KEY_LANGUAGE.into(), language.as_str().into());
        }
        Change::Window(placement) => put_placement(map, placement),
        Change::AddRecent(path) => {
            let mut recent = read_recent(map);
            recent.retain(|entry| folded(entry) != folded(path));
            recent.insert(0, path.clone());
            recent.truncate(RECENT_LIMIT);
            put_recent(map, recent);
        }
        Change::RemoveRecent(path) => {
            let mut recent = read_recent(map);
            recent.retain(|entry| folded(entry) != folded(path));
            put_recent(map, recent);
        }
        Change::ClearRecent => put_recent(map, Vec::new()),
        Change::SplashCeremony(shown) => {
            map.insert(KEY_SPLASH_CEREMONY.into(), (*shown).into());
        }
        Change::SplashCeremonyUnlocked(unlocked) => {
            map.insert(KEY_SPLASH_CEREMONY_UNLOCKED.into(), (*unlocked).into());
        }
        Change::WrapLines(wrap) => {
            map.insert(KEY_WRAP_LINES.into(), (*wrap).into());
        }
        Change::HideTargetsInTree(hide) => {
            map.insert(KEY_HIDE_TARGETS_IN_TREE.into(), (*hide).into());
        }
        Change::Translation(translation) => put_translation(map, translation),
        Change::TranslationConfirm(confirm) => {
            map.insert(KEY_TRANSLATION_CONFIRM.into(), (*confirm).into());
        }
        Change::TranslationMachineNotice(shown) => {
            map.insert(KEY_TRANSLATION_MACHINE_NOTICE.into(), (*shown).into());
        }
    }
}

enum Stored {
    Found(Map<String, Value>),
    Missing,
    Broken,
    /// ロック、権限。中身が分からないので、壊れた扱いにも空の扱いにもしない。
    Unreadable,
}

fn parse(bytes: &[u8]) -> Option<Map<String, Value>> {
    let body = bytes.strip_prefix(&UTF8_BOM).unwrap_or(bytes);
    match serde_json::from_slice(body) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn classify(read: &io::Result<Vec<u8>>) -> Stored {
    match read {
        Ok(bytes) => parse(bytes).map_or(Stored::Broken, Stored::Found),
        Err(error) if error.kind() == ErrorKind::NotFound => Stored::Missing,
        Err(_) => Stored::Unreadable,
    }
}

fn read_stored(path: &Path) -> Stored {
    classify(&fs::read(path))
}

fn broken_name(path: &Path, number: u32) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".");
    name.push(BROKEN_SUFFIX);
    if number > 0 {
        name.push(format!(".{number}"));
    }
    PathBuf::from(name)
}

/// 壊れたファイルを空いた名前へ移す。既存の物は消さない。もう無ければ、別の EXE が移した後である。
fn quarantine(path: &Path) -> Result<(), u32> {
    for number in 0..BROKEN_NAME_ATTEMPTS {
        match SystemReplacer.move_new(path, &broken_name(path, number)) {
            Ok(()) | Err(ERROR_FILE_NOT_FOUND) => return Ok(()),
            Err(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) => {}
            Err(code) => return Err(code),
        }
    }
    Err(ERROR_ALREADY_EXISTS)
}

fn render(map: &Map<String, Value>) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec_pretty(map)?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[derive(Default)]
struct Inner {
    /// 最後に読めたファイルの中身。
    base: Map<String, Value>,
    /// まだファイルへ書けていない変更。
    pending: Vec<Change>,
    told_unwritable: bool,
    startup_notice: Option<&'static str>,
}

impl Inner {
    fn tell_unwritable_once(&mut self) -> Option<&'static str> {
        if self.told_unwritable {
            return None;
        }
        self.told_unwritable = true;
        Some(NOTICE_UNWRITABLE)
    }

    fn current(&self) -> Map<String, Value> {
        let mut view = self.base.clone();
        for change in &self.pending {
            apply(&mut view, change);
        }
        view
    }
}

pub struct Store {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
}

impl Store {
    /// 無ければ既定で動く。ファイルは作らない。
    pub fn load(path: Option<PathBuf>) -> Self {
        let mut inner = Inner::default();
        if let Some(path) = path.as_deref() {
            let _held = FileLock::acquire(path, LOCK_TIMEOUT);
            match read_stored(path) {
                Stored::Found(map) => inner.base = map,
                Stored::Broken => {
                    // 移せなくても上書きはしない。書くときにもう一度確かめる
                    let _ = quarantine(path);
                    inner.startup_notice = Some(NOTICE_BROKEN);
                }
                Stored::Missing | Stored::Unreadable => {}
            }
        }
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 起動の間に分かった知らせ。1 度だけ返す。
    pub fn take_startup_notice(&self) -> Option<&'static str> {
        self.lock().startup_notice.take()
    }

    /// ファイルを読み直した今の値。読めなければ最後に読めた値で答える。
    pub fn snapshot(&self) -> Settings {
        let mut inner = self.lock();
        if let Some(path) = self.path.as_deref() {
            match read_stored(path) {
                Stored::Found(map) => inner.base = map,
                Stored::Missing => inner.base = Map::new(),
                Stored::Broken | Stored::Unreadable => {}
            }
        }
        validated(&inner.current())
    }

    /// 変更を当てて書く。知らせる物があればキーを返す。
    pub fn update(&self, change: Change) -> Option<&'static str> {
        self.update_with(change, &SystemReplacer)
    }

    pub(super) fn update_with(
        &self,
        change: Change,
        replacer: &dyn Replacer,
    ) -> Option<&'static str> {
        let mut inner = self.lock();
        inner.pending.push(change);
        let Some(path) = self.path.as_deref() else {
            return inner.tell_unwritable_once();
        };
        // 読み直しと書き込みの間に別の EXE が入ると履歴が 1 件消えるので、ロックの下で行う。
        // 取れなければ変更は pending に残る。次の書き込みか、閉じるときの窓の位置の保存で書く
        let Some(_held) = FileLock::acquire(path, LOCK_TIMEOUT) else {
            return inner.tell_unwritable_once();
        };

        let mut notice = None;
        for _ in 0..WRITE_ATTEMPTS {
            let read = fs::read(path);
            let (mut map, seen) = match classify(&read) {
                Stored::Found(map) => (map, read.ok()),
                Stored::Missing => (Map::new(), None),
                Stored::Broken => {
                    if quarantine(path).is_err() {
                        return inner.tell_unwritable_once();
                    }
                    notice = Some(NOTICE_BROKEN);
                    (Map::new(), None)
                }
                Stored::Unreadable => return inner.tell_unwritable_once(),
            };
            for change in &inner.pending {
                apply(&mut map, change);
            }
            let Ok(bytes) = render(&map) else {
                return inner.tell_unwritable_once();
            };
            let verify = |written: &[u8]| written == bytes.as_slice();
            // 人やほかのツールはロックを取らない。読んだ後に変わっていたら読み直して混ぜ直す
            let unchanged = || {
                if fs::read(path).ok() == seen {
                    Ok(())
                } else {
                    Err(WriteFailure::ExternalChange)
                }
            };
            match write_atomically(path, &bytes, &verify, &unchanged, replacer) {
                Ok(_) => {
                    inner.base = map;
                    inner.pending.clear();
                    return notice;
                }
                Err(WriteFailure::ExternalChange | WriteFailure::TargetAppeared) => {}
                Err(_) => break,
            }
        }
        notice.or_else(|| inner.tell_unwritable_once())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn a_missing_or_invalid_language_is_english() {
        let missing = validated(&map(json!({})));
        assert_eq!(missing.language, "en");
        let invalid = validated(&map(json!({ "language": "fr" })));
        assert_eq!(invalid.language, "en");
        let numeric = validated(&map(json!({ "language": 3 })));
        assert_eq!(numeric.language, "en");
        let empty = validated(&map(json!({ "language": "" })));
        assert_eq!(empty.language, "en");
    }

    #[test]
    fn a_japanese_setting_stays_japanese() {
        let valid = validated(&map(json!({ "language": "ja" })));
        assert_eq!(valid.language, "ja");
    }

    #[test]
    fn a_bad_value_falls_back_for_that_key_only() {
        let settings = validated(&map(json!({
            "theme": 7,
            "language": "en",
            "window": { "x": "left", "y": 0, "width": 800, "height": 600 },
            "recentFiles": ["a.json", 3, "A.JSON", "b.json"]
        })));
        assert_eq!(settings.theme, DEFAULT_THEME);
        assert_eq!(settings.language, "en");
        assert_eq!(settings.window, None);
        assert_eq!(settings.recent, ["a.json", "b.json"]);
    }

    #[test]
    fn splash_ceremony_defaults_and_bad_values() {
        let none = validated(&map(json!({})));
        assert!(none.splash_ceremony);
        assert!(!none.splash_ceremony_unlocked);
        let set = validated(&map(json!({"splashCeremony": false, "splashCeremonyUnlocked": true})));
        assert!(!set.splash_ceremony);
        assert!(set.splash_ceremony_unlocked);
        for bad in [json!("no"), json!(0), json!(null), json!([])] {
            let read = validated(&map(json!({"splashCeremony": bad.clone(), "splashCeremonyUnlocked": bad})));
            assert!(read.splash_ceremony);
            assert!(!read.splash_ceremony_unlocked);
        }
    }

    #[test]
    fn splash_ceremony_changes_write_only_their_keys() {
        let mut written = map(json!({"theme": "light", "unknown": 1}));
        apply(&mut written, &Change::SplashCeremony(false));
        apply(&mut written, &Change::SplashCeremonyUnlocked(true));
        assert_eq!(written["splashCeremony"], json!(false));
        assert_eq!(written["splashCeremonyUnlocked"], json!(true));
        assert_eq!(written["theme"], json!("light"));
        assert_eq!(written["unknown"], json!(1));
    }

    #[test]
    fn wrap_lines_defaults_to_off_and_ignores_bad_values() {
        assert!(!validated(&map(json!({}))).wrap_lines);
        assert!(validated(&map(json!({"wrapLines": true}))).wrap_lines);
        assert!(!validated(&map(json!({"wrapLines": false}))).wrap_lines);
        for bad in [json!("yes"), json!(1), json!(null), json!({})] {
            assert!(!validated(&map(json!({ "wrapLines": bad }))).wrap_lines);
        }
    }

    #[test]
    fn wrap_lines_change_writes_only_its_key() {
        let mut written = map(json!({"theme": "light", "unknown": 1}));
        apply(&mut written, &Change::WrapLines(true));
        assert_eq!(written["wrapLines"], json!(true));
        assert!(validated(&written).wrap_lines);
        apply(&mut written, &Change::WrapLines(false));
        assert_eq!(written["wrapLines"], json!(false));
        assert_eq!(written["theme"], json!("light"));
        assert_eq!(written["unknown"], json!(1));
    }

    #[test]
    fn hide_targets_in_tree_defaults_to_shown_and_ignores_bad_values() {
        assert!(!validated(&map(json!({}))).hide_targets_in_tree);
        assert!(validated(&map(json!({"hideTargetsInTree": true}))).hide_targets_in_tree);
        assert!(!validated(&map(json!({"hideTargetsInTree": false}))).hide_targets_in_tree);
        for bad in [json!("yes"), json!(1), json!(null), json!({})] {
            assert!(!validated(&map(json!({ "hideTargetsInTree": bad }))).hide_targets_in_tree);
        }
    }

    #[test]
    fn hide_targets_in_tree_change_writes_only_its_key() {
        let mut written = map(json!({"theme": "light", "wrapLines": true, "unknown": 1}));
        apply(&mut written, &Change::HideTargetsInTree(true));
        assert_eq!(written["hideTargetsInTree"], json!(true));
        assert!(validated(&written).hide_targets_in_tree);
        apply(&mut written, &Change::HideTargetsInTree(false));
        assert_eq!(written["hideTargetsInTree"], json!(false));
        assert_eq!(written["theme"], json!("light"));
        assert_eq!(written["wrapLines"], json!(true));
        assert_eq!(written["unknown"], json!(1));
    }

    #[test]
    fn translation_settings_default_off() {
        let none = validated(&map(json!({}))).translation;
        assert!(!none.enabled);
        assert_eq!(none, Translation::default());
        assert_eq!(none.service, "gemini");
        assert_eq!(none.tier, "free");
        assert_eq!(none.model, "gemini-3.1-flash-lite");
        assert!(none.fallback);
        assert!(none.confirm);
        assert!(none.machine_notice);
    }

    /// F5: 無料枠か有料か（translationTier）は互換のために読むだけ。無くても、一覧の外でも有効のまま。
    #[test]
    fn translation_tier_is_read_but_not_required() {
        let without = json!({
            "translationEnabled": true,
            "translationService": "gemini",
            "translationModel": "gemini-3.1-flash-lite"
        });
        let read = validated(&map(without.clone())).translation;
        assert!(read.enabled);
        assert_eq!(read.tier, "free");
        for (stored, expected) in [(json!("paid"), "paid"), (json!("Paid"), "free"), (json!(1), "free")] {
            let mut value = without.clone();
            value.as_object_mut().expect("object").insert("translationTier".into(), stored.clone());
            let read = validated(&map(value)).translation;
            assert!(read.enabled, "{stored}");
            assert_eq!(read.tier, expected, "{stored}");
        }
    }

    #[test]
    fn translation_machine_notice_defaults_on_and_ignores_bad_values() {
        assert!(validated(&map(json!({}))).translation.machine_notice);
        for (stored, expected) in [(json!(false), false), (json!(true), true), (json!("no"), true), (json!(0), true), (json!(null), true)] {
            let read = validated(&map(json!({ "translationMachineNotice": stored.clone() }))).translation;
            assert_eq!(read.machine_notice, expected, "{stored}");
        }
    }

    #[test]
    fn translation_machine_notice_change_writes_only_its_key() {
        let before = json!({
            "theme": "light",
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "paid",
            "translationModel": "gemini-3.6-flash",
            "translationConfirm": false
        });
        let mut written = map(before.clone());
        apply(&mut written, &Change::TranslationMachineNotice(false));
        let mut expected = before.clone();
        expected.as_object_mut().expect("object").insert("translationMachineNotice".into(), json!(false));
        assert_eq!(Value::Object(written.clone()), expected);
        let read = validated(&written).translation;
        assert!(!read.machine_notice);
        assert!(read.enabled);
        assert!(!read.confirm);
        apply(&mut written, &Change::TranslationMachineNotice(true));
        assert!(validated(&written).translation.machine_notice);
    }

    #[test]
    fn translation_fallback_defaults_on_and_ignores_bad_values() {
        let good = json!({
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "free",
            "translationModel": "gemini-3.1-flash-lite"
        });
        // F3 より前の設定ファイル（キーが無い）は入で、有効のまま
        let read = validated(&map(good.clone())).translation;
        assert!(read.fallback);
        assert!(read.enabled);
        for (stored, expected) in [(json!(false), false), (json!(true), true), (json!("no"), true), (json!(0), true), (json!(null), true)] {
            let mut value = good.clone();
            value.as_object_mut().expect("object").insert("translationFallback".into(), stored.clone());
            let read = validated(&map(value)).translation;
            assert_eq!(read.fallback, expected, "{stored}");
            assert!(read.enabled, "{stored}");
        }
    }

    #[test]
    fn translation_settings_bad_values_fall_back() {
        let valid = validated(&map(json!({
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "paid",
            "translationModel": "gemini-3.6-flash"
        })))
        .translation;
        assert!(valid.enabled);
        assert_eq!(valid.tier, "paid");
        assert_eq!(valid.model, "gemini-3.6-flash");
        for bad in [json!("yes"), json!(1), json!(null), json!({}), json!([])] {
            let read = validated(&map(json!({
                "translationEnabled": bad.clone(),
                "translationService": bad.clone(),
                "translationTier": bad.clone(),
                "translationModel": bad
            })))
            .translation;
            assert_eq!(read, Translation::default());
        }
        // 一覧の外のモデルは URL のパスに入るので既定へ戻す。
        // 利用者の選んでいない既定の組で送らないよう、有効の印は落とす（T2 の Codex レビューの指摘）
        let outside = validated(&map(json!({
            "translationEnabled": true,
            "translationService": "openai",
            "translationTier": "Paid",
            "translationModel": "../../v1/evil"
        })))
        .translation;
        assert!(!outside.enabled);
        assert_eq!(outside.service, "gemini");
        assert_eq!(outside.tier, "free");
        assert_eq!(outside.model, "gemini-3.1-flash-lite");
    }

    #[test]
    fn broken_translation_choice_turns_translation_off() {
        let good = json!({
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "paid",
            "translationModel": "gemini-3.6-flash"
        });
        assert!(validated(&map(good.clone())).translation.enabled);
        // どれか 1 つが無い、型が違う、一覧の外なら無効（translationTier は F5 から判定に使わない）
        for key in ["translationService", "translationModel"] {
            for broken in [None, Some(json!(1)), Some(json!("removed"))] {
                let mut value = good.clone();
                let object = value.as_object_mut().expect("object");
                match broken {
                    None => {
                        object.remove(key);
                    }
                    Some(bad) => {
                        object.insert(key.into(), bad);
                    }
                }
                let read = validated(&map(value)).translation;
                assert!(!read.enabled, "{key} broken but still enabled");
            }
        }
    }

    #[test]
    fn translation_change_writes_only_its_key() {
        let mut written = map(json!({"theme": "light", "wrapLines": true, "unknown": 1, "translationTier": "paid"}));
        let translation = Translation {
            enabled: true,
            service: "gemini".into(),
            // 構造体の値は書かない。ファイルにあった値（paid）がそのまま残る
            tier: "free".into(),
            model: "gemini-3.5-flash-lite".into(),
            fallback: false,
            confirm: false,
            machine_notice: false,
        };
        apply(&mut written, &Change::Translation(translation.clone()));
        assert_eq!(
            Value::Object(written.clone()),
            json!({
                "theme": "light",
                "wrapLines": true,
                "unknown": 1,
                "translationEnabled": true,
                "translationService": "gemini",
                "translationTier": "paid",
                "translationModel": "gemini-3.5-flash-lite",
                "translationFallback": false,
                "translationConfirm": false,
                "translationMachineNotice": false
            })
        );
        assert_eq!(validated(&written).translation, Translation { tier: "paid".into(), ..translation.clone() });

        // 無い設定ファイルには translationTier を足さない
        let mut fresh = Map::new();
        apply(&mut fresh, &Change::Translation(translation));
        assert!(!fresh.contains_key("translationTier"));
    }

    #[test]
    fn translation_confirm_defaults_on_and_ignores_bad_values() {
        assert!(validated(&map(json!({}))).translation.confirm);
        let good = json!({
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "free",
            "translationModel": "gemini-3.1-flash-lite"
        });
        // F4 より前の設定ファイル（キーが無い）は確かめを出し、有効のまま
        let read = validated(&map(good.clone())).translation;
        assert!(read.confirm);
        assert!(read.enabled);
        for (stored, expected) in [(json!(false), false), (json!(true), true), (json!("no"), true), (json!(0), true), (json!(null), true), (json!({}), true)] {
            let mut value = good.clone();
            value.as_object_mut().expect("object").insert("translationConfirm".into(), stored.clone());
            let read = validated(&map(value)).translation;
            assert_eq!(read.confirm, expected, "{stored}");
            assert!(read.enabled, "{stored}");
        }
    }

    #[test]
    fn translation_confirm_change_writes_only_its_key() {
        let before = json!({
            "theme": "light",
            "unknown": 1,
            "translationEnabled": true,
            "translationService": "gemini",
            "translationTier": "paid",
            "translationModel": "gemini-3.6-flash",
            "translationFallback": false
        });
        let mut written = map(before.clone());
        apply(&mut written, &Change::TranslationConfirm(false));
        let mut expected = before.clone();
        expected.as_object_mut().expect("object").insert("translationConfirm".into(), json!(false));
        assert_eq!(Value::Object(written.clone()), expected);
        let read = validated(&written).translation;
        assert!(!read.confirm);
        assert!(read.enabled);
        assert!(!read.fallback);
        assert_eq!(read.model, "gemini-3.6-flash");
        // 戻すと確かめを出す
        apply(&mut written, &Change::TranslationConfirm(true));
        assert!(validated(&written).translation.confirm);
    }

    #[test]
    fn splash_ms_keeps_zero_and_falls_back_for_bad_values() {
        assert_eq!(validated(&map(json!({}))).splash_ms, DEFAULT_SPLASH_MS);
        assert_eq!(validated(&map(json!({"splashMs": 0}))).splash_ms, 0);
        assert_eq!(validated(&map(json!({"splashMs": 3000}))).splash_ms, 3000);
        for bad in [json!(-5), json!(1.5), json!("1"), json!(null)] {
            assert_eq!(validated(&map(json!({ "splashMs": bad }))).splash_ms, DEFAULT_SPLASH_MS);
        }
    }

    #[test]
    fn a_zero_size_is_not_a_placement() {
        let value = json!({ "window": { "x": 0, "y": 0, "width": 0, "height": 600 } });
        assert_eq!(read_placement(&map(value)), None);
    }

    #[test]
    fn a_recent_file_moves_to_the_front_without_doubling() {
        let mut settings = map(json!({ "recentFiles": ["C:\\a.json", "C:\\b.json"] }));
        apply(&mut settings, &Change::AddRecent("c:/B.JSON".into()));
        assert_eq!(read_recent(&settings), ["c:/B.JSON", "C:\\a.json"]);
    }

    #[test]
    fn the_list_is_cut_at_the_limit() {
        let mut settings = Map::new();
        for number in 0..=RECENT_LIMIT {
            apply(&mut settings, &Change::AddRecent(format!("{number}.json")));
        }
        let recent = read_recent(&settings);
        assert_eq!(recent.len(), RECENT_LIMIT);
        assert_eq!(recent[0], format!("{RECENT_LIMIT}.json"));
        assert!(!recent.contains(&"0.json".to_owned()));
    }

    #[test]
    fn a_placement_keeps_unknown_keys_of_the_window_object() {
        let mut settings = map(json!({ "window": { "note": "mine" } }));
        let placement = Placement { x: 1, y: 2, width: 3, height: 4, maximized: true };
        apply(&mut settings, &Change::Window(placement));
        assert_eq!(settings["window"]["note"], "mine");
        assert_eq!(read_placement(&settings), Some(placement));
    }
}
