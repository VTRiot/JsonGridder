//! パスの許可集合。ダイアログ、ドロップ、起動引数で来たパスだけを読み書きできる。
//!
//! 許可の付与はこの crate の内側からだけ行う。画面から付与する口を作らない。
//! 比較には解決後の値を使い、表示には受け取った形を使う。`canonicalize` の結果は
//! 拡張長パス（`\\?\`）になるので、画面へ出さない。

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;

use super::identity::same_identity;

/// 名前として使えない装置の名前。`\\?\` を付けると作れてしまうので、ここで断る。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathDenied {
    /// 許可集合に無い。
    NotGranted,
    /// フォルダ、装置など通常のファイルでない。
    NotAFile,
    /// 親への移動、別のデータの流れ、装置の名前など、受け付けない形。
    BadName,
}

/// 許可を確かめたパス。[`PathGrants`] だけが作れる。
#[derive(Clone, Debug)]
pub struct GrantedPath {
    real: PathBuf,
    display: String,
}

impl GrantedPath {
    /// 読み書きと比較に使う値。
    pub fn real(&self) -> &Path {
        &self.real
    }

    /// 画面に出す値。受け取った形のまま。
    pub fn display(&self) -> &str {
        &self.display
    }

    /// 同じファイルか。両方の実体が取れれば実体で比べる（ハードリンクは別のパスでも同じ）。
    /// 片方が無い（新しく作る保存先）など実体が取れなければ、解決したパスで比べる。
    pub fn is_same_file(&self, other: &GrantedPath) -> bool {
        same_identity(&self.real, &other.real).unwrap_or_else(|| self.real == other.real)
    }
}

#[derive(Default)]
pub struct PathGrants {
    granted: Mutex<HashSet<PathBuf>>,
}

impl PathGrants {
    /// ダイアログ、ドロップ、起動引数で来たパスを許可する。
    pub fn grant(&self, path: &Path) -> Result<GrantedPath, PathDenied> {
        let real = resolve(path)?;
        self.granted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(real.clone());
        Ok(granted(real, path))
    }

    /// 許可集合にあるときだけ [`GrantedPath`] を返す。
    pub fn check(&self, path: &Path) -> Result<GrantedPath, PathDenied> {
        let real = resolve(path)?;
        let allowed = self
            .granted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&real);
        if allowed {
            Ok(granted(real, path))
        } else {
            Err(PathDenied::NotGranted)
        }
    }
}

fn granted(real: PathBuf, display: &Path) -> GrantedPath {
    GrantedPath {
        real,
        display: display.to_string_lossy().into_owned(),
    }
}

/// 比較に使う値を作る。無いファイルは親を解決して名前を足す。
fn resolve(path: &Path) -> Result<PathBuf, PathDenied> {
    check_shape(path)?;
    match fs::canonicalize(path) {
        Ok(real) => {
            let is_file = fs::metadata(&real).is_ok_and(|metadata| metadata.is_file());
            if is_file { Ok(real) } else { Err(PathDenied::NotAFile) }
        }
        Err(_) => {
            let name = path.file_name().ok_or(PathDenied::BadName)?;
            let parent = path.parent().ok_or(PathDenied::BadName)?;
            let parent = fs::canonicalize(parent).map_err(|_| PathDenied::NotAFile)?;
            if !parent.is_dir() {
                return Err(PathDenied::NotAFile);
            }
            Ok(parent.join(name))
        }
    }
}

fn check_shape(path: &Path) -> Result<(), PathDenied> {
    if !path.is_absolute() {
        return Err(PathDenied::BadName);
    }
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                if matches!(prefix.kind(), Prefix::DeviceNS(_) | Prefix::Verbatim(_)) {
                    return Err(PathDenied::BadName);
                }
            }
            Component::ParentDir | Component::CurDir => return Err(PathDenied::BadName),
            Component::Normal(name) => {
                if !is_plain_name(&name.to_string_lossy()) {
                    return Err(PathDenied::BadName);
                }
            }
            Component::RootDir => {}
        }
    }
    Ok(())
}

/// `:` は別のデータの流れ。末尾の点と空白は OS が黙って落とすので別の名前になる。
fn is_plain_name(name: &str) -> bool {
    if name.contains(':') || name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    !RESERVED_NAMES
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_change_meaning_are_refused() {
        assert!(is_plain_name("data.json"));
        assert!(is_plain_name("console.json"));
        assert!(!is_plain_name("data.json:meta"));
        assert!(!is_plain_name("data.json."));
        assert!(!is_plain_name("data.json "));
        assert!(!is_plain_name("NUL"));
        assert!(!is_plain_name("com1"));
        assert!(is_plain_name("aux.json"));
    }

    #[test]
    fn relative_paths_are_refused() {
        assert_eq!(check_shape(Path::new("data.json")), Err(PathDenied::BadName));
    }
}
