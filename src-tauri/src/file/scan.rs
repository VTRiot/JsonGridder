//! パーサでは検出できないものを字句で走査する。
//!
//! 入力はデコードの後の UTF-8。Shift_JIS の 2 バイト目の `\` を誤読しないためである。
//! 再帰しない。スタックは 1 段 1 バイトと、オブジェクトごとのキー集合だけを持つ。
//! 深さの上限を超えた段ではキーを集めず、トークンだけを進める。
//!
//! [`diagnose`] は同じ走査で、表とツリーに入れない理由のうち文書の中で最初に見つかったものと、その位置を返す。
//! 警告の帯に出すためで、開く処理と表示の切り替えの判定は [`scan`] だけを使う。

use std::collections::HashMap;
use std::collections::hash_map::Entry;

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

/// 文書の中の位置。行と列は 1 から数える。列は行の頭からの Unicode のスカラー値の数。
/// 行の区切りは `\r\n`、`\n`、`\r`（テキストの表示のエディタと同じ）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPosition {
    pub line: usize,
    pub column: usize,
}

/// 表とツリーに入れない理由のうち、文書の中で最初に見つかったもの。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Problem {
    /// JSON として読めない。`at` は走査が止まった位置。
    Syntax { at: TextPosition },
    /// 同じオブジェクトに同じキーがある。`first` は最初の出現、`at` は 2 つ目。
    DuplicateKey {
        key: String,
        at: TextPosition,
        first: TextPosition,
    },
    /// オブジェクトの判定や原型に関わる名前のキー。
    ReservedKey { key: String, at: TextPosition },
    /// 入れ子が `limit` 段を超えた。`at` は超えた段を開く括弧。
    DepthExceeded { at: TextPosition, limit: usize },
}

const ARRAY: u8 = 0;
const OBJECT: u8 = 1;
/// UTF-8 の 2 バイト目以降の印（`10xxxxxx`）。列を数えるときに飛ばす。
const UTF8_CONTINUATION_MASK: u8 = 0b1100_0000;
const UTF8_CONTINUATION: u8 = 0b1000_0000;

#[derive(Default)]
struct ObjectKeys {
    /// キーと、その最初の出現のバイトの位置。
    seen: HashMap<Box<[u8]>, usize>,
    last_index: Option<u64>,
    named_key_seen: bool,
}

/// 最初に見つかった理由。位置はバイトで持ち、[`diagnose`] が行と列に直す。
enum Found {
    DuplicateKey { key: Vec<u8>, at: usize, first: usize },
    ReservedKey { key: Vec<u8>, at: usize },
    DepthExceeded { at: usize },
}

struct Scanner<'a> {
    input: &'a [u8],
    position: usize,
    containers: Vec<u8>,
    objects: Vec<ObjectKeys>,
    result: ScanResult,
    first: Option<Found>,
}

impl<'a> Scanner<'a> {
    fn new(input: &'a [u8]) -> Self {
        Scanner {
            input,
            position: 0,
            containers: Vec::new(),
            objects: Vec::new(),
            result: ScanResult::default(),
            first: None,
        }
    }
}

/// 構文の誤りで止まっても、そこまでに立てたフラグを返す。
pub fn scan(input: &[u8]) -> ScanResult {
    let mut scanner = Scanner::new(input);
    scanner.result.syntax_ok = scanner.run().is_some();
    scanner.result
}

/// 表とツリーに入れない最初の理由と位置。入れる文書なら `None`。
/// `Some` になるのは、同じ入力の [`scan`] が `text_only()` を返すときに限る。
pub fn diagnose(input: &[u8]) -> Option<Problem> {
    let mut scanner = Scanner::new(input);
    let complete = scanner.run().is_some();
    let at = |offset: usize| locate(input, offset);
    let lossy = |key: &[u8]| String::from_utf8_lossy(key).into_owned();
    match scanner.first {
        Some(Found::DuplicateKey { key, at: second, first }) => Some(Problem::DuplicateKey {
            key: lossy(&key),
            at: at(second),
            first: at(first),
        }),
        Some(Found::ReservedKey { key, at: offset }) => Some(Problem::ReservedKey {
            key: lossy(&key),
            at: at(offset),
        }),
        Some(Found::DepthExceeded { at: offset }) => Some(Problem::DepthExceeded {
            at: at(offset),
            limit: MAX_DEPTH,
        }),
        None if !complete => Some(Problem::Syntax {
            at: at(scanner.position),
        }),
        None => None,
    }
}

/// バイトの位置を行と列に直す。`offset` より前だけを見る。
fn locate(input: &[u8], offset: usize) -> TextPosition {
    let mut line = 1;
    let mut column = 1;
    let end = offset.min(input.len());
    for (index, &byte) in input[..end].iter().enumerate() {
        let line_break = byte == b'\n' || (byte == b'\r' && input.get(index + 1) != Some(&b'\n'));
        if line_break {
            line += 1;
            column = 1;
        } else if byte & UTF8_CONTINUATION_MASK != UTF8_CONTINUATION {
            column += 1;
        }
    }
    TextPosition { line, column }
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
            if self.first.is_none() {
                // 開く括弧は読み進めた直後なので、1 つ前の位置
                self.first = Some(Found::DepthExceeded {
                    at: self.position - 1,
                });
            }
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
            let at = self.position;
            let key = self.read_key_text()?;
            self.note_key(key, at);
        }
        self.skip_whitespace();
        if self.peek()? != b':' {
            return None;
        }
        self.position += 1;
        Some(())
    }

    /// `at` はキーの開く `"` の位置。
    fn note_key(&mut self, key: Vec<u8>, at: usize) {
        if RESERVED_KEYS.contains(&key.as_slice()) {
            self.result.reserved_key = true;
            if self.first.is_none() {
                self.first = Some(Found::ReservedKey {
                    key: key.clone(),
                    at,
                });
            }
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
        match object.seen.entry(key.into_boxed_slice()) {
            Entry::Occupied(seen) => {
                self.result.duplicate_key = true;
                if self.first.is_none() {
                    self.first = Some(Found::DuplicateKey {
                        key: seen.key().to_vec(),
                        at,
                        first: *seen.get(),
                    });
                }
            }
            Entry::Vacant(slot) => {
                slot.insert(at);
            }
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
    /// 不正なときは読み進めずに止まる。止まった位置（[`diagnose`] の構文の誤りの位置）がエスケープの文字を指す。
    fn read_escape(&mut self) -> Option<u32> {
        let escape = self.peek()?;
        let unit = match escape {
            b'"' | b'\\' | b'/' => escape as u32,
            b'b' => 0x08,
            b'f' => 0x0C,
            b'n' => 0x0A,
            b'r' => 0x0D,
            b't' => 0x09,
            b'u' => {
                let start = self.position + 1;
                let digits = self.input.get(start..start + ESCAPE_DIGITS)?;
                let mut unit = 0;
                for digit in digits {
                    unit = unit * 16 + (*digit as char).to_digit(16)?;
                }
                self.position += ESCAPE_DIGITS;
                unit
            }
            _ => return None,
        };
        self.position += 1;
        Some(unit)
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
        /// 表の全行が持つ（null を含む）。持つことはブラウザの側の試験が確かめる。
        diagnosis: Option<Problem>,
    }

    const GOLDEN: &str = include_str!("../../../tests/fixtures/scan-golden.json");

    #[test]
    fn every_row_of_the_golden_table_holds() {
        let rows: Vec<GoldenRow> = serde_json::from_str(GOLDEN).unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            assert_eq!(scan(row.input.as_bytes()), row.result, "{}", row.name);
            assert_eq!(diagnose(row.input.as_bytes()), row.diagnosis, "{}", row.name);
        }
    }

    #[test]
    fn a_reason_is_given_exactly_when_the_document_is_text_only() {
        let rows: Vec<GoldenRow> = serde_json::from_str(GOLDEN).unwrap();
        let mut inputs: Vec<String> = rows.into_iter().map(|row| row.input).collect();
        let deep = |levels: usize| format!("{}{}", "{\"k\":".repeat(levels), "}".repeat(levels));
        inputs.push(deep(MAX_DEPTH));
        inputs.push(deep(MAX_DEPTH + 1));
        inputs.push(r#"{"a":{"__proto__":1},"b":1,"b":2"#.to_owned());
        inputs.push("\"\\u12\"".to_owned());
        for input in inputs {
            let result = scan(input.as_bytes());
            assert_eq!(diagnose(input.as_bytes()).is_some(), result.text_only(), "{input}");
        }
    }

    #[test]
    fn the_first_reason_in_document_order_is_given() {
        // 予約の名前が先、重複が後、最後に構文の誤り
        let problem = diagnose(br#"{"a":{"__proto__":1},"b":1,"b":2"#).unwrap();
        assert_eq!(
            problem,
            Problem::ReservedKey {
                key: "__proto__".into(),
                at: TextPosition { line: 1, column: 7 }
            }
        );
    }

    #[test]
    fn positions_count_lines_and_unicode_scalars() {
        assert_eq!(locate(b"", 0), TextPosition { line: 1, column: 1 });
        assert_eq!(locate(b"a\nb", 2), TextPosition { line: 2, column: 1 });
        assert_eq!(locate(b"a\r\nb", 3), TextPosition { line: 2, column: 1 });
        assert_eq!(locate(b"a\rb", 2), TextPosition { line: 2, column: 1 });
        assert_eq!(locate(b"a\r\rb", 3), TextPosition { line: 3, column: 1 });
        // 「名」は 3 バイト、絵文字は 4 バイトで、どちらも 1 列
        assert_eq!(locate("名😀x".as_bytes(), 7), TextPosition { line: 1, column: 3 });
        // 入力の外の位置は末尾に丸める
        assert_eq!(locate(b"ab", 9), TextPosition { line: 1, column: 3 });
    }

    #[test]
    fn a_bad_escape_stops_at_the_escape_letter() {
        assert_eq!(
            diagnose(b"\"\\u12\""),
            Some(Problem::Syntax {
                at: TextPosition { line: 1, column: 3 }
            })
        );
        assert!(!scan(b"\"\\u12\"").syntax_ok);
        assert!(scan(b"\"\\u0041\"").syntax_ok);
    }

    #[test]
    fn the_reason_serializes_for_the_screen() {
        let problem = diagnose(br#"{"a":1,"a":2}"#).unwrap();
        let json = serde_json::to_value(&problem).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "duplicateKey",
                "key": "a",
                "at": { "line": 1, "column": 8 },
                "first": { "line": 1, "column": 2 }
            })
        );
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        let json = serde_json::to_value(diagnose(deep.as_bytes()).unwrap()).unwrap();
        assert_eq!(json["kind"], "depthExceeded");
        assert_eq!(json["limit"], MAX_DEPTH);
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
