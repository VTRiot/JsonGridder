//! ファイルの読み書きの核。画面の文言を持たず、結果は型で返す。
//!
//! 読み書きは [`allow::GrantedPath`] を受ける関数だけが行う。許可の無いパスは
//! 型の上でここへ入れない。

pub mod allow;
pub mod decode;
pub mod encode;
pub mod format;
pub mod frame;
pub mod open;
pub mod replace;
pub mod save;
pub mod scan;
pub mod session;

#[cfg(all(test, windows))]
mod real_file_tests;

use sha2::{Digest, Sha256};

pub type Sha256Digest = [u8; 32];

pub fn sha256(bytes: &[u8]) -> Sha256Digest {
    Sha256::digest(bytes).into()
}

pub fn to_hex(digest: &Sha256Digest) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// OS のエラーコード。OS から来ていないエラーは 0。
pub fn os_code(error: &std::io::Error) -> u32 {
    error.raw_os_error().map_or(0, |code| code as u32)
}
