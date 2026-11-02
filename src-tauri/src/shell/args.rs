//! 起動引数からパスを取る。`Url::parse` を通さない。日本語と絵文字のパスをそのまま受ける。

use std::ffi::OsString;
use std::path::{Path, PathBuf, absolute};

/// `-` で始まるものを除いた最初の引数。絶対パスでなければ `cwd` と結ぶ。
pub fn startup_path(args: impl Iterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    args.skip(1)
        .find(|arg| !arg.as_encoded_bytes().starts_with(b"-"))
        .map(|arg| {
            let joined = cwd.join(arg);
            // `..\a.json` は許可の検査が断るので、ここで畳む
            absolute(&joined).unwrap_or(joined)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(args: &[&str]) -> Option<PathBuf> {
        let args = std::iter::once("JsonGridder.exe")
            .chain(args.iter().copied())
            .map(OsString::from);
        startup_path(args, Path::new(r"C:\work\docs"))
    }

    #[test]
    fn no_argument_gives_no_path() {
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn an_absolute_path_stays_as_it_is() {
        assert_eq!(pick(&[r"D:\a.json"]), Some(PathBuf::from(r"D:\a.json")));
    }

    #[test]
    fn a_relative_path_joins_the_working_directory() {
        assert_eq!(
            pick(&["a.json"]),
            Some(PathBuf::from(r"C:\work\docs\a.json"))
        );
        assert_eq!(
            pick(&[r"..\a.json"]),
            Some(PathBuf::from(r"C:\work\a.json"))
        );
    }

    #[test]
    fn options_are_skipped_and_the_first_path_wins() {
        assert_eq!(
            pick(&["--flag", "a.json", "b.json"]),
            Some(PathBuf::from(r"C:\work\docs\a.json"))
        );
    }

    #[test]
    fn japanese_and_emoji_paths_keep_their_characters() {
        assert_eq!(
            pick(&["日本語 😀.json"]),
            Some(PathBuf::from(r"C:\work\docs\日本語 😀.json"))
        );
    }
}
