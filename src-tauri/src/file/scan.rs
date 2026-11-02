//! パーサでは検出できないものを字句で走査する。
//!
//! 入力はデコードの後の UTF-8。Shift_JIS の 2 バイト目の `\` を誤読しないためである。
//! 再帰しない。スタックは 1 段 1 バイトと、オブジェクトごとのキー集合だけを持つ。
//! 深さの上限を超えた段ではキーを集めず、トークンだけを進める。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// これを超える深さの文書はテキストの表示に限る。
pub const MAX_DEPTH: usize = 1000;
/// 配列の添字と同じ形のキーの上限。これを超えるキーは文字列として順序が保たれる。
const MAX_ARRAY_INDEX: u64 = 4_294_967_294;
const SURROGATE_FIRST: u32 = 0xD800;
const SURROGATE_LAST: u32 = 0xDFFF;
const HIGH_SURROGATE_LAST: u32 = 0xDBFF;
const LOW_SURROGATE_FIRST: u32 = 0xDC00;
const SUPPLEMENTARY_BASE: u32 = 0x10000;
const SURROGATE_PAYLOAD_BITS: u32 = 10;
const ESCAPE_DIGITS: usize = 4;
const FIRST_PRINTABLE: u8 = 0x20;
/// オブジェクトの判定や原型に関わる名前。エディタのパーサが拒否するので、表とツリーで開けない。
const RESERVED_KEYS: [&[u8]; 2] = [b"__proto__", b"constructor"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub duplicate_key: bool,
    pub numeric_key_reorder: bool,
    #[serde(default)]
    pub reserved_key: bool,
    pub depth_exceeded: bool,
    pub syntax_ok: bool,
}

impl ScanResult {
    /// 表とツリーに入れない文書。
    pub fn text_only(&self) -> bool {
        !self.syntax_ok || self.duplicate_key || self.reserved_key || self.depth_exceeded
    }
}

const ARRAY: u8 = 0;
const OBJECT: u8 = 1;

#[derive(Default)]
struct ObjectKeys {
    seen: HashSet<Box<[u8]>>,
    last_index: Option<u64>,
    named_key_seen: bool,
}

struct Scanner<'a> {
    input: &'a [u8],
    position: usize,
    containers: Vec<u8>,
    objects: Vec<ObjectKeys>,
    result: ScanResult,
}

/// 構文の誤りで止まっても、そこまでに立てたフラグを返す。
pub fn scan(input: &[u8]) -> ScanResult {
    let mut scanner = Scanner {
        input,
        position: 0,
        containers: Vec::new(),
        objects: Vec::new(),
        result: ScanResult::default(),
    };
    scanner.result.syntax_ok = scanner.run().is_some();
    scanner.result
}

impl Scanner<'_> {
    /// 全体が 1 つの値として読めたら `Some`。
    fn run(&mut self) -> Option<()> {
        'value: loop {
            self.skip_whitespace();
            match self.peek()? {
                b'{' => {
                    self.position += 1;
                    self.enter(OBJECT);
                    self.skip_whitespace();
                    if self.peek()? == b'}' {
                        self.position += 1;
                        self.leave();
                    } else {
                        self.read_key()?;
                        continue 'value;
                    }
                }
                b'[' => {
                    self.position += 1;
                    self.enter(ARRAY);
                    self.skip_whitespace();
                    if self.peek()? == b']' {
                        self.position += 1;
                        self.leave();
                    } else {
                        continue 'value;
                    }
                }
                b'"' => self.skip_string()?,
                b't' => self.read_keyword(b"true")?,
                b'f' => self.read_keyword(b"false")?,
                b'n' => self.read_keyword(b"null")?,
                _ => self.read_number()?,
            }

            loop {
                self.skip_whitespace();
                let Some(&kind) = self.containers.last() else {
                    return (self.position == self.input.len()).then_some(());
                };
                match (kind, self.peek()?) {
                    (_, b',') => {
                        self.position += 1;
                        if kind == OBJECT {
                            self.skip_whitespace();
                            self.read_key()?;
                        }
                        continue 'value;
                    }
                    (ARRAY, b']') | (OBJECT, b'}') => {
                        self.position += 1;
                        self.leave();
                    }
                    _ => return None,
                }
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn enter(&mut self, kind: u8) {
        self.containers.push(kind);
        if self.containers.len() > MAX_DEPTH {
            self.result.depth_exceeded = true;
        } else if kind == OBJECT {
            self.objects.push(ObjectKeys::default());
        }
    }

    fn leave(&mut self) {
        let depth = self.containers.len();
        if self.containers.pop() == Some(OBJECT) && depth <= MAX_DEPTH {
            self.objects.pop();
        }
    }

    fn read_key(&mut self) -> Option<()> {
        if self.peek()? != b'"' {
            return None;
        }
        if self.containers.len() > MAX_DEPTH {
            self.skip_string()?;
        } else {
            let key = self.read_key_text()?;
            self.note_key(key);
        }
        self.skip_whitespace();
        if self.peek()? != b':' {
            return None;
        }
        self.position += 1;
        Some(())
    }

    fn note_key(&mut self, key: Vec<u8>) {
        if RESERVED_KEYS.contains(&key.as_slice()) {
            self.result.reserved_key = true;
        }
        let object = self.objects.last_mut().expect("an object is open");
        if let Some(index) = array_index(&key) {
            if object.named_key_seen || object.last_index.is_some_and(|last| index < last) {
                self.result.numeric_key_reorder = true;
            }
            object.last_index = Some(index);
        } else {
            object.named_key_seen = true;
        }
        if !object.seen.insert(key.into_boxed_slice()) {
            self.result.duplicate_key = true;
        }
    }

    /// 文字列を読み飛ばす。閉じる `"` の次の位置へ進める。
    fn skip_string(&mut self) -> Option<()> {
        self.walk_string(|_| {})
    }

    /// エスケープを解いたキーを返す。`"a"` と `"a"` は同じキーである。
    /// 孤立したサロゲートは 3 バイトで残す。有効な UTF-8 と重ならない。
    fn read_key_text(&mut self) -> Option<Vec<u8>> {
        let mut key = Vec::new();
        self.walk_string(|piece| match piece {
            Piece::Raw(bytes) => key.extend_from_slice(bytes),
            Piece::Unit(code_point) => push_code_point(&mut key, code_point),
        })?;
        Some(key)
    }

    fn walk_string(&mut self, mut sink: impl FnMut(Piece<'_>)) -> Option<()> {
        self.position += 1; // 開く "
        let mut high_surrogate: Option<u32> = None;
        loop {
            let start = self.position;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' {
                    break;
                }
                if byte < FIRST_PRINTABLE {
                    return None;
                }
                self.position += 1;
            }
            let raw = &self.input[start..self.position];
            if !raw.is_empty() {
                flush_surrogate(&mut high_surrogate, &mut sink);
                sink(Piece::Raw(raw));
            }
            let terminator = self.peek()?;
            self.position += 1;
            if terminator == b'"' {
                flush_surrogate(&mut high_surrogate, &mut sink);
                return Some(());
            }
            let unit = self.read_escape()?;
            match (high_surrogate.take(), unit) {
                (Some(high), low)
                    if (LOW_SURROGATE_FIRST..=SURROGATE_LAST).contains(&low) =>
                {
                    let payload = ((high - SURROGATE_FIRST) << SURROGATE_PAYLOAD_BITS)
                        | (low - LOW_SURROGATE_FIRST);
                    sink(Piece::Unit(SUPPLEMENTARY_BASE + payload));
                }
                (previous, unit) => {
                    if let Some(lone) = previous {
                        sink(Piece::Unit(lone));
                    }
                    if (SURROGATE_FIRST..=HIGH_SURROGATE_LAST).contains(&unit) {
                        high_surrogate = Some(unit);
                    } else {
                        sink(Piece::Unit(unit));
                    }
                }
            }
        }
    }

    /// `\` の次から読み、エスケープが表す単位を返す。
    fn read_escape(&mut self) -> Option<u32> {
        let escape = self.peek()?;
        self.position += 1;
        Some(match escape {
            b'"' | b'\\' | b'/' => escape as u32,
            b'b' => 0x08,
            b'f' => 0x0C,
            b'n' => 0x0A,
            b'r' => 0x0D,
            b't' => 0x09,
            b'u' => {
                let digits = self.input.get(self.position..self.position + ESCAPE_DIGITS)?;
                self.position += ESCAPE_DIGITS;
                let mut unit = 0;
                for digit in digits {
                    unit = unit * 16 + (*digit as char).to_digit(16)?;
                }
                unit
            }
            _ => return None,
        })
    }

    fn read_keyword(&mut self, keyword: &[u8]) -> Option<()> {
        if self.input[self.position..].starts_with(keyword) {
            self.position += keyword.len();
            Some(())
        } else {
            None
        }
    }

    fn read_number(&mut self) -> Option<()> {
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek()? {
            b'0' => self.position += 1,
            b'1'..=b'9' => self.skip_digits(),
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            self.expect_digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            self.expect_digits()?;
        }
        Some(())
    }

    fn expect_digits(&mut self) -> Option<()> {
        if !self.peek()?.is_ascii_digit() {
            return None;
        }
        self.skip_digits();
        Some(())
    }

    fn skip_digits(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.position += 1;
        }
    }
}

enum Piece<'a> {
    Raw(&'a [u8]),
    Unit(u32),
}

fn flush_surrogate(pending: &mut Option<u32>, sink: &mut impl FnMut(Piece<'_>)) {
    if let Some(lone) = pending.take() {
        sink(Piece::Unit(lone));
    }
}

/// UTF-8 の形で足す。サロゲートも同じ形にする（`char` にならないので手で組む）。
fn push_code_point(bytes: &mut Vec<u8>, code_point: u32) {
    if let Some(character) = char::from_u32(code_point) {
        let mut buffer = [0; 4];
        bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
    } else {
        bytes.push(0xE0 | (code_point >> 12) as u8);
        bytes.push(0x80 | ((code_point >> 6) & 0x3F) as u8);
        bytes.push(0x80 | (code_point & 0x3F) as u8);
    }
}

/// 配列の添字と同じ形のキー。JavaScript のオブジェクトで先頭へ動く。
fn array_index(key: &[u8]) -> Option<u64> {
    let (first, rest) = key.split_first()?;
    if !first.is_ascii_digit() || (*first == b'0' && !rest.is_empty()) {
        return None;
    }
    let mut value = 0u64;
    for digit in key {
        if !digit.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(digit - b'0');
        if value > MAX_ARRAY_INDEX {
            return None;
        }
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct GoldenRow {
        name: String,
        input: String,
        result: ScanResult,
    }

    const GOLDEN: &str = include_str!("../../../tests/fixtures/scan-golden.json");

    #[test]
    fn every_row_of_the_golden_table_holds() {
        let rows: Vec<GoldenRow> = serde_json::from_str(GOLDEN).unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            assert_eq!(scan(row.input.as_bytes()), row.result, "{}", row.name);
        }
    }

    #[test]
    fn reserved_keys_keep_a_document_in_text_mode() {
        for input in [
            r#"{"__proto__":1}"#,
            r#"[{"a":{"constructor":{}}}]"#,
            r#"{"\u005f_proto__":1}"#,
            r#"{"c\u006fnstructor":1}"#,
        ] {
            let result = scan(input.as_bytes());
            assert!(result.reserved_key, "{input}");
            assert!(result.text_only(), "{input}");
        }
    }

    #[test]
    fn the_same_words_in_values_are_not_keys() {
        let result = scan(br#"{"a":"__proto__","b":["constructor"],"toString":1}"#);
        assert!(!result.reserved_key);
        assert!(!result.text_only());
    }

    #[test]
    fn a_million_levels_do_not_overflow_the_stack() {
        let levels = 1_000_000;
        let input = format!("{}{}", "[".repeat(levels), "]".repeat(levels));
        let result = scan(input.as_bytes());
        assert!(result.depth_exceeded);
        assert!(result.syntax_ok);
    }

    #[test]
    fn exactly_the_limit_is_allowed_and_one_more_is_not() {
        let nest = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
        assert!(!scan(nest(MAX_DEPTH).as_bytes()).depth_exceeded);
        assert!(scan(nest(MAX_DEPTH + 1).as_bytes()).depth_exceeded);
    }

    #[test]
    fn objects_past_the_limit_scan_without_collecting_keys() {
        let levels = MAX_DEPTH + 5;
        let input = format!(
            "{}{{\"a\":1,\"a\":1}}{}",
            "{\"k\":".repeat(levels),
            "}".repeat(levels)
        );
        let result = scan(input.as_bytes());
        assert!(result.depth_exceeded);
        assert!(result.syntax_ok);
    }

    #[test]
    fn flags_set_before_a_syntax_error_are_kept() {
        let result = scan(b"[{\"a\":1,\"a\":2},");
        assert!(result.duplicate_key);
        assert!(!result.syntax_ok);
    }

    #[test]
    fn large_documents_finish_with_their_flags() {
        let row = "{\"name\":\"value\",\"count\":12345},";
        let mut input = String::from("[");
        while input.len() <= 10 * 1024 * 1024 {
            input.push_str(row);
        }
        input.push_str("{\"a\":1,\"a\":1}]");
        let result = scan(input.as_bytes());
        assert!(result.duplicate_key);
        assert!(result.syntax_ok);
    }
}
