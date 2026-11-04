//! Windows 標準の WinHTTP で送る `Transport`。新しいクレートを使わない。
//!
//! - セッション（`WinHttpOpen`）は最初の送信で作る。翻訳が無効なら送信の経路が呼ばれない。
//! - 宛先は許した一覧の中だけ。本番の一覧は Gemini の HTTPS の 1 つで、平文の宛先は試験だけが使う。
//! - 転送（リダイレクト）は追わない。キーのヘッダが別の宛先へ行かない。
//! - キーはヘッダ `x-goog-api-key` にだけ入れる。ヘッダを作った領域は送った後に 0 で塗る。
//! - 取り消しは、同期の呼び出しが戻るたびに印を見て、このスレッドでハンドルを閉じて戻る。
//!   同期の要求のハンドルを別のスレッドから閉じない（WinHTTP の決まり。T2 の Codex レビュー 2 回目の指摘）。
//!   通信の途中の呼び出しは時間切れ（`TIMEOUT`）までに戻る。画面は取り消しの時点で止まった扱い。

use std::sync::atomic::{AtomicUsize, Ordering, compiler_fence};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use super::gemini::GEMINI_ENDPOINT;
use super::secret::Secret;
use super::service::{Cancel, Endpoint, HttpRequest, HttpResponse, Transport, TransportError};

/// 1 組の時間切れ。名前解決、接続、送信、受け取りのそれぞれに使う。数字の札は仮置き。
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// 応答の大きさの上限。超える応答は壊れた物として扱う。数字の札は仮置き。
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// 本番で送ってよい宛先。
pub const PRODUCTION_ENDPOINTS: [Endpoint; 1] = [GEMINI_ENDPOINT];
const USER_AGENT: &str = "JsonGridder";

/// OS の部品が使うプロキシの決め方。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Proxy {
    /// OS の設定に従う（本番）。
    Automatic,
    /// 使わない（127.0.0.1 の試験のサーバ）。
    #[cfg_attr(not(test), allow(dead_code))]
    None,
}

pub struct WinHttpTransport {
    allowed: Vec<Endpoint>,
    allow_plain: bool,
    proxy: Proxy,
    timeout: Duration,
    max_response: usize,
    session: Mutex<Option<system::Handle>>,
    opened: AtomicUsize,
}

impl WinHttpTransport {
    /// 本番の Transport。作るだけでは何も開かない。
    pub fn production() -> Self {
        Self {
            allowed: PRODUCTION_ENDPOINTS.to_vec(),
            allow_plain: false,
            proxy: Proxy::Automatic,
            timeout: TIMEOUT,
            max_response: MAX_RESPONSE_BYTES,
            session: Mutex::new(None),
            opened: AtomicUsize::new(0),
        }
    }

    /// 試験だけの Transport。127.0.0.1 の平文の宛先を許す。
    #[cfg(test)]
    fn local(allowed: Vec<Endpoint>, timeout: Duration, max_response: usize) -> Self {
        assert!(allowed.iter().all(|endpoint| endpoint.host == "127.0.0.1"));
        Self {
            allowed,
            allow_plain: true,
            proxy: Proxy::None,
            timeout,
            max_response,
            session: Mutex::new(None),
            opened: AtomicUsize::new(0),
        }
    }

    /// `WinHttpOpen` を呼んだ回数。
    #[cfg(test)]
    fn sessions_opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    fn permits(&self, endpoint: &Endpoint) -> bool {
        self.allowed.contains(endpoint) && (endpoint.secure || self.allow_plain)
    }
}

/// キーを入れたヘッダの文字。捨てるときに 0 で塗る。
struct WideSecret(Vec<u16>);

impl Drop for WideSecret {
    fn drop(&mut self) {
        let capacity = self.0.capacity();
        let start = self.0.as_mut_ptr();
        for offset in 0..capacity {
            // SAFETY: `start` から `capacity` 個は Vec が確保した領域で、u16 は初期化の制約が無い
            unsafe { std::ptr::write_volatile(start.add(offset), 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

/// `Content-Type` とキーのヘッダ。キーは ASCII の表示できる文字だけ（改行でヘッダを差し込ませない）。
fn header_block(request: &HttpRequest, key: &Secret) -> Option<WideSecret> {
    if key.is_empty() || !key.expose().iter().all(u8::is_ascii_graphic) {
        return None;
    }
    let head: Vec<u16> = format!("Content-Type: application/json\r\n{}: ", request.key_header)
        .encode_utf16()
        .collect();
    // 先に全体の大きさを確保する（伸ばし直すと、キーの入った古い領域が塗られずに残る）
    let mut wide = WideSecret(Vec::with_capacity(head.len() + key.len() + 1));
    wide.0.extend_from_slice(&head);
    wide.0.extend(key.expose().iter().map(|&byte| u16::from(byte)));
    wide.0.push(0);
    Some(wide)
}

impl Transport for WinHttpTransport {
    fn send(
        &self,
        request: &HttpRequest,
        key: &Secret,
        cancel: &Cancel,
    ) -> Result<HttpResponse, TransportError> {
        // 宛先とキーの検査は、セッションを作る前に行う
        if !self.permits(&request.endpoint) {
            return Err(TransportError::Refused);
        }
        let headers = header_block(request, key).ok_or(TransportError::Refused)?;
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        let mut session = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if session.is_none() {
            *session = Some(system::open_session(self.proxy, self.timeout)?);
            self.opened.fetch_add(1, Ordering::SeqCst);
        }
        let session = session.as_ref().ok_or(TransportError::Refused)?;
        system::exchange(session, request, &headers, cancel, self.max_response)
    }
}

mod system {
    use std::ffi::c_void;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Networking::WinHttp::{
        ERROR_WINHTTP_OPERATION_CANCELLED, ERROR_WINHTTP_TIMEOUT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_ADDREQ_FLAG_ADD, WINHTTP_DISABLE_COOKIES,
        WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_OPTION_REDIRECT_POLICY,
        WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
        WinHttpAddRequestHeaders, WinHttpCloseHandle, WinHttpConnect, WinHttpOpen,
        WinHttpOpenRequest, WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData,
        WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
    };

    use super::{Proxy, WideSecret};
    use crate::translate::service::{Cancel, HttpRequest, HttpResponse, TransportError};

    /// WinHTTP のハンドル。捨てるときに閉じる。
    pub struct Handle(*mut c_void);

    // SAFETY: WinHTTP のハンドルはスレッドをまたいで渡せる。同時に 2 つのスレッドからは使わない
    // （セッションは Mutex の中、接続と要求は 1 回の送信の中だけ）
    unsafe impl Send for Handle {}

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: 開けたハンドルで、ここでだけ閉じる
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn failure() -> TransportError {
        // SAFETY: 引数の無い読み取りだけの呼び出し
        match unsafe { GetLastError() } {
            ERROR_WINHTTP_TIMEOUT => TransportError::Timeout,
            ERROR_WINHTTP_OPERATION_CANCELLED => TransportError::Cancelled,
            code => TransportError::Network(code),
        }
    }

    fn opened(raw: *mut c_void) -> Result<Handle, TransportError> {
        if raw.is_null() { Err(failure()) } else { Ok(Handle(raw)) }
    }

    fn set_u32(handle: *mut c_void, option: u32, value: u32) -> Result<(), TransportError> {
        // SAFETY: value はこの呼び出しの間生きている 4 バイト
        let done = unsafe {
            WinHttpSetOption(handle, option, (&raw const value).cast(), size_of::<u32>() as u32)
        };
        if done != 0 { Ok(()) } else { Err(failure()) }
    }

    fn millis(duration: Duration) -> i32 {
        i32::try_from(duration.as_millis()).unwrap_or(i32::MAX)
    }

    pub fn open_session(proxy: Proxy, timeout: Duration) -> Result<Handle, TransportError> {
        let agent = wide(super::USER_AGENT);
        let access = match proxy {
            Proxy::Automatic => WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            Proxy::None => WINHTTP_ACCESS_TYPE_NO_PROXY,
        };
        // SAFETY: agent は 0 で終わる。プロキシの名と除外は無し（null）。同期の呼び出し（flags 0）
        let session = opened(unsafe {
            WinHttpOpen(agent.as_ptr(), access, std::ptr::null(), std::ptr::null(), 0)
        })?;
        let limit = millis(timeout);
        // SAFETY: 開けたセッション
        if unsafe { WinHttpSetTimeouts(session.0, limit, limit, limit, limit) } == 0 {
            return Err(failure());
        }
        set_u32(session.0, WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER)?;
        Ok(session)
    }

    /// 1 回の要求と応答。ハンドルはすべてこのスレッドだけが使い、このスレッドで閉じる
    /// （要求、接続の順。`Handle` の捨てる順は宣言の逆）。
    pub fn exchange(
        session: &Handle,
        request: &HttpRequest,
        headers: &WideSecret,
        cancel: &Cancel,
        max_response: usize,
    ) -> Result<HttpResponse, TransportError> {
        let host = wide(request.endpoint.host);
        // SAFETY: 開けたセッションと 0 で終わる名
        let connection =
            opened(unsafe { WinHttpConnect(session.0, host.as_ptr(), request.endpoint.port, 0) })?;
        let verb = wide("POST");
        let path = wide(&request.path);
        let flags = if request.endpoint.secure { WINHTTP_FLAG_SECURE } else { 0 };
        // SAFETY: 開けた接続と 0 で終わる文字列。版と参照元と受ける型は既定（null）
        let opened_request = opened(unsafe {
            WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                flags,
            )
        })?;
        let result = talk(&opened_request, request, headers, cancel, max_response);
        drop(opened_request);
        drop(connection);
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        result
    }

    /// 同期の呼び出しが戻るたびに取り消しを見る。取り消されていれば次の呼び出しをしない。
    fn checked(cancel: &Cancel) -> Result<(), TransportError> {
        if cancel.is_cancelled() { Err(TransportError::Cancelled) } else { Ok(()) }
    }

    fn talk(
        handle: &Handle,
        request: &HttpRequest,
        headers: &WideSecret,
        cancel: &Cancel,
        max_response: usize,
    ) -> Result<HttpResponse, TransportError> {
        let raw = handle.0;
        set_u32(raw, WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER)?;
        set_u32(raw, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_DISABLE_COOKIES)?;
        // SAFETY: headers は 0 で終わる。長さ u32::MAX は「0 で終わる」の意味
        if unsafe { WinHttpAddRequestHeaders(raw, headers.0.as_ptr(), u32::MAX, WINHTTP_ADDREQ_FLAG_ADD) } == 0 {
            return Err(failure());
        }
        let size = u32::try_from(request.body.len()).map_err(|_| TransportError::Refused)?;
        // SAFETY: 本文はこの呼び出しの間生きている。追加のヘッダは無し（null）
        let sent = unsafe {
            WinHttpSendRequest(
                raw,
                std::ptr::null(),
                0,
                request.body.as_ptr().cast(),
                size,
                size,
                0,
            )
        };
        if sent == 0 {
            return Err(failure());
        }
        checked(cancel)?;
        // SAFETY: 送った要求
        if unsafe { WinHttpReceiveResponse(raw, std::ptr::null_mut()) } == 0 {
            return Err(failure());
        }
        checked(cancel)?;
        let mut status: u32 = 0;
        let mut length = size_of::<u32>() as u32;
        // SAFETY: status は 4 バイト、length はその大きさ。名は番号で引く（null）
        let queried = unsafe {
            WinHttpQueryHeaders(
                raw,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                std::ptr::null(),
                (&raw mut status).cast(),
                &mut length,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(failure());
        }
        let status = u16::try_from(status).map_err(|_| TransportError::Network(status))?;
        let mut body = Vec::new();
        loop {
            let mut available: u32 = 0;
            // SAFETY: 受け取った要求
            if unsafe { WinHttpQueryDataAvailable(raw, &mut available) } == 0 {
                return Err(failure());
            }
            if available == 0 {
                break;
            }
            let start = body.len();
            if start + available as usize > max_response {
                return Err(TransportError::TooLarge);
            }
            body.resize(start + available as usize, 0);
            let mut read: u32 = 0;
            // SAFETY: body の start から available バイトは確保した領域
            let done = unsafe {
                WinHttpReadData(raw, body[start..].as_mut_ptr().cast(), available, &mut read)
            };
            if done == 0 {
                return Err(failure());
            }
            body.truncate(start + read as usize);
            checked(cancel)?;
        }
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::mpsc::{self, Receiver};
    use std::thread;
    use std::time::Instant;

    use serde_json::{Value, json};

    use super::*;
    use crate::translate::batch::{ItemIn, LIMITS, plan};
    use crate::translate::gemini::{Gemini, KEY_HEADER};
    use crate::translate::job::{self, Job, JobEvent, RETRY};
    use crate::translate::service::ErrorKind;

    const KEY: &str = "test-not-a-real-key-QwErTy135790";
    /// 試験のサーバが応答を返さずに待つ長さ。取り消しの試験はこれより十分早く戻ることを見る。
    const HOLD: Duration = Duration::from_secs(20);
    const TEST_TIMEOUT: Duration = Duration::from_secs(30);

    enum Reply {
        Bytes(Vec<u8>),
        /// 受け取った後、応答を返さずに待つ。
        Hold,
        /// 受け取った後、待ってから返す。
        Late(Duration, Vec<u8>),
    }

    /// 遅れて返す応答の遅れ。取り消しはこの間に行う。
    const LATE: Duration = Duration::from_millis(500);

    struct Server {
        endpoint: Endpoint,
        requests: Receiver<Vec<u8>>,
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut raw = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).expect("read");
            if read == 0 {
                return raw;
            }
            raw.extend_from_slice(&buffer[..read]);
            let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else { continue };
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map_or(0, |value| value.trim().parse().expect("length"));
            if raw.len() >= end + 4 + length {
                return raw;
            }
        }
    }

    /// 127.0.0.1 の試験のサーバ。台本の順に 1 接続ずつ答える。
    fn serve(replies: Vec<Reply>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (sender, requests) = mpsc::channel();
        thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let raw = read_request(&mut stream);
                let _ = sender.send(raw);
                match reply {
                    Reply::Bytes(bytes) => {
                        let _ = stream.write_all(&bytes);
                    }
                    Reply::Hold => thread::sleep(HOLD),
                    Reply::Late(delay, bytes) => {
                        thread::sleep(delay);
                        let _ = stream.write_all(&bytes);
                    }
                }
            }
        });
        Server {
            endpoint: Endpoint { host: "127.0.0.1", port, secure: false },
            requests,
        }
    }

    fn http(status: &str, extra: &str, body: &str) -> Reply {
        Reply::Bytes(
            format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len())
                .into_bytes(),
        )
    }

    fn translated(pairs: Value) -> String {
        json!({ "candidates": [{ "content": { "parts": [{ "text": pairs.to_string() }] }, "finishReason": "STOP" }] }).to_string()
    }

    fn request_to(endpoint: Endpoint) -> HttpRequest {
        HttpRequest {
            endpoint,
            path: "/v1beta/models/gemini-3.1-flash-lite:generateContent".into(),
            key_header: KEY_HEADER,
            body: br#"{"contents":[]}"#.to_vec(),
        }
    }

    fn key() -> Secret {
        Secret::new(KEY.to_owned())
    }

    fn count(haystack: &[u8], needle: &[u8]) -> usize {
        haystack.windows(needle.len()).filter(|window| *window == needle).count()
    }

    #[test]
    fn key_only_in_header() {
        let server = serve(vec![http("200 OK", "", "{}")]);
        let transport = WinHttpTransport::local(vec![server.endpoint], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
        let response = transport.send(&request_to(server.endpoint), &key(), &Cancel::default()).expect("sent");
        assert_eq!(response.status, 200);
        let raw = server.requests.recv().expect("request");
        let end = raw.windows(4).position(|window| window == b"\r\n\r\n").expect("head");
        let (head, body) = raw.split_at(end);
        let head = String::from_utf8_lossy(head);
        let request_line = head.lines().next().expect("line");
        assert_eq!(request_line, "POST /v1beta/models/gemini-3.1-flash-lite:generateContent HTTP/1.1");
        // キーは全体でちょうど 1 回、キーのヘッダの行にだけある
        assert_eq!(count(&raw, KEY.as_bytes()), 1);
        let key_lines: Vec<&str> = head.lines().filter(|line| line.contains(KEY)).collect();
        assert_eq!(key_lines, vec![format!("{KEY_HEADER}: {KEY}")]);
        assert_eq!(count(body, KEY.as_bytes()), 0);
        assert!(head.to_ascii_lowercase().contains("content-type: application/json"));
    }

    #[test]
    fn keys_that_could_inject_headers_are_refused_before_sending() {
        let transport = WinHttpTransport::local(vec![Endpoint { host: "127.0.0.1", port: 9, secure: false }], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
        for bad in [format!("{KEY}\r\nX-Other: 1"), format!("{KEY} x"), String::new()] {
            let result = transport.send(&request_to(transport.allowed[0]), &Secret::new(bad), &Cancel::default());
            assert_eq!(result, Err(TransportError::Refused));
        }
        assert_eq!(transport.sessions_opened(), 0);
    }

    #[test]
    fn production_refuses_other_destinations() {
        assert_eq!(PRODUCTION_ENDPOINTS, [GEMINI_ENDPOINT]);
        assert!(PRODUCTION_ENDPOINTS.iter().all(|endpoint| endpoint.secure && endpoint.port == 443));
        let transport = WinHttpTransport::production();
        let others = [
            Endpoint { host: "127.0.0.1", port: 443, secure: true },
            Endpoint { host: "evil.example", port: 443, secure: true },
            // 同じ名でも平文や別のポートは許さない
            Endpoint { secure: false, ..GEMINI_ENDPOINT },
            Endpoint { port: 8443, ..GEMINI_ENDPOINT },
        ];
        for endpoint in others {
            assert_eq!(transport.send(&request_to(endpoint), &key(), &Cancel::default()), Err(TransportError::Refused));
        }
        // 拒んだときはセッションも作らない
        assert_eq!(transport.sessions_opened(), 0);
    }

    #[test]
    fn no_session_until_first_job() {
        let server = serve(vec![http("200 OK", "", "{}"), http("200 OK", "", "{}")]);
        let transport = WinHttpTransport::local(vec![server.endpoint], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
        assert_eq!(transport.sessions_opened(), 0);
        let production = WinHttpTransport::production();
        assert_eq!(production.sessions_opened(), 0);
        assert!(production.session.lock().expect("session").is_none());

        transport.send(&request_to(server.endpoint), &key(), &Cancel::default()).expect("first");
        assert_eq!(transport.sessions_opened(), 1);
        transport.send(&request_to(server.endpoint), &key(), &Cancel::default()).expect("second");
        // 同じ仕事の中では作り直さない
        assert_eq!(transport.sessions_opened(), 1);
    }

    #[test]
    fn redirects_are_not_followed() {
        // 転送先の聞き手。接続が来たら印を残す
        let thief = TcpListener::bind("127.0.0.1:0").expect("bind");
        let thief_port = thief.local_addr().expect("addr").port();
        thief.set_nonblocking(true).expect("nonblocking");
        let location = format!("Location: http://127.0.0.1:{thief_port}/steal\r\n");
        let server = serve(vec![http("302 Found", &location, "")]);
        let thief_endpoint = Endpoint { host: "127.0.0.1", port: thief_port, secure: false };
        // 転送先も許した一覧に入れ、転送を止めるのが転送の決まりだけであることを確かめる
        let transport = WinHttpTransport::local(vec![server.endpoint, thief_endpoint], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
        let response = transport.send(&request_to(server.endpoint), &key(), &Cancel::default()).expect("sent");
        assert_eq!(response.status, 302);
        thread::sleep(Duration::from_millis(200));
        assert!(thief.accept().is_err(), "the redirect was followed");
    }

    #[test]
    fn large_responses_are_refused() {
        let body = "x".repeat(4096);
        let server = serve(vec![http("200 OK", "", &body)]);
        let transport = WinHttpTransport::local(vec![server.endpoint], TEST_TIMEOUT, 1024);
        assert_eq!(transport.send(&request_to(server.endpoint), &key(), &Cancel::default()), Err(TransportError::TooLarge));
    }

    #[test]
    fn slow_server_times_out() {
        let server = serve(vec![Reply::Hold]);
        let transport = WinHttpTransport::local(vec![server.endpoint], Duration::from_secs(1), MAX_RESPONSE_BYTES);
        let started = Instant::now();
        assert_eq!(transport.send(&request_to(server.endpoint), &key(), &Cancel::default()), Err(TransportError::Timeout));
        assert!(started.elapsed() < HOLD);
    }

    #[test]
    fn cancel_stops_job() {
        // 1 組目は訳を返し、2 組目は少し遅れて訳を返す。遅れている間に取り消す。
        // 別のスレッドからハンドルを閉じず、呼び出しが戻った所で取り消しを見て、その組の訳を捨てる
        let first = translated(json!([{ "i": 0, "t": "訳a" }]));
        let second = translated(json!([{ "i": 0, "t": "訳b" }]));
        let Reply::Bytes(late) = http("200 OK", "", &second) else { unreachable!() };
        let server = serve(vec![http("200 OK", "", &first), Reply::Late(LATE, late)]);
        let endpoint = server.endpoint;
        let items = vec![ItemIn { id: 1, text: "a".into() }, ItemIn { id: 2, text: "b".into() }];
        let limits = crate::translate::batch::Limits { batch_items: 1, ..LIMITS };
        let planned = plan(items, &limits).expect("plan");
        let cancel = Arc::new(Cancel::default());
        let worker_cancel = Arc::clone(&cancel);
        let (events_sender, events) = mpsc::channel();
        let worker = thread::spawn(move || {
            let transport = WinHttpTransport::local(vec![endpoint], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
            let service = Gemini::at(endpoint);
            let key = key();
            let wait = |duration: Duration| worker_cancel.wait(duration);
            let job = Job {
                id: 3,
                plan: &planned,
                service: &service,
                transport: &transport,
                key: &key,
                target: "ja",
                model: crate::translate::GEMINI_MODELS[0],
                models: &crate::translate::GEMINI_MODELS,
                fallback: false,
                cancel: &worker_cancel,
                retry: RETRY,
                wait: &wait,
            };
            job::run(&job, &mut |event| {
                let _ = events_sender.send(event);
            });
        });
        server.requests.recv().expect("first request");
        server.requests.recv().expect("second request");
        let started = Instant::now();
        cancel.cancel();
        worker.join().expect("worker");
        let elapsed = started.elapsed();
        let events: Vec<JobEvent> = events.try_iter().collect();
        // 戻るのは応答が届いた時（時間切れより前）。画面を止まった扱いにするのは TranslateState::cancel の役目
        assert!(elapsed < TEST_TIMEOUT, "cancel took {elapsed:?}");
        assert_eq!(
            events,
            vec![
                JobEvent::Translated { job: 3, model: crate::translate::GEMINI_MODELS[0].into(), results: vec![job::Translated { id: 1, text: "訳a".into() }] },
                JobEvent::Finished { job: 3, error: Some(ErrorKind::Cancelled), detail: None },
            ]
        );
    }

    #[test]
    fn cancel_before_send_opens_nothing() {
        let transport = WinHttpTransport::local(vec![Endpoint { host: "127.0.0.1", port: 9, secure: false }], TEST_TIMEOUT, MAX_RESPONSE_BYTES);
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(transport.send(&request_to(transport.allowed[0]), &key(), &cancel), Err(TransportError::Cancelled));
        assert_eq!(transport.sessions_opened(), 0);
    }
}
