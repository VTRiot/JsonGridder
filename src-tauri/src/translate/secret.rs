//! API キーを持つ型。表示とデバッグの出力は伏せ字にし、捨てるときに中身を 0 で塗る。
//!
//! 複製（`Clone`）は作らない。取り出せるのは HTTP のヘッダを作る所だけにする。

use std::fmt;
use std::sync::atomic::{Ordering, compiler_fence};

/// `Debug` と `Display` が出す文字。長さも出さない。
pub const MASK: &str = "***";

pub struct Secret(Vec<u8>);

impl Secret {
    /// 受け取った文字列の領域をそのまま持つ（写しを作らない）。
    pub fn new(text: String) -> Self {
        Self(text.into_bytes())
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// 前後の空白（貼り付けで付く改行など）を、領域の中で詰めて除く。
    pub fn trim_in_place(&mut self) {
        let end = self
            .0
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .map_or(0, |last| last + 1);
        self.0.truncate(end);
        let start = self
            .0
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(self.0.len());
        self.0.drain(..start);
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 中身。資格情報マネージャーへ書く所と、HTTP のヘッダを作る所だけが呼ぶ。
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // 詰めた後の余りの領域にも元の文字が残るので、確保した全体を塗る
        let capacity = self.0.capacity();
        let start = self.0.as_mut_ptr();
        for offset in 0..capacity {
            // SAFETY: `start` から `capacity` バイトは Vec が確保した領域で、u8 は初期化の制約が無い
            unsafe { std::ptr::write_volatile(start.add(offset), 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(MASK)
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(MASK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "test-not-a-real-key-0123456789";

    #[test]
    fn secret_debug_is_masked() {
        let secret = Secret::new(SAMPLE.to_owned());
        let shown = [
            format!("{secret:?}"),
            format!("{secret:#?}"),
            format!("{secret}"),
            format!("{:?}", Some(&secret)),
            format!("{:?}", vec![&secret]),
        ];
        for text in shown {
            assert!(!text.contains(SAMPLE), "key leaked: {text}");
            assert!(!text.contains("test-"), "part of the key leaked: {text}");
            assert!(!text.contains(&SAMPLE.len().to_string()), "length leaked: {text}");
        }
        assert_eq!(format!("{secret:?}"), MASK);
        assert_eq!(secret.expose(), SAMPLE.as_bytes());
    }

    #[test]
    fn trim_keeps_the_inside_and_drops_pasted_whitespace() {
        let mut secret = Secret::new(format!(" \t{SAMPLE}\r\n"));
        secret.trim_in_place();
        assert_eq!(secret.expose(), SAMPLE.as_bytes());
        let mut blank = Secret::new(" \r\n ".to_owned());
        blank.trim_in_place();
        assert!(blank.is_empty());
    }
}
