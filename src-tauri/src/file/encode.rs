//! テキストを、開いたときの文字コードでバイト列へ戻す。
//!
//! `encoding_rs::Encoding::encode` は表せない文字を数値参照へ置き換え、UTF-16 の
//! 出力を UTF-8 にするので使わない。

use encoding_rs::{EncoderResult, SHIFT_JIS};

use super::decode::{Encoding, bom_bytes, decode_strict};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unrepresentable {
    pub code_point: u32,
    /// 保存する text の中の位置（UTF-16 の単位）。
    pub offset: usize,
}

pub fn encode(text: &str, encoding: Encoding, bom: bool) -> Result<Vec<u8>, Unrepresentable> {
    let prefix = if bom { bom_bytes(encoding) } else { &[] };
    match encoding {
        Encoding::Utf8 => {
            let mut bytes = Vec::with_capacity(prefix.len() + text.len());
            bytes.extend_from_slice(prefix);
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        Encoding::Utf16Le => Ok(encode_utf16(text, prefix, u16::to_le_bytes)),
        Encoding::Utf16Be => Ok(encode_utf16(text, prefix, u16::to_be_bytes)),
        Encoding::ShiftJis => encode_shift_jis(text),
    }
}

fn encode_utf16(text: &str, prefix: &[u8], to_bytes: fn(u16) -> [u8; 2]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(prefix.len() + text.len() * 2);
    bytes.extend_from_slice(prefix);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&to_bytes(unit));
    }
    bytes
}

fn encode_shift_jis(text: &str) -> Result<Vec<u8>, Unrepresentable> {
    let mut encoder = SHIFT_JIS.new_encoder();
    let capacity = encoder
        .max_buffer_length_from_utf8_without_replacement(text.len())
        .expect("the text is smaller than the address space");
    let mut bytes = Vec::with_capacity(capacity);
    let (result, read) = encoder.encode_from_utf8_to_vec_without_replacement(text, &mut bytes, true);
    match result {
        EncoderResult::InputEmpty => match first_changed_character(text, &bytes) {
            Some(changed) => Err(changed),
            None => Ok(bytes),
        },
        EncoderResult::Unmappable(character) => Err(Unrepresentable {
            code_point: character as u32,
            offset: text[..read - character.len_utf8()].encode_utf16().count(),
        }),
        EncoderResult::OutputFull => unreachable!("the buffer has the maximum length"),
    }
}

/// 符号器は U+00A5、U+203E、U+2212 を別の文字のバイトへ畳む。読み直すと別の文字に
/// なるので、表せない文字と同じに扱う。保存の読み直しの検証は残すので、読めないバイト列は
/// ここで止めなくても書かれない。
fn first_changed_character(text: &str, bytes: &[u8]) -> Option<Unrepresentable> {
    let decoded = decode_strict(bytes, Encoding::ShiftJis, false)?;
    if decoded == text {
        return None;
    }
    let mut offset = 0;
    for (written, read_back) in text.chars().zip(decoded.chars()) {
        if written != read_back {
            return Some(Unrepresentable {
                code_point: written as u32,
                offset,
            });
        }
        offset += written.len_utf16();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_is_written_as_utf16() {
        assert_eq!(encode("a", Encoding::Utf16Le, false).unwrap(), b"a\x00");
        assert_eq!(encode("a", Encoding::Utf16Be, true).unwrap(), b"\xFE\xFF\x00a");
    }

    #[test]
    fn a_bom_returns_only_when_the_file_had_one() {
        assert_eq!(encode("a", Encoding::Utf8, true).unwrap(), b"\xEF\xBB\xBFa");
        assert_eq!(encode("a", Encoding::Utf8, false).unwrap(), b"a");
    }

    #[test]
    fn shift_jis_stops_at_a_character_it_cannot_hold() {
        assert_eq!(encode("表", Encoding::ShiftJis, false).unwrap(), b"\x95\x5C");
        assert_eq!(
            encode("あ😀", Encoding::ShiftJis, false),
            Err(Unrepresentable {
                code_point: 0x1F600,
                offset: 1
            })
        );
    }

    #[test]
    fn shift_jis_stops_at_a_character_that_would_come_back_as_another() {
        for (character, code_point) in [('\u{A5}', 0xA5), ('\u{203E}', 0x203E), ('\u{2212}', 0x2212)] {
            assert_eq!(
                encode(&format!("😀あ{character}"), Encoding::ShiftJis, false).err().map(|e| e.code_point),
                Some(0x1F600)
            );
            assert_eq!(
                encode(&format!("あ{character}い"), Encoding::ShiftJis, false),
                Err(Unrepresentable {
                    code_point,
                    offset: 1
                })
            );
        }
    }

    #[test]
    fn shift_jis_keeps_characters_that_come_back_the_same() {
        let text = "表\\~\u{FF5E}\u{FF0D}\u{FFE2}";
        let bytes = encode(text, Encoding::ShiftJis, false).unwrap();
        assert_eq!(decode_strict(&bytes, Encoding::ShiftJis, false).as_deref(), Some(text));
    }
}
