//! 読み込み。サイズは読む前に、開いたハンドルで判定する。

use std::fs::File;
use std::io::{ErrorKind, Read};

use serde::{Deserialize, Serialize};

use super::allow::GrantedPath;
use super::decode::{Detection, Encoding, detect};
use super::encode::encode;
use super::format::{TextFormat, detect_format};
use super::scan::{ScanResult, scan};
use super::{Sha256Digest, os_code, sha256};

const MEBIBYTE: u64 = 1024 * 1024;
/// これ以下は全部の表示で開く。超えるとテキストの表示は使えない。
pub const ALL_MODES_LIMIT: u64 = 10 * MEBIBYTE;
/// これを超えると確認を受けてから読む。
pub const CONFIRM_LIMIT: u64 = 100 * MEBIBYTE;
/// これを超えると開かない。V8 の文字列の上限。UTF-16 の長さはバイト数以下なので、
/// バイト数で切れば文字列の上限を超えない。
pub const REFUSE_LIMIT: u64 = 536_870_888;

const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_SHARING_VIOLATION: u32 = 32;

/// 利用者が認めた内容。呼び直しで渡す。
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accept {
    #[serde(default)]
    pub size: bool,
    #[serde(default)]
    pub encoding: Option<Encoding>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeClass {
    AllModes,
    NoTextMode,
    Oversize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefuseReason {
    TooLarge,
    Utf32,
    Undecodable,
    TextOnlyTooLarge,
    ChangedWhileReading,
}

#[derive(Debug)]
pub struct OpenedDocument {
    pub bytes: Vec<u8>,
    pub text: String,
    pub sha256: Sha256Digest,
    pub encoding: Encoding,
    pub bom: bool,
    pub format: TextFormat,
    pub scan: ScanResult,
    pub size_class: SizeClass,
    pub round_trip_ok: bool,
}

#[derive(Debug)]
pub enum ReadOutcome {
    Opened(Box<OpenedDocument>),
    NeedsSizeConfirm { size: u64 },
    NeedsEncodingConfirm { encoding: Encoding },
    Refused {
        reason: RefuseReason,
        scan: Option<ScanResult>,
    },
    Missing,
    Locked { code: u32 },
    Failed { code: u32 },
}

pub fn read_document(path: &GrantedPath, accept: &Accept) -> ReadOutcome {
    read_counted(path, accept, &mut |_| {})
}

/// `on_read` は読んだバイト数を受ける。判定の前に読まないことの確かめに使う。
pub fn read_counted(
    path: &GrantedPath,
    accept: &Accept,
    on_read: &mut dyn FnMut(usize),
) -> ReadOutcome {
    let mut file = match File::open(path.real()) {
        Ok(file) => file,
        Err(error) => return failed_open(&error),
    };
    let size = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => return failed_open(&error),
    };
    let size_class = match classify_size(size, accept.size) {
        Ok(class) => class,
        Err(outcome) => return outcome,
    };

    // 判定の後に伸びても読むのは 1 バイト余分まで。メモリを使い切らない
    let mut bytes = Vec::with_capacity(size as usize);
    if let Err(error) = (&mut file).take(size + 1).read_to_end(&mut bytes) {
        return failed_open(&error);
    }
    on_read(bytes.len());
    if bytes.len() as u64 != size {
        return ReadOutcome::Refused {
            reason: RefuseReason::ChangedWhileReading,
            scan: None,
        };
    }

    match detect(&bytes) {
        Detection::Decoded {
            text,
            encoding,
            bom,
        } => finish(bytes, text, encoding, bom, size_class),
        Detection::Probable { text, encoding } => {
            // 推定の文字コードは JSON として読めるときだけ提案する。文字化けで開かない
            if !scan(text.as_bytes()).syntax_ok {
                refused(RefuseReason::Undecodable)
            } else if accept.encoding == Some(encoding) {
                finish(bytes, text, encoding, false, size_class)
            } else {
                ReadOutcome::NeedsEncodingConfirm { encoding }
            }
        }
        Detection::Utf32 => refused(RefuseReason::Utf32),
        Detection::Undecodable => refused(RefuseReason::Undecodable),
    }
}

fn classify_size(size: u64, accepted: bool) -> Result<SizeClass, ReadOutcome> {
    if size > REFUSE_LIMIT {
        Err(refused(RefuseReason::TooLarge))
    } else if size <= ALL_MODES_LIMIT {
        Ok(SizeClass::AllModes)
    } else if size <= CONFIRM_LIMIT {
        Ok(SizeClass::NoTextMode)
    } else if accepted {
        Ok(SizeClass::Oversize)
    } else {
        Err(ReadOutcome::NeedsSizeConfirm { size })
    }
}

fn finish(
    bytes: Vec<u8>,
    text: String,
    encoding: Encoding,
    bom: bool,
    size_class: SizeClass,
) -> ReadOutcome {
    let scan = scan(text.as_bytes());
    if scan.text_only() && size_class != SizeClass::AllModes {
        return ReadOutcome::Refused {
            reason: RefuseReason::TextOnlyTooLarge,
            scan: Some(scan),
        };
    }
    let round_trip_ok = encode(&text, encoding, bom).is_ok_and(|encoded| encoded == bytes);
    ReadOutcome::Opened(Box::new(OpenedDocument {
        sha256: sha256(&bytes),
        format: detect_format(&text),
        bytes,
        text,
        encoding,
        bom,
        scan,
        size_class,
        round_trip_ok,
    }))
}

fn refused(reason: RefuseReason) -> ReadOutcome {
    ReadOutcome::Refused { reason, scan: None }
}

fn failed_open(error: &std::io::Error) -> ReadOutcome {
    let code = os_code(error);
    if error.kind() == ErrorKind::NotFound {
        ReadOutcome::Missing
    } else if code == ERROR_SHARING_VIOLATION || code == ERROR_ACCESS_DENIED {
        ReadOutcome::Locked { code }
    } else {
        ReadOutcome::Failed { code }
    }
}
