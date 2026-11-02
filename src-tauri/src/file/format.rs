//! 開いたときの書式の記録。保存はこの記録に合わせて書き戻す。

use serde::Serialize;

/// インデントが検出できない複数行の文書に使う幅。エディタの既定と同じ。
const DEFAULT_INDENT: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Newline {
    Crlf,
    Lf,
    Cr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EolKind {
    Crlf,
    Lf,
    Cr,
    Mixed,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Indent {
    Spaces { count: usize },
    Tab,
    /// 1 行の文書。
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    pub eol: EolKind,
    /// 書き戻す改行。混在のときは多い方。同数なら CRLF、LF、CR の順。
    pub eol_dominant: Newline,
    pub indent: Indent,
    pub final_newline: bool,
}

pub fn detect_format(text: &str) -> TextFormat {
    let (crlf, lf, cr) = count_newlines(text);
    let kinds = [crlf, lf, cr].iter().filter(|count| **count > 0).count();
    let eol = match (kinds, crlf > 0, lf > 0) {
        (0, _, _) => EolKind::None,
        (1, true, _) => EolKind::Crlf,
        (1, _, true) => EolKind::Lf,
        (1, _, _) => EolKind::Cr,
        _ => EolKind::Mixed,
    };
    let eol_dominant = if crlf >= lf && crlf >= cr && crlf > 0 {
        Newline::Crlf
    } else if cr > lf {
        Newline::Cr
    } else {
        Newline::Lf
    };
    TextFormat {
        eol,
        eol_dominant,
        indent: detect_indent(text),
        final_newline: text.ends_with('\n') || text.ends_with('\r'),
    }
}

fn count_newlines(text: &str) -> (usize, usize, usize) {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf, mut cr) = (0, 0, 0);
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        index += 1;
    }
    (crlf, lf, cr)
}

/// 最初に字下げされた行で決める。整形された文書ではそれが 1 段目である。
fn detect_indent(text: &str) -> Indent {
    // 末尾の改行だけの文書は 1 行の文書である
    if !text.trim_end().contains(['\n', '\r']) {
        return Indent::None;
    }
    for line in text.split(['\n', '\r']) {
        let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
        if line.starts_with('\t') {
            return Indent::Tab;
        }
        let rest = &line[spaces..];
        if spaces > 0 && !rest.is_empty() {
            return Indent::Spaces { count: spaces };
        }
    }
    Indent::Spaces {
        count: DEFAULT_INDENT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_are_counted_by_kind() {
        assert_eq!(detect_format("[1]").eol, EolKind::None);
        assert_eq!(detect_format("[\r\n1\r\n]").eol, EolKind::Crlf);
        assert_eq!(detect_format("[\n1\n]").eol, EolKind::Lf);
        assert_eq!(detect_format("[\r1\r]").eol, EolKind::Cr);
        assert_eq!(detect_format("[\r\n1\n]").eol, EolKind::Mixed);
    }

    #[test]
    fn mixed_newlines_return_as_the_more_common_kind() {
        assert_eq!(detect_format("[\r\n1,\n2,\n3\n]").eol_dominant, Newline::Lf);
        assert_eq!(detect_format("[\r\n1,\r\n2\n]").eol_dominant, Newline::Crlf);
        assert_eq!(detect_format("[\r\n1\n]").eol_dominant, Newline::Crlf);
    }

    #[test]
    fn indentation_is_taken_from_the_first_indented_line() {
        assert_eq!(detect_format("[1]").indent, Indent::None);
        assert_eq!(detect_format("[1]\r\n").indent, Indent::None);
        assert_eq!(detect_format("[\n  1\n]").indent, Indent::Spaces { count: 2 });
        assert_eq!(detect_format("{\r\n    \"a\": [\r\n        1\r\n    ]\r\n}").indent, Indent::Spaces { count: 4 });
        assert_eq!(detect_format("[\n\t1\n]").indent, Indent::Tab);
    }

    #[test]
    fn a_multiline_document_without_indentation_uses_the_default_width() {
        assert_eq!(
            detect_format("[\n1\n]").indent,
            Indent::Spaces {
                count: DEFAULT_INDENT
            }
        );
    }

    #[test]
    fn the_final_newline_is_recorded() {
        assert!(!detect_format("[1]").final_newline);
        assert!(detect_format("[1]\n").final_newline);
        assert!(detect_format("[1]\r\n").final_newline);
    }
}
