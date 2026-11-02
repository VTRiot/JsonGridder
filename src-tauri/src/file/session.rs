//! 開いている文書の基準と、開く、保存、別名保存の入口。
//!
//! 基準のバイト列はここに置き、画面は `revision` で指す。100 MB の複製を画面との間で
//! 往復させないためである。基準は保存の成功のときだけ、一度に入れ替える。

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::allow::{GrantedPath, PathDenied, PathGrants};
use super::decode::{Encoding, decode_strict};
use super::encode::{Unrepresentable, encode};
use super::format::{TextFormat, detect_format};
use super::open::{Accept, ReadOutcome, RefuseReason, SizeClass, read_document};
use super::replace::Replacer;
use super::save::{WriteFailure, Written, write_atomically};
use super::scan::{ScanResult, scan};
use super::{Sha256Digest, os_code, sha256, to_hex};

/// 文書が無いときの `revision`。
pub const NO_DOCUMENT: u64 = 0;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
struct Session {
    path: GrantedPath,
    bytes: Vec<u8>,
    sha256: Sha256Digest,
    text_sha256: Sha256Digest,
    text_empty: bool,
    encoding: Encoding,
    bom: bool,
    round_trip_ok: bool,
    revision: u64,
}

#[derive(Default)]
struct Slots {
    current: Option<Session>,
    /// 読み終えたが、画面がまだ受け取っていない文書。
    pending: Option<Session>,
}

pub struct FileState {
    pub grants: PathGrants,
    slots: Mutex<Slots>,
    revisions: AtomicU64,
}

impl Default for FileState {
    fn default() -> Self {
        Self {
            grants: PathGrants::default(),
            slots: Mutex::default(),
            revisions: AtomicU64::new(NO_DOCUMENT + 1),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum OpenReply {
    Opened {
        revision: u64,
        path: String,
        sha256: String,
        encoding: Encoding,
        bom: bool,
        format: TextFormat,
        scan: ScanResult,
        text_only: bool,
        size_class: SizeClass,
        round_trip_ok: bool,
    },
    NeedsSizeConfirm {
        size: u64,
    },
    NeedsEncodingConfirm {
        encoding: Encoding,
    },
    Refused {
        reason: RefuseReason,
        scan: Option<ScanResult>,
    },
    Denied {
        reason: PathDenied,
    },
    Missing,
    Locked {
        code: u32,
    },
    Failed {
        code: u32,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Confirmations {
    pub blank: bool,
    pub unparsable: bool,
    pub round_trip: bool,
    pub overwrite_external: bool,
    pub recreate_missing: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveRequest {
    pub revision: u64,
    /// 別名で保存するときの保存先。無ければ開いているパスへ書く。
    pub path: Option<String>,
    /// 開いたときと別の文字コードで書く。表せない文字を UTF-8 で逃がすときに使う。BOM は付けない。
    pub encoding: Option<Encoding>,
    pub confirm: Confirmations,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfirmReason {
    Blank,
    Unparsable,
    RoundTrip,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SaveReply {
    Saved {
        revision: u64,
        path: String,
        sha256: String,
        backup_left: Option<String>,
        /// 書いたテキストの書式。基準のバイト列を書いたときは無い。
        format: Option<TextFormat>,
    },
    Unchanged,
    NeedsConfirm {
        reasons: Vec<ConfirmReason>,
    },
    ExternalChange,
    Missing,
    Unrepresentable {
        code_point: u32,
        offset: usize,
    },
    StaleRevision,
    NoDocument,
    Denied {
        reason: PathDenied,
    },
    ReadOnly,
    /// ファイルの権限が書き込みを許さない。読み取り専用と同じく、別名保存へ導ける。
    WriteDenied,
    Locked {
        code: u32,
    },
    FolderDenied {
        code: u32,
    },
    TargetAppeared,
    VerifyFailed,
    Failed {
        code: u32,
    },
    RecoveryNeeded {
        original_at: String,
    },
    /// `reason` で止まり、退避名を消せなかった。元の名前の文書には触っていない。
    BackupLeft {
        reason: Box<SaveReply>,
        backup_left: String,
    },
}

impl FileState {
    fn lock(&self) -> MutexGuard<'_, Slots> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn next_revision(&self) -> u64 {
        self.revisions.fetch_add(1, Ordering::Relaxed)
    }

    /// 読み込む。文書は控えに置き、`commit_open` まで基準を変えない。
    /// 画面は読み込みの後に開くのをやめることがある。
    pub fn open(&self, path: &str, accept: &Accept) -> (OpenReply, Vec<u8>) {
        let path = match self.grants.check(Path::new(path)) {
            Ok(path) => path,
            Err(reason) => return (OpenReply::Denied { reason }, Vec::new()),
        };
        let opened = match read_document(&path, accept) {
            ReadOutcome::Opened(opened) => opened,
            ReadOutcome::NeedsSizeConfirm { size } => {
                return (OpenReply::NeedsSizeConfirm { size }, Vec::new());
            }
            ReadOutcome::NeedsEncodingConfirm { encoding } => {
                return (OpenReply::NeedsEncodingConfirm { encoding }, Vec::new());
            }
            ReadOutcome::Refused { reason, scan } => {
                return (OpenReply::Refused { reason, scan }, Vec::new());
            }
            ReadOutcome::Missing => return (OpenReply::Missing, Vec::new()),
            ReadOutcome::Locked { code } => return (OpenReply::Locked { code }, Vec::new()),
            ReadOutcome::Failed { code } => return (OpenReply::Failed { code }, Vec::new()),
        };

        let opened = *opened;
        let revision = self.next_revision();
        let reply = OpenReply::Opened {
            revision,
            path: path.display().to_owned(),
            sha256: to_hex(&opened.sha256),
            encoding: opened.encoding,
            bom: opened.bom,
            format: opened.format,
            scan: opened.scan,
            text_only: opened.scan.text_only(),
            size_class: opened.size_class,
            round_trip_ok: opened.round_trip_ok,
        };
        self.lock().pending = Some(Session {
            text_sha256: sha256(opened.text.as_bytes()),
            text_empty: opened.text.is_empty(),
            path,
            bytes: opened.bytes,
            sha256: opened.sha256,
            encoding: opened.encoding,
            bom: opened.bom,
            round_trip_ok: opened.round_trip_ok,
            revision,
        });
        (reply, opened.text.into_bytes())
    }

    /// 画面が文書を受け取った合図。控えを基準にする。`revision` が違えば何もしない。
    #[cfg(test)]
    pub fn commit_open(&self, revision: u64) -> bool {
        self.commit_open_path(revision).is_some()
    }

    /// 受け取った文書の、画面に出す形のパスを返す。受け取らなければ `None`。
    pub fn commit_open_path(&self, revision: u64) -> Option<String> {
        let mut slots = self.lock();
        if slots.pending.as_ref().is_none_or(|pending| pending.revision != revision) {
            return None;
        }
        slots.current = slots.pending.take();
        slots.current.as_ref().map(|current| current.path.display().to_owned())
    }

    pub fn save(&self, request: &SaveRequest, text: &str, replacer: &dyn Replacer) -> SaveReply {
        let mut slots = self.lock();
        let renamed = match request.path.as_deref().map(|path| self.grants.check(Path::new(path))) {
            Some(Ok(path)) => Some(path),
            Some(Err(reason)) => return SaveReply::Denied { reason },
            None => None,
        };
        let current = slots.current.as_ref();
        if request.revision != current.map_or(NO_DOCUMENT, |session| session.revision) {
            return SaveReply::StaleRevision;
        }
        let Some(target) = renamed.or_else(|| current.map(|session| session.path.clone())) else {
            return SaveReply::NoDocument;
        };
        let same_file = current.is_some_and(|session| session.path.is_same_file(&target));
        let (encoding, bom) = current.map_or((Encoding::Utf8, false), |session| {
            (session.encoding, session.bom)
        });
        let converting = request.encoding.is_some_and(|wanted| wanted != encoding);
        let (encoding, bom) = match request.encoding {
            Some(wanted) if converting => (wanted, false),
            _ => (encoding, bom),
        };

        let text_digest = sha256(text.as_bytes());
        if !converting && current.is_some_and(|session| session.text_sha256 == text_digest) {
            // 内容が基準と同じ。開いているパスならディスクを見て、別名なら基準のバイト列を書く
            if same_file {
                return self.keep_baseline_on_disk(&mut slots, request.confirm, replacer);
            }
            return self.write_baseline(&mut slots, &target, &|| Ok(()), replacer);
        }

        let reasons = confirmation_reasons(current, text, request.confirm, converting);
        if !reasons.is_empty() {
            return SaveReply::NeedsConfirm { reasons };
        }
        let bytes = match encode(text, encoding, bom) {
            Ok(bytes) => bytes,
            Err(Unrepresentable { code_point, offset }) => {
                return SaveReply::Unrepresentable { code_point, offset };
            }
        };
        let expected = current.filter(|_| same_file).map(|session| session.sha256);
        let verify = |written: &[u8]| decode_strict(written, encoding, bom).as_deref() == Some(text);
        let before_publish = || match &expected {
            Some(expected) => check_unchanged_on_disk(&target, expected, request.confirm),
            None => Ok(()),
        };
        match write_atomically(target.real(), &bytes, &verify, &before_publish, replacer) {
            Ok(written) => {
                let revision = self.next_revision();
                let sha256 = sha256(&bytes);
                let reply = saved(revision, &target, &sha256, written, Some(detect_format(text)));
                slots.current = Some(Session {
                    path: target,
                    bytes,
                    sha256,
                    text_sha256: text_digest,
                    text_empty: text.is_empty(),
                    encoding,
                    bom,
                    // 書いた直後に読み直して一致を確かめたので、もう往復できる
                    round_trip_ok: true,
                    revision,
                });
                reply
            }
            Err(failure) => failure_reply(failure),
        }
    }

    /// 未編集の文書を保存する。別のパスへは基準のバイト列をそのまま書き、元のファイルには触らない。
    /// `path` が無いか開いているパスと同じなら [`Self::keep_baseline_on_disk`] へ。
    pub fn save_baseline_as(&self, request: &SaveRequest, replacer: &dyn Replacer) -> SaveReply {
        let mut slots = self.lock();
        let target = match request.path.as_deref().map(|path| self.grants.check(Path::new(path))) {
            Some(Ok(path)) => Some(path),
            Some(Err(reason)) => return SaveReply::Denied { reason },
            None => None,
        };
        let Some(current) = slots.current.as_ref() else {
            return SaveReply::NoDocument;
        };
        if current.revision != request.revision {
            return SaveReply::StaleRevision;
        }
        match target {
            Some(target) if !current.path.is_same_file(&target) => {
                self.write_baseline(&mut slots, &target, &|| Ok(()), replacer)
            }
            _ => self.keep_baseline_on_disk(&mut slots, request.confirm, replacer),
        }
    }

    /// 開いているパスへ基準を保つ。ディスクが基準と同じなら 1 バイトも書かない。消えたか外部で
    /// 変わったなら、編集済みの保存と同じ確認へ回す。認められたら基準のバイト列を書く。
    fn keep_baseline_on_disk(
        &self,
        slots: &mut Slots,
        confirm: Confirmations,
        replacer: &dyn Replacer,
    ) -> SaveReply {
        let Some(current) = slots.current.as_ref() else {
            return SaveReply::NoDocument;
        };
        let target = current.path.clone();
        let expected = current.sha256;
        if check_unchanged_on_disk(&target, &expected, Confirmations::default()).is_ok() {
            return SaveReply::Unchanged;
        }
        let before_publish = || check_unchanged_on_disk(&target, &expected, confirm);
        self.write_baseline(slots, &target, &before_publish, replacer)
    }

    fn write_baseline(
        &self,
        slots: &mut Slots,
        target: &GrantedPath,
        before_publish: &dyn Fn() -> Result<(), WriteFailure>,
        replacer: &dyn Replacer,
    ) -> SaveReply {
        let Some(session) = slots.current.as_mut() else {
            return SaveReply::NoDocument;
        };
        match write_atomically(target.real(), &session.bytes, &|_| true, before_publish, replacer) {
            Ok(written) => {
                session.path = target.clone();
                session.revision = self.next_revision();
                saved(session.revision, target, &session.sha256, written, None)
            }
            Err(failure) => failure_reply(failure),
        }
    }
}

fn confirmation_reasons(
    current: Option<&Session>,
    text: &str,
    confirm: Confirmations,
    converting: bool,
) -> Vec<ConfirmReason> {
    let mut reasons = Vec::new();
    let baseline_empty = current.is_none_or(|session| session.text_empty);
    if text.trim().is_empty() && !baseline_empty && !confirm.blank {
        reasons.push(ConfirmReason::Blank);
    }
    if !scan(text.as_bytes()).syntax_ok && !confirm.unparsable {
        reasons.push(ConfirmReason::Unparsable);
    }
    if !converting && current.is_some_and(|session| !session.round_trip_ok) && !confirm.round_trip {
        reasons.push(ConfirmReason::RoundTrip);
    }
    reasons
}

/// 置き換えの直前に元のファイルを読み、基準と比べる。mtime だけでは同じ時刻の書き換えを見逃す。
/// 他のアプリを止めないのでロックは取らない。ここから置き換えまでの短い窓は残る。
fn check_unchanged_on_disk(
    target: &GrantedPath,
    expected: &Sha256Digest,
    confirm: Confirmations,
) -> Result<(), WriteFailure> {
    match hash_file(target.real()) {
        Ok(actual) if actual == *expected => Ok(()),
        Ok(_) if confirm.overwrite_external => Ok(()),
        Ok(_) => Err(WriteFailure::ExternalChange),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if confirm.recreate_missing {
                Ok(())
            } else {
                Err(WriteFailure::Missing)
            }
        }
        Err(error) => Err(WriteFailure::Locked {
            code: os_code(&error),
        }),
    }
}

fn hash_file(path: &Path) -> std::io::Result<Sha256Digest> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; HASH_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&buffer[..read]);
    }
}

fn saved(
    revision: u64,
    target: &GrantedPath,
    digest: &Sha256Digest,
    written: Written,
    format: Option<TextFormat>,
) -> SaveReply {
    SaveReply::Saved {
        revision,
        path: target.display().to_owned(),
        sha256: to_hex(digest),
        backup_left: left_behind(written.backup_left),
        format,
    }
}

/// 既に消えた退避名は報告しない。利用者が探しても見つからないためである（B30）。
fn left_behind(backup: Option<PathBuf>) -> Option<String> {
    backup
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

fn failure_reply(failure: WriteFailure) -> SaveReply {
    match failure {
        WriteFailure::ReadOnly => SaveReply::ReadOnly,
        WriteFailure::WriteDenied => SaveReply::WriteDenied,
        WriteFailure::Locked { code } => SaveReply::Locked { code },
        WriteFailure::FolderDenied { code } => SaveReply::FolderDenied { code },
        WriteFailure::TargetAppeared => SaveReply::TargetAppeared,
        WriteFailure::VerifyFailed => SaveReply::VerifyFailed,
        WriteFailure::ExternalChange => SaveReply::ExternalChange,
        WriteFailure::Missing => SaveReply::Missing,
        WriteFailure::Failed { code } => SaveReply::Failed { code },
        WriteFailure::RecoveryNeeded { original_at } => SaveReply::RecoveryNeeded {
            original_at: original_at.to_string_lossy().into_owned(),
        },
        WriteFailure::BackupLeft { failure, backup } => SaveReply::BackupLeft {
            reason: Box::new(failure_reply(*failure)),
            backup_left: backup.to_string_lossy().into_owned(),
        },
    }
}

#[cfg(test)]
mod left_behind_tests {
    use super::*;

    #[test]
    fn a_backup_that_is_gone_is_not_reported() {
        let gone = std::env::temp_dir().join("jgv-no-such-backup-name");
        assert_eq!(left_behind(Some(gone)), None);
    }

    #[test]
    fn a_backup_that_exists_is_reported() {
        let there = std::env::temp_dir();
        assert_eq!(
            left_behind(Some(there.clone())),
            Some(there.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn no_backup_reports_nothing() {
        assert_eq!(left_behind(None), None);
    }
}
