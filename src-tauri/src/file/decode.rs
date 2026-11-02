//! 文字コードの判定とデコード。判定はここの 1 か所だけで行う。
//!
//! 置換を伴うデコードは使わない。デコードできないバイト列は開かない。

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16BE_BOM: [u8; 2] = [0xFE, 0xFF];
const UTF32LE_BOM: [u8; 4] = [0xFF, 0xFE, 0x00, 0x00];
const UTF32BE_BOM: [u8; 4] = [0x00, 0x00, 0xFE, 0xFF];
/// ASCII だけの UTF-16 は strict UTF-8 を通るので、先頭のこの範囲の NUL で見分ける。
const NUL_PROBE_BYTES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    ShiftJis,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Detection {
    /// 確かに読めた。
    Decoded {
        text: String,
        encoding: Encoding,
        bom: bool,
    },
    /// 読めたが推定なので、JSON として通り利用者が認めたときだけ開く。
    Probable { text: String, encoding: Encoding },
    /// 対応していない UTF-32。
    Utf32,
    Undecodable,
}

pub fn detect(bytes: &[u8]) -> Detection {
    if bytes.starts_with(&UTF32LE_BOM) || bytes.starts_with(&UTF32BE_BOM) {
        return Detection::Utf32;
    }
    for (bom, encoding) in [
        (&UTF8_BOM[..], Encoding::Utf8),
        (&UTF16LE_BOM[..], Encoding::Utf16Le),
        (&UTF16BE_BOM[..], Encoding::Utf16Be),
    ] {
        if bytes.starts_with(bom) {
            return match decode_strict(bytes, encoding, true) {
                Some(text) => Detection::Decoded {
                    text,
                    encoding,
                    bom: true,
                },
                None => Detection::Undecodable,
            };
        }
    }

    let probe = &bytes[..bytes.len().min(NUL_PROBE_BYTES)];
    if probe.contains(&0) {
        return detect_bomless_utf16(bytes, probe);
    }
    if let Some(text) = decode_strict(bytes, Encoding::Utf8, false) {
        return Detection::Decoded {
            text,
            encoding: Encoding::Utf8,
            bom: false,
        };
    }
    match decode_strict(bytes, Encoding::ShiftJis, false) {
        Some(text) => Detection::Probable {
            text,
            encoding: Encoding::ShiftJis,
        },
        None => Detection::Undecodable,
    }
}

/// NUL の位置で向きを決める。JSON の先頭は ASCII なので、どちらかの位置に NUL が並ぶ。
fn detect_bomless_utf16(bytes: &[u8], probe: &[u8]) -> Detection {
    let encoding = if probe.first() == Some(&0) {
        Encoding::Utf16Be
    } else {
        Encoding::Utf16Le
    };
    match decode_strict(bytes, encoding, false) {
        Some(text) => Detection::Probable { text, encoding },
        None => Detection::Undecodable,
    }
}

/// 指定の文字コードで読む。1 か所でも読めなければ `None`。`bom` は先頭の BOM を除く印。
pub fn decode_strict(bytes: &[u8], encoding: Encoding, bom: bool) -> Option<String> {
    match encoding {
        Encoding::Utf8 => {
            let body = if bom {
                bytes.strip_prefix(&UTF8_BOM)?
            } else {
                bytes
            };
            std::str::from_utf8(body).ok().map(str::to_owned)
        }
        Encoding::Utf16Le => decode_utf16(bytes, bom.then_some(&UTF16LE_BOM), u16::from_le_bytes),
        Encoding::Utf16Be => decode_utf16(bytes, bom.then_some(&UTF16BE_BOM), u16::from_be_bytes),
        Encoding::ShiftJis => SHIFT_JIS
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(|text| text.into_owned()),
    }
}

fn decode_utf16(
    bytes: &[u8],
    bom: Option<&[u8; 2]>,
    to_unit: fn([u8; 2]) -> u16,
) -> Option<String> {
    let body = match bom {
        Some(bom) => bytes.strip_prefix(bom)?,
        None => bytes,
    };
    if body.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|pair| to_unit([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

pub fn bom_bytes(encoding: Encoding) -> &'static [u8] {
    match encoding {
        Encoding::Utf8 => &UTF8_BOM,
        Encoding::Utf16Le => &UTF16LE_BOM,
        Encoding::Utf16Be => &UTF16BE_BOM,
        Encoding::ShiftJis => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(bytes: &[u8]) -> (String, Encoding, bool) {
        match detect(bytes) {
            Detection::Decoded {
                text,
                encoding,
                bom,
            } => (text, encoding, bom),
            other => panic!("not decoded: {other:?}"),
        }
    }

    #[test]
    fn a_bom_is_followed_and_kept_out_of_the_text() {
        assert_eq!(decoded(b"\xEF\xBB\xBF[1]"), ("[1]".into(), Encoding::Utf8, true));
        assert_eq!(
            decoded(b"\xFF\xFE[\x001\x00]\x00"),
            ("[1]".into(), Encoding::Utf16Le, true)
        );
        assert_eq!(
            decoded(b"\xFE\xFF\x00[\x001\x00]"),
            ("[1]".into(), Encoding::Utf16Be, true)
        );
    }

    #[test]
    fn utf32_is_refused() {
        assert_eq!(detect(b"\xFF\xFE\x00\x00[\x00\x00\x00"), Detection::Utf32);
        assert_eq!(detect(b"\x00\x00\xFE\xFF\x00\x00\x00["), Detection::Utf32);
    }

    #[test]
    fn broken_bytes_after_a_bom_are_undecodable() {
        assert_eq!(detect(b"\xEF\xBB\xBF[\xFF]"), Detection::Undecodable);
        assert_eq!(detect(b"\xFF\xFE[\x00\x00"), Detection::Undecodable);
        assert_eq!(detect(b"\xFF\xFE\x00\xD8[\x00"), Detection::Undecodable);
    }

    #[test]
    fn utf16_without_a_bom_is_only_probable() {
        assert_eq!(
            detect(b"[\x001\x00]\x00"),
            Detection::Probable {
                text: "[1]".into(),
                encoding: Encoding::Utf16Le
            }
        );
        assert_eq!(
            detect(b"\x00[\x001\x00]"),
            Detection::Probable {
                text: "[1]".into(),
                encoding: Encoding::Utf16Be
            }
        );
    }

    #[test]
    fn shift_jis_is_only_probable() {
        let bytes = b"[\"\x95\x5C\"]"; // 2 バイト目が \ になる文字
        assert_eq!(
            detect(bytes),
            Detection::Probable {
                text: "[\"表\"]".into(),
                encoding: Encoding::ShiftJis
            }
        );
    }

    #[test]
    fn bytes_that_no_encoding_reads_are_undecodable() {
        assert_eq!(detect(b"[\xFD\xFE]"), Detection::Undecodable);
    }

    #[test]
    fn an_empty_file_is_empty_text() {
        assert_eq!(decoded(b""), (String::new(), Encoding::Utf8, false));
    }
}
