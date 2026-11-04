//! 翻訳の機能。設定と API キーの置き場所（T1）と、翻訳の核（T2）。
//!
//! キーは資格情報マネージャーに置き、設定の JSON とログと画面に出さない。
//! WebView へは「キーがあるか」の真偽だけを返し、キーを返す口は作らない。
//! 通信は Rust だけが行う。翻訳が有効かは Rust が設定ファイルから読み、WebView の申告は信じない。
//! 無効なら Transport を作らない（WinHTTP のセッションも作られない）。

pub mod batch;
pub mod credential;
pub mod gemini;
pub mod job;
pub mod secret;
pub mod service;
#[cfg(windows)]
pub mod winhttp;

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::settings::store::{Change, Store, Translation};
use crate::settings::{on_worker, record};
use batch::{ItemIn, LIMITS, PlanError, plan};
use credential::{CredentialManager, KeyStore, MAX_SECRET_BYTES, legacy_target, target_for};
use gemini::Gemini;
use job::{Job, JobEvent, RETRY};
use secret::Secret;
use service::{Cancel, Transport};

/// 訳す先の言語。翻訳先は UI の言語なので、UI の言語の一覧と同じ。
pub const TARGETS: [&str; 2] = crate::settings::store::LANGUAGES;

/// 翻訳のサービス。先頭が既定。
pub const SERVICES: [&str; 1] = ["gemini"];
pub const DEFAULT_SERVICE: &str = SERVICES[0];
/// 無料枠か有料の API か。先頭が既定。どちらになるかはキーのプロジェクトで Google が決める
/// （課金を有効にしたプロジェクトのキーなら有料）。F5 からはそれぞれにキーを置き、翻訳のたびに選ぶ。
pub const TIERS: [&str; 2] = ["free", "paid"];
pub const DEFAULT_TIER: &str = TIERS[0];
/// Gemini のモデル。先頭が既定（安定版で最も安い Flash-Lite）。URL のパスに入るので、一覧の外は使わない。
pub const GEMINI_MODELS: [&str; 3] = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
];

/// サービスのモデルの一覧。知らないサービスは空。
pub fn models(service: &str) -> &'static [&'static str] {
    match service {
        "gemini" => &GEMINI_MODELS,
        _ => &[],
    }
}

/// サービスの既定のモデル。知らないサービスは空の文字列（どの一覧にも当たらない）。
pub fn default_model(service: &str) -> &'static str {
    models(service).first().copied().unwrap_or("")
}

/// WebView へ返す翻訳の設定。キーそのものは持たない。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationView {
    pub enabled: bool,
    pub service: String,
    pub model: String,
    /// 混雑のときに別のモデルへ切り替えるか。
    pub fallback: bool,
    /// 送る前に確かめるか。
    pub confirm: bool,
    /// 結果の小窓に「訳は機械の推測」の注意書きを出すか。
    pub machine_notice: bool,
    /// キーのある枠（`TIERS` の順）。
    pub key_tiers: Vec<&'static str>,
    /// F5 より前の、枠の決まっていないキーが残っているか（移すまで翻訳には使わない）。
    pub has_legacy_key: bool,
    pub services: Vec<&'static str>,
    pub tiers: Vec<&'static str>,
    pub models: Vec<&'static str>,
}

/// 設定の値が一覧の外。どの値が外れたかだけを言う。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsError {
    Service,
    Model,
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Service => "unknown translation service",
            Self::Model => "unknown translation model",
        })
    }
}

/// キーを受け付けない理由。文にキーもキーの一部も入れない。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    Empty,
    TooLong,
    /// 空白、制御文字、ASCII の外の文字。HTTP のヘッダに入るので受け付けない。
    BadCharacter,
    /// 資格情報マネージャーの誤り（Win32 の番号）。
    Store(u32),
    /// 書けたと OS が答えたのに、書いた直後に読み直すと無い、または違う（F1-b）。
    NotSaved,
    /// 無料枠か有料かの値が一覧の外。
    Tier,
    /// 移す元（F5 より前のキー）が無い。
    NoLegacy,
    /// 移す先にもうキーがある。黙って上書きしない（先に移す先のキーを削除してもらう）。
    Occupied,
}

impl KeyError {
    /// WebView が辞書のキーを引く短い名。文にキーを入れない。
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong => "tooLong",
            Self::BadCharacter => "badCharacter",
            Self::Store(_) => "store",
            Self::NotSaved => "notSaved",
            Self::Tier => SETTINGS_ERROR_CODE,
            Self::NoLegacy => "noLegacy",
            Self::Occupied => "occupied",
        }
    }
}

impl fmt::Display for KeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("translation key is empty"),
            Self::TooLong => formatter.write_str("translation key is too long"),
            Self::BadCharacter => {
                formatter.write_str("translation key has a character that is not allowed")
            }
            Self::Store(code) => write!(formatter, "credential manager error {code}"),
            Self::NotSaved => formatter.write_str("translation key was not saved"),
            Self::Tier => formatter.write_str("unknown translation tier"),
            Self::NoLegacy => formatter.write_str("no earlier translation key to move"),
            Self::Occupied => formatter.write_str("a translation key is already stored there"),
        }
    }
}

/// 値を一覧で検査する。外れは拒む（既定へ黙って戻さない）。
/// 無料枠か有料かは設定に持たない（翻訳のたびに選ぶ）。`tier` は既定の値を入れるが、ファイルには書かれない。
pub fn checked_settings(
    enabled: bool,
    service: &str,
    model: &str,
    fallback: bool,
    confirm: bool,
    machine_notice: bool,
) -> Result<Translation, SettingsError> {
    if !SERVICES.contains(&service) {
        return Err(SettingsError::Service);
    }
    if !models(service).contains(&model) {
        return Err(SettingsError::Model);
    }
    Ok(Translation {
        enabled,
        service: service.into(),
        tier: DEFAULT_TIER.into(),
        model: model.into(),
        fallback,
        confirm,
        machine_notice,
    })
}

/// 一覧の中の枠の名（`'static`）を返す。外れは `None`。
fn listed_tier(tier: &str) -> Option<&'static str> {
    TIERS.iter().copied().find(|listed| *listed == tier)
}

/// 貼り付けで付いた前後の空白を除き、ヘッダに入れてよい文字だけかを確かめる。
pub fn accept_key(raw: String) -> Result<Secret, KeyError> {
    // 先に Secret へ移すので、拒んだときも中身は塗って捨てられる
    let mut secret = Secret::new(raw);
    secret.trim_in_place();
    if secret.is_empty() {
        return Err(KeyError::Empty);
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err(KeyError::TooLong);
    }
    if !secret.expose().iter().all(u8::is_ascii_graphic) {
        return Err(KeyError::BadCharacter);
    }
    Ok(secret)
}

fn view(store: &Store, keys: &dyn KeyStore) -> Result<TranslationView, KeyError> {
    let translation = store.snapshot().translation;
    let mut key_tiers = Vec::new();
    for tier in TIERS {
        if keys
            .exists(&target_for(&translation.service, tier))
            .map_err(KeyError::Store)?
        {
            key_tiers.push(tier);
        }
    }
    let has_legacy_key = keys
        .exists(&legacy_target(&translation.service))
        .map_err(KeyError::Store)?;
    Ok(TranslationView {
        models: models(&translation.service).to_vec(),
        enabled: translation.enabled,
        service: translation.service,
        model: translation.model,
        fallback: translation.fallback,
        confirm: translation.confirm,
        machine_notice: translation.machine_notice,
        key_tiers,
        has_legacy_key,
        services: SERVICES.to_vec(),
        tiers: TIERS.to_vec(),
    })
}

/// 書いてから読み直して比べる。OS が書けたと答えても、読み直して無い・違うなら
/// `NotSaved` を返し、書けたとは言わない（F1-b。資格情報マネージャーへの書き込みが
/// 並ぶと、書いた直後の読みが「無い」を返すことがある）。違う値は消さない（別の書き手の物かもしれない）。
fn write_checked(keys: &dyn KeyStore, target: &str, secret: &Secret) -> Result<(), KeyError> {
    keys.write(target, secret).map_err(KeyError::Store)?;
    match keys.read(target).map_err(KeyError::Store)? {
        Some(stored) if stored.expose() == secret.expose() => Ok(()),
        _ => Err(KeyError::NotSaved),
    }
}

/// 今のサービスの、選んだ枠（無料枠用か有料用）の置き場所へキーを書く。設定の JSON には触らない。
fn save_key(store: &Store, keys: &dyn KeyStore, tier: &str, raw: String) -> Result<(), KeyError> {
    // 先に Secret へ移す（枠が外れて拒むときも、キーは塗って捨てられる）
    let secret = accept_key(raw)?;
    let tier = listed_tier(tier).ok_or(KeyError::Tier)?;
    let target = target_for(&store.snapshot().translation.service, tier);
    write_checked(keys, &target, &secret)
}

fn clear_key(store: &Store, keys: &dyn KeyStore, tier: &str) -> Result<(), KeyError> {
    let tier = listed_tier(tier).ok_or(KeyError::Tier)?;
    let service = store.snapshot().translation.service;
    keys.delete(&target_for(&service, tier)).map_err(KeyError::Store)
}

/// キーを `from` から `to` へ移す。移す先に書き、読み直して同じと確かめてから、元を消す。
///
/// 移す先にもうキーがあれば何もせず `Occupied`（黙って上書きしない）。読み直しで確かめられなければ
/// 元を消さずに `NotSaved`（元のキーは残るので、もう一度移せる）。元が無ければ `NoLegacy`。
pub fn move_key(keys: &dyn KeyStore, from: &str, to: &str) -> Result<(), KeyError> {
    let secret = keys.read(from).map_err(KeyError::Store)?.ok_or(KeyError::NoLegacy)?;
    if keys.exists(to).map_err(KeyError::Store)? {
        return Err(KeyError::Occupied);
    }
    write_checked(keys, to, &secret)?;
    keys.delete(from).map_err(KeyError::Store)
}

/// F5 より前のキーを、選んだ枠（無料枠用か有料用）へ移す。
fn move_legacy_key(store: &Store, keys: &dyn KeyStore, tier: &str) -> Result<(), KeyError> {
    let tier = listed_tier(tier).ok_or(KeyError::Tier)?;
    let service = store.snapshot().translation.service;
    move_key(keys, &legacy_target(&service), &target_for(&service, tier))
}

/// 設定の値が一覧の外のときに WebView へ返す短い名（どの値かは画面に出さない）。
pub const SETTINGS_ERROR_CODE: &str = "settings";

/// 翻訳の設定と、キーがあるか。設定ファイルを読み直す。誤りは `KeyError::code` の短い名。
#[tauri::command]
pub async fn translation_settings(app: AppHandle) -> Result<TranslationView, String> {
    on_worker(app, |app| view(&app.state::<Store>(), &CredentialManager))
        .await?
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub async fn set_translation_settings(
    app: AppHandle,
    enabled: bool,
    service: String,
    model: String,
    fallback: bool,
    confirm: bool,
    machine_notice: bool,
) -> Result<(), String> {
    let translation = checked_settings(enabled, &service, &model, fallback, confirm, machine_notice)
        .map_err(|_| SETTINGS_ERROR_CODE.to_owned())?;
    on_worker(app, move |app| record(app, Change::Translation(translation))).await
}

/// 送る前に確かめるかだけを保存する（確かめの「今後表示しない」）。ほかの翻訳の設定には触らない。
#[tauri::command]
pub async fn set_translation_confirm(app: AppHandle, confirm: bool) -> Result<(), String> {
    on_worker(app, move |app| record(app, Change::TranslationConfirm(confirm))).await
}

/// 小窓の注意書きを出すかだけを保存する（小窓の「今後表示しない」）。ほかの翻訳の設定には触らない。
#[tauri::command]
pub async fn set_translation_machine_notice(app: AppHandle, shown: bool) -> Result<(), String> {
    on_worker(app, move |app| record(app, Change::TranslationMachineNotice(shown))).await
}

/// 選んだ枠のキーを書き、読み直して確かめる。受け取った文字列は Secret に移し、捨てるときに塗る。
/// キーは返さない。誤りは `KeyError::code` の短い名（WebView が辞書で引く）。
#[tauri::command]
pub async fn set_translation_key(app: AppHandle, tier: String, key: String) -> Result<(), String> {
    on_worker(app, move |app| save_key(&app.state::<Store>(), &CredentialManager, &tier, key))
        .await?
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub async fn clear_translation_key(app: AppHandle, tier: String) -> Result<(), String> {
    on_worker(app, move |app| clear_key(&app.state::<Store>(), &CredentialManager, &tier))
        .await?
        .map_err(|error| error.code().to_owned())
}

/// F5 より前のキーを、選んだ枠へ移す（書いて読み直してから元を消す）。キーは返さない。
#[tauri::command]
pub async fn move_translation_key(app: AppHandle, tier: String) -> Result<(), String> {
    on_worker(app, move |app| move_legacy_key(&app.state::<Store>(), &CredentialManager, &tier))
        .await?
        .map_err(|error| error.code().to_owned())
}

/// 仕事を始めない理由。WebView は `code` で辞書のキーを引く。文にキーを入れない。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartError {
    /// 翻訳が無効（設定ファイルの値）。
    Disabled,
    /// キーが無い。
    NoKey,
    /// 置き場所のキーがヘッダに入れられない文字を含む。
    Key,
    /// 訳す先の言語が一覧の外。
    Target,
    /// 設定のサービスかモデルが一覧の外。
    Settings,
    /// 無料枠か有料かの値が一覧の外。
    Tier,
    /// 別の仕事が動いている（1 度に 1 つ）。
    Busy,
    Plan(PlanError),
    /// 資格情報マネージャーの誤り（Win32 の番号）。
    Store(u32),
    /// 仕事のスレッドを作れない。
    Thread,
}

impl StartError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NoKey => "noKey",
            Self::Key => "key",
            Self::Target => "target",
            Self::Settings => "settings",
            Self::Tier => "tier",
            Self::Busy => "busy",
            Self::Plan(error) => error.code(),
            Self::Store(_) => "store",
            Self::Thread => "thread",
        }
    }
}

/// 知らせの出口。取り消しか仕事の終わりのどちらか先の方が取り出し、`Finished` を 1 回だけ出す。
/// 取り出された後の知らせは捨てる（取り消した後に戻った組の訳を画面へ出さない）。
type Sink = Arc<Mutex<Option<Box<dyn FnMut(JobEvent) + Send>>>>;

struct Running {
    id: u64,
    cancel: Arc<Cancel>,
    sink: Sink,
}

/// 動いている仕事（1 つまで）。Transport はここに持たない（仕事ごとに作る）。
#[derive(Default)]
pub struct TranslateState {
    next: AtomicU64,
    running: Arc<Mutex<Option<Running>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl TranslateState {
    /// 番号の合う仕事を取り消す。合わなければ何もしない。
    ///
    /// 画面へはすぐに `Finished`（取り消し）を出し、次の仕事を受け付ける。
    /// 通信の途中の組は、WinHTTP の呼び出しが戻った所（遅くとも時間切れ）で捨てられる。
    pub fn cancel(&self, id: u64) -> bool {
        // 2 つの鍵を同時に持たない（仕事のスレッドとの行き違いで止まらないように）
        let running = {
            let mut slot = lock(&self.running);
            match slot.as_ref() {
                Some(running) if running.id == id => slot.take(),
                _ => return false,
            }
        };
        let Some(running) = running else { return false };
        running.cancel.cancel();
        let emit = lock(&running.sink).take();
        if let Some(mut emit) = emit {
            emit(JobEvent::Finished {
                job: id,
                error: Some(service::ErrorKind::Cancelled),
                detail: None,
            });
        }
        true
    }

    #[cfg(test)]
    fn is_idle(&self) -> bool {
        self.running.lock().unwrap_or_else(PoisonError::into_inner).is_none()
    }
}

/// 検査してから仕事を作る。検査を 1 つでも外れたら、Transport を作らずに返す。
/// `make_transport` は仕事のスレッドの中で 1 回だけ呼ぶ。`tier` は右クリックで選んだ枠で、
/// その枠のキーだけを読む（F5 より前のキーは使わない）。
#[allow(clippy::too_many_arguments)]
pub fn begin<T, F, E>(
    state: &TranslateState,
    translation: &Translation,
    keys: &dyn KeyStore,
    tier: &str,
    items: Vec<ItemIn>,
    target: &str,
    make_transport: F,
    emit: E,
) -> Result<(u64, JoinHandle<()>), StartError>
where
    T: Transport + 'static,
    F: FnOnce() -> T + Send + 'static,
    E: FnMut(JobEvent) + Send + 'static,
{
    // (1) 有効か。設定ファイルから読んだ値だけを見る
    if !translation.enabled {
        return Err(StartError::Disabled);
    }
    if !TARGETS.contains(&target) {
        return Err(StartError::Target);
    }
    let checked = checked_settings(
        true,
        &translation.service,
        &translation.model,
        translation.fallback,
        translation.confirm,
        translation.machine_notice,
    )
    .map_err(|_| StartError::Settings)?;
    let tier = listed_tier(tier).ok_or(StartError::Tier)?;
    // (2) 件数と文字の上限
    let planned = plan(items, &LIMITS).map_err(StartError::Plan)?;
    // (3) 選んだ枠のキーがあるか
    let key = keys
        .read(&target_for(&checked.service, tier))
        .map_err(StartError::Store)?
        .ok_or(StartError::NoKey)?;
    if !key.expose().iter().all(u8::is_ascii_graphic) {
        return Err(StartError::Key);
    }
    let mut running = state.running.lock().unwrap_or_else(PoisonError::into_inner);
    if running.is_some() {
        return Err(StartError::Busy);
    }
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(Cancel::default());
    let sink: Sink = Arc::new(Mutex::new(Some(Box::new(emit))));
    *running = Some(Running {
        id,
        cancel: Arc::clone(&cancel),
        sink: Arc::clone(&sink),
    });
    let slot = Arc::clone(&state.running);
    let target = target.to_owned();
    let spawned = thread::Builder::new()
        .name("translate".into())
        .spawn(move || {
            let transport = make_transport();
            let service = Gemini::new();
            let wait = |duration: std::time::Duration| cancel.wait(duration);
            let job = Job {
                id,
                plan: &planned,
                service: &service,
                transport: &transport,
                key: &key,
                target: &target,
                model: &checked.model,
                models: models(&checked.service),
                fallback: checked.fallback,
                cancel: &cancel,
                retry: RETRY,
                wait: &wait,
            };
            job::run(&job, &mut |event| {
                if !matches!(event, JobEvent::Finished { .. }) {
                    if let Some(emit) = lock(&sink).as_mut() {
                        emit(event);
                    }
                    return;
                }
                // 終わりを知らせる前に空ける（知らせを受けてすぐ次を頼めるように）。
                // 鍵は 1 つずつ持つ（取り消しの側と同じ順で、同時に持たない）
                {
                    let mut running = lock(&slot);
                    if running.as_ref().is_some_and(|running| running.id == id) {
                        *running = None;
                    }
                }
                let emit = lock(&sink).take();
                if let Some(mut emit) = emit {
                    emit(event);
                }
            });
        });
    match spawned {
        Ok(handle) => Ok((id, handle)),
        Err(_) => {
            *running = None;
            Err(StartError::Thread)
        }
    }
}

/// 本番の Transport。作るだけでは何も開かない（セッションは最初の送信で作る）。
#[cfg(windows)]
fn production_transport() -> winhttp::WinHttpTransport {
    winhttp::WinHttpTransport::production()
}

/// Windows の外には通信の部品が無い。送らずに拒む。
#[cfg(not(windows))]
struct Unsupported;

#[cfg(not(windows))]
impl Transport for Unsupported {
    fn send(
        &self,
        _request: &service::HttpRequest,
        _key: &Secret,
        _cancel: &Cancel,
    ) -> Result<service::HttpResponse, service::TransportError> {
        Err(service::TransportError::Refused)
    }
}

#[cfg(not(windows))]
fn production_transport() -> Unsupported {
    Unsupported
}

/// 翻訳の仕事を始める。進み具合と組ごとの結果は `channel` で届く。戻りは仕事の番号。
#[tauri::command]
pub async fn translate_start(
    app: AppHandle,
    items: Vec<ItemIn>,
    target: String,
    tier: String,
    channel: Channel<JobEvent>,
) -> Result<u64, String> {
    on_worker(app, move |app| {
        // 設定ファイルを読み直し、WebView の申告ではなくファイルの値で有効かを決める。
        // 枠（無料枠か有料か）は利用者が右クリックで選んだ物で、どのキーを読むかだけを決める
        let translation = app.state::<Store>().snapshot().translation;
        begin(
            app.state::<TranslateState>().inner(),
            &translation,
            &CredentialManager,
            &tier,
            items,
            &target,
            production_transport,
            move |event| {
                let _ = channel.send(event);
            },
        )
        .map(|(id, _)| id)
        .map_err(|error| error.code().to_owned())
    })
    .await?
}

#[tauri::command]
pub fn translate_cancel(state: tauri::State<'_, TranslateState>, job: u64) -> bool {
    state.cancel(job)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;
    use crate::settings::store::SETTINGS_FILE;

    const SAMPLE: &str = "test-not-a-real-key-AbCdEf0123456789";

    #[derive(Default)]
    struct MemoryKeys(Mutex<HashMap<String, Vec<u8>>>);

    impl KeyStore for MemoryKeys {
        fn write(&self, target: &str, secret: &Secret) -> Result<(), u32> {
            let mut keys = self.0.lock().expect("keys");
            keys.insert(target.into(), secret.expose().to_vec());
            Ok(())
        }
        fn read(&self, target: &str) -> Result<Option<Secret>, u32> {
            let keys = self.0.lock().expect("keys");
            Ok(keys.get(target).cloned().map(Secret::from_bytes))
        }
        fn delete(&self, target: &str) -> Result<(), u32> {
            self.0.lock().expect("keys").remove(target);
            Ok(())
        }
    }

    struct Folder(PathBuf);

    impl Folder {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "jgv-translate-{}-{tag}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("folder");
            Self(path)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn key_never_in_settings_json() {
        let folder = Folder::new("settings-json");
        let path = folder.0.join(SETTINGS_FILE);
        let store = Store::load(Some(path.clone()));
        let keys = MemoryKeys::default();

        let enabled = checked_settings(true, "gemini", GEMINI_MODELS[1], true, true, true).expect("valid");
        assert_eq!(store.update(Change::Translation(enabled)), None);
        save_key(&store, &keys, "paid", format!("  {SAMPLE}\r\n")).expect("save");
        assert_eq!(store.update(Change::WrapLines(true)), None);

        let written = fs::read_to_string(&path).expect("settings file");
        let probe = &SAMPLE[SAMPLE.len() - 12..];
        assert!(!written.contains(SAMPLE), "key in settings: {written}");
        assert!(!written.contains(probe), "part of the key in settings: {written}");
        let parsed: Value = serde_json::from_str(&written).expect("json");
        let mut names: Vec<&str> = parsed.as_object().expect("object").keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "translationConfirm",
                "translationEnabled",
                "translationFallback",
                "translationMachineNotice",
                "translationModel",
                "translationService",
                "wrapLines"
            ]
        );

        // キーは有料用の置き場所に、前後の空白を除いて入る。無料枠用と F5 より前の置き場所には入らない
        let stored = keys.read(&target_for("gemini", "paid")).expect("read").expect("found");
        assert_eq!(stored.expose(), SAMPLE.as_bytes());
        assert!(keys.read(&target_for("gemini", "free")).expect("read").is_none());
        assert!(keys.read(&legacy_target("gemini")).expect("read").is_none());

        // WebView へ返す値にもキーは無く、どの枠にあるかだけがある
        let shown = view(&store, &keys).expect("view");
        assert_eq!(shown.key_tiers, ["paid"]);
        assert!(!shown.has_legacy_key);
        let serialized = serde_json::to_string(&shown).expect("serialize");
        assert!(!serialized.contains(probe), "key in view: {serialized}");
        assert!(serialized.contains("\"keyTiers\":[\"paid\"]"), "{serialized}");
        assert!(serialized.contains("\"machineNotice\":true"), "{serialized}");
        assert!(!serialized.contains("\"tier\":"), "{serialized}");

        // 無料枠用も置くと両方。消すと選んだ枠だけが消える
        save_key(&store, &keys, "free", SAMPLE.to_owned()).expect("save free");
        assert_eq!(view(&store, &keys).expect("view").key_tiers, ["free", "paid"]);
        clear_key(&store, &keys, "paid").expect("clear");
        assert_eq!(view(&store, &keys).expect("view").key_tiers, ["free"]);
        clear_key(&store, &keys, "free").expect("clear");
        assert!(view(&store, &keys).expect("view").key_tiers.is_empty());
        // 一覧の外の枠は拒み、どこにも書かない
        assert_eq!(save_key(&store, &keys, "Paid", SAMPLE.to_owned()), Err(KeyError::Tier));
        assert_eq!(clear_key(&store, &keys, ""), Err(KeyError::Tier));
        assert!(keys.0.lock().expect("keys").is_empty());
        let after = fs::read_to_string(&path).expect("settings file");
        assert!(!after.contains(probe));
    }

    /// 書き込みの後の読みを差し替える置き場所。OS が「書けた」と答えたのに残らない形を作る（F1-b）。
    enum Lost {
        /// 書き込みが消える（前の値があればそれが残る）。
        Dropped,
        /// 別の値が残る。
        Altered,
        /// 読み直しが OS の誤りを返す。
        ReadFails(u32),
    }

    struct LosingKeys {
        inner: MemoryKeys,
        lost: Lost,
    }

    impl KeyStore for LosingKeys {
        fn write(&self, target: &str, secret: &Secret) -> Result<(), u32> {
            match self.lost {
                Lost::Dropped => Ok(()),
                Lost::Altered => self.inner.write(target, &Secret::new("test-not-a-real-key-other".to_owned())),
                Lost::ReadFails(_) => self.inner.write(target, secret),
            }
        }
        fn read(&self, target: &str) -> Result<Option<Secret>, u32> {
            match self.lost {
                Lost::ReadFails(code) => Err(code),
                _ => self.inner.read(target),
            }
        }
        fn delete(&self, target: &str) -> Result<(), u32> {
            self.inner.delete(target)
        }
    }

    #[test]
    fn key_save_lost_write_is_reported() {
        let folder = Folder::new("lost-write");
        let store = Store::load(Some(folder.0.join(SETTINGS_FILE)));
        let target = target_for("gemini", "free");

        // 初めての保存で書き込みが消える
        let keys = LosingKeys { inner: MemoryKeys::default(), lost: Lost::Dropped };
        assert_eq!(save_key(&store, &keys, "free", SAMPLE.to_owned()), Err(KeyError::NotSaved));
        assert!(view(&store, &keys).expect("view").key_tiers.is_empty());

        // 入れ直しの書き込みが消え、前のキーが残る。「ある」だけで成功と言わない
        let old = "test-not-a-real-key-previous";
        keys.inner.write(&target, &Secret::new(old.to_owned())).expect("seed");
        assert_eq!(save_key(&store, &keys, "free", SAMPLE.to_owned()), Err(KeyError::NotSaved));
        // 前の値は消さない（別の書き手の物かもしれない）
        assert_eq!(keys.inner.read(&target).expect("read").expect("kept").expose(), old.as_bytes());

        // 違う値が残る
        let keys = LosingKeys { inner: MemoryKeys::default(), lost: Lost::Altered };
        assert_eq!(save_key(&store, &keys, "paid", SAMPLE.to_owned()), Err(KeyError::NotSaved));

        // 読み直しが誤りなら、その番号を返す（保存できたとは言わない）
        let keys = LosingKeys { inner: MemoryKeys::default(), lost: Lost::ReadFails(1312) };
        assert_eq!(save_key(&store, &keys, "paid", SAMPLE.to_owned()), Err(KeyError::Store(1312)));

        // WebView へ返す短い名と文にキーが入らない
        for error in [KeyError::NotSaved, KeyError::Store(1312), KeyError::Occupied, KeyError::NoLegacy, KeyError::Tier] {
            for text in [error.to_string(), error.code().to_owned(), format!("{error:?}")] {
                assert!(!text.contains("AbCdEf"), "key in error: {text}");
            }
        }
        assert_eq!(KeyError::NotSaved.code(), "notSaved");

        // 書き込みが残る置き場所では成功する（読み直しが成功の条件を狭めすぎない）
        let keys = MemoryKeys::default();
        assert_eq!(save_key(&store, &keys, "free", format!(" {SAMPLE}\n")), Ok(()));
    }

    #[test]
    fn key_error_codes_are_in_the_dictionary() {
        // 画面は `app.settings.translation.error.{code}` を引く。辞書は TS の試験が全数を見るので、ここは名の一覧を固める
        let codes: Vec<&str> = [
            KeyError::Empty,
            KeyError::TooLong,
            KeyError::BadCharacter,
            KeyError::Store(5),
            KeyError::NotSaved,
            KeyError::Tier,
            KeyError::NoLegacy,
            KeyError::Occupied,
        ]
        .iter()
        .map(|error| error.code())
        .collect();
        assert_eq!(codes, ["empty", "tooLong", "badCharacter", "store", "notSaved", "settings", "noLegacy", "occupied"]);
        assert_eq!(SETTINGS_ERROR_CODE, "settings");
        assert_eq!(StartError::Tier.code(), "tier");
    }

    #[test]
    fn key_errors_never_contain_key() {
        let cases = [
            (String::new(), KeyError::Empty),
            (" \r\n\t ".to_owned(), KeyError::Empty),
            (format!("{SAMPLE}\r\nX-Other: 1"), KeyError::BadCharacter),
            (format!("{SAMPLE} {SAMPLE}"), KeyError::BadCharacter),
            (format!("{SAMPLE}\u{3042}"), KeyError::BadCharacter),
            (SAMPLE.repeat(MAX_SECRET_BYTES / SAMPLE.len() + 1), KeyError::TooLong),
        ];
        for (raw, expected) in cases {
            let error = accept_key(raw).expect_err("refused");
            assert_eq!(error, expected);
            for text in [error.to_string(), format!("{error:?}")] {
                assert!(!text.contains("AbCdEf"), "key in error: {text}");
            }
        }
        assert_eq!(accept_key(format!("\t{SAMPLE}\n")).expect("accepted").expose(), SAMPLE.as_bytes());
    }

    #[test]
    fn settings_outside_the_lists_are_refused() {
        assert!(checked_settings(false, "gemini", "gemini-3.1-flash-lite", true, true, true).is_ok());
        assert!(!checked_settings(true, "gemini", "gemini-3.1-flash-lite", false, true, true).expect("valid").fallback);
        assert!(!checked_settings(true, "gemini", "gemini-3.1-flash-lite", true, false, true).expect("valid").confirm);
        assert!(!checked_settings(true, "gemini", "gemini-3.1-flash-lite", true, true, false).expect("valid").machine_notice);
        assert_eq!(
            checked_settings(true, "openai", "gemini-3.1-flash-lite", true, true, true),
            Err(SettingsError::Service)
        );
        for model in ["", "gemini-flash-latest", "../models/x", "gemini-3.1-flash-lite?key=1"] {
            assert_eq!(checked_settings(true, "gemini", model, true, true, true), Err(SettingsError::Model));
        }
        assert_eq!(default_model(DEFAULT_SERVICE), "gemini-3.1-flash-lite");
        for tier in TIERS {
            assert_eq!(listed_tier(tier), Some(tier));
        }
        for tier in ["", "Free", "PAID", "free ", "legacy"] {
            assert_eq!(listed_tier(tier), None, "{tier}");
        }
    }

    /// 確かめの「今後表示しない」は確かめの値だけを書き、読み直しても残る。ほかの翻訳の設定は替わらない。
    #[test]
    fn confirm_choice_round_trips_through_the_settings_file() {
        let folder = Folder::new("confirm");
        let path = folder.0.join(SETTINGS_FILE);
        let store = Store::load(Some(path.clone()));
        let keys = MemoryKeys::default();
        assert!(view(&store, &keys).expect("view").confirm, "default is to confirm");

        let chosen = checked_settings(true, "gemini", GEMINI_MODELS[1], false, true, true).expect("valid");
        assert_eq!(store.update(Change::Translation(chosen.clone())), None);
        assert_eq!(store.update(Change::TranslationConfirm(false)), None);

        let reloaded = Store::load(Some(path.clone()));
        let shown = view(&reloaded, &keys).expect("view");
        assert!(!shown.confirm);
        assert!(shown.enabled);
        assert!(!shown.fallback);
        assert_eq!(shown.model, GEMINI_MODELS[1]);
        let serialized = serde_json::to_string(&shown).expect("serialize");
        assert!(serialized.contains("\"confirm\":false"), "{serialized}");

        // 設定のダイアログの保存で戻せる
        let back = Translation { confirm: true, ..chosen };
        assert_eq!(reloaded.update(Change::Translation(back)), None);
        assert!(Store::load(Some(path)).snapshot().translation.confirm);
    }

    /// 小窓の「今後表示しない」は注意書きの値だけを書き、読み直しても残る。設定のダイアログの保存で戻せる。
    #[test]
    fn machine_notice_choice_round_trips_through_the_settings_file() {
        let folder = Folder::new("machine-notice");
        let path = folder.0.join(SETTINGS_FILE);
        let store = Store::load(Some(path.clone()));
        let keys = MemoryKeys::default();
        assert!(view(&store, &keys).expect("view").machine_notice, "default is to show");

        let chosen = checked_settings(true, "gemini", GEMINI_MODELS[2], true, false, true).expect("valid");
        assert_eq!(store.update(Change::Translation(chosen.clone())), None);
        assert_eq!(store.update(Change::TranslationMachineNotice(false)), None);

        let reloaded = Store::load(Some(path.clone()));
        let shown = view(&reloaded, &keys).expect("view");
        assert!(!shown.machine_notice);
        assert!(shown.enabled);
        assert!(!shown.confirm);
        assert_eq!(shown.model, GEMINI_MODELS[2]);

        let back = Translation { machine_notice: true, ..chosen };
        assert_eq!(reloaded.update(Change::Translation(back)), None);
        assert!(Store::load(Some(path)).snapshot().translation.machine_notice);
    }

    /// F5 より前のキーは、移すまでそのまま残り、翻訳には使わない。移すと書いて読み直してから元を消す。
    #[test]
    fn legacy_key_is_moved_only_when_asked() {
        let folder = Folder::new("legacy");
        let store = Store::load(Some(folder.0.join(SETTINGS_FILE)));
        let keys = MemoryKeys::default();
        let legacy = legacy_target("gemini");
        keys.write(&legacy, &Secret::new(SAMPLE.to_owned())).expect("seed");

        // 開いただけでは移さない。どの枠にも無く、以前のキーがあるとだけ出す
        let shown = view(&store, &keys).expect("view");
        assert!(shown.has_legacy_key);
        assert!(shown.key_tiers.is_empty());
        let serialized = serde_json::to_string(&shown).expect("serialize");
        assert!(serialized.contains("\"hasLegacyKey\":true"), "{serialized}");
        assert!(!serialized.contains(&SAMPLE[SAMPLE.len() - 12..]));
        // 新しい枠のキーを保存・削除しても、以前のキーには触らない
        save_key(&store, &keys, "free", "test-not-a-real-key-free".to_owned()).expect("save free");
        clear_key(&store, &keys, "free").expect("clear free");
        assert_eq!(keys.read(&legacy).expect("read").expect("kept").expose(), SAMPLE.as_bytes());

        // 一覧の外の枠には移さない
        assert_eq!(move_legacy_key(&store, &keys, "Paid"), Err(KeyError::Tier));
        assert!(view(&store, &keys).expect("view").has_legacy_key);

        // 移す先にキーがあれば上書きせず、どちらも残す
        let paid = target_for("gemini", "paid");
        keys.write(&paid, &Secret::new("test-not-a-real-key-paid".to_owned())).expect("seed paid");
        assert_eq!(move_legacy_key(&store, &keys, "paid"), Err(KeyError::Occupied));
        assert_eq!(keys.read(&paid).expect("read").expect("kept").expose(), b"test-not-a-real-key-paid");
        assert_eq!(keys.read(&legacy).expect("read").expect("kept").expose(), SAMPLE.as_bytes());

        // 無料枠へ移す。以前の置き場所は消え、無料枠に同じ値が入る
        assert_eq!(move_legacy_key(&store, &keys, "free"), Ok(()));
        let shown = view(&store, &keys).expect("view");
        assert!(!shown.has_legacy_key);
        assert_eq!(shown.key_tiers, ["free", "paid"]);
        assert_eq!(keys.read(&target_for("gemini", "free")).expect("read").expect("moved").expose(), SAMPLE.as_bytes());
        // 2 度目は元が無い
        assert_eq!(move_legacy_key(&store, &keys, "free"), Err(KeyError::NoLegacy));
    }

    /// 移す先の読み直しで確かめられなければ、元のキーを消さない。
    #[test]
    fn legacy_key_move_keeps_the_source_when_the_write_is_not_confirmed() {
        let legacy = legacy_target("gemini");
        let free = target_for("gemini", "free");
        for lost in [Lost::Dropped, Lost::Altered] {
            let keys = LosingKeys { inner: MemoryKeys::default(), lost };
            keys.inner.write(&legacy, &Secret::new(SAMPLE.to_owned())).expect("seed");
            assert_eq!(move_key(&keys, &legacy, &free), Err(KeyError::NotSaved));
            assert_eq!(keys.inner.read(&legacy).expect("read").expect("kept").expose(), SAMPLE.as_bytes());
        }
        // 読みが誤りなら、その番号を返して何も消さない
        let keys = LosingKeys { inner: MemoryKeys::default(), lost: Lost::ReadFails(1312) };
        keys.inner.write(&legacy, &Secret::new(SAMPLE.to_owned())).expect("seed");
        assert_eq!(move_key(&keys, &legacy, &free), Err(KeyError::Store(1312)));
        assert!(keys.inner.read(&legacy).expect("read").is_some());
    }

    /// 本物の資格情報マネージャーで移す（試験だけの対象名。利用者のキーには触らない）。
    #[cfg(windows)]
    #[test]
    fn legacy_key_move_real_credential_manager() {
        use credential::test_support::{Cleanup, one_at_a_time, test_target};
        let _turn = one_at_a_time();
        let from = test_target("move-from");
        let to = test_target("move-to");
        let _cleanup_from = Cleanup(from.clone());
        let _cleanup_to = Cleanup(to.clone());
        let store = CredentialManager;

        store.write(&from, &Secret::new(SAMPLE.to_owned())).expect("seed");
        // 移す先が埋まっていれば何もしない
        store.write(&to, &Secret::new("test-not-a-real-key-occupied".to_owned())).expect("seed to");
        assert_eq!(move_key(&store, &from, &to), Err(KeyError::Occupied));
        assert_eq!(store.read(&from).expect("read").expect("kept").expose(), SAMPLE.as_bytes());
        store.delete(&to).expect("free the target");

        assert_eq!(move_key(&store, &from, &to), Ok(()));
        assert_eq!(store.read(&to).expect("read").expect("moved").expose(), SAMPLE.as_bytes());
        assert!(store.read(&from).expect("read").is_none());
        assert_eq!(move_key(&store, &from, &to), Err(KeyError::NoLegacy));
    }

    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::time::Duration;

    use job::{JobEvent, Translated};
    use service::{ErrorKind, HttpRequest, HttpResponse, TransportError};

    /// 読んだ回数を数える置き場所。
    #[derive(Default)]
    struct CountingKeys {
        inner: MemoryKeys,
        reads: AtomicUsize,
    }

    impl KeyStore for CountingKeys {
        fn write(&self, target: &str, secret: &Secret) -> Result<(), u32> {
            self.inner.write(target, secret)
        }
        fn read(&self, target: &str) -> Result<Option<Secret>, u32> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.read(target)
        }
        fn delete(&self, target: &str) -> Result<(), u32> {
            self.inner.delete(target)
        }
    }

    fn keys_with_sample() -> CountingKeys {
        let keys = CountingKeys::default();
        keys.inner.write(&target_for("gemini", "free"), &Secret::new(SAMPLE.to_owned())).expect("write");
        keys
    }

    /// 送られた件数を数え、送られた文字列に印を付けて返す。
    struct Echo {
        sent: Arc<AtomicUsize>,
        /// 取り消しを見ずに、`LATE` だけ遅れて普通に返す（同期の通信の途中で取り消された形）。
        late: bool,
    }

    const LATE: Duration = Duration::from_millis(300);
    /// 仕事のスレッドが送り始めるのを待つ上限（試験が止まらないための歯止め）。
    const START_WAIT: Duration = Duration::from_secs(5);

    impl Transport for Echo {
        fn send(&self, request: &HttpRequest, key: &Secret, _cancel: &Cancel) -> Result<HttpResponse, TransportError> {
            assert_eq!(key.expose(), SAMPLE.as_bytes());
            self.sent.fetch_add(1, Ordering::SeqCst);
            if self.late {
                std::thread::sleep(LATE);
            }
            let body: Value = serde_json::from_slice(&request.body).expect("body");
            let data = body.pointer("/contents/0/parts/0/text").and_then(Value::as_str).expect("data");
            let items: Vec<Value> = serde_json::from_str(data).expect("items");
            let pairs: Vec<Value> = items.iter().map(|item| serde_json::json!({ "i": item["i"], "t": format!("訳:{}", item["t"].as_str().expect("t")) })).collect();
            let text = Value::Array(pairs).to_string();
            let reply = serde_json::json!({ "candidates": [{ "content": { "parts": [{ "text": text }] }, "finishReason": "STOP" }] });
            Ok(HttpResponse { status: 200, body: reply.to_string().into_bytes() })
        }
    }

    struct Probe {
        made: Arc<AtomicUsize>,
        sent: Arc<AtomicUsize>,
    }

    impl Probe {
        fn new() -> Self {
            Self { made: Arc::default(), sent: Arc::default() }
        }

        fn factory(&self, late: bool) -> impl FnOnce() -> Echo + Send + 'static {
            let made = Arc::clone(&self.made);
            let sent = Arc::clone(&self.sent);
            move || {
                made.fetch_add(1, Ordering::SeqCst);
                Echo { sent, late }
            }
        }
    }

    fn items(texts: &[&str]) -> Vec<ItemIn> {
        texts.iter().enumerate().map(|(id, text)| ItemIn { id: id as u64, text: (*text).into() }).collect()
    }

    fn settings_file(folder: &Folder, enabled: bool) -> Translation {
        let path = folder.0.join(SETTINGS_FILE);
        fs::write(
            &path,
            serde_json::json!({
                "translationEnabled": enabled,
                "translationService": "gemini",
                "translationTier": "free",
                "translationModel": GEMINI_MODELS[0]
            })
            .to_string(),
        )
        .expect("write settings");
        Store::load(Some(path)).snapshot().translation
    }

    fn ignore(_: JobEvent) {}

    #[test]
    fn disabled_sends_nothing() {
        // 設定ファイルが無効なら、キーがあっても Transport を作らず、キーも読まない
        let folder = Folder::new("disabled");
        let translation = settings_file(&folder, false);
        assert!(!translation.enabled);
        let state = TranslateState::default();
        let keys = keys_with_sample();
        let probe = Probe::new();
        let result = begin(&state, &translation, &keys, "free", items(&["Hello"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::Disabled));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);
        assert_eq!(probe.sent.load(Ordering::SeqCst), 0);
        assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
        assert!(state.is_idle());

        // 設定ファイルに有効の値が無いとき（既定）も同じ
        fs::write(folder.0.join(SETTINGS_FILE), "{}").expect("write");
        let translation = Store::load(Some(folder.0.join(SETTINGS_FILE))).snapshot().translation;
        let result = begin(&state, &translation, &keys, "free", items(&["Hello"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::Disabled));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn no_key_sends_nothing() {
        let folder = Folder::new("no-key");
        let translation = settings_file(&folder, true);
        let state = TranslateState::default();
        let keys = CountingKeys::default();
        let probe = Probe::new();
        let result = begin(&state, &translation, &keys, "free", items(&["Hello"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::NoKey));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);
        assert!(state.is_idle());
    }

    #[test]
    fn bad_requests_are_refused_before_any_transport() {
        let folder = Folder::new("bad-requests");
        let translation = settings_file(&folder, true);
        let state = TranslateState::default();
        let keys = keys_with_sample();
        let probe = Probe::new();
        let cases: Vec<(Vec<ItemIn>, &str, StartError)> = vec![
            (items(&["a"]), "fr", StartError::Target),
            (Vec::new(), "ja", StartError::Plan(PlanError::NoItems)),
            (items(&["a", " "]), "ja", StartError::Plan(PlanError::Blank)),
        ];
        for (sent, target, expected) in cases {
            let result = begin(&state, &translation, &keys, "free", sent, target, probe.factory(false), ignore);
            assert_eq!(result.err(), Some(expected));
        }
        // ファイルの外から来た値（一覧の外のモデル）も、Rust の一覧で拒む
        let tampered = Translation { model: "gemini-flash-latest".into(), ..translation.clone() };
        let result = begin(&state, &tampered, &keys, "free", items(&["a"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::Settings));
        // 置き場所のキーが改行を含めば送らない
        keys.inner.write(&target_for("gemini", "free"), &Secret::new(format!("{SAMPLE}\r\nX: 1"))).expect("write");
        let result = begin(&state, &translation, &keys, "free", items(&["a"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::Key));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);
        assert!(state.is_idle());
        for language in TARGETS {
            assert!(gemini::language_name(language).is_some(), "{language}");
        }
    }

    #[test]
    fn enabled_job_runs_and_one_job_at_a_time() {
        let folder = Folder::new("enabled");
        let translation = settings_file(&folder, true);
        let state = TranslateState::default();
        let keys = keys_with_sample();

        // 通信の途中の仕事の間は、次の仕事を断る
        let held = Probe::new();
        let (sender, events) = mpsc::channel();
        let (first, handle) = begin(&state, &translation, &keys, "free", items(&["a"]), "ja", held.factory(true), move |event| {
            let _ = sender.send(event);
        })
        .expect("first job");
        // 通信の途中に入るのを待つ（遅れの間に取り消すため）
        let deadline = std::time::Instant::now() + START_WAIT;
        while held.sent.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < deadline, "the job did not start sending");
            std::thread::yield_now();
        }
        let probe = Probe::new();
        let busy = begin(&state, &translation, &keys, "free", items(&["b"]), "ja", probe.factory(false), ignore);
        assert_eq!(busy.err(), Some(StartError::Busy));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);
        // 番号の違う取り消しは効かない
        assert!(!state.cancel(first + 100));
        assert!(!state.is_idle());
        assert!(state.cancel(first));
        // 通信が戻るのを待たずに、止まった知らせが出て、次を受け付ける
        assert_eq!(events.try_iter().collect::<Vec<_>>(), vec![JobEvent::Finished { job: first, error: Some(ErrorKind::Cancelled), detail: None }]);
        assert!(state.is_idle());
        assert!(!state.cancel(first));
        // 遅れて戻った組の訳は捨てられ、2 度目の終わりの知らせも出ない
        handle.join().expect("join");
        assert_eq!(events.try_iter().count(), 0);
        assert_eq!(held.made.load(Ordering::SeqCst), 1);
        assert_eq!(held.sent.load(Ordering::SeqCst), 1);

        // 空いたら次の仕事が動く。Transport は仕事の中で 1 回だけ作る
        let (sender, events) = mpsc::channel();
        let (second, handle) = begin(&state, &translation, &keys, "free", items(&["Hi", "Hi", "Yo"]), "ja", probe.factory(false), move |event| {
            let _ = sender.send(event);
        })
        .expect("second job");
        assert_ne!(first, second);
        handle.join().expect("join");
        let seen: Vec<JobEvent> = events.try_iter().collect();
        assert_eq!(probe.made.load(Ordering::SeqCst), 1);
        assert_eq!(probe.sent.load(Ordering::SeqCst), 1);
        assert_eq!(
            seen,
            vec![
                JobEvent::Translated {
                    job: second,
                    model: GEMINI_MODELS[0].into(),
                    results: vec![
                        Translated { id: 0, text: "訳:Hi".into() },
                        Translated { id: 1, text: "訳:Hi".into() },
                        Translated { id: 2, text: "訳:Yo".into() },
                    ]
                },
                JobEvent::Finished { job: second, error: None, detail: None },
            ]
        );
        assert!(state.is_idle());
        for event in &seen {
            assert!(!serde_json::to_string(event).expect("json").contains(&SAMPLE[SAMPLE.len() - 12..]));
        }
    }

    /// 最初のモデルにだけ 1 日の上限（待てない長さの 429）を返し、ほかのモデルは訳す。
    struct FirstModelExhausted;

    impl Transport for FirstModelExhausted {
        fn send(&self, request: &HttpRequest, key: &Secret, cancel: &Cancel) -> Result<HttpResponse, TransportError> {
            if request.path.contains(&format!("/{}:", GEMINI_MODELS[0])) {
                let body = serde_json::json!({ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded.",
                    "details": [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "3600s" }] } });
                return Ok(HttpResponse { status: 429, body: body.to_string().into_bytes() });
            }
            Echo { sent: Arc::default(), late: false }.send(request, key, cancel)
        }
    }

    #[test]
    fn saved_fallback_choice_reaches_the_job() {
        let folder = Folder::new("fallback");
        let translation = settings_file(&folder, true);
        // 設定ファイルにキーが無ければ入（F3 より前の設定ファイル）
        assert!(translation.fallback);
        let keys = keys_with_sample();
        for (fallback, expected) in [(true, None), (false, Some(ErrorKind::Quota))] {
            let state = TranslateState::default();
            let chosen = Translation { fallback, ..translation.clone() };
            let (sender, events) = mpsc::channel();
            let (_, handle) = begin(&state, &chosen, &keys, "free", items(&["a"]), "ja", || FirstModelExhausted, move |event| {
                let _ = sender.send(event);
            })
            .expect("job");
            handle.join().expect("join");
            let seen: Vec<JobEvent> = events.try_iter().collect();
            let switched = seen.iter().any(|event| matches!(event, JobEvent::Switched { .. }));
            assert_eq!(switched, fallback);
            match seen.last() {
                Some(JobEvent::Finished { error, detail, .. }) => {
                    assert_eq!(*error, expected);
                    assert_eq!(detail.is_some(), !fallback);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    const PAID_SAMPLE: &str = "test-not-a-real-key-Paid9876543210";

    /// 送られたキーを覚え、最初のモデルにだけ 1 日の上限を返す（切り替えが枠ごとの仕事でも効くかを見る）。
    struct KeyRecorder {
        seen: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl Transport for KeyRecorder {
        fn send(&self, request: &HttpRequest, key: &Secret, cancel: &Cancel) -> Result<HttpResponse, TransportError> {
            self.seen.lock().expect("seen").push(key.expose().to_vec());
            if request.path.contains(&format!("/{}:", GEMINI_MODELS[0])) {
                let body = serde_json::json!({ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded.",
                    "details": [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "3600s" }] } });
                return Ok(HttpResponse { status: 429, body: body.to_string().into_bytes() });
            }
            // 訳は Echo に作らせる（Echo は試験のキーを確かめるので、記録した後は試験のキーで渡す）
            Echo { sent: Arc::default(), late: false }.send(request, &Secret::new(SAMPLE.to_owned()), cancel)
        }
    }

    /// 右クリックで選んだ枠のキーだけを読む。もう一方の枠のキーと F5 より前のキーは使わない。
    #[test]
    fn tier_is_routed_to_its_own_key() {
        let folder = Folder::new("tier-routing");
        let translation = settings_file(&folder, true);
        let keys = CountingKeys::default();
        keys.inner.write(&target_for("gemini", "paid"), &Secret::new(PAID_SAMPLE.to_owned())).expect("write paid");
        keys.inner.write(&legacy_target("gemini"), &Secret::new(SAMPLE.to_owned())).expect("write legacy");

        // 無料枠のキーが無い。以前のキーがあっても使わず、通信もしない
        let state = TranslateState::default();
        let probe = Probe::new();
        let result = begin(&state, &translation, &keys, "free", items(&["a"]), "ja", probe.factory(false), ignore);
        assert_eq!(result.err(), Some(StartError::NoKey));
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);

        // 一覧の外の枠はキーを読む前に拒む
        let reads = keys.reads.load(Ordering::SeqCst);
        for tier in ["", "Paid", "legacy", "../gemini"] {
            let result = begin(&state, &translation, &keys, tier, items(&["a"]), "ja", probe.factory(false), ignore);
            assert_eq!(result.err(), Some(StartError::Tier), "{tier}");
        }
        assert_eq!(keys.reads.load(Ordering::SeqCst), reads);
        assert_eq!(probe.made.load(Ordering::SeqCst), 0);

        // 有料を選ぶと有料のキーで送る。切り替え（F3）はこの仕事の中で効く
        for fallback in [true, false] {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let recorder = KeyRecorder { seen: Arc::clone(&seen) };
            let chosen = Translation { fallback, ..translation.clone() };
            let (sender, events) = mpsc::channel();
            let (_, handle) = begin(&state, &chosen, &keys, "paid", items(&["a"]), "ja", move || recorder, move |event| {
                let _ = sender.send(event);
            })
            .expect("paid job");
            handle.join().expect("join");
            let sent = seen.lock().expect("seen").clone();
            assert!(!sent.is_empty());
            assert!(sent.iter().all(|key| key == PAID_SAMPLE.as_bytes()), "only the paid key is sent");
            let events: Vec<JobEvent> = events.try_iter().collect();
            assert_eq!(events.iter().any(|event| matches!(event, JobEvent::Switched { .. })), fallback);
            match events.last() {
                Some(JobEvent::Finished { error, .. }) => assert_eq!(*error, if fallback { None } else { Some(ErrorKind::Quota) }),
                other => panic!("{other:?}"),
            }
        }

        // 無料枠のキーを置くと無料枠を選んだ仕事はそのキーで送り、有料のキーは送らない
        keys.inner.write(&target_for("gemini", "free"), &Secret::new(SAMPLE.to_owned())).expect("write free");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = KeyRecorder { seen: Arc::clone(&seen) };
        let (_, handle) = begin(&state, &translation, &keys, "free", items(&["a"]), "ja", move || recorder, ignore).expect("free job");
        handle.join().expect("join");
        let sent = seen.lock().expect("seen").clone();
        assert!(!sent.is_empty());
        assert!(sent.iter().all(|key| key == SAMPLE.as_bytes()), "only the free key is sent");
        // 以前のキーは移すまで残る
        assert!(keys.inner.read(&legacy_target("gemini")).expect("read").is_some());
    }
}
