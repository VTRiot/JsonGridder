//! 原子保存。同じフォルダの一時ファイルに書き、同期し、読み直し、置き換える。
//!
//! 退避名は同じフォルダの一意名を先に作って確保する。`ReplaceFileW` は既存の退避名を
//! 黙って上書きするので、利用者のファイルの名前を渡さない。確保した名前には乱数の印を書き、
//! 失敗の後に元のファイルがそこへ動いたかを見分ける。

use std::collections::hash_map::RandomState;
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use super::replace::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND,
    ERROR_SHARING_VIOLATION, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, Replacer, open_for_write_check,
};
use super::{os_code, sha256};

const LOCK_RETRY_ATTEMPTS: u32 = 3;
const LOCK_RETRY_TOTAL: Duration = Duration::from_millis(500);
/// 乱数 64 ビットの名前なので、衝突は現実には起きない。無限に回らないための上限。
const NAME_COLLISION_ATTEMPTS: u32 = 16;
const TEMP_EXTENSION: &str = "tmp";
const BACKUP_EXTENSION: &str = "bak";
/// 利用者の名前を含めない。長い名前で上限を超えないため。
const NAME_PREFIX: &str = ".jgv-";

#[derive(Debug, PartialEq, Eq)]
pub struct Written {
    /// 成功したが退避を消せなかったときの場所。
    pub backup_left: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteFailure {
    ReadOnly,
    /// ファイルの権限が書き込みを許さない。読み取り専用と同じく、別名保存へ導ける。
    WriteDenied,
    Locked { code: u32 },
    /// フォルダに書けない。元のファイルへの直接の上書きには落とさない。
    FolderDenied { code: u32 },
    /// 新規のつもりの保存先が、書く間に現れた。
    TargetAppeared,
    /// 読み直しが書いた内容と合わない。
    VerifyFailed,
    /// 置き換えの直前の確かめで、元のファイルが基準と違っていた。
    ExternalChange,
    /// 置き換えの直前の確かめで、元のファイルが無かった。
    Missing,
    Failed { code: u32 },
    /// 元のファイルが退避名に残り、戻せなかった。または元の名前に文書が無く、退避名を読めない。
    /// 退避名を消さない。
    RecoveryNeeded { original_at: PathBuf },
    /// `failure` で止まり、退避名を消せなかった。元の名前の文書には触っていない。
    BackupLeft {
        failure: Box<WriteFailure>,
        backup: PathBuf,
    },
}

/// `bytes` を `target` へ書く。失敗なら `target` は元のままで、一時ファイルも残さない。
/// `verify` は読み直したバイト列を受け、書こうとした文書と一致するかを返す。
/// `before_publish` は置き換えのたびに、その直前に呼ばれ、元のファイルの確かめに使う。
/// 確かめと置き換えの間の窓を、一時ファイルの書き込みの時間の分だけ縮める。
/// ロックの再試行の前にも呼ぶ。ロックの持ち主が書いた内容を置き換えで消さないためである。
pub fn write_atomically(
    target: &Path,
    bytes: &[u8],
    verify: &dyn Fn(&[u8]) -> bool,
    before_publish: &dyn Fn() -> Result<(), WriteFailure>,
    replacer: &dyn Replacer,
) -> Result<Written, WriteFailure> {
    let existing = match fs::metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(failure_from(&error)),
    };
    if existing.as_ref().is_some_and(|metadata| metadata.permissions().readonly()) {
        return Err(WriteFailure::ReadOnly);
    }
    if existing.is_some() {
        check_writable(target)?;
    }
    let folder = target.parent().ok_or(WriteFailure::Failed { code: 0 })?;

    let temp = write_temp(folder, bytes)?;
    replacer.temp_written(&temp);
    let result = verify_temp(&temp, bytes, verify).and_then(|()| before_publish()).and_then(|()| {
        if existing.is_some() {
            replace_existing(target, &temp, folder, before_publish, replacer)
        } else {
            move_to_new(target, &temp, replacer)
        }
    });
    if !matches!(result, Err(WriteFailure::RecoveryNeeded { .. })) {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// ファイルの権限が書き込みを許すかを、書かずに確かめる。
/// 共有違反はここで止めない。ロックの扱いは置き換えの側が持つ。
fn check_writable(target: &Path) -> Result<(), WriteFailure> {
    let Err(error) = open_for_write_check(target) else {
        return Ok(());
    };
    match os_code(&error) {
        ERROR_ACCESS_DENIED => Err(WriteFailure::WriteDenied),
        ERROR_SHARING_VIOLATION | ERROR_FILE_NOT_FOUND => Ok(()),
        code => Err(WriteFailure::Failed { code }),
    }
}

fn write_temp(folder: &Path, bytes: &[u8]) -> Result<PathBuf, WriteFailure> {
    let (temp, mut file) = reserve_name(folder, TEMP_EXTENSION)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(WriteFailure::Failed {
            code: os_code(&error),
        });
    }
    Ok(temp)
}

fn random_number() -> u64 {
    RandomState::new().build_hasher().finish()
}

/// 同じフォルダに一意名のファイルを作る。作れた名前だけが自分の物である。
fn reserve_name(folder: &Path, extension: &str) -> Result<(PathBuf, File), WriteFailure> {
    let mut last_error = None;
    for _ in 0..NAME_COLLISION_ATTEMPTS {
        let path = folder.join(format!("{NAME_PREFIX}{:016x}.{extension}", random_number()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => last_error = Some(error),
            Err(error) => {
                return Err(WriteFailure::FolderDenied {
                    code: os_code(&error),
                });
            }
        }
    }
    Err(WriteFailure::Failed {
        code: last_error.as_ref().map_or(0, os_code),
    })
}

fn verify_temp(
    temp: &Path,
    expected: &[u8],
    verify: &dyn Fn(&[u8]) -> bool,
) -> Result<(), WriteFailure> {
    let written = fs::read(temp).map_err(|error| WriteFailure::Failed {
        code: os_code(&error),
    })?;
    if sha256(&written) == sha256(expected) && verify(&written) {
        Ok(())
    } else {
        Err(WriteFailure::VerifyFailed)
    }
}

fn replace_existing(
    target: &Path,
    temp: &Path,
    folder: &Path,
    before_publish: &dyn Fn() -> Result<(), WriteFailure>,
    replacer: &dyn Replacer,
) -> Result<Written, WriteFailure> {
    let (backup, mut placeholder) = reserve_name(folder, BACKUP_EXTENSION)?;
    let marker = random_number().to_le_bytes();
    let marked = placeholder.write_all(&marker);
    drop(placeholder);
    if let Err(error) = marked {
        let _ = fs::remove_file(&backup);
        return Err(WriteFailure::Failed {
            code: os_code(&error),
        });
    }

    let pause = LOCK_RETRY_TOTAL / (LOCK_RETRY_ATTEMPTS - 1);
    let mut outcome = replacer.replace(target, temp, &backup);
    for _ in 1..LOCK_RETRY_ATTEMPTS {
        match outcome {
            Err(code) if is_lock(code) && !is_read_only(target) => {
                sleep(pause);
                // ロックの間に書かれていたら、置き換えると外部の内容が退避と一緒に消える
                if let Err(failure) = before_publish() {
                    return Err(give_up(failure, target, &backup, &marker));
                }
                // 置き換えは既存の退避名を上書きする。印のままでなければ次へ進まない
                if inspect_backup(&backup, &marker) != BackupHolds::Nothing {
                    return Err(give_up(stopped_by(code, target), target, &backup, &marker));
                }
                outcome = replacer.replace(target, temp, &backup);
            }
            _ => break,
        }
    }

    match outcome {
        Ok(()) => Ok(Written {
            backup_left: fs::remove_file(&backup).is_err().then_some(backup),
        }),
        Err(code) => recover(code, target, &backup, &marker, replacer),
    }
}

fn is_lock(code: u32) -> bool {
    code == ERROR_ACCESS_DENIED || code == ERROR_SHARING_VIOLATION
}

fn is_read_only(target: &Path) -> bool {
    fs::metadata(target).is_ok_and(|metadata| metadata.permissions().readonly())
}

/// 退避名に何があるかの答え。消してよいことと「元が居る」と言えることは別である。
#[derive(Debug, PartialEq, Eq)]
enum BackupHolds {
    /// 印のままか、名前が無いか、フォルダである。元はここに居ない。
    Nothing,
    /// 印でないファイルがある。元がここへ動いている。
    Original,
    /// 読めない。元かどうかを言えず、消してもいけない。
    Unknown,
}

/// 確保した退避名は印だけを持つ。元は 0 バイトのこともあるので、長さの一致は印の証拠にしない。
fn inspect_backup(backup: &Path, marker: &[u8]) -> BackupHolds {
    let metadata = match fs::metadata(backup) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return BackupHolds::Nothing,
        Err(_) => return BackupHolds::Unknown,
    };
    if metadata.is_dir() {
        // 文書はファイルなので元ではない。消す呼び出しは失敗し、残った名前として報告される
        return BackupHolds::Nothing;
    }
    if metadata.len() != marker.len() as u64 {
        return BackupHolds::Original;
    }
    match fs::read(backup) {
        Ok(bytes) if bytes == marker => BackupHolds::Nothing,
        Ok(_) => BackupHolds::Original,
        Err(_) => BackupHolds::Unknown,
    }
}

/// 元の名前に何かがあるか。確かめられないときは、あるものとして扱う。
fn name_is_taken(target: &Path) -> bool {
    target.try_exists().unwrap_or(true)
}

/// 置き換えをやめるときの片付け。元が退避名に居れば、消さずに場所を返す。
/// 元の名前に文書があるなら、読めない退避名を元とは呼ばず、残った名前として報告する。
fn give_up(failure: WriteFailure, target: &Path, backup: &Path, marker: &[u8]) -> WriteFailure {
    let recovery = || WriteFailure::RecoveryNeeded {
        original_at: backup.to_path_buf(),
    };
    let left = |failure| WriteFailure::BackupLeft {
        failure: Box::new(failure),
        backup: backup.to_path_buf(),
    };
    match inspect_backup(backup, marker) {
        BackupHolds::Original => recovery(),
        BackupHolds::Unknown if name_is_taken(target) => left(failure),
        BackupHolds::Unknown => recovery(),
        BackupHolds::Nothing => match fs::remove_file(backup) {
            Err(error) if error.kind() != ErrorKind::NotFound => left(failure),
            _ => failure,
        },
    }
}

/// 置き換えの失敗のコードを、止まった理由へ直す。
fn stopped_by(code: u32, target: &Path) -> WriteFailure {
    if code == ERROR_FILE_NOT_FOUND || !name_is_taken(target) {
        WriteFailure::Missing
    } else if !is_lock(code) {
        WriteFailure::Failed { code }
    } else if is_read_only(target) {
        WriteFailure::ReadOnly
    } else {
        WriteFailure::Locked { code }
    }
}

/// 失敗の後の片付け。元のファイルが退避名に居る恐れがあれば、退避名を消さない。
fn recover(
    code: u32,
    target: &Path,
    backup: &Path,
    marker: &[u8],
    replacer: &dyn Replacer,
) -> Result<Written, WriteFailure> {
    // 文書は 1177 で元が退避名に居ると書く。印のままなら戻す物が無い。読めなければ戻さず場所を返す
    if code == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 {
        let holds = inspect_backup(backup, marker);
        if holds == BackupHolds::Original && replacer.move_new(backup, target).is_ok() {
            return Err(WriteFailure::Failed { code });
        }
        if holds != BackupHolds::Nothing {
            return Err(WriteFailure::RecoveryNeeded {
                original_at: backup.to_path_buf(),
            });
        }
    }
    Err(give_up(stopped_by(code, target), target, backup, marker))
}

fn move_to_new(
    target: &Path,
    temp: &Path,
    replacer: &dyn Replacer,
) -> Result<Written, WriteFailure> {
    match replacer.move_new(temp, target) {
        Ok(()) => Ok(Written { backup_left: None }),
        Err(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) => Err(WriteFailure::TargetAppeared),
        Err(code) => Err(WriteFailure::Failed { code }),
    }
}

fn failure_from(error: &std::io::Error) -> WriteFailure {
    let code = os_code(error);
    if is_lock(code) {
        WriteFailure::Locked { code }
    } else {
        WriteFailure::Failed { code }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backup_name_that_cannot_be_inspected_is_unknown() {
        let unreadable_name = Path::new("name\0with-nul");
        assert!(fs::metadata(unreadable_name).is_err());
        assert_eq!(inspect_backup(unreadable_name, b"marker"), BackupHolds::Unknown);
    }

    #[test]
    fn a_backup_name_that_is_gone_holds_nothing() {
        let gone = std::env::temp_dir().join(format!("{NAME_PREFIX}{:016x}", random_number()));
        assert_eq!(inspect_backup(&gone, b"marker"), BackupHolds::Nothing);
    }
}
