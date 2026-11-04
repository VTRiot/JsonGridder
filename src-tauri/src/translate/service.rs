//! 翻訳のサービスと通信の口。サービスは要求を作って応答を読むだけで、通信はしない。
//! 通信は `Transport` だけが行い、サービスの許した宛先の外へは送らない。

use std::fmt;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

use super::secret::Secret;

/// 送る宛先。サービスの実装が定数で持つ。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: &'static str,
    pub port: u16,
    /// HTTPS か。本番の宛先は必ず true。
    pub secure: bool,
}

/// 1 回の HTTP の要求。キーは持たない（`Transport::send` に別に渡し、ヘッダにだけ入れる）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub endpoint: Endpoint,
    /// `POST` の宛先のパス。キーを入れない。
    pub path: String,
    /// キーを入れるヘッダの名。
    pub key_header: &'static str,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// 通信の失敗。文にキーを入れない（持っていない）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// 許した宛先の外か、ヘッダに入れられない文字のキー。通信を始めずに拒んだ。
    Refused,
    /// 取り消された。
    Cancelled,
    /// 時間切れ。
    Timeout,
    /// 応答が大きさの上限を超えた。
    TooLarge,
    /// 名前解決、接続、TLS など（Win32 の番号）。
    Network(u32),
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused => formatter.write_str("request refused before sending"),
            Self::Cancelled => formatter.write_str("cancelled"),
            Self::Timeout => formatter.write_str("timed out"),
            Self::TooLarge => formatter.write_str("response is too large"),
            Self::Network(code) => write!(formatter, "network error {code}"),
        }
    }
}

/// 送る文字列の 1 件。`i` は組の中の番号。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Piece {
    pub index: usize,
    pub text: String,
}

/// 失敗の種類。画面の案内（辞書のキー）はこの名で引く。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Key,
    Permission,
    Model,
    Quota,
    /// モデルが混雑している（503 か `UNAVAILABLE`）。時間をおくか別のモデルで通る。
    Overloaded,
    Service,
    Network,
    Malformed,
    Cancelled,
}

impl ErrorKind {
    /// 別のモデルへ切り替えれば通る見込みのある失敗か。キー、権限、形の誤りでは切り替えない。
    pub const fn model_specific(self) -> bool {
        matches!(self, Self::Overloaded | Self::Quota)
    }
}

/// 画面に出す詳しい文の長さの上限（文字数）。Google の文がこれより長ければ切る。数字の札は仮置き。
pub const DETAIL_MAX_CHARS: usize = 300;
/// `status` の長さの上限（Google の状態の名は 30 文字に届かない）。
const STATUS_MAX_CHARS: usize = 64;
/// 切ったときに末尾へ付ける印。
const ELLIPSIS: char = '…';

/// サービスが言った失敗の理由（Google の `error.status` と `error.message`）。
/// 画面の詳しい行に出す。キーと要求の本文は入れない（`scrub` で塗る）。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ErrorDetail {
    pub status: String,
    pub message: String,
}

fn truncated(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push(ELLIPSIS);
    cut
}

/// Google の API キーの形（`AIza` の後に 35 文字）。文に紛れていたら塗る。
const KEY_PREFIX: &str = "AIza";
const KEY_TAIL_CHARS: usize = 35;
const MASK: &str = "***";

fn mask_key_shapes(text: &str) -> String {
    let is_key_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(KEY_PREFIX) {
        out.push_str(&rest[..found]);
        let after = &rest[found + KEY_PREFIX.len()..];
        let tail = after.chars().take_while(|c| is_key_char(*c)).count();
        if tail >= KEY_TAIL_CHARS {
            out.push_str(MASK);
            // 鍵の文字は ASCII なので文字数とバイト数が同じ
            rest = &after[tail..];
        } else {
            out.push_str(KEY_PREFIX);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

impl ErrorDetail {
    /// 状態の名は大文字と数字と `_` だけを残し、文は制御文字を空白にしてキーの形を塗る。
    /// 長さはまだ切らない。送ったキーそのものを塗ってから切るため、画面へ出す前に必ず `scrub` を通す。
    pub fn new(status: &str, message: &str) -> Self {
        let status = if !status.is_empty()
            && status.len() <= STATUS_MAX_CHARS
            && status.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            status.to_owned()
        } else {
            String::new()
        };
        let flat: String = message
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        Self {
            status,
            message: mask_key_shapes(flat.trim()),
        }
    }

    /// 送ったキーが文に入っていれば塗り（サービスがキーを言い返す形に備える）、長さを切る。
    pub fn scrub(mut self, key: &Secret) -> Self {
        if let Ok(key) = std::str::from_utf8(key.expose())
            && !key.is_empty()
        {
            self.message = self.message.replace(key, MASK);
        }
        self.message = truncated(&self.message, DETAIL_MAX_CHARS);
        self
    }
}

/// 1 組の応答を読んだ結果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchOutcome {
    /// 訳。`(番号, 訳)` の並び。番号の集合が送った集合と合うかは呼ぶ側が確かめる。
    Translated(Vec<(usize, String)>),
    /// 応答の形が読めない（JSON でない、配列でない、要素の形が違う）。
    Malformed,
    /// 出力の長さの上限で切れた。
    Truncated,
    /// 安全のために拒まれた。
    Blocked,
    /// 状態の番号による失敗。`retry_after` はサービスが示した待ち時間。
    Failed {
        kind: ErrorKind,
        retryable: bool,
        retry_after: Option<Duration>,
        /// サービスが言った理由。キーを含まない。
        detail: Option<ErrorDetail>,
    },
}

/// サービスの差し替えの口。Gemini のほかに足すときは実装を 1 つ足す。
pub trait TranslationService: Send + Sync {
    /// このサービスが送ってよい宛先。
    fn endpoint(&self) -> Endpoint;
    /// 要求を作る。モデルが一覧の外なら `None`（作らない）。
    fn build(&self, pieces: &[Piece], target: &str, model: &str) -> Option<HttpRequest>;
    fn parse(&self, response: &HttpResponse) -> BatchOutcome;
}

/// 通信の口。試験では台本どおりに答える実装に差し替える。
pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: &HttpRequest,
        key: &Secret,
        cancel: &Cancel,
    ) -> Result<HttpResponse, TransportError>;
}

/// 取り消しの印。別のスレッドから `cancel` を呼ぶ。
///
/// 通信の途中のハンドルは閉じない（WinHTTP の同期の要求を別のスレッドから閉じてはならない）。
/// Transport は同期の呼び出しが戻るたびにこの印を見て、自分のスレッドで閉じて戻る。
/// 画面は取り消しの時点で止まった扱いにし、戻った組の結果は捨てる（`TranslateState::cancel`）。
#[derive(Default)]
pub struct Cancel {
    cancelled: Mutex<bool>,
    woken: Condvar,
}

impl Cancel {
    fn lock(&self) -> std::sync::MutexGuard<'_, bool> {
        self.cancelled.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn cancel(&self) {
        *self.lock() = true;
        self.woken.notify_all();
    }

    pub fn is_cancelled(&self) -> bool {
        *self.lock()
    }

    /// `duration` だけ待つ。途中で取り消されたら true を返してすぐ戻る。
    pub fn wait(&self, duration: Duration) -> bool {
        let cancelled = self.lock();
        let (cancelled, _) = self
            .woken
            .wait_timeout_while(cancelled, duration, |cancelled| !*cancelled)
            .unwrap_or_else(PoisonError::into_inner);
        *cancelled
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    #[test]
    fn cancel_wakes_the_wait() {
        let cancel = Arc::new(Cancel::default());
        let waiter = Arc::clone(&cancel);
        let started = Instant::now();
        let handle = std::thread::spawn(move || waiter.wait(Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(50));
        cancel.cancel();
        assert!(handle.join().expect("join"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(cancel.is_cancelled());
        // 取り消し済みなら待たずに戻る
        assert!(cancel.wait(Duration::from_secs(30)));
    }

    #[test]
    fn detail_is_cleaned_masked_and_cut() {
        let key = Secret::new("test-not-a-real-key-QwErTy112233".to_owned());
        // 制御文字は空白、前後の空白は落とす。送ったキーと、キーの形の文字列は塗る
        let detail = ErrorDetail::new("UNAVAILABLE", " a\nb\u{0007}c test-not-a-real-key-QwErTy112233 AIzaSyA0123456789abcdefghijklmnopqrstuv AIzaShort ")
            .scrub(&key);
        assert_eq!(detail.status, "UNAVAILABLE");
        assert_eq!(detail.message, "a b c *** *** AIzaShort");
        // 名でない status は捨てる
        for status in ["unavailable", "A B", "<x>", &"A".repeat(STATUS_MAX_CHARS + 1)] {
            assert_eq!(ErrorDetail::new(status, "m").status, "", "{status}");
        }
        // 長さは文字数で切り、末尾に印を付ける（日本語でも文字の途中で切らない）
        let long = "あ".repeat(DETAIL_MAX_CHARS * 2);
        let cut = ErrorDetail::new("X", &long).scrub(&key).message;
        assert_eq!(cut.chars().count(), DETAIL_MAX_CHARS);
        assert!(cut.ends_with(ELLIPSIS));
        let exact = "b".repeat(DETAIL_MAX_CHARS);
        assert_eq!(ErrorDetail::new("X", &exact).scrub(&key).message, exact);
    }

    #[test]
    fn only_overload_and_quota_switch_models() {
        let switching: Vec<ErrorKind> = [
            ErrorKind::Key,
            ErrorKind::Permission,
            ErrorKind::Model,
            ErrorKind::Quota,
            ErrorKind::Overloaded,
            ErrorKind::Service,
            ErrorKind::Network,
            ErrorKind::Malformed,
            ErrorKind::Cancelled,
        ]
        .into_iter()
        .filter(|kind| kind.model_specific())
        .collect();
        assert_eq!(switching, [ErrorKind::Quota, ErrorKind::Overloaded]);
    }
}
