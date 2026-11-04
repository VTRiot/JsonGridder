//! 送る文字列を検査し、重複を 1 回にまとめ、組に分ける。通信はしない。
//!
//! WebView の集め方は信じない: 空の文字列と同じ番号の重複を拒み、件と仕事の大きさに上限を置く。

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

/// 大きさの上限。文字数は Unicode のコードポイントで数える。
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// 1 組の文字数。これを 1 件で超える文字列は 1 件で 1 組。
    pub batch_chars: usize,
    /// 1 組の件数。
    pub batch_items: usize,
    /// 1 件の文字数。超えたら送らない。
    pub item_chars: usize,
    /// 1 回の仕事で送る文字数（重複を除いた後）。超えたら仕事を作らない。
    pub job_chars: usize,
}

/// 数字の札はすべて仮置き（計画の「数字の札」）。T6 の実測で見直す。
pub const LIMITS: Limits = Limits {
    batch_chars: 6_000,
    batch_items: 50,
    item_chars: 30_000,
    job_chars: 200_000,
};

/// WebView から受ける 1 件。`id` は WebView が行や場所に付けた番号。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ItemIn {
    pub id: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    /// 1 件も無い。
    NoItems,
    /// 空の文字列か空白だけの文字列がある。
    Blank,
    /// 同じ番号が 2 回ある。
    DuplicateId,
    /// 仕事の文字数の上限を超える。
    TooMuch,
}

impl PlanError {
    /// WebView が辞書のキーを引く名。
    pub fn code(self) -> &'static str {
        match self {
            Self::NoItems => "noItems",
            Self::Blank => "blank",
            Self::DuplicateId => "duplicateId",
            Self::TooMuch => "tooMuch",
        }
    }
}

/// 組に分けた仕事。`texts` の番号が組の中の `i` になる。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// 重複を除いた文字列。
    pub texts: Vec<String>,
    /// 文字列ごとの、WebView の番号の並び（結果を全部へ配る）。
    pub owners: Vec<Vec<u64>>,
    /// 組。`texts` の番号の並び。
    pub batches: Vec<Vec<usize>>,
    /// 長すぎて送らない WebView の番号。
    pub too_long: Vec<u64>,
    /// 送る文字数（重複を除いた後）。
    pub sent_chars: usize,
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

pub fn plan(items: Vec<ItemIn>, limits: &Limits) -> Result<Plan, PlanError> {
    if items.is_empty() {
        return Err(PlanError::NoItems);
    }
    let mut ids = HashSet::with_capacity(items.len());
    let mut by_text: HashMap<String, usize> = HashMap::new();
    let mut texts = Vec::new();
    let mut owners: Vec<Vec<u64>> = Vec::new();
    let mut too_long = Vec::new();
    for item in items {
        if item.text.trim().is_empty() {
            return Err(PlanError::Blank);
        }
        if !ids.insert(item.id) {
            return Err(PlanError::DuplicateId);
        }
        if chars(&item.text) > limits.item_chars {
            too_long.push(item.id);
            continue;
        }
        match by_text.get(&item.text) {
            Some(&index) => owners[index].push(item.id),
            None => {
                by_text.insert(item.text.clone(), texts.len());
                texts.push(item.text);
                owners.push(vec![item.id]);
            }
        }
    }
    let sent_chars = texts.iter().map(|text| chars(text)).sum();
    if sent_chars > limits.job_chars {
        return Err(PlanError::TooMuch);
    }
    let batches = split(&texts, limits);
    Ok(Plan {
        texts,
        owners,
        batches,
        too_long,
        sent_chars,
    })
}

/// 順に詰め、件数か文字数の上限を超える前に組を切る。
fn split(texts: &[String], limits: &Limits) -> Vec<Vec<usize>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0;
    for (index, text) in texts.iter().enumerate() {
        let size = chars(text);
        let full = current.len() >= limits.batch_items || current_chars + size > limits.batch_chars;
        if !current.is_empty() && full {
            batches.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        current.push(index);
        current_chars += size;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: Limits = Limits {
        batch_chars: 10,
        batch_items: 3,
        item_chars: 20,
        job_chars: 60,
    };

    fn items(texts: &[&str]) -> Vec<ItemIn> {
        texts
            .iter()
            .enumerate()
            .map(|(id, text)| ItemIn { id: id as u64, text: (*text).into() })
            .collect()
    }

    #[test]
    fn batches_respect_limits() {
        // かなは 1 文字 3 バイトだが、数えるのはコードポイント
        let texts = ["ああああ", "いいいい", "う", "え", "お", "かかかかかかかかかかかか", "き"];
        let planned = plan(items(&texts), &SMALL).expect("plan");
        for batch in &planned.batches {
            assert!(batch.len() <= SMALL.batch_items);
            let size: usize = batch.iter().map(|&i| chars(&planned.texts[i])).sum();
            // 1 件で上限を超える物だけが上限を超えてよい
            assert!(size <= SMALL.batch_chars || batch.len() == 1, "{batch:?}");
        }
        assert_eq!(planned.batches, vec![vec![0, 1, 2], vec![3, 4], vec![5], vec![6]]);
        // 全部の文字列がちょうど 1 回ずつ組に入る
        let mut seen: Vec<usize> = planned.batches.concat();
        seen.sort_unstable();
        assert_eq!(seen, (0..planned.texts.len()).collect::<Vec<_>>());
    }

    #[test]
    fn duplicates_sent_once() {
        let planned = plan(items(&["Re: hello", "Hi", "Re: hello", "Re: hello"]), &SMALL).expect("plan");
        assert_eq!(planned.texts, vec!["Re: hello".to_owned(), "Hi".to_owned()]);
        assert_eq!(planned.owners, vec![vec![0, 2, 3], vec![1]]);
        assert_eq!(planned.sent_chars, 11);
        assert_eq!(planned.batches.concat().len(), 2);
    }

    #[test]
    fn too_long_items_are_not_sent() {
        let long = "x".repeat(SMALL.item_chars + 1);
        let planned = plan(items(&["a", &long, "b"]), &SMALL).expect("plan");
        assert_eq!(planned.too_long, vec![1]);
        assert!(!planned.texts.contains(&long));
        assert_eq!(planned.sent_chars, 2);
        // ちょうど上限の 1 件は送る（1 件で 1 組）
        let edge = "y".repeat(SMALL.item_chars);
        let planned = plan(items(&[&edge]), &SMALL).expect("plan");
        assert_eq!(planned.batches, vec![vec![0]]);
    }

    #[test]
    fn bad_inputs_are_refused() {
        assert_eq!(plan(Vec::new(), &SMALL), Err(PlanError::NoItems));
        assert_eq!(plan(items(&["a", ""]), &SMALL), Err(PlanError::Blank));
        assert_eq!(plan(items(&["a", " \n\t"]), &SMALL), Err(PlanError::Blank));
        let twice = vec![ItemIn { id: 7, text: "a".into() }, ItemIn { id: 7, text: "b".into() }];
        assert_eq!(plan(twice, &SMALL), Err(PlanError::DuplicateId));
        let many: Vec<String> = (0..7).map(|n| format!("{n}{}", "z".repeat(9))).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(plan(items(&refs), &SMALL), Err(PlanError::TooMuch));
    }
}
