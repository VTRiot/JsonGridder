//! 画面との間の枠。`[メタの長さ u32 LE][メタの JSON][本文]`。
//! 本文を JSON に入れないので、大きな文書でも直列化が要らない。

const LENGTH_BYTES: usize = 4;

pub fn pack(meta: &[u8], body: &[u8]) -> Vec<u8> {
    let length = u32::try_from(meta.len()).expect("the metadata is small");
    let mut frame = Vec::with_capacity(LENGTH_BYTES + meta.len() + body.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(meta);
    frame.extend_from_slice(body);
    frame
}

/// 枠を `(メタ, 本文)` へ分ける。本文は複製しない。
pub fn unpack(mut frame: Vec<u8>) -> Option<(Vec<u8>, Vec<u8>)> {
    let header: [u8; LENGTH_BYTES] = frame.get(..LENGTH_BYTES)?.try_into().ok()?;
    let meta_end = LENGTH_BYTES.checked_add(u32::from_le_bytes(header) as usize)?;
    if meta_end > frame.len() {
        return None;
    }
    let body = frame.split_off(meta_end);
    frame.drain(..LENGTH_BYTES);
    Some((frame, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packed_frame_comes_back_unchanged() {
        let frame = pack(b"{}", "表".as_bytes());
        assert_eq!(unpack(frame), Some((b"{}".to_vec(), "表".as_bytes().to_vec())));
    }

    #[test]
    fn a_frame_shorter_than_its_header_says_is_refused() {
        assert_eq!(unpack(vec![1, 2]), None);
        assert_eq!(unpack(vec![9, 0, 0, 0, b'{']), None);
    }
}
