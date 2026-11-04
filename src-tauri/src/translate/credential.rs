//! Windows の資格情報マネージャー（汎用の資格情報）に API キーを置く。
//!
//! 中身は OS が DPAPI で利用者ごとに守る。設定の JSON には書かない。

use super::secret::Secret;

/// 資格情報の対象名の頭。
pub const TARGET_PREFIX: &str = "JsonGridder/translation/";

/// F5 より前の、サービスに 1 つのキーの置き場所（例: `JsonGridder/translation/gemini`）。
/// 翻訳には使わない。利用者が無料枠用か有料用へ移すまで、触らずに残す。
pub fn legacy_target(service: &str) -> String {
    format!("{TARGET_PREFIX}{service}")
}

/// 無料枠用か有料用のキーの置き場所（例: `JsonGridder/translation/gemini/free`）。
pub fn target_for(service: &str, tier: &str) -> String {
    format!("{TARGET_PREFIX}{service}/{tier}")
}

/// 置き場所の口。試験ではメモリの実装に差し替える。誤りは Win32 の番号。
pub trait KeyStore: Send + Sync {
    fn write(&self, target: &str, secret: &Secret) -> Result<(), u32>;
    /// 無ければ `Ok(None)`。
    fn read(&self, target: &str) -> Result<Option<Secret>, u32>;
    /// 無くても `Ok(())`。
    fn delete(&self, target: &str) -> Result<(), u32>;

    fn exists(&self, target: &str) -> Result<bool, u32> {
        self.read(target).map(|found| found.is_some())
    }
}

/// OS の資格情報マネージャー。
pub struct CredentialManager;

#[cfg(windows)]
mod system {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };

    use super::{CredentialManager, KeyStore, Secret};

    /// OS が受け付ける中身の大きさの上限（バイト）。
    pub const MAX_SECRET_BYTES: usize = CRED_MAX_CREDENTIAL_BLOB_SIZE as usize;

    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text).encode_wide().chain(Some(0)).collect()
    }

    fn last_error() -> u32 {
        // SAFETY: 引数の無い読み取りだけの呼び出し
        unsafe { GetLastError() }
    }

    impl KeyStore for CredentialManager {
        fn write(&self, target: &str, secret: &Secret) -> Result<(), u32> {
            let mut name = wide(target);
            if secret.len() > MAX_SECRET_BYTES {
                return Err(ERROR_INVALID_PARAMETER);
            }
            let size = u32::try_from(secret.len()).map_err(|_| ERROR_INVALID_PARAMETER)?;
            // SAFETY: CREDENTIALW は数とポインタだけの構造体で、0 は「無い」の意味として正しい
            let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = name.as_mut_ptr();
            credential.CredentialBlobSize = size;
            // CredWriteW は中身を読むだけで書き換えない
            credential.CredentialBlob = secret.expose().as_ptr().cast_mut();
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            // SAFETY: credential と name と secret はこの呼び出しの間生きている
            if unsafe { CredWriteW(&credential, 0) } != 0 {
                Ok(())
            } else {
                Err(last_error())
            }
        }

        fn read(&self, target: &str) -> Result<Option<Secret>, u32> {
            let name = wide(target);
            let mut found: *mut CREDENTIALW = std::ptr::null_mut();
            // SAFETY: name は 0 で終わる。成功すれば found は OS が確保した領域を指す
            if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) } == 0 {
                let code = last_error();
                return if code == ERROR_NOT_FOUND { Ok(None) } else { Err(code) };
            }
            // SAFETY: 成功したので found は有効。中身は CredentialBlobSize バイト
            let secret = unsafe {
                let credential = &*found;
                let size = credential.CredentialBlobSize as usize;
                let blob = credential.CredentialBlob;
                let bytes = if blob.is_null() || size == 0 {
                    Vec::new()
                } else {
                    let copied = std::slice::from_raw_parts(blob, size).to_vec();
                    // OS の領域に残さない
                    for offset in 0..size {
                        std::ptr::write_volatile(blob.add(offset), 0);
                    }
                    copied
                };
                CredFree(found.cast_const().cast());
                Secret::from_bytes(bytes)
            };
            Ok(Some(secret))
        }

        fn delete(&self, target: &str) -> Result<(), u32> {
            let name = wide(target);
            // SAFETY: name は 0 で終わる
            if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
                return Ok(());
            }
            match last_error() {
                ERROR_NOT_FOUND => Ok(()),
                code => Err(code),
            }
        }
    }
}

#[cfg(windows)]
pub use system::MAX_SECRET_BYTES;

#[cfg(not(windows))]
/// Windows の `CRED_MAX_CREDENTIAL_BLOB_SIZE` と同じ値。Windows 以外では置き場所が無い。
pub const MAX_SECRET_BYTES: usize = 5 * 512;

#[cfg(not(windows))]
impl KeyStore for CredentialManager {
    fn write(&self, _target: &str, _secret: &Secret) -> Result<(), u32> {
        Err(u32::MAX)
    }
    fn read(&self, _target: &str) -> Result<Option<Secret>, u32> {
        Err(u32::MAX)
    }
    fn delete(&self, _target: &str) -> Result<(), u32> {
        Err(u32::MAX)
    }
}

/// 本物の資格情報マネージャーを使う試験の道具（この単位と `translate` の試験が共に使う）。
#[cfg(all(test, windows))]
pub(crate) mod test_support {
    use super::{CredentialManager, KeyStore, TARGET_PREFIX};

    use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 資格情報マネージャーを使う試験を 1 つずつ回す。別の名前どうしでも、書き込みと消去が
    /// 並ぶと、書いた直後の読みが「無い」を返す・消した物が残ることがある（F1 の調べ）。
    static REAL_STORE: Mutex<()> = Mutex::new(());

    pub(crate) fn one_at_a_time() -> MutexGuard<'static, ()> {
        REAL_STORE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 試験だけの対象名。実際の利用者のキー（`JsonGridder/translation/gemini` とその下）には触らない。
    /// プロセスの番号は使い回されるので、起動の時刻も入れ、前の実行の残りと名前が重ならないようにする。
    pub(crate) fn test_target(tag: &str) -> String {
        static RUN: OnceLock<u128> = OnceLock::new();
        let run = RUN.get_or_init(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos())
        });
        format!("{TARGET_PREFIX}test-{}-{run:x}-{tag}", std::process::id())
    }

    /// 試験が途中で落ちても、作った資格情報を消す。
    pub(crate) struct Cleanup(pub(crate) String);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = CredentialManager.delete(&self.0);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::test_support::{Cleanup, one_at_a_time, test_target};
    use super::*;

    #[test]
    fn tier_targets_are_separate_from_the_legacy_target() {
        assert_eq!(legacy_target("gemini"), "JsonGridder/translation/gemini");
        assert_eq!(target_for("gemini", "free"), "JsonGridder/translation/gemini/free");
        assert_eq!(target_for("gemini", "paid"), "JsonGridder/translation/gemini/paid");
    }

    #[test]
    fn credential_roundtrip_real() {
        // 後片付け（Cleanup）より先に取り、後片付けが済んでから放す
        let _turn = one_at_a_time();
        let target = test_target("roundtrip");
        assert!(!target.ends_with("/gemini"));
        let _cleanup = Cleanup(target.clone());
        let store = CredentialManager;

        assert!(!store.exists(&target).expect("read before write"));
        let first = "test-not-a-real-key-first";
        store.write(&target, &Secret::new(first.to_owned())).expect("write");
        let read = store.read(&target).expect("read").expect("found");
        assert_eq!(read.expose(), first.as_bytes());

        // 入れ直すと上書きされる
        let second = "test-not-a-real-key-second";
        store.write(&target, &Secret::new(second.to_owned())).expect("rewrite");
        let read = store.read(&target).expect("read").expect("found");
        assert_eq!(read.expose(), second.as_bytes());

        store.delete(&target).expect("delete");
        assert!(store.read(&target).expect("read after delete").is_none());
        // 無い物を消しても誤りにしない
        store.delete(&target).expect("delete again");
        assert!(!store.exists(&target).expect("exists after delete"));
    }

    #[test]
    fn the_largest_allowed_secret_is_stored() {
        let _turn = one_at_a_time();
        let target = test_target("largest");
        let _cleanup = Cleanup(target.clone());
        let largest = "k".repeat(MAX_SECRET_BYTES);
        CredentialManager
            .write(&target, &Secret::new(largest.clone()))
            .expect("write the largest");
        let read = CredentialManager.read(&target).expect("read").expect("found");
        assert_eq!(read.expose(), largest.as_bytes());
    }
}
