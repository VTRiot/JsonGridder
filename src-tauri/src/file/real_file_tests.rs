//! 実ファイルの試験。OS の置き換えの挙動そのものを確かめる。

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::fs::{FileTimesExt, MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::Value;

use super::allow::{GrantedPath, PathDenied};
use super::decode::Encoding;
use super::format::Indent;
use super::open::{self, Accept, ReadOutcome, RefuseReason, SizeClass};
use super::save::{WriteFailure, write_atomically};
use super::replace::{
    ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, Replacer,
    SystemReplacer, open_for_write_check,
};
use super::session::{ConfirmReason, Confirmations, FileState, OpenReply, SaveReply, SaveRequest};
use super::{sha256, to_hex};

const CORPUS: &str = include_str!("../../../tests/fixtures/encoding-corpus.json");
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const SHARE_NONE: u32 = 0;
const SHARE_READ: u32 = 1;
const SHARE_READ_WRITE: u32 = 3;
const MEBIBYTE: u64 = 1024 * 1024;
const OLD_TIME_SECONDS: u64 = 1_500_000_000;
const ERROR_UNABLE_TO_REMOVE_REPLACED: u32 = 1175;
const ERROR_UNABLE_TO_MOVE_REPLACEMENT: u32 = 1176;

static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);

struct Workspace {
    dir: PathBuf,
    state: FileState,
}

impl Workspace {
    fn new() -> Self {
        let mut dir = std::env::temp_dir();
        // 並列の試験は同じ時刻を引く。番号で分け、create_dir で共有を落とす
        let unique = format!(
            "jgv-test-{}-{:x}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed)
        );
        dir.push(unique);
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        Self {
            dir,
            state: FileState::default(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        // 拡張長の接頭辞を外し、利用者のパスと同じ形で渡す
        let text = self.dir.join(name).to_string_lossy().into_owned();
        PathBuf::from(text.trim_start_matches(r"\\?\"))
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn grant(&self, path: &Path) {
        self.state.grants.grant(path).unwrap();
    }

    /// 許可を与えて開き、基準にする。`revision` を返す。
    fn open(&self, path: &Path) -> u64 {
        self.grant(path);
        self.open_accepted(path, &accept_all(path))
    }

    fn open_accepted(&self, path: &Path, accept: &Accept) -> u64 {
        let (reply, _) = self.state.open(path.to_str().unwrap(), accept);
        let OpenReply::Opened { revision, .. } = reply else {
            panic!("not opened: {reply:?}");
        };
        assert!(self.state.commit_open(revision));
        revision
    }

    fn names(&self) -> BTreeSet<String> {
        fs::read_dir(&self.dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn expect_names(&self, expected: &[&str]) {
        let expected: BTreeSet<String> = expected.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(self.names(), expected, "files in the folder");
    }

    fn save(&self, revision: u64, text: &str) -> SaveReply {
        self.save_with(revision, text, Confirmations::default())
    }

    fn save_baseline(&self, revision: u64, path: Option<&Path>, confirm: Confirmations) -> SaveReply {
        let request = SaveRequest {
            revision,
            path: path.map(|path| path.to_str().unwrap().to_owned()),
            confirm,
            ..SaveRequest::default()
        };
        self.state.save_baseline_as(&request, &SystemReplacer)
    }

    fn save_with(&self, revision: u64, text: &str, confirm: Confirmations) -> SaveReply {
        let request = SaveRequest {
            revision,
            confirm,
            ..SaveRequest::default()
        };
        self.state.save(&request, text, &SystemReplacer)
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = Command::new("icacls")
            .arg(&self.dir)
            .args(["/reset", "/T", "/Q"])
            .output();
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let mut permissions = entry.metadata().map(|m| m.permissions()).ok();
                if let Some(permissions) = permissions.as_mut() {
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(entry.path(), permissions.clone());
                }
            }
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// 確認の要る文書もそのまま開く。
fn accept_all(path: &Path) -> Accept {
    let bytes = fs::read(path).unwrap_or_default();
    let encoding = match super::decode::detect(&bytes) {
        super::decode::Detection::Probable { encoding, .. } => Some(encoding),
        _ => None,
    };
    Accept {
        size: true,
        encoding,
    }
}

fn digest_of(path: &Path) -> String {
    to_hex(&sha256(&fs::read(path).unwrap()))
}

fn revision_of(reply: &SaveReply) -> u64 {
    match reply {
        SaveReply::Saved { revision, .. } => *revision,
        other => panic!("not saved: {other:?}"),
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|index| u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap())
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    encoding: Encoding,
    bom: bool,
    eol: String,
    indent: Value,
    final_newline: bool,
    round_trip_ok: bool,
    probable: bool,
}

#[derive(Deserialize)]
struct CorpusRow {
    name: String,
    hex: String,
    expected: Expected,
}

fn corpus() -> Vec<CorpusRow> {
    serde_json::from_str(CORPUS).unwrap()
}

// ---- 未編集は書かない ----

#[test]
fn every_corpus_file_opens_with_the_recorded_format() {
    for row in corpus() {
        let space = Workspace::new();
        let path = space.write("doc.json", &unhex(&row.hex));
        space.grant(&path);
        if row.expected.probable {
            let (reply, _) = space.state.open(path.to_str().unwrap(), &Accept::default());
            assert!(
                matches!(reply, OpenReply::NeedsEncodingConfirm { encoding } if encoding == row.expected.encoding),
                "{}: {reply:?}",
                row.name
            );
        }
        let (reply, text) = space.state.open(path.to_str().unwrap(), &accept_all(&path));
        let OpenReply::Opened {
            encoding,
            bom,
            format,
            round_trip_ok,
            ..
        } = reply
        else {
            panic!("{}: {reply:?}", row.name);
        };
        let format = serde_json::to_value(format).unwrap();
        assert_eq!(encoding, row.expected.encoding, "{}", row.name);
        assert_eq!(bom, row.expected.bom, "{}", row.name);
        assert_eq!(format["eol"], row.expected.eol.as_str(), "{}", row.name);
        assert_eq!(format["indent"], row.expected.indent, "{}", row.name);
        assert_eq!(format["finalNewline"], row.expected.final_newline, "{}", row.name);
        assert_eq!(round_trip_ok, row.expected.round_trip_ok, "{}", row.name);
        assert!(std::str::from_utf8(&text).is_ok(), "{}", row.name);
    }
}

#[test]
fn saving_the_opened_text_writes_nothing() {
    for row in corpus() {
        let space = Workspace::new();
        let path = space.write("doc.json", &unhex(&row.hex));
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(OLD_TIME_SECONDS);
        File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        let digest = digest_of(&path);

        space.grant(&path);
        let (reply, text) = space.state.open(path.to_str().unwrap(), &accept_all(&path));
        let OpenReply::Opened { revision, .. } = reply else {
            panic!("{}: {reply:?}", row.name);
        };
        assert!(space.state.commit_open(revision));
        let text = String::from_utf8(text).unwrap();
        assert_eq!(space.save(revision, &text), SaveReply::Unchanged, "{}", row.name);

        assert_eq!(digest_of(&path), digest, "{}", row.name);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before, "{}", row.name);
        space.expect_names(&["doc.json"]);
    }
}

#[test]
fn saving_the_baseline_as_writes_the_original_bytes_to_new_and_existing_paths() {
    for row in corpus() {
        let original = unhex(&row.hex);
        let space = Workspace::new();
        let path = space.write("doc.json", &original);
        let new_path = space.path("new.json");
        let existing = space.write("existing.json", b"other");
        let revision = space.open(&path);
        space.grant(&new_path);
        space.grant(&existing);

        let reply = space.save_baseline(revision, Some(&new_path), Confirmations::default());
        let revision = revision_of(&reply);
        assert_eq!(fs::read(&new_path).unwrap(), original, "{}", row.name);

        let reply = space.save_baseline(revision, Some(&existing), Confirmations::default());
        revision_of(&reply);
        assert_eq!(fs::read(&existing).unwrap(), original, "{}", row.name);

        assert_eq!(fs::read(&path).unwrap(), original, "{}", row.name);
        space.expect_names(&["doc.json", "existing.json", "new.json"]);
    }
}

#[test]
fn saving_the_baseline_over_its_own_path_writes_nothing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let reply = space.save_baseline(revision, Some(&path), Confirmations::default());
    assert_eq!(reply, SaveReply::Unchanged);
}

#[test]
fn an_unedited_save_writes_nothing_while_the_disk_matches() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(space.save_baseline(revision, None, Confirmations::default()), SaveReply::Unchanged);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    space.expect_names(&["doc.json"]);
}

#[test]
fn an_unedited_save_of_a_vanished_file_reports_it_and_recreates_on_request() {
    for same_path in [false, true] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);
        fs::remove_file(&path).unwrap();
        space.grant(&path);
        let chosen = same_path.then_some(path.as_path());

        assert_eq!(space.save_baseline(revision, chosen, Confirmations::default()), SaveReply::Missing);
        assert!(!path.exists());

        let confirm = Confirmations { recreate_missing: true, ..Confirmations::default() };
        revision_of(&space.save_baseline(revision, chosen, confirm));
        assert_eq!(fs::read(&path).unwrap(), b"[1]");
    }
}

#[test]
fn an_unedited_save_over_an_external_change_reports_it_and_overwrites_on_request() {
    for same_path in [false, true] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);
        fs::write(&path, b"[2]").unwrap();
        space.grant(&path);
        let chosen = same_path.then_some(path.as_path());

        assert_eq!(space.save_baseline(revision, chosen, Confirmations::default()), SaveReply::ExternalChange);
        assert_eq!(fs::read(&path).unwrap(), b"[2]");

        let confirm = Confirmations { overwrite_external: true, ..Confirmations::default() };
        revision_of(&space.save_baseline(revision, chosen, confirm));
        assert_eq!(fs::read(&path).unwrap(), b"[1]");
    }
}

#[test]
fn the_same_text_over_a_vanished_file_is_not_reported_as_unchanged() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    fs::remove_file(&path).unwrap();
    assert_eq!(space.save(revision, "[1]"), SaveReply::Missing);
}

#[test]
fn a_saved_reply_carries_the_format_of_the_text_it_wrote() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"{\"a\":1}");
    let revision = space.open(&path);
    let SaveReply::Saved { format: Some(format), .. } = space.save(revision, "{\n  \"a\": 1\n}\n") else {
        panic!("not saved with a format");
    };
    assert_eq!(format.indent, Indent::Spaces { count: 2 });
    assert!(format.final_newline);
}

// ---- 書式 ----

#[test]
fn an_edit_keeps_the_encoding_and_the_bom() {
    let cases: [(&[u8], &str, &[u8]); 5] = [
        (b"\xEF\xBB\xBF[1]", "[2]", b"\xEF\xBB\xBF[2]"),
        (b"\xFF\xFE[\x00]\x00", "[1]", b"\xFF\xFE[\x001\x00]\x00"),
        (b"\xFE\xFF\x00[\x00]", "[1]", b"\xFE\xFF\x00[\x001\x00]"),
        (b"[\x00]\x00", "[1]", b"[\x001\x00]\x00"),
        (b"[\"\x95\x5C\"]", "[\"\x7F\"]", b"[\"\x7F\"]"),
    ];
    for (before, text, after) in cases {
        let space = Workspace::new();
        let path = space.write("doc.json", before);
        let revision = space.open(&path);
        revision_of(&space.save(revision, text));
        assert_eq!(fs::read(&path).unwrap(), after);
        space.expect_names(&["doc.json"]);
    }
}

// ---- 文字コード ----

#[test]
fn undecodable_bytes_never_open_with_replacement_characters() {
    let cases: [(&str, &[u8]); 6] = [
        ("broken utf-8", b"[\"\xFF\xFE\xFD\"]"),
        ("broken utf-8 after a bom", b"\xEF\xBB\xBF[\"\xC3\"]"),
        ("shift_jis", b"[\"\x95\x5C\"]"),
        ("bomless utf-16", b"[\x001\x00]\x00"),
        ("odd utf-16", b"[\x001\x00]"),
        ("utf-32", b"\xFF\xFE\x00\x00[\x00\x00\x00"),
    ];
    for (name, bytes) in cases {
        let space = Workspace::new();
        let path = space.write("doc.json", bytes);
        space.grant(&path);
        let (reply, text) = space.state.open(path.to_str().unwrap(), &Accept::default());
        assert!(
            matches!(
                reply,
                OpenReply::Refused { .. } | OpenReply::NeedsEncodingConfirm { .. }
            ),
            "{name}: {reply:?}"
        );
        assert!(text.is_empty(), "{name}");
    }
}

#[test]
fn a_probable_encoding_does_not_open_when_the_text_is_not_json() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"\x95\x5C \x95\x5C");
    space.grant(&path);
    let accept = Accept {
        size: false,
        encoding: Some(Encoding::ShiftJis),
    };
    let (reply, _) = space.state.open(path.to_str().unwrap(), &accept);
    assert!(
        matches!(
            reply,
            OpenReply::Refused {
                reason: RefuseReason::Undecodable,
                ..
            }
        ),
        "{reply:?}"
    );
}

#[test]
fn accepted_shift_jis_opens_without_replacement_characters() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[\"\x95\x5C\"]");
    space.grant(&path);
    let accept = Accept {
        size: false,
        encoding: Some(Encoding::ShiftJis),
    };
    let (reply, text) = space.state.open(path.to_str().unwrap(), &accept);
    assert!(matches!(reply, OpenReply::Opened { .. }), "{reply:?}");
    let text = String::from_utf8(text).unwrap();
    assert_eq!(text, "[\"表\"]");
    assert!(!text.contains('\u{FFFD}'));
}

// ---- 途中の失敗 ----

/// 隣の既定の名前のファイルが、どの結果の後も変わらないことを一緒に確かめる。
fn with_neighbor(check: impl FnOnce(&Workspace, &Path, u64)) {
    let space = Workspace::new();
    let path = space.write("name.json", b"[1]");
    let neighbor = space.write("name.json.bak", b"precious");
    let neighbor_digest = digest_of(&neighbor);
    let revision = space.open(&path);
    check(&space, &path, revision);
    assert_eq!(digest_of(&neighbor), neighbor_digest);
}

#[test]
fn a_successful_save_leaves_the_neighboring_backup_and_no_temporary_files() {
    with_neighbor(|space, path, revision| {
        revision_of(&space.save(revision, "[2]"));
        assert_eq!(fs::read(path).unwrap(), b"[2]");
        space.expect_names(&["name.json", "name.json.bak"]);
    });
}

#[test]
fn a_read_only_file_stops_the_save() {
    with_neighbor(|space, path, revision| {
        let digest = digest_of(path);
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();

        assert_eq!(space.save(revision, "[2]"), SaveReply::ReadOnly);

        assert_eq!(digest_of(path), digest);
        space.expect_names(&["name.json", "name.json.bak"]);
    });
}

#[test]
fn a_locked_file_stops_the_save() {
    for share in [SHARE_NONE, SHARE_READ, SHARE_READ_WRITE] {
        with_neighbor(|space, path, revision| {
            let digest = digest_of(path);
            let lock = OpenOptions::new().read(true).share_mode(share).open(path).unwrap();

            let reply = space.save(revision, "[2]");
            assert!(
                matches!(
                    reply,
                    SaveReply::Locked {
                        code: ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION
                    }
                ),
                "share {share}: {reply:?}"
            );

            drop(lock);
            assert_eq!(digest_of(path), digest);
            space.expect_names(&["name.json", "name.json.bak"]);
        });
    }
}

#[test]
fn a_folder_that_refuses_writes_stops_the_save_without_touching_the_file() {
    with_neighbor(|space, path, revision| {
        let digest = digest_of(path);
        let denied = Command::new("icacls")
            .arg(&space.dir)
            .args(["/deny", "*S-1-1-0:(WD,AD)"])
            .output()
            .unwrap();
        assert!(denied.status.success());

        let reply = space.save(revision, "[2]");
        let reset = Command::new("icacls").arg(&space.dir).args(["/reset"]).output().unwrap();
        assert!(reset.status.success());

        assert!(matches!(reply, SaveReply::FolderDenied { .. }), "{reply:?}");
        assert_eq!(digest_of(path), digest);
        space.expect_names(&["name.json", "name.json.bak"]);
    });
}

/// 書き込みを許さないファイルの権限の 3 種。`ReplaceFileW` はこれらを越えて置き換える。
const WRITE_REFUSING_ACLS: [&[&str]; 3] = [
    &["/deny", "*S-1-1-0:(WD)"],
    &["/deny", "*S-1-1-0:(W)"],
    &["/inheritance:r", "/grant:r", "*S-1-1-0:(R)"],
];
/// 中身の書き換えを止めない拒否。追記、属性、拡張属性。
const CONTENT_NEUTRAL_RIGHTS: [&str; 3] = ["AD", "WA", "WEA"];

fn apply_acl(path: &Path, arguments: &[&str]) {
    let applied = Command::new("icacls").arg(path).args(arguments).output().unwrap();
    assert!(applied.status.success(), "{arguments:?}");
}

/// `(W)` の拒否は開く処理に要る同期の権利も含むので、拒否のままでは読み直せない。
fn lift_deny(path: &Path) {
    apply_acl(path, &["/remove:d", "*S-1-1-0"]);
}

#[test]
fn the_write_check_does_not_shut_out_other_programs() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let other = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(SHARE_READ_WRITE)
        .open(&path)
        .unwrap();

    open_for_write_check(&path).unwrap();

    drop(other);
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
}

#[test]
fn a_file_that_refuses_writes_stops_the_save() {
    for arguments in WRITE_REFUSING_ACLS {
        with_neighbor(|space, path, revision| {
            let digest = digest_of(path);
            let acl_before = acl_of(path);
            apply_acl(path, arguments);
            let acl = acl_of(path);
            assert_ne!(acl, acl_before);

            let reply = space.save(revision, "[2]");

            assert_eq!(acl_of(path), acl, "{arguments:?}");
            lift_deny(path);
            assert_eq!(reply, SaveReply::WriteDenied, "{arguments:?}");
            assert_eq!(digest_of(path), digest, "{arguments:?}");
            space.expect_names(&["name.json", "name.json.bak"]);
        });
    }
}

#[test]
fn a_refusal_that_leaves_the_contents_writable_does_not_stop_the_save() {
    for right in CONTENT_NEUTRAL_RIGHTS {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);
        apply_acl(&path, &["/deny", &format!("*S-1-1-0:({right})")]);

        let reply = space.save(revision, "[2]");

        lift_deny(&path);
        assert!(matches!(reply, SaveReply::Saved { .. }), "{right}: {reply:?}");
        assert_eq!(fs::read(&path).unwrap(), b"[2]", "{right}");
        space.expect_names(&["doc.json"]);
    }
}

#[test]
fn a_file_that_refuses_writes_stops_the_baseline_copy_over_it() {
    for arguments in WRITE_REFUSING_ACLS {
        with_neighbor(|space, path, revision| {
            let target = space.write("target.json", b"[9]");
            space.grant(&target);
            let digest = digest_of(&target);
            apply_acl(&target, arguments);

            let reply = space.save_baseline(revision, Some(&target), Confirmations::default());

            lift_deny(&target);
            assert_eq!(reply, SaveReply::WriteDenied, "{arguments:?}");
            assert_eq!(digest_of(&target), digest, "{arguments:?}");
            assert_eq!(fs::read(path).unwrap(), b"[1]");
            space.expect_names(&["name.json", "name.json.bak", "target.json"]);
        });
    }
}

#[test]
fn a_file_that_refuses_writes_can_be_saved_under_another_name() {
    with_neighbor(|space, path, revision| {
        let digest = digest_of(path);
        apply_acl(path, WRITE_REFUSING_ACLS[0]);
        let new_path = space.path("new.json");
        space.grant(&new_path);
        let request = SaveRequest {
            revision,
            path: Some(new_path.to_str().unwrap().to_owned()),
            ..SaveRequest::default()
        };

        revision_of(&space.state.save(&request, "[2]", &SystemReplacer));

        assert_eq!(fs::read(&new_path).unwrap(), b"[2]");
        assert_eq!(digest_of(path), digest);
    });
}

/// 公式の文書が書く失敗の状態を作る偽物。1176、1177 は実物で再現できない。
struct FailingReplacer {
    code: u32,
    restore_fails: bool,
}

impl Replacer for FailingReplacer {
    fn replace(&self, target: &Path, _replacement: &Path, backup: &Path) -> Result<(), u32> {
        if self.code == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 {
            fs::rename(target, backup).unwrap();
        }
        Err(self.code)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        if self.restore_fails {
            return Err(ERROR_ACCESS_DENIED);
        }
        fs::rename(from, to).map_err(|error| super::os_code(&error))
    }
}

fn save_through(space: &Workspace, revision: u64, replacer: &dyn Replacer) -> SaveReply {
    let request = SaveRequest {
        revision,
        ..SaveRequest::default()
    };
    space.state.save(&request, "[2]", replacer)
}

#[test]
fn the_replacement_failures_that_keep_both_names_clean_up_and_keep_the_file() {
    for code in [ERROR_UNABLE_TO_REMOVE_REPLACED, ERROR_UNABLE_TO_MOVE_REPLACEMENT] {
        with_neighbor(|space, path, revision| {
            let digest = digest_of(path);
            let replacer = FailingReplacer {
                code,
                restore_fails: false,
            };

            assert_eq!(save_through(space, revision, &replacer), SaveReply::Failed { code });

            assert_eq!(digest_of(path), digest);
            space.expect_names(&["name.json", "name.json.bak"]);
        });
    }
}

#[test]
fn a_failure_that_moved_the_original_away_restores_it() {
    with_neighbor(|space, path, revision| {
        let digest = digest_of(path);
        let replacer = FailingReplacer {
            code: ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
            restore_fails: false,
        };

        assert_eq!(
            save_through(space, revision, &replacer),
            SaveReply::Failed {
                code: ERROR_UNABLE_TO_MOVE_REPLACEMENT_2
            }
        );

        assert_eq!(digest_of(path), digest);
        space.expect_names(&["name.json", "name.json.bak"]);
    });
}

#[test]
fn a_failed_restore_keeps_the_original_and_says_where_it_is() {
    with_neighbor(|space, path, revision| {
        let original = fs::read(path).unwrap();
        let replacer = FailingReplacer {
            code: ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
            restore_fails: true,
        };

        let reply = save_through(space, revision, &replacer);

        let SaveReply::RecoveryNeeded { original_at } = reply else {
            panic!("{reply:?}");
        };
        assert_eq!(fs::read(original_at).unwrap(), original);
        assert!(!path.exists());
    });
}

/// 指定の回数だけ共有違反を返し、その後は本物へ渡す。
struct BrieflyLocked {
    remaining: Cell<u32>,
}

impl Replacer for BrieflyLocked {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        if self.remaining.get() > 0 {
            self.remaining.set(self.remaining.get() - 1);
            return Err(ERROR_SHARING_VIOLATION);
        }
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_brief_lock_is_waited_out() {
    with_neighbor(|space, path, revision| {
        let replacer = BrieflyLocked {
            remaining: Cell::new(2),
        };
        revision_of(&save_through(space, revision, &replacer));
        assert_eq!(fs::read(path).unwrap(), b"[2]");
    });
}

/// 1 回目の置き換えを実物に通し、失敗の直後に外のプログラムの動きを起こす。
struct ActsAfterTheFirstFailure<F> {
    acted: Cell<bool>,
    act: F,
}

impl<F> ActsAfterTheFirstFailure<F> {
    fn new(act: F) -> Self {
        Self {
            acted: Cell::new(false),
            act,
        }
    }
}

impl<F: Fn(&Path)> Replacer for ActsAfterTheFirstFailure<F> {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        let result = SystemReplacer.replace(target, replacement, backup);
        if !self.acted.replace(true) {
            assert!(
                matches!(result, Err(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION)),
                "{result:?}"
            );
            (self.act)(target);
        }
        result
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

/// 保存の前から書き込みで開いている別のプログラム。
fn writer_on(path: &Path) -> RefCell<Option<File>> {
    let file = OpenOptions::new().write(true).share_mode(SHARE_READ).open(path).unwrap();
    RefCell::new(Some(file))
}

#[test]
fn an_outside_write_behind_the_lock_is_not_replaced_on_the_retry() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let writer = writer_on(&path);
    let replacer = ActsAfterTheFirstFailure::new(|_: &Path| {
        let mut file = writer.borrow_mut().take().unwrap();
        file.write_all(b"[7]").unwrap();
    });

    assert_eq!(save_through(&space, revision, &replacer), SaveReply::ExternalChange);

    assert_eq!(fs::read(&path).unwrap(), b"[7]");
    space.expect_names(&["doc.json"]);
}

#[test]
fn a_file_removed_behind_the_lock_is_reported_as_missing_on_the_retry() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let writer = writer_on(&path);
    let replacer = ActsAfterTheFirstFailure::new(|target: &Path| {
        drop(writer.borrow_mut().take());
        fs::remove_file(target).unwrap();
    });

    assert_eq!(save_through(&space, revision, &replacer), SaveReply::Missing);

    space.expect_names(&[]);
}

#[test]
fn a_real_lock_released_without_a_write_is_waited_out() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let writer = writer_on(&path);
    let replacer = ActsAfterTheFirstFailure::new(|_: &Path| drop(writer.borrow_mut().take()));

    revision_of(&save_through(&space, revision, &replacer));

    assert_eq!(fs::read(&path).unwrap(), b"[2]");
    space.expect_names(&["doc.json"]);
}

#[test]
fn a_confirmed_overwrite_still_passes_the_check_on_the_retry() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    fs::write(&path, b"[5]").unwrap();
    let writer = writer_on(&path);
    let replacer = ActsAfterTheFirstFailure::new(|_: &Path| drop(writer.borrow_mut().take()));
    let request = SaveRequest {
        revision,
        confirm: Confirmations {
            overwrite_external: true,
            ..Confirmations::default()
        },
        ..SaveRequest::default()
    };

    revision_of(&space.state.save(&request, "[2]", &replacer));

    assert_eq!(fs::read(&path).unwrap(), b"[2]");
}

#[test]
fn an_exclusive_hold_taken_behind_the_lock_stops_the_retry_without_replacing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let writer = writer_on(&path);
    let exclusive = RefCell::new(None);
    let replacer = ActsAfterTheFirstFailure::new(|target: &Path| {
        drop(writer.borrow_mut().take());
        let file = OpenOptions::new().read(true).share_mode(SHARE_NONE).open(target).unwrap();
        *exclusive.borrow_mut() = Some(file);
    });

    let reply = save_through(&space, revision, &replacer);

    drop(exclusive.borrow_mut().take());
    assert!(matches!(reply, SaveReply::Locked { .. }), "{reply:?}");
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    space.expect_names(&["doc.json"]);
}

/// ロックの失敗の報告の裏で、元が退避名へ動いていた形。
#[derive(Default)]
struct MovedThenDenied {
    moved: Cell<bool>,
}

impl Replacer for MovedThenDenied {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        if self.moved.replace(true) {
            return SystemReplacer.replace(target, replacement, backup);
        }
        fs::rename(target, backup).unwrap();
        Err(ERROR_ACCESS_DENIED)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_lock_failure_that_moved_the_original_keeps_it_and_says_where_it_is() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);

    let reply = save_through(&space, revision, &MovedThenDenied::default());

    let SaveReply::RecoveryNeeded { original_at } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(fs::read(original_at).unwrap(), b"[1]");
    assert!(!path.exists());
}

/// 元が退避名へ動き、元の名前に別の物が現れた後に失敗する形。
struct MovedThenSomethingAppeared;

impl Replacer for MovedThenSomethingAppeared {
    fn replace(&self, target: &Path, _replacement: &Path, backup: &Path) -> Result<(), u32> {
        fs::rename(target, backup).unwrap();
        fs::write(target, b"appeared").unwrap();
        Err(ERROR_UNABLE_TO_REMOVE_REPLACED)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn an_original_on_the_backup_name_is_kept_after_any_failure() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);

    let reply = save_through(&space, revision, &MovedThenSomethingAppeared);

    let SaveReply::RecoveryNeeded { original_at } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(fs::read(original_at).unwrap(), b"[1]");
    assert_eq!(fs::read(&path).unwrap(), b"appeared");
}

#[test]
fn an_empty_original_that_moved_behind_the_lock_is_kept_too() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"");
    let revision = space.open(&path);

    let reply = save_through(&space, revision, &MovedThenDenied::default());

    let SaveReply::RecoveryNeeded { original_at } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(fs::read(original_at).unwrap(), b"");
}

#[test]
fn a_confirmed_recreate_does_not_remove_an_original_that_moved_behind_the_lock() {
    for original in [&b"[1]"[..], &b""[..]] {
        let space = Workspace::new();
        let path = space.write("doc.json", original);
        let revision = space.open(&path);
        let request = SaveRequest {
            revision,
            confirm: Confirmations {
                recreate_missing: true,
                ..Confirmations::default()
            },
            ..SaveRequest::default()
        };

        let reply = space.state.save(&request, "[2]", &MovedThenDenied::default());

        let SaveReply::RecoveryNeeded { original_at } = reply else {
            panic!("{reply:?}");
        };
        assert_eq!(fs::read(original_at).unwrap(), original);
    }
}

fn leftovers(space: &Workspace, extension: &str) -> usize {
    space
        .names()
        .iter()
        .filter(|name| name.starts_with(".jgv-") && name.ends_with(extension))
        .count()
}

/// 退避名を指定の共有で開き、保存が返るまで持ち続ける。
struct HoldsTheBackup {
    share: u32,
    held: RefCell<Option<File>>,
    calls: Cell<u32>,
    /// 置き換えの代わりに、このコードで失敗する。無ければ実物へ渡す。
    fails_with: Option<u32>,
    removes_the_document: bool,
}

impl HoldsTheBackup {
    fn new(share: u32) -> Self {
        Self {
            share,
            held: RefCell::new(None),
            calls: Cell::new(0),
            fails_with: None,
            removes_the_document: false,
        }
    }
}

impl Replacer for HoldsTheBackup {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        self.calls.set(self.calls.get() + 1);
        let file = OpenOptions::new().read(true).share_mode(self.share).open(backup).unwrap();
        *self.held.borrow_mut() = Some(file);
        if self.removes_the_document {
            fs::remove_file(target).unwrap();
        }
        match self.fails_with {
            Some(code) => Err(code),
            None => SystemReplacer.replace(target, replacement, backup),
        }
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn an_unreadable_backup_name_beside_the_document_is_not_called_the_original() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = HoldsTheBackup::new(SHARE_NONE);

    let reply = save_through(&space, revision, &replacer);

    drop(replacer.held.borrow_mut().take());
    let SaveReply::BackupLeft { reason, backup_left } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(
        *reason,
        SaveReply::Failed {
            code: ERROR_UNABLE_TO_REMOVE_REPLACED
        }
    );
    assert_ne!(fs::read(backup_left).unwrap(), b"[1]");
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    assert_eq!(leftovers(&space, ".tmp"), 0);
    assert_eq!(leftovers(&space, ".bak"), 1);
}

#[test]
fn an_unreadable_backup_name_with_no_document_keeps_both_and_asks_for_recovery() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let mut replacer = HoldsTheBackup::new(SHARE_NONE);
    replacer.fails_with = Some(ERROR_UNABLE_TO_REMOVE_REPLACED);
    replacer.removes_the_document = true;

    let reply = save_through(&space, revision, &replacer);

    drop(replacer.held.borrow_mut().take());
    assert!(matches!(reply, SaveReply::RecoveryNeeded { .. }), "{reply:?}");
    assert_eq!(leftovers(&space, ".tmp"), 1);
    assert_eq!(leftovers(&space, ".bak"), 1);
}

#[test]
fn an_unreadable_backup_name_stops_the_retry() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let mut replacer = HoldsTheBackup::new(SHARE_NONE);
    replacer.fails_with = Some(ERROR_SHARING_VIOLATION);

    let reply = save_through(&space, revision, &replacer);

    drop(replacer.held.borrow_mut().take());
    assert_eq!(replacer.calls.get(), 1);
    let SaveReply::BackupLeft { reason, .. } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(
        *reason,
        SaveReply::Locked {
            code: ERROR_SHARING_VIOLATION
        }
    );
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
}

#[test]
fn a_marker_that_cannot_be_removed_is_reported_as_left() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = HoldsTheBackup::new(SHARE_READ);

    let reply = save_through(&space, revision, &replacer);

    drop(replacer.held.borrow_mut().take());
    assert!(matches!(reply, SaveReply::BackupLeft { .. }), "{reply:?}");
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    assert_eq!(leftovers(&space, ".tmp"), 0);
}

/// 退避名の印をフォルダへ替える。
struct FolderOnTheBackup {
    removes_the_document: bool,
}

impl Replacer for FolderOnTheBackup {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        fs::remove_file(backup).unwrap();
        fs::create_dir(backup).unwrap();
        if self.removes_the_document {
            fs::remove_file(target).unwrap();
            return Err(ERROR_UNABLE_TO_REMOVE_REPLACED);
        }
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_folder_on_the_backup_name_is_never_called_the_original() {
    for (removes_the_document, expected) in [
        (
            false,
            SaveReply::Failed {
                code: ERROR_UNABLE_TO_REMOVE_REPLACED,
            },
        ),
        (true, SaveReply::Missing),
    ] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);

        let reply = save_through(&space, revision, &FolderOnTheBackup { removes_the_document });

        let SaveReply::BackupLeft { reason, .. } = reply else {
            panic!("{reply:?}");
        };
        assert_eq!(*reason, expected);
        assert_eq!(leftovers(&space, ".tmp"), 0);
    }
}

/// 1177 の裏で元が退避名へ動き、読めないまま持たれ、元の名前に別の物が現れる。
#[derive(Default)]
struct MovedHeldAndReplacedOn1177 {
    held: RefCell<Option<File>>,
}

impl Replacer for MovedHeldAndReplacedOn1177 {
    fn replace(&self, target: &Path, _replacement: &Path, backup: &Path) -> Result<(), u32> {
        fs::rename(target, backup).unwrap();
        let file = OpenOptions::new().read(true).share_mode(SHARE_NONE).open(backup).unwrap();
        *self.held.borrow_mut() = Some(file);
        fs::write(target, b"appeared").unwrap();
        Err(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_1177_with_an_unreadable_backup_name_asks_for_recovery() {
    // 印と同じ 8 バイトの元。長さでは元と分からず、読むしかない形にする
    let original = b"[123456]";
    let space = Workspace::new();
    let path = space.write("doc.json", original);
    let revision = space.open(&path);
    let replacer = MovedHeldAndReplacedOn1177::default();

    let reply = save_through(&space, revision, &replacer);

    drop(replacer.held.borrow_mut().take());
    let SaveReply::RecoveryNeeded { original_at } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(fs::read(original_at).unwrap(), original);
    assert_eq!(fs::read(&path).unwrap(), b"appeared");
    assert_eq!(leftovers(&space, ".tmp"), 1);
}

/// 元の名前を消してから失敗する。元は退避名へ動いていない。
struct RemovedThenFailed {
    code: u32,
}

impl Replacer for RemovedThenFailed {
    fn replace(&self, target: &Path, _replacement: &Path, _backup: &Path) -> Result<(), u32> {
        fs::remove_file(target).unwrap();
        Err(self.code)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_document_removed_during_a_failed_replace_is_missing_and_the_marker_is_not_restored() {
    for code in [
        ERROR_UNABLE_TO_REMOVE_REPLACED,
        ERROR_UNABLE_TO_MOVE_REPLACEMENT,
        ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
    ] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);

        let reply = save_through(&space, revision, &RemovedThenFailed { code });

        assert_eq!(reply, SaveReply::Missing, "{code}");
        space.expect_names(&[]);
    }
}

#[test]
fn a_1177_that_did_not_move_the_original_changes_nothing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);

    let reply = save_through(
        &space,
        revision,
        &FailingReplacerWithoutMove {
            code: ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
        },
    );

    assert_eq!(
        reply,
        SaveReply::Failed {
            code: ERROR_UNABLE_TO_MOVE_REPLACEMENT_2
        }
    );
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    space.expect_names(&["doc.json"]);
}

/// コードだけを返し、何も動かさない。
struct FailingReplacerWithoutMove {
    code: u32,
}

impl Replacer for FailingReplacerWithoutMove {
    fn replace(&self, _target: &Path, _replacement: &Path, _backup: &Path) -> Result<(), u32> {
        Err(self.code)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

/// ロックの失敗の裏で元が退避名へ動き、元の名前へ別の物が書かれる。2 回目は実物へ渡す。
#[derive(Default)]
struct MovedAndOverwrittenBehindTheLock {
    calls: Cell<u32>,
}

impl Replacer for MovedAndOverwrittenBehindTheLock {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        self.calls.set(self.calls.get() + 1);
        if self.calls.get() > 1 {
            return SystemReplacer.replace(target, replacement, backup);
        }
        fs::rename(target, backup).unwrap();
        fs::write(target, b"[7]").unwrap();
        Err(ERROR_ACCESS_DENIED)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_retry_never_runs_over_an_original_on_the_backup_name() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = MovedAndOverwrittenBehindTheLock::default();
    let request = SaveRequest {
        revision,
        confirm: Confirmations {
            overwrite_external: true,
            ..Confirmations::default()
        },
        ..SaveRequest::default()
    };

    let reply = space.state.save(&request, "[2]", &replacer);

    assert_eq!(replacer.calls.get(), 1);
    let SaveReply::RecoveryNeeded { original_at } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(fs::read(original_at).unwrap(), b"[1]");
    assert_eq!(fs::read(&path).unwrap(), b"[7]");
}

#[test]
fn a_left_backup_name_reaches_the_screen_with_its_reason() {
    let reply = SaveReply::BackupLeft {
        reason: Box::new(SaveReply::Locked {
            code: ERROR_SHARING_VIOLATION,
        }),
        backup_left: "left.bak".to_owned(),
    };

    assert_eq!(
        serde_json::to_value(&reply).unwrap(),
        serde_json::json!({
            "kind": "BackupLeft",
            "reason": { "kind": "Locked", "code": ERROR_SHARING_VIOLATION },
            "backupLeft": "left.bak"
        })
    );
}

/// 読み直しの検証の前に一時ファイルを壊す。
struct CorruptsTemp;

impl Replacer for CorruptsTemp {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }

    fn temp_written(&self, temp: &Path) {
        fs::write(temp, b"[9]").unwrap();
    }
}

#[test]
fn bytes_that_differ_when_read_back_are_not_published() {
    with_neighbor(|space, path, revision| {
        let digest = digest_of(path);
        assert_eq!(save_through(space, revision, &CorruptsTemp), SaveReply::VerifyFailed);
        assert_eq!(digest_of(path), digest);
        space.expect_names(&["name.json", "name.json.bak"]);
    });
}

// ---- 保存で残るもの ----

fn acl_of(path: &Path) -> String {
    let listing = Command::new("icacls").arg(path).output().unwrap();
    assert!(listing.status.success());
    String::from_utf8_lossy(&listing.stdout).into_owned()
}

fn stream_of(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}:meta", path.display()))
}

#[test]
fn a_save_keeps_the_acl_streams_attributes_and_creation_time() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let default_acl = acl_of(&path);
    let granted = Command::new("icacls")
        .arg(&path)
        .args(["/grant", "*S-1-1-0:(R)"])
        .output()
        .unwrap();
    assert!(granted.status.success());
    fs::write(stream_of(&path), b"note").unwrap();
    let created = SystemTime::UNIX_EPOCH + Duration::from_secs(OLD_TIME_SECONDS);
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_created(created))
        .unwrap();
    let hidden = Command::new("attrib").arg("+h").arg(&path).output().unwrap();
    assert!(hidden.status.success());

    let acl = acl_of(&path);
    assert_ne!(acl, default_acl);
    let revision = space.open(&path);
    revision_of(&space.save(revision, "[2]"));

    assert_eq!(fs::read(&path).unwrap(), b"[2]");
    assert_eq!(acl_of(&path), acl);
    assert_eq!(fs::read(stream_of(&path)).unwrap(), b"note");
    let metadata = fs::metadata(&path).unwrap();
    assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN, 0);
    assert_eq!(metadata.created().unwrap(), created);
}

// ---- 外部の変更 ----

#[test]
fn an_outside_write_of_the_same_size_and_time_is_detected() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let revision = space.open(&path);

    let mut outside = OpenOptions::new().write(true).open(&path).unwrap();
    outside.write_all(b"[7]").unwrap();
    outside.set_modified(modified).unwrap();
    drop(outside);

    assert_eq!(space.save(revision, "[2]"), SaveReply::ExternalChange);
    assert_eq!(fs::read(&path).unwrap(), b"[7]");
    // 書き込みで開いて確かめても、ファイルの時刻は動かない
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    space.expect_names(&["doc.json"]);

    let confirm = Confirmations {
        overwrite_external: true,
        ..Confirmations::default()
    };
    revision_of(&space.save_with(revision, "[2]", confirm));
    assert_eq!(fs::read(&path).unwrap(), b"[2]");
}

#[test]
fn a_vanished_file_is_reported_apart_from_a_changed_one() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    fs::remove_file(&path).unwrap();

    assert_eq!(space.save(revision, "[2]"), SaveReply::Missing);
    space.expect_names(&[]);

    let confirm = Confirmations {
        recreate_missing: true,
        ..Confirmations::default()
    };
    revision_of(&space.save_with(revision, "[2]", confirm));
    assert_eq!(fs::read(&path).unwrap(), b"[2]");
    space.expect_names(&["doc.json"]);
}

/// 一時ファイルを書いた直後に、外のプログラムが元のファイルへ触る。
struct OutsideWriteDuringSave {
    target: PathBuf,
    change: Option<&'static [u8]>,
}

impl Replacer for OutsideWriteDuringSave {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }

    fn temp_written(&self, _temp: &Path) {
        match self.change {
            Some(bytes) => fs::write(&self.target, bytes).unwrap(),
            None => fs::remove_file(&self.target).unwrap(),
        }
    }
}

#[test]
fn an_outside_write_during_the_save_is_detected() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = OutsideWriteDuringSave {
        target: path.clone(),
        change: Some(b"[7]"),
    };

    assert_eq!(save_through(&space, revision, &replacer), SaveReply::ExternalChange);

    assert_eq!(fs::read(&path).unwrap(), b"[7]");
    space.expect_names(&["doc.json"]);
}

#[test]
fn a_file_removed_during_the_save_is_reported_as_missing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = OutsideWriteDuringSave {
        target: path.clone(),
        change: None,
    };

    assert_eq!(save_through(&space, revision, &replacer), SaveReply::Missing);

    space.expect_names(&[]);
}

/// 元のファイルを置き換えの直前に消す。確かめの後の窓で消えた場合である。
struct RemovedAtTheReplace;

impl Replacer for RemovedAtTheReplace {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        fs::remove_file(target).unwrap();
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_file_removed_at_the_last_moment_leaves_no_placeholder() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);

    assert_eq!(save_through(&space, revision, &RemovedAtTheReplace), SaveReply::Missing);

    space.expect_names(&[]);
}

// ---- 空への変化、パースが通らない text ----

#[test]
fn a_change_to_blank_text_needs_confirmation() {
    for blank in ["", "  \r\n"] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);

        let reply = space.save(revision, blank);
        let SaveReply::NeedsConfirm { reasons } = reply else {
            panic!("{reply:?}");
        };
        assert!(reasons.contains(&ConfirmReason::Blank));
        assert_eq!(fs::read(&path).unwrap(), b"[1]");

        let confirm = Confirmations {
            blank: true,
            unparsable: true,
            ..Confirmations::default()
        };
        revision_of(&space.save_with(revision, blank, confirm));
        assert_eq!(fs::read(&path).unwrap(), blank.as_bytes());
    }
}

#[test]
fn text_that_does_not_parse_is_written_only_when_confirmed_and_never_repaired() {
    let cases = [
        "{\"a\":1, /* c */ \"b\":2} // tail",
        "{\"a\":1}\r\n{\"a\":2}\r\n",
        "{\"a\":[1,2",
        "{\"a\":\"hello wor",
    ];
    for text in cases {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[1]");
        let revision = space.open(&path);

        assert_eq!(
            space.save(revision, text),
            SaveReply::NeedsConfirm {
                reasons: vec![ConfirmReason::Unparsable]
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"[1]");

        let confirm = Confirmations {
            unparsable: true,
            ..Confirmations::default()
        };
        revision_of(&space.save_with(revision, text, confirm));
        assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
    }
}

// ---- 表せない文字、往復不一致 ----

#[test]
fn a_character_shift_jis_cannot_hold_stops_before_any_file_is_made() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[\"\x95\x5C\"]");
    let digest = digest_of(&path);
    let revision = space.open(&path);

    assert_eq!(
        space.save(revision, "[\"表😀\"]"),
        SaveReply::Unrepresentable {
            code_point: 0x1F600,
            offset: 3
        }
    );

    assert_eq!(digest_of(&path), digest);
    space.expect_names(&["doc.json"]);
}

#[test]
fn a_character_shift_jis_folds_into_another_is_reported_where_it_stands() {
    for (character, code_point) in [("\u{A5}", 0xA5), ("\u{203E}", 0x203E), ("\u{2212}", 0x2212)] {
        let space = Workspace::new();
        let path = space.write("doc.json", b"[\"\x95\x5C\"]");
        let digest = digest_of(&path);
        let new_path = space.path("new.json");
        space.grant(&new_path);
        let revision = space.open(&path);
        let text = format!("[\"表\",\"{character}\"]");

        assert_eq!(
            space.save(revision, &text),
            SaveReply::Unrepresentable {
                code_point,
                offset: 6
            }
        );

        assert_eq!(digest_of(&path), digest);
        space.expect_names(&["doc.json"]);

        let request = SaveRequest {
            revision,
            path: Some(new_path.to_str().unwrap().to_owned()),
            encoding: Some(Encoding::Utf8),
            ..SaveRequest::default()
        };
        revision_of(&space.state.save(&request, &text, &SystemReplacer));
        assert_eq!(fs::read(&new_path).unwrap(), text.as_bytes());
    }
}

#[test]
fn a_file_that_does_not_round_trip_asks_before_it_is_rewritten() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[\"\xFA\x54\"]");
    let revision = space.open(&path);

    assert_eq!(
        space.save(revision, "[\"\u{FFE2}\", 1]"),
        SaveReply::NeedsConfirm {
            reasons: vec![ConfirmReason::RoundTrip]
        }
    );
    assert_eq!(fs::read(&path).unwrap(), b"[\"\xFA\x54\"]");

    let confirm = Confirmations {
        round_trip: true,
        ..Confirmations::default()
    };
    let revision = revision_of(&space.save_with(revision, "[\"\u{FFE2}\", 1]", confirm));
    // 書いた後は往復できるので、次の保存は聞かない
    revision_of(&space.save(revision, "[\"\u{FFE2}\", 2]"));
}

#[test]
fn a_document_shift_jis_cannot_hold_can_be_saved_as_utf8() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[\"\x95\x5C\"]");
    let digest = digest_of(&path);
    let new_path = space.path("new.json");
    space.grant(&new_path);
    let revision = space.open(&path);

    let request = SaveRequest {
        revision,
        path: Some(new_path.to_str().unwrap().to_owned()),
        encoding: Some(Encoding::Utf8),
        ..SaveRequest::default()
    };
    let revision = revision_of(&space.state.save(&request, "[\"表😀\"]", &SystemReplacer));

    assert_eq!(fs::read(&new_path).unwrap(), "[\"表😀\"]".as_bytes());
    assert_eq!(digest_of(&path), digest);
    // 次の保存も UTF-8 のまま
    revision_of(&space.save(revision, "[\"😀\"]"));
    assert_eq!(fs::read(&new_path).unwrap(), "[\"😀\"]".as_bytes());
}

#[test]
fn saving_unedited_text_in_another_encoding_converts_it() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[\"\x95\x5C\"]");
    let new_path = space.path("new.json");
    space.grant(&new_path);
    let revision = space.open(&path);

    let request = SaveRequest {
        revision,
        path: Some(new_path.to_str().unwrap().to_owned()),
        encoding: Some(Encoding::Utf8),
        ..SaveRequest::default()
    };
    revision_of(&space.state.save(&request, "[\"表\"]", &SystemReplacer));

    assert_eq!(fs::read(&new_path).unwrap(), "[\"表\"]".as_bytes());
}

// ---- 基準 ----

#[test]
fn a_saved_baseline_lets_the_next_save_write_the_old_text_again() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let revision = revision_of(&space.save(revision, "[2]"));
    assert_eq!(space.save(revision, "[2]"), SaveReply::Unchanged);
    revision_of(&space.save(revision, "[1]"));
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
}

#[test]
fn an_old_revision_writes_nothing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let first = space.open(&path);
    revision_of(&space.save(first, "[2]"));
    assert_eq!(space.save(first, "[3]"), SaveReply::StaleRevision);
    assert_eq!(fs::read(&path).unwrap(), b"[2]");
}

#[test]
fn a_failed_save_keeps_the_baseline() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let replacer = FailingReplacer {
        code: ERROR_UNABLE_TO_REMOVE_REPLACED,
        restore_fails: false,
    };
    assert!(matches!(save_through(&space, revision, &replacer), SaveReply::Failed { .. }));
    assert_eq!(space.save(revision, "[1]"), SaveReply::Unchanged);
    revision_of(&space.save(revision, "[2]"));
}

#[test]
fn after_a_save_as_the_next_save_goes_to_the_new_path_without_a_false_alarm() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let new_path = space.path("new.json");
    space.grant(&new_path);
    let revision = space.open(&path);

    let request = SaveRequest {
        revision,
        path: Some(new_path.to_str().unwrap().to_owned()),
        ..SaveRequest::default()
    };
    let revision = revision_of(&space.state.save(&request, "[2]", &SystemReplacer));
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    assert_eq!(fs::read(&new_path).unwrap(), b"[2]");

    revision_of(&space.save(revision, "[3]"));
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    assert_eq!(fs::read(&new_path).unwrap(), b"[3]");
}

#[test]
fn a_save_as_of_the_baseline_text_writes_the_original_bytes() {
    let space = Workspace::new();
    let original = b"[\"\xFA\x54\"]";
    let path = space.write("doc.json", original);
    let new_path = space.path("new.json");
    space.grant(&new_path);
    let (revision, text) = {
        space.grant(&path);
        let (reply, text) = space.state.open(path.to_str().unwrap(), &accept_all(&path));
        let OpenReply::Opened { revision, .. } = reply else {
            panic!("{reply:?}");
        };
        assert!(space.state.commit_open(revision));
        (revision, String::from_utf8(text).unwrap())
    };

    let request = SaveRequest {
        revision,
        path: Some(new_path.to_str().unwrap().to_owned()),
        ..SaveRequest::default()
    };
    revision_of(&space.state.save(&request, &text, &SystemReplacer));
    assert_eq!(fs::read(&new_path).unwrap(), original);
}

#[test]
fn a_document_abandoned_after_reading_does_not_replace_the_baseline() {
    let space = Workspace::new();
    let first = space.write("first.json", b"[1]");
    let second = space.write("second.json", b"[2]");
    let revision = space.open(&first);
    space.grant(&second);

    let (reply, _) = space.state.open(second.to_str().unwrap(), &Accept::default());
    let OpenReply::Opened { revision: abandoned, .. } = reply else {
        panic!("{reply:?}");
    };

    revision_of(&space.save(revision, "[3]"));
    assert_eq!(fs::read(&first).unwrap(), b"[3]");
    assert_eq!(fs::read(&second).unwrap(), b"[2]");
    assert!(!space.state.commit_open(revision));
    assert!(space.state.commit_open(abandoned));
}

#[test]
fn a_first_save_without_a_document_creates_the_file() {
    let space = Workspace::new();
    let path = space.path("new.json");
    space.grant(&path);
    let request = SaveRequest {
        revision: super::session::NO_DOCUMENT,
        path: Some(path.to_str().unwrap().to_owned()),
        ..SaveRequest::default()
    };
    let revision = revision_of(&space.state.save(&request, "[1]", &SystemReplacer));
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
    revision_of(&space.save(revision, "[2]"));
    assert_eq!(fs::read(&path).unwrap(), b"[2]");
}

// ---- サイズ ----

fn sparse_file(path: &Path, size: u64) -> File {
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;

    let file = File::create(path).unwrap();
    let mut returned = 0;
    // SAFETY: ハンドルは file が持ち、入出力の領域は使わない。
    let done = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(done, 0);
    file.set_len(size).unwrap();
    file
}

fn granted_path(space: &Workspace, path: &Path) -> GrantedPath {
    space.state.grants.grant(path).unwrap()
}

#[test]
fn the_size_is_judged_before_a_single_byte_is_read() {
    let space = Workspace::new();
    let path = space.path("sparse.json");
    drop(sparse_file(&path, open::CONFIRM_LIMIT + 1));
    let granted = granted_path(&space, &path);

    let mut read = 0;
    let outcome = open::read_counted(&granted, &Accept::default(), &mut |bytes| read += bytes);

    assert!(matches!(outcome, ReadOutcome::NeedsSizeConfirm { .. }), "{outcome:?}");
    assert_eq!(read, 0);
}

#[test]
fn a_file_above_the_limit_is_refused_even_when_accepted() {
    let space = Workspace::new();
    let path = space.path("sparse.json");
    drop(sparse_file(&path, open::REFUSE_LIMIT + 1));
    let granted = granted_path(&space, &path);

    let mut read = 0;
    let accept = Accept {
        size: true,
        encoding: None,
    };
    let outcome = open::read_counted(&granted, &accept, &mut |bytes| read += bytes);

    assert!(
        matches!(
            outcome,
            ReadOutcome::Refused {
                reason: RefuseReason::TooLarge,
                ..
            }
        ),
        "{outcome:?}"
    );
    assert_eq!(read, 0);
}

#[test]
fn text_only_documents_above_the_text_limit_return_their_flags_without_a_body() {
    let space = Workspace::new();
    let mut text = String::from("[{\"a\":1,\"a\":1}");
    while (text.len() as u64) <= 11 * MEBIBYTE {
        text.push_str(",{\"name\":\"value\"}");
    }
    text.push(']');
    let path = space.write("big.json", text.as_bytes());
    space.grant(&path);

    let (reply, body) = space.state.open(path.to_str().unwrap(), &Accept::default());

    let OpenReply::Refused {
        reason: RefuseReason::TextOnlyTooLarge,
        scan: Some(scan),
    } = reply
    else {
        panic!("{reply:?}");
    };
    assert!(scan.duplicate_key);
    assert!(body.is_empty());
}

#[test]
fn a_document_above_the_text_limit_opens_without_the_text_mode() {
    let space = Workspace::new();
    let mut text = String::from("[{\"b\":1,\"2\":\"x\"}");
    while (text.len() as u64) <= 11 * MEBIBYTE {
        text.push_str(",{\"name\":\"value\"}");
    }
    text.push(']');
    let path = space.write("big.json", text.as_bytes());
    space.grant(&path);

    let (reply, _) = space.state.open(path.to_str().unwrap(), &Accept::default());

    let OpenReply::Opened { size_class, scan, .. } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(size_class, SizeClass::NoTextMode);
    assert!(scan.numeric_key_reorder);
}

// ---- 許可 ----

#[test]
fn a_path_without_a_grant_cannot_be_read_or_written() {
    let space = Workspace::new();
    let opened = space.write("opened.json", b"[1]");
    let other = space.write("other.json", b"[2]");
    let revision = space.open(&opened);

    let (reply, text) = space.state.open(other.to_str().unwrap(), &Accept::default());
    assert!(matches!(
        reply,
        OpenReply::Denied {
            reason: PathDenied::NotGranted
        }
    ));
    assert!(text.is_empty());

    let request = SaveRequest {
        revision,
        path: Some(other.to_str().unwrap().to_owned()),
        ..SaveRequest::default()
    };
    assert_eq!(
        space.state.save(&request, "[3]", &SystemReplacer),
        SaveReply::Denied {
            reason: PathDenied::NotGranted
        }
    );
    assert_eq!(
        space.save_baseline(revision, Some(&other), Confirmations::default()),
        SaveReply::Denied {
            reason: PathDenied::NotGranted
        }
    );
    assert_eq!(fs::read(&other).unwrap(), b"[2]");
}

#[test]
fn parent_steps_streams_and_folders_are_refused() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let grants = &space.state.grants;
    grants.grant(&path).unwrap();

    let through_parent = space.path("sub").join("..").join("doc.json");
    assert!(matches!(grants.check(&through_parent), Err(PathDenied::BadName)));
    assert!(matches!(grants.check(&stream_of(&path)), Err(PathDenied::BadName)));
    assert!(matches!(
        grants.grant(&space.dir.clone()),
        Err(PathDenied::NotAFile | PathDenied::BadName)
    ));
    fs::create_dir(space.path("folder")).unwrap();
    assert!(matches!(grants.grant(&space.path("folder")), Err(PathDenied::NotAFile)));
}

#[test]
fn another_spelling_of_the_same_file_passes() {
    let space = Workspace::new();
    let path = space.write("Document Name.json", b"[1]");
    let grants = &space.state.grants;
    grants.grant(&path).unwrap();

    let upper = PathBuf::from(path.to_str().unwrap().to_uppercase());
    assert!(grants.check(&upper).is_ok());

    let short = short_name(&path);
    match short {
        Some(short) if short != path => assert!(grants.check(&short).is_ok()),
        _ => println!("8.3 names are off on this volume; the short spelling was not tested"),
    }
}

// ---- 同じファイルの判定（B64）。ハードリンクは別のパスでも同じ実体 ----

/// 開いている文書を `path` へ、編集した `text` で保存する（名前を付けて保存）。
fn save_as(space: &Workspace, revision: u64, path: &Path, text: &str) -> SaveReply {
    let request = SaveRequest {
        revision,
        path: Some(path.to_str().unwrap().to_owned()),
        ..SaveRequest::default()
    };
    space.state.save(&request, text, &SystemReplacer)
}

#[test]
fn a_hard_link_is_the_same_file() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let link = space.path("linked.json");
    fs::hard_link(&path, &link).unwrap();
    let original = granted_path(&space, &path);
    let linked = granted_path(&space, &link);
    assert!(original.is_same_file(&linked));
    assert!(linked.is_same_file(&original));
}

#[test]
fn a_different_file_with_the_same_bytes_is_not_the_same_file() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let copy = space.write("copy.json", b"[1]");
    let original = granted_path(&space, &path);
    assert!(!original.is_same_file(&granted_path(&space, &copy)));
    // 無いファイル（新しく作る保存先）は実体が取れず、解決したパスで比べる
    assert!(!original.is_same_file(&granted_path(&space, &space.path("new.json"))));
    assert!(original.is_same_file(&granted_path(&space, &path)));
}

#[test]
fn saving_through_a_hard_link_checks_for_an_outside_change() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let link = space.path("linked.json");
    fs::hard_link(&path, &link).unwrap();
    space.grant(&link);
    // 外のアプリが元の名前で書き換える（その場の書き換えなのでリンクは保たれる）
    fs::write(&path, b"[2]").unwrap();

    assert_eq!(save_as(&space, revision, &link, "[3]"), SaveReply::ExternalChange);
    assert_eq!(fs::read(&path).unwrap(), b"[2]");
    assert_eq!(fs::read(&link).unwrap(), b"[2]");
}

#[test]
fn saving_over_a_different_file_does_not_compare_it_with_the_baseline() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    // 別の実体。中身が基準と違っても、開いているファイルの外の変更とは見なさない
    let other = space.write("other.json", b"[5]");
    space.grant(&other);

    revision_of(&save_as(&space, revision, &other, "[3]"));
    assert_eq!(fs::read(&other).unwrap(), b"[3]");
    assert_eq!(fs::read(&path).unwrap(), b"[1]");
}

#[test]
fn saving_the_baseline_through_a_hard_link_writes_nothing() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let link = space.path("linked.json");
    fs::hard_link(&path, &link).unwrap();
    space.grant(&link);
    let before = fs::metadata(&path).unwrap().modified().unwrap();

    assert_eq!(space.save_baseline(revision, Some(&link), Confirmations::default()), SaveReply::Unchanged);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    // 書いていないので、2 つの名前は同じ実体のまま
    assert!(granted_path(&space, &path).is_same_file(&granted_path(&space, &link)));
}

#[test]
fn saving_the_baseline_through_a_hard_link_does_not_overwrite_an_outside_change() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let link = space.path("linked.json");
    fs::hard_link(&path, &link).unwrap();
    space.grant(&link);
    fs::write(&path, b"[2]").unwrap();

    assert_eq!(
        space.save_baseline(revision, Some(&link), Confirmations::default()),
        SaveReply::ExternalChange
    );
    assert_eq!(fs::read(&link).unwrap(), b"[2]");
}

#[test]
fn saving_the_baseline_through_a_copy_with_the_same_bytes_writes_it() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let revision = space.open(&path);
    let copy = space.write("copy.json", b"[1]");
    space.grant(&copy);

    // 別の実体なので、開いているファイルの「書かない」判定に入らず、基準を書く
    let reply = space.save_baseline(revision, Some(&copy), Confirmations::default());
    let SaveReply::Saved { path: saved_to, .. } = reply else {
        panic!("{reply:?}");
    };
    assert_eq!(saved_to, copy.to_str().unwrap());
    assert_eq!(fs::read(&copy).unwrap(), b"[1]");
}

fn short_name(path: &Path) -> Option<PathBuf> {
    let output = Command::new("cmd")
        .args(["/C", "for", "%I", "in", "("])
        .arg(path)
        .args([")", "do", "@echo", "%~sI"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

#[test]
fn the_real_path_is_not_shown_to_the_screen() {
    let space = Workspace::new();
    let path = space.write("doc.json", b"[1]");
    let granted = granted_path(&space, &path);
    assert!(!granted.display().starts_with(r"\\?\"));
    assert_eq!(granted.display(), path.to_str().unwrap());
}

#[test]
fn a_symbolic_link_saves_through_to_the_real_file() {
    let space = Workspace::new();
    let real = space.write("real.json", b"[1]");
    let link = space.path("link.json");
    if std::os::windows::fs::symlink_file(&real, &link).is_err() {
        println!("creating symbolic links is not allowed here; this case was not tested");
        return;
    }
    let revision = space.open(&link);
    revision_of(&space.save(revision, "[2]"));
    assert_eq!(fs::read(&real).unwrap(), b"[2]");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
}

/// 新規のつもりの保存先が、移す直前に現れる。
struct AppearsBeforeTheMove;

impl Replacer for AppearsBeforeTheMove {
    fn replace(&self, target: &Path, replacement: &Path, backup: &Path) -> Result<(), u32> {
        SystemReplacer.replace(target, replacement, backup)
    }

    fn move_new(&self, from: &Path, to: &Path) -> Result<(), u32> {
        fs::write(to, b"appeared").unwrap();
        SystemReplacer.move_new(from, to)
    }
}

#[test]
fn a_new_file_that_appears_during_the_save_is_not_overwritten() {
    let space = Workspace::new();
    let path = space.path("new.json");
    let result = write_atomically(&path, b"[1]", &|_| true, &|| Ok(()), &AppearsBeforeTheMove);
    assert_eq!(result, Err(WriteFailure::TargetAppeared));
    assert_eq!(fs::read(&path).unwrap(), b"appeared");
    space.expect_names(&["new.json"]);
}

// --- 外の変更の見張りとテキストで開く（D5） ---

use super::session::{DiskStatus, NO_DOCUMENT};
use crate::shell::external::{TextEditorLauncher, TextEditorReply, open_in_text_editor};

/// 外の編集の後の時刻のずれ。NTFS の時刻の分解能（100 ns）より十分に大きければよい。
const OUTSIDE_EDIT_LATER: Duration = Duration::from_secs(2);

/// 中身を替え、更新時刻を `modified` にする。サイズと時刻を決めた形で外の編集を作る。
fn rewrite_with_time(path: &Path, bytes: &[u8], modified: SystemTime) {
    fs::write(path, bytes).unwrap();
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

#[test]
fn disk_status_is_same_while_the_disk_matches_the_baseline() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    assert_eq!(space.state.disk_status(revision), DiskStatus::Same);
    assert_eq!(space.state.disk_status(revision), DiskStatus::Same);
}

#[test]
fn disk_status_reports_an_outside_change_with_its_digest() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    fs::write(&path, b"[22]").unwrap();
    assert_eq!(
        space.state.disk_status(revision),
        DiskStatus::Changed {
            sha256: digest_of(&path)
        }
    );
}

#[test]
fn disk_status_reports_a_vanished_file_as_missing() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    fs::remove_file(&path).unwrap();
    assert_eq!(space.state.disk_status(revision), DiskStatus::Missing);
}

#[test]
fn disk_status_is_stale_for_an_old_revision_and_for_no_document() {
    let space = Workspace::new();
    assert_eq!(space.state.disk_status(NO_DOCUMENT), DiskStatus::Stale);
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let saved = revision_of(&space.save(revision, "[2]"));
    assert_eq!(space.state.disk_status(revision), DiskStatus::Stale);
    // 自分の保存の直後は外の変更と見なさない
    assert_eq!(space.state.disk_status(saved), DiskStatus::Same);
}

#[test]
fn disk_status_does_not_read_again_while_the_size_and_time_stay_the_same() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let revision = space.open(&path);
    // 1 回目は全部を読んで確かめ、サイズと時刻を覚える
    assert_eq!(space.state.disk_status(revision), DiskStatus::Same);
    // 同じサイズと時刻のまま中身が変わっても、読まずに Same（数字の札の仮置き）。保存直前の照合が止める
    rewrite_with_time(&path, b"[2]", modified);
    assert_eq!(space.state.disk_status(revision), DiskStatus::Same);
    assert_eq!(space.save(revision, "[3]"), SaveReply::ExternalChange);
}

#[test]
fn disk_status_reads_again_when_the_time_changes() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let revision = space.open(&path);
    assert_eq!(space.state.disk_status(revision), DiskStatus::Same);
    // 同じサイズで中身と時刻が変わる（ふつうの外の編集）
    rewrite_with_time(&path, b"[2]", modified + OUTSIDE_EDIT_LATER);
    assert!(matches!(space.state.disk_status(revision), DiskStatus::Changed { .. }));
}

/// 起動を記録するだけの偽物。
struct RecordingLauncher {
    executable: Option<PathBuf>,
    result: Result<(), u32>,
    launched: RefCell<Vec<String>>,
}

impl RecordingLauncher {
    fn new(executable: Option<PathBuf>) -> Self {
        Self {
            executable,
            result: Ok(()),
            launched: RefCell::new(Vec::new()),
        }
    }
}

impl TextEditorLauncher for RecordingLauncher {
    fn text_executable(&self) -> Option<PathBuf> {
        self.executable.clone()
    }

    fn launch(&self, path: &str) -> Result<(), u32> {
        self.launched.borrow_mut().push(path.to_owned());
        self.result
    }
}

#[test]
fn open_in_text_editor_uses_the_baseline_path() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let other = space.write("notepad.exe", b"");
    let own = space.write("jsongridder.exe", b"");
    let launcher = RecordingLauncher::new(Some(other));
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, Some(&own)),
        TextEditorReply::Opened
    );
    assert_eq!(*launcher.launched.borrow(), vec![path.to_str().unwrap().to_owned()]);
}

#[test]
fn open_in_text_editor_refuses_no_document_and_an_old_revision() {
    let space = Workspace::new();
    let launcher = RecordingLauncher::new(None);
    assert_eq!(
        open_in_text_editor(&space.state, NO_DOCUMENT, &launcher, None),
        TextEditorReply::Stale
    );
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    revision_of(&space.save(revision, "[2]"));
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, None),
        TextEditorReply::Stale
    );
    assert!(launcher.launched.borrow().is_empty());
}

#[test]
fn open_in_text_editor_does_not_launch_itself() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let own = space.write("jsongridder.exe", b"");
    // 関連付けは別の書き方（大文字）で同じ実体を指す
    let association = PathBuf::from(own.to_str().unwrap().to_uppercase());
    let launcher = RecordingLauncher::new(Some(association));
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, Some(&own)),
        TextEditorReply::SelfAssociated
    );
    assert!(launcher.launched.borrow().is_empty());
}

#[test]
fn open_in_text_editor_does_not_launch_itself_through_a_hard_link() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let own = space.write("jsongridder.exe", b"MZ");
    // 関連付けは自分の EXE へのハードリンク（別の名前、同じ実体）
    let link = space.path("linked-editor.exe");
    fs::hard_link(&own, &link).unwrap();
    let launcher = RecordingLauncher::new(Some(link));
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, Some(&own)),
        TextEditorReply::SelfAssociated
    );
    assert!(launcher.launched.borrow().is_empty());
}

#[test]
fn open_in_text_editor_launches_a_different_file_with_the_same_bytes() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let own = space.write("jsongridder.exe", b"MZ");
    // 中身も大きさも同じだが、別の実体（写し）
    let copy = space.write("copied-editor.exe", b"MZ");
    let launcher = RecordingLauncher::new(Some(copy));
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, Some(&own)),
        TextEditorReply::Opened
    );
    assert_eq!(*launcher.launched.borrow(), vec![path.to_str().unwrap().to_owned()]);
}

/// 本物の関連付けを引くだけ（起動しない）。このマシンの `.txt` の既定のアプリに依るので、既定では回さない。
/// `cargo test --lib -- --ignored the_text_association_can_be_read` で、FFI の呼び方が通ることを見る。
#[test]
#[ignore]
fn the_text_association_can_be_read() {
    use crate::shell::external::SystemLauncher;
    let executable = SystemLauncher.text_executable();
    println!("text executable: {executable:?}");
    if let Some(executable) = executable {
        assert!(executable.is_absolute(), "{executable:?}");
    }
}

#[test]
fn open_in_text_editor_reports_a_failed_launch_and_a_missing_file() {
    let space = Workspace::new();
    let path = space.write("a.json", b"[1]");
    let revision = space.open(&path);
    let mut launcher = RecordingLauncher::new(None);
    launcher.result = Err(ERROR_ACCESS_DENIED);
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, None),
        TextEditorReply::Failed {
            code: ERROR_ACCESS_DENIED
        }
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        open_in_text_editor(&space.state, revision, &launcher, None),
        TextEditorReply::Missing
    );
    assert_eq!(launcher.launched.borrow().len(), 1);
}
