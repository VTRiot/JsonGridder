//! Rust 側の文言。フロントエンドと同じ辞書ファイルを引く。
//!
//! 引く順は、今の言語、基準の言語（英語）、キー名。言語は起動時と切り替えのたびに
//! [`set_language`] で替える。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

static EN: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| parse(include_str!("../../src/i18n/en.json")));
static JA: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| parse(include_str!("../../src/i18n/ja.json")));

/// 日本語のコード。これ以外のコードは基準の言語（英語）。
const LANGUAGE_JAPANESE: &str = "ja";

static JAPANESE: AtomicBool = AtomicBool::new(false);

fn parse(source: &str) -> HashMap<String, String> {
    serde_json::from_str(source).unwrap_or_default()
}

fn find(dictionary: &HashMap<String, String>, key: &str) -> Option<String> {
    dictionary.get(key).filter(|value| !value.is_empty()).cloned()
}

fn lookup(dictionary: &HashMap<String, String>, key: &str) -> String {
    find(dictionary, key).unwrap_or_else(|| key.to_string())
}

/// 画面の言語に合わせる。知らないコードは基準の言語になる。
pub fn set_language(code: &str) {
    JAPANESE.store(code == LANGUAGE_JAPANESE, Ordering::SeqCst);
}

fn translate(japanese: bool, key: &str) -> String {
    let current = if japanese { &JA } else { &EN };
    find(current, key)
        .or_else(|| find(&EN, key))
        .unwrap_or_else(|| key.to_string())
}

/// 文言を引く。無いキーはキー名を返し、画面を壊さない。
pub fn t(key: &str) -> String {
    translate(JAPANESE.load(Ordering::SeqCst), key)
}

/// 言語を指して引く。今の言語は替えない（試験で使う）。
#[cfg(test)]
pub fn t_in(code: &str, key: &str) -> String {
    translate(code == LANGUAGE_JAPANESE, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_dictionaries_parse_and_have_the_startup_error() {
        assert!(!JA.is_empty());
        assert!(!EN.is_empty());
        assert_ne!(translate(true, "app.error.initFailedBody"), "app.error.initFailedBody");
        assert_ne!(translate(false, "app.error.initFailedBody"), "app.error.initFailedBody");
    }

    #[test]
    fn the_two_dictionaries_have_the_same_keys() {
        let mut ja: Vec<_> = JA.keys().collect();
        let mut en: Vec<_> = EN.keys().collect();
        ja.sort();
        en.sort();
        assert_eq!(ja, en);
    }

    #[test]
    fn the_language_picks_the_dictionary() {
        assert_eq!(translate(true, "app.dialog.dontSave"), "保存しない");
        assert_eq!(translate(false, "app.dialog.dontSave"), "Don't Save");
    }

    #[test]
    fn the_unsaved_choices_and_messages_exist_in_both_languages() {
        for key in [
            "app.dialog.save",
            "app.dialog.dontSave",
            "app.dialog.cancel",
            "app.dialog.unsavedTitle",
            "app.dialog.unsavedBody",
            "app.dialog.unsavedBlockedBody",
            "app.dialog.stuckTitle",
            "app.dialog.stuckBody",
            "app.dialog.wait",
            "app.dialog.closeWithoutSaving",
            "app.dialog.filterJson",
            "app.dialog.filterAll",
        ] {
            for japanese in [true, false] {
                assert_ne!(translate(japanese, key), key, "{key}");
            }
        }
    }

    #[test]
    fn a_missing_or_empty_key_falls_back_to_the_key_name() {
        let dictionary = parse(r#"{"present":"value","empty":""}"#);
        assert_eq!(lookup(&dictionary, "present"), "value");
        assert_eq!(lookup(&dictionary, "absent"), "absent");
        assert_eq!(lookup(&dictionary, "empty"), "empty");
        assert_eq!(translate(true, "no.such.key"), "no.such.key");
    }

    #[test]
    fn a_broken_dictionary_gives_key_names_instead_of_failing() {
        assert_eq!(lookup(&parse("{"), "any.key"), "any.key");
    }
}
