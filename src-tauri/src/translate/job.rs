//! 1 回の翻訳の仕事。組を順に送り、組ごとの結果を知らせる。
//!
//! 止めても、それまでに知らせた結果は WebView に残る。知らせていない残りは WebView が「未翻訳」と扱う。
//! 文書には触らない（訳はどこにも自動で書かない）。
//!
//! モデルの切り替え（F3）: 選んだモデルが混雑（503）か回数の上限（429）で再試行の後も通らず、
//! 切り替えが有効なら、モデルの一覧の次のモデル（末尾の次は先頭）で残りの組を送る。
//! 1 回の仕事で各モデルは 1 回まで使う（離れたモデルへは戻らない）。保存した設定のモデルは替えない。

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use super::batch::Plan;
use super::secret::Secret;
use super::service::{
    BatchOutcome, Cancel, ErrorDetail, ErrorKind, HttpRequest, Piece, TranslationService,
    Transport, TransportError,
};

/// 429 と 503 の再試行。数字の札は仮置き（計画の「数字の札」）。
#[derive(Clone, Copy, Debug)]
pub struct Retry {
    /// 再試行の回数の上限（最初の 1 回を除く）。
    pub attempts: u32,
    /// 待つ時間の上限。サービスの示した待ちがこれを超えたら止める。
    pub max_wait: Duration,
    /// サービスが待ちを示さないときの最初の待ち。回ごとに倍にする。
    pub first_wait: Duration,
}

pub const RETRY: Retry = Retry {
    attempts: 2,
    max_wait: Duration::from_secs(60),
    first_wait: Duration::from_secs(2),
};

/// 1 件の訳。`id` は WebView の番号。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Translated {
    pub id: u64,
    pub text: String,
}

/// 1 件ずつの失敗。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemFailure {
    /// 安全のために拒まれた。
    Blocked,
    /// 応答の形が合わなかった（割って送り直しても）。
    Malformed,
    /// 長すぎて送らなかった。
    TooLong,
}

/// WebView へ知らせること。訳と番号と種類と、サービスの言った理由だけで、キーは持たない。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobEvent {
    /// `model` はこの組を訳したモデル。
    Translated { job: u64, model: String, results: Vec<Translated> },
    Failed { job: u64, ids: Vec<u64>, reason: ItemFailure },
    /// 回数の上限やサービスの混雑で、待ってから同じモデルへ送り直す。
    Waiting { job: u64, seconds: u64, reason: ErrorKind, model: String },
    /// `from` が `reason` で通らないので、残りの組を `to` で送る。
    Switched { job: u64, from: String, to: String, reason: ErrorKind },
    /// 終わった。`error` が無ければ全部の組を送り終えた。`detail` はサービスの言った理由。
    Finished { job: u64, error: Option<ErrorKind>, detail: Option<ErrorDetail> },
}

pub struct Job<'a> {
    pub id: u64,
    pub plan: &'a Plan,
    pub service: &'a dyn TranslationService,
    pub transport: &'a dyn Transport,
    pub key: &'a Secret,
    pub target: &'a str,
    /// 最初に使うモデル（保存した設定の値）。
    pub model: &'a str,
    /// 切り替えの候補の並び（サービスのモデルの一覧）。
    pub models: &'a [&'a str],
    /// 混雑のときに別のモデルへ切り替えるか。
    pub fallback: bool,
    pub cancel: &'a Cancel,
    pub retry: Retry,
    /// 待つ。取り消されたら true。
    pub wait: &'a dyn Fn(Duration) -> bool,
}

/// 止めるべき失敗。`detail` はキーを塗った後のサービスの文。
#[derive(Debug)]
struct Stop {
    kind: ErrorKind,
    detail: Option<ErrorDetail>,
}

impl From<ErrorKind> for Stop {
    fn from(kind: ErrorKind) -> Self {
        Self { kind, detail: None }
    }
}

/// 仕事の中で今使っているモデルと、使ったモデル。
struct Models<'a> {
    current: Cell<&'a str>,
    used: RefCell<Vec<&'a str>>,
}

impl<'a> Models<'a> {
    fn new(first: &'a str) -> Self {
        Self {
            current: Cell::new(first),
            used: RefCell::new(vec![first]),
        }
    }

    /// 一覧の中で今のモデルの次（末尾の次は先頭）から、まだ使っていないモデル。
    fn next(&self, list: &[&'a str]) -> Option<&'a str> {
        let current = self.current.get();
        let start = list.iter().position(|model| *model == current).map_or(0, |at| at + 1);
        let used = self.used.borrow();
        (0..list.len())
            .map(|step| list[(start + step) % list.len()])
            .find(|model| !used.contains(model))
    }

    fn switch(&self, to: &'a str) {
        self.current.set(to);
        self.used.borrow_mut().push(to);
    }
}

/// 組を順に送る。最後に必ず `Finished` を 1 回知らせる。
pub fn run(job: &Job<'_>, emit: &mut dyn FnMut(JobEvent)) {
    if !job.plan.too_long.is_empty() {
        emit(JobEvent::Failed {
            job: job.id,
            ids: job.plan.too_long.clone(),
            reason: ItemFailure::TooLong,
        });
    }
    let models = Models::new(job.model);
    let mut stop = None;
    for batch in &job.plan.batches {
        if let Err(failure) = process(job, &models, batch, true, emit) {
            stop = Some(failure);
            break;
        }
    }
    let (error, detail) = stop.map_or((None, None), |stop| (Some(stop.kind), stop.detail));
    emit(JobEvent::Finished { job: job.id, error, detail });
}

fn owners_of(job: &Job<'_>, texts: &[usize]) -> Vec<u64> {
    texts
        .iter()
        .flat_map(|&index| job.plan.owners[index].iter().copied())
        .collect()
}

fn fail(job: &Job<'_>, texts: &[usize], reason: ItemFailure, emit: &mut dyn FnMut(JobEvent)) {
    if texts.is_empty() {
        return;
    }
    emit(JobEvent::Failed {
        job: job.id,
        ids: owners_of(job, texts),
        reason,
    });
}

/// 1 組を送る。形の合わない応答は 1 回だけ半分に割って送り直す。止めるべき失敗は `Err`。
fn process<'a>(
    job: &Job<'a>,
    models: &Models<'a>,
    texts: &[usize],
    may_split: bool,
    emit: &mut dyn FnMut(JobEvent),
) -> Result<(), Stop> {
    // 組の中の番号は 0 から振る。応答の番号はこの並びの位置
    let pieces: Vec<Piece> = texts
        .iter()
        .enumerate()
        .map(|(index, &text)| Piece {
            index,
            text: job.plan.texts[text].clone(),
        })
        .collect();
    let splittable = may_split && texts.len() > 1;
    let retry_split = |emit: &mut dyn FnMut(JobEvent)| -> Result<(), Stop> {
        let (front, back) = texts.split_at(texts.len() / 2);
        process(job, models, front, false, emit)?;
        process(job, models, back, false, emit)
    };
    match send(job, models, &pieces, emit)? {
        BatchOutcome::Translated(pairs) => {
            let checked = check_pairs(pairs, texts.len());
            match checked {
                Checked::Complete(found) => {
                    deliver(job, models, texts, found, emit);
                    Ok(())
                }
                _ if splittable => retry_split(emit),
                Checked::Partial(found) => {
                    let missing: Vec<usize> = (0..texts.len())
                        .filter(|index| !found.contains_key(index))
                        .map(|index| texts[index])
                        .collect();
                    deliver(job, models, texts, found, emit);
                    fail(job, &missing, ItemFailure::Malformed, emit);
                    Ok(())
                }
                Checked::Broken => {
                    fail(job, texts, ItemFailure::Malformed, emit);
                    Ok(())
                }
            }
        }
        BatchOutcome::Malformed | BatchOutcome::Truncated if splittable => retry_split(emit),
        BatchOutcome::Malformed | BatchOutcome::Truncated => {
            fail(job, texts, ItemFailure::Malformed, emit);
            Ok(())
        }
        BatchOutcome::Blocked => {
            fail(job, texts, ItemFailure::Blocked, emit);
            Ok(())
        }
        // `send` は失敗を `Err` にして返す
        BatchOutcome::Failed { kind, detail, .. } => Err(Stop { kind, detail: detail.map(|detail| detail.scrub(job.key)) }),
    }
}

enum Checked {
    /// 送った番号がちょうど 1 回ずつある。
    Complete(HashMap<usize, String>),
    /// 足りない番号があるが、知らない番号と重複は無い。
    Partial(HashMap<usize, String>),
    /// 知らない番号か重複がある。応答全体を信じない。
    Broken,
}

fn check_pairs(pairs: Vec<(usize, String)>, sent: usize) -> Checked {
    let mut found = HashMap::with_capacity(pairs.len());
    for (index, text) in pairs {
        if index >= sent || found.insert(index, text).is_some() {
            return Checked::Broken;
        }
    }
    if found.len() == sent {
        Checked::Complete(found)
    } else {
        Checked::Partial(found)
    }
}

fn deliver(
    job: &Job<'_>,
    models: &Models<'_>,
    texts: &[usize],
    found: HashMap<usize, String>,
    emit: &mut dyn FnMut(JobEvent),
) {
    let mut results = Vec::new();
    let mut ordered: Vec<(usize, String)> = found.into_iter().collect();
    ordered.sort_unstable_by_key(|(index, _)| *index);
    for (index, text) in ordered {
        for &id in &job.plan.owners[texts[index]] {
            results.push(Translated {
                id,
                text: text.clone(),
            });
        }
    }
    if !results.is_empty() {
        emit(JobEvent::Translated {
            job: job.id,
            model: models.current.get().to_owned(),
            results,
        });
    }
}

/// 今のモデルへの要求を作り、宛先を確かめる。
fn request_for(job: &Job<'_>, model: &str, pieces: &[Piece]) -> Result<HttpRequest, Stop> {
    let request = job
        .service
        .build(pieces, job.target, model)
        .ok_or(ErrorKind::Model)?;
    // サービスの許した宛先の外へは送らない（Transport も自分の一覧で確かめる）
    if request.endpoint != job.service.endpoint() {
        return Err(ErrorKind::Network.into());
    }
    Ok(request)
}

/// 通信の失敗の詳しい行（Win32 の番号か時間切れ）。キーは持たない。
fn transport_detail(error: TransportError) -> Option<ErrorDetail> {
    Some(ErrorDetail::new("", &error.to_string()))
}

/// 1 組を送り、429 と 503 は待って送り直す。それでも通らなければ、切り替えが有効なら次のモデルへ。
/// 止めるべき失敗は `Err`。戻った後に取り消されていれば、その組の結果は捨てる。
fn send<'a>(
    job: &Job<'a>,
    models: &Models<'a>,
    pieces: &[Piece],
    emit: &mut dyn FnMut(JobEvent),
) -> Result<BatchOutcome, Stop> {
    let mut request = request_for(job, models.current.get(), pieces)?;
    let mut retries = 0;
    loop {
        if job.cancel.is_cancelled() {
            return Err(ErrorKind::Cancelled.into());
        }
        let response = job.transport.send(&request, job.key, job.cancel);
        if job.cancel.is_cancelled() {
            return Err(ErrorKind::Cancelled.into());
        }
        let outcome = match response {
            Ok(response) => job.service.parse(&response),
            Err(TransportError::Cancelled) => return Err(ErrorKind::Cancelled.into()),
            Err(TransportError::TooLarge) => BatchOutcome::Malformed,
            Err(error @ (TransportError::Refused | TransportError::Timeout | TransportError::Network(_))) => {
                return Err(Stop { kind: ErrorKind::Network, detail: transport_detail(error) });
            }
        };
        let BatchOutcome::Failed {
            kind,
            retryable,
            retry_after,
            detail,
        } = outcome
        else {
            return Ok(outcome);
        };
        let delay = retry_after.unwrap_or_else(|| job.retry.first_wait * 2u32.saturating_pow(retries));
        if retryable && retries < job.retry.attempts && delay <= job.retry.max_wait {
            // 待ちの秒は切り上げて知らせる（0 秒と出さない）
            let seconds = delay.as_secs() + u64::from(delay.subsec_nanos() > 0);
            emit(JobEvent::Waiting {
                job: job.id,
                seconds,
                reason: kind,
                model: models.current.get().to_owned(),
            });
            if (job.wait)(delay) {
                return Err(ErrorKind::Cancelled.into());
            }
            retries += 1;
            continue;
        }
        // このモデルでは通らない。混雑と回数の上限だけは別のモデルで通る見込みがある
        let next = if job.fallback && kind.model_specific() { models.next(job.models) } else { None };
        let Some(next) = next else {
            return Err(Stop { kind, detail: detail.map(|detail| detail.scrub(job.key)) });
        };
        emit(JobEvent::Switched {
            job: job.id,
            from: models.current.get().to_owned(),
            to: next.to_owned(),
            reason: kind,
        });
        models.switch(next);
        request = request_for(job, next, pieces)?;
        retries = 0;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::*;
    use crate::translate::batch::{ItemIn, LIMITS, Limits, plan};
    use crate::translate::gemini::Gemini;
    use crate::translate::service::{HttpRequest, HttpResponse};

    const KEY: &str = "test-not-a-real-key-ZyXwVu987654";

    enum Step {
        /// 送られた文字列に印を付けて返す。
        Echo,
        /// 最後の 1 件を落として返す。
        DropLast,
        /// 知らない番号を足して返す。
        Extra,
        Status(u16, Value),
        Raw(HttpResponse),
        Fail(TransportError),
        /// 送られた後に取り消し、普通の応答を返す。
        CancelThenEcho,
    }

    #[derive(Default)]
    struct Scripted {
        steps: Mutex<VecDeque<Step>>,
        sent: Mutex<Vec<HttpRequest>>,
    }

    impl Scripted {
        fn new(steps: Vec<Step>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                sent: Mutex::default(),
            }
        }

        fn sent_texts(&self) -> Vec<Vec<String>> {
            self.sent.lock().expect("sent").iter().map(texts_of).collect()
        }
    }

    fn texts_of(request: &HttpRequest) -> Vec<String> {
        let body: Value = serde_json::from_slice(&request.body).expect("body");
        let data = body.pointer("/contents/0/parts/0/text").and_then(Value::as_str).expect("data");
        let items: Value = serde_json::from_str(data).expect("items");
        items.as_array().expect("array").iter().map(|item| item["t"].as_str().expect("t").to_owned()).collect()
    }

    fn reply(pairs: Vec<Value>) -> HttpResponse {
        let text = Value::Array(pairs).to_string();
        let body = json!({ "candidates": [{ "content": { "parts": [{ "text": text }] }, "finishReason": "STOP" }] });
        HttpResponse { status: 200, body: body.to_string().into_bytes() }
    }

    fn echoed(request: &HttpRequest) -> Vec<Value> {
        texts_of(request)
            .into_iter()
            .enumerate()
            .map(|(index, text)| json!({ "i": index, "t": format!("訳:{text}") }))
            .collect()
    }

    impl Transport for Scripted {
        fn send(&self, request: &HttpRequest, key: &Secret, cancel: &Cancel) -> Result<HttpResponse, TransportError> {
            assert_eq!(key.expose(), KEY.as_bytes());
            self.sent.lock().expect("sent").push(request.clone());
            let step = self.steps.lock().expect("steps").pop_front().unwrap_or(Step::Echo);
            let mut pairs = echoed(request);
            match step {
                Step::Echo => Ok(reply(pairs)),
                Step::DropLast => {
                    pairs.pop();
                    Ok(reply(pairs))
                }
                Step::Extra => {
                    pairs.push(json!({ "i": 99, "t": "injected" }));
                    Ok(reply(pairs))
                }
                Step::Status(status, error) => Ok(HttpResponse { status, body: json!({ "error": error }).to_string().into_bytes() }),
                Step::Raw(response) => Ok(response),
                Step::Fail(error) => Err(error),
                Step::CancelThenEcho => {
                    cancel.cancel();
                    Ok(reply(pairs))
                }
            }
        }
    }

    struct Outcome {
        events: Vec<JobEvent>,
        waits: Vec<Duration>,
    }

    fn run_with(texts: &[&str], limits: &Limits, transport: &Scripted) -> Outcome {
        run_job(texts, limits, transport, false)
    }

    fn run_job(texts: &[&str], limits: &Limits, transport: &Scripted, fallback: bool) -> Outcome {
        let items = texts.iter().enumerate().map(|(id, text)| ItemIn { id: id as u64, text: (*text).into() }).collect();
        let planned = plan(items, limits).expect("plan");
        let key = Secret::new(KEY.to_owned());
        let cancel = Cancel::default();
        let waits = Mutex::new(Vec::new());
        let wait = |duration: Duration| {
            waits.lock().expect("waits").push(duration);
            false
        };
        let service = Gemini::new();
        let job = Job {
            id: 7,
            plan: &planned,
            service: &service,
            transport,
            key: &key,
            target: "ja",
            model: crate::translate::GEMINI_MODELS[0],
            models: &crate::translate::GEMINI_MODELS,
            fallback,
            cancel: &cancel,
            retry: RETRY,
            wait: &wait,
        };
        let mut events = Vec::new();
        run(&job, &mut |event| events.push(event));
        Outcome { events, waits: waits.into_inner().expect("waits") }
    }

    const TWO_PER_BATCH: Limits = Limits { batch_items: 2, ..LIMITS };

    fn translated_ids(events: &[JobEvent]) -> Vec<u64> {
        let mut ids: Vec<u64> = events
            .iter()
            .filter_map(|event| match event {
                JobEvent::Translated { results, .. } => Some(results.iter().map(|result| result.id)),
                _ => None,
            })
            .flatten()
            .collect();
        ids.sort_unstable();
        ids
    }

    fn finished(events: &[JobEvent]) -> Option<ErrorKind> {
        match events.last() {
            Some(JobEvent::Finished { error, .. }) => *error,
            other => panic!("last event is not Finished: {other:?}"),
        }
    }

    #[test]
    fn duplicates_are_given_to_every_owner() {
        let transport = Scripted::new(vec![]);
        let outcome = run_with(&["Re: hi", "Hello", "Re: hi"], &LIMITS, &transport);
        assert_eq!(transport.sent_texts(), vec![vec!["Re: hi".to_owned(), "Hello".to_owned()]]);
        assert_eq!(
            outcome.events[0],
            JobEvent::Translated {
                job: 7,
                model: crate::translate::GEMINI_MODELS[0].into(),
                results: vec![
                    Translated { id: 0, text: "訳:Re: hi".into() },
                    Translated { id: 2, text: "訳:Re: hi".into() },
                    Translated { id: 1, text: "訳:Hello".into() },
                ]
            }
        );
        assert_eq!(finished(&outcome.events), None);
    }

    #[test]
    fn mismatched_ids_split_then_fail() {
        // 4 件の組: 1 件足りない → 半分に割る → 前は合う、後ろはまた 1 件足りない → その 1 件だけ失敗
        let transport = Scripted::new(vec![Step::DropLast, Step::Echo, Step::DropLast]);
        let outcome = run_with(&["a", "b", "c", "d"], &LIMITS, &transport);
        assert_eq!(transport.sent_texts(), vec![vec!["a", "b", "c", "d"], vec!["a", "b"], vec!["c", "d"]]);
        assert_eq!(translated_ids(&outcome.events), vec![0, 1, 2]);
        assert!(outcome.events.contains(&JobEvent::Failed { job: 7, ids: vec![3], reason: ItemFailure::Malformed }));
        assert_eq!(finished(&outcome.events), None);

        // 知らない番号が混じった応答は、割った後なら組の全部を失敗にする（訳を 1 件も信じない）
        let transport = Scripted::new(vec![Step::Extra, Step::Extra, Step::Echo]);
        let outcome = run_with(&["a", "b", "c", "d"], &LIMITS, &transport);
        assert_eq!(transport.sent.lock().expect("sent").len(), 3);
        assert_eq!(translated_ids(&outcome.events), vec![2, 3]);
        assert!(outcome.events.contains(&JobEvent::Failed { job: 7, ids: vec![0, 1], reason: ItemFailure::Malformed }));

        // 1 件の組は割れないので、そのまま失敗
        let transport = Scripted::new(vec![Step::DropLast]);
        let outcome = run_with(&["only"], &LIMITS, &transport);
        assert_eq!(transport.sent.lock().expect("sent").len(), 1);
        assert_eq!(outcome.events[0], JobEvent::Failed { job: 7, ids: vec![0], reason: ItemFailure::Malformed });
    }

    #[test]
    fn truncated_batch_is_split() {
        let truncated = HttpResponse {
            status: 200,
            body: json!({ "candidates": [{ "content": { "parts": [{ "text": "[{\"i\":0" }] }, "finishReason": "MAX_TOKENS" }] }).to_string().into_bytes(),
        };
        let transport = Scripted::new(vec![Step::Raw(truncated)]);
        let outcome = run_with(&["a", "b"], &LIMITS, &transport);
        assert_eq!(transport.sent_texts(), vec![vec!["a", "b"], vec!["a"], vec!["b"]]);
        assert_eq!(translated_ids(&outcome.events), vec![0, 1]);
    }

    #[test]
    fn blocked_batch_marks_its_items() {
        let blocked = HttpResponse { status: 200, body: json!({ "promptFeedback": { "blockReason": "SAFETY" } }).to_string().into_bytes() };
        let transport = Scripted::new(vec![Step::Raw(blocked)]);
        let outcome = run_with(&["a", "b", "c"], &TWO_PER_BATCH, &transport);
        assert_eq!(outcome.events[0], JobEvent::Failed { job: 7, ids: vec![0, 1], reason: ItemFailure::Blocked });
        assert_eq!(translated_ids(&outcome.events), vec![2]);
        assert_eq!(finished(&outcome.events), None);
    }

    #[test]
    fn partial_results_survive_failure() {
        let transport = Scripted::new(vec![Step::Echo, Step::Status(401, json!({ "status": "UNAUTHENTICATED" }))]);
        let outcome = run_with(&["a", "b", "c", "d", "e"], &TWO_PER_BATCH, &transport);
        // 3 組目は送らない
        assert_eq!(transport.sent.lock().expect("sent").len(), 2);
        assert_eq!(translated_ids(&outcome.events), vec![0, 1]);
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Key));
        assert_eq!(outcome.events.len(), 2);

        let transport = Scripted::new(vec![Step::Echo, Step::Fail(TransportError::Network(12007))]);
        let outcome = run_with(&["a", "b", "c"], &TWO_PER_BATCH, &transport);
        assert_eq!(translated_ids(&outcome.events), vec![0, 1]);
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Network));
    }

    fn quota(delay: Option<&str>) -> Step {
        let details: Vec<Value> = delay
            .map(|delay| json!({ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay }))
            .into_iter()
            .collect();
        Step::Status(429, json!({ "status": "RESOURCE_EXHAUSTED", "details": details }))
    }

    #[test]
    fn quota_waits_then_stops() {
        // 待ちを示されたら待つ。回数の上限を超えたら止める
        let transport = Scripted::new(vec![quota(Some("5s")), quota(Some("5s")), quota(Some("5s"))]);
        let outcome = run_with(&["a"], &LIMITS, &transport);
        assert_eq!(outcome.waits, vec![Duration::from_secs(5); 2]);
        assert_eq!(outcome.events[0], JobEvent::Waiting { job: 7, seconds: 5, reason: ErrorKind::Quota, model: crate::translate::GEMINI_MODELS[0].into() });
        assert_eq!(transport.sent.lock().expect("sent").len(), 3);
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Quota));

        // 待ちを示されなければ、最初の待ちから倍にする。待った後に通れば訳す
        let transport = Scripted::new(vec![quota(None), quota(None), Step::Echo]);
        let outcome = run_with(&["a"], &LIMITS, &transport);
        assert_eq!(outcome.waits, vec![RETRY.first_wait, RETRY.first_wait * 2]);
        assert_eq!(translated_ids(&outcome.events), vec![0]);
        assert_eq!(finished(&outcome.events), None);

        // 上限より長い待ちは待たずに止める（1 日の上限など）
        let transport = Scripted::new(vec![quota(Some("3600s"))]);
        let outcome = run_with(&["a"], &LIMITS, &transport);
        assert!(outcome.waits.is_empty());
        assert_eq!(transport.sent.lock().expect("sent").len(), 1);
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Quota));

        // 503 も待って送り直す。500 は送り直さない
        let transport = Scripted::new(vec![Step::Status(503, json!({})), Step::Echo]);
        let outcome = run_with(&["a"], &LIMITS, &transport);
        assert_eq!(outcome.waits.len(), 1);
        assert_eq!(finished(&outcome.events), None);
        let transport = Scripted::new(vec![Step::Status(500, json!({}))]);
        let outcome = run_with(&["a"], &LIMITS, &transport);
        assert!(outcome.waits.is_empty());
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Service));
    }

    #[test]
    fn cancelled_batch_results_are_dropped() {
        let transport = Scripted::new(vec![Step::Echo, Step::CancelThenEcho]);
        let outcome = run_with(&["a", "b", "c", "d", "e"], &TWO_PER_BATCH, &transport);
        assert_eq!(transport.sent.lock().expect("sent").len(), 2);
        // 取り消しの後に戻った組の訳は知らせない
        assert_eq!(translated_ids(&outcome.events), vec![0, 1]);
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Cancelled));
    }

    #[test]
    fn too_long_items_are_reported_without_sending() {
        let long = "x".repeat(LIMITS.item_chars + 1);
        let transport = Scripted::new(vec![]);
        let outcome = run_with(&["a", &long], &LIMITS, &transport);
        assert_eq!(outcome.events[0], JobEvent::Failed { job: 7, ids: vec![1], reason: ItemFailure::TooLong });
        assert_eq!(transport.sent_texts(), vec![vec!["a".to_owned()]]);
    }

    #[test]
    fn errors_never_contain_key() {
        // サービスが誤りの文にキーを返しても、知らせる物はキーを持たない
        let echoing = json!({ "status": "INVALID_ARGUMENT", "message": format!("API key not valid: {KEY}"),
            "details": [{ "reason": "API_KEY_INVALID", "metadata": { "key": KEY } }] });
        let scenarios = vec![
            vec![Step::Status(400, echoing.clone())],
            vec![Step::Status(403, echoing.clone())],
            vec![Step::Status(429, echoing.clone()), Step::Status(429, echoing.clone()), Step::Status(429, echoing)],
            vec![Step::Fail(TransportError::Timeout)],
            vec![Step::Raw(HttpResponse { status: 200, body: format!("{{\"leak\":\"{KEY}\"}}").into_bytes() })],
        ];
        let probe = &KEY[KEY.len() - 10..];
        for steps in scenarios {
            let transport = Scripted::new(steps);
            let outcome = run_with(&["a"], &LIMITS, &transport);
            for event in &outcome.events {
                let shown = [serde_json::to_string(event).expect("json"), format!("{event:?}")];
                for text in shown {
                    assert!(!text.contains(probe), "key in event: {text}");
                }
            }
            // キーは URL のパスと本文に入らない
            for request in transport.sent.lock().expect("sent").iter() {
                assert!(!request.path.contains(probe));
                assert!(!String::from_utf8_lossy(&request.body).contains(probe));
                assert!(!format!("{request:?}").contains(probe));
            }
        }
        for error in [TransportError::Refused, TransportError::Cancelled, TransportError::Timeout, TransportError::TooLarge, TransportError::Network(5)] {
            assert!(!error.to_string().contains(probe));
        }
        // 長い文の切れ目にキーがまたがっても、切る前に塗るので頭も尻も残らない
        let head = &KEY[..10];
        let long = format!("{}{KEY} tail", "x".repeat(crate::translate::service::DETAIL_MAX_CHARS - KEY.len() / 2));
        for fallback in [false, true] {
            let transport = Scripted::new(vec![Step::Status(400, json!({ "status": "INVALID_ARGUMENT", "message": long }))]);
            let outcome = run_job(&["a"], &LIMITS, &transport, fallback);
            let shown = serde_json::to_string(&outcome.events).expect("json");
            assert!(!shown.contains(probe) && !shown.contains(head), "key in event: {shown}");
            assert!(shown.contains("***"));
        }
    }

    const A: &str = crate::translate::GEMINI_MODELS[0];
    const B: &str = crate::translate::GEMINI_MODELS[1];
    const C: &str = crate::translate::GEMINI_MODELS[2];

    /// 2026-11-04 に実測した 503 の本文。
    fn overloaded() -> Step {
        Step::Status(503, json!({ "code": 503, "status": "UNAVAILABLE",
            "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later." }))
    }

    /// 送った要求のモデル（URL のパスから）。
    fn sent_models(transport: &Scripted) -> Vec<String> {
        transport
            .sent
            .lock()
            .expect("sent")
            .iter()
            .map(|request| request.path.trim_start_matches("/v1beta/models/").trim_end_matches(":generateContent").to_owned())
            .collect()
    }

    fn switches(events: &[JobEvent]) -> Vec<(String, String, ErrorKind)> {
        events
            .iter()
            .filter_map(|event| match event {
                JobEvent::Switched { from, to, reason, .. } => Some((from.clone(), to.clone(), *reason)),
                _ => None,
            })
            .collect()
    }

    fn translated_models(events: &[JobEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                JobEvent::Translated { model, .. } => Some(model.clone()),
                _ => None,
            })
            .collect()
    }

    fn finished_detail(events: &[JobEvent]) -> Option<ErrorDetail> {
        match events.last() {
            Some(JobEvent::Finished { detail, .. }) => detail.clone(),
            other => panic!("last event is not Finished: {other:?}"),
        }
    }

    #[test]
    fn fallback_overload_on_first_model_continues_on_next() {
        // 3 組。1 組目は A で通る。2 組目は A が再試行の後も混雑 → B へ切り替え、残りの組も B で送る
        let transport = Scripted::new(vec![Step::Echo, overloaded(), overloaded(), overloaded()]);
        let outcome = run_job(&["a", "b", "c", "d", "e", "f"], &TWO_PER_BATCH, &transport, true);
        assert_eq!(sent_models(&transport), [A, A, A, A, B, B]);
        assert_eq!(switches(&outcome.events), vec![(A.to_owned(), B.to_owned(), ErrorKind::Overloaded)]);
        assert_eq!(translated_models(&outcome.events), [A, B, B]);
        assert_eq!(translated_ids(&outcome.events), vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(outcome.waits.len(), RETRY.attempts as usize);
        assert_eq!(finished(&outcome.events), None);
        assert_eq!(finished_detail(&outcome.events), None);

        // 1 日の上限（待ちが長すぎる 429）は待たずに次のモデルへ
        let transport = Scripted::new(vec![quota(Some("3600s"))]);
        let outcome = run_job(&["a"], &LIMITS, &transport, true);
        assert!(outcome.waits.is_empty());
        assert_eq!(sent_models(&transport), [A, B]);
        assert_eq!(switches(&outcome.events), vec![(A.to_owned(), B.to_owned(), ErrorKind::Quota)]);
        assert_eq!(finished(&outcome.events), None);
    }

    #[test]
    fn fallback_not_on_key_permission_blocked_or_malformed() {
        let invalid = json!({ "status": "INVALID_ARGUMENT", "message": "API key not valid. Please pass a valid API key.",
            "details": [{ "reason": "API_KEY_INVALID" }] });
        let cases = vec![
            (Step::Status(400, invalid), Some(ErrorKind::Key)),
            (Step::Status(403, json!({ "status": "PERMISSION_DENIED", "message": "denied" })), Some(ErrorKind::Permission)),
            (Step::Status(404, json!({ "status": "NOT_FOUND" })), Some(ErrorKind::Model)),
            (Step::Status(500, json!({ "status": "INTERNAL" })), Some(ErrorKind::Service)),
            (Step::Fail(TransportError::Network(12007)), Some(ErrorKind::Network)),
            (Step::Raw(HttpResponse { status: 200, body: json!({ "promptFeedback": { "blockReason": "SAFETY" } }).to_string().into_bytes() }), None),
            (Step::Raw(HttpResponse { status: 200, body: b"<html>".to_vec() }), None),
        ];
        for (step, expected) in cases {
            let transport = Scripted::new(vec![step]);
            let outcome = run_job(&["a"], &LIMITS, &transport, true);
            assert_eq!(sent_models(&transport), [A], "{expected:?}");
            assert!(switches(&outcome.events).is_empty(), "{expected:?}");
            assert_eq!(finished(&outcome.events), expected);
        }
        // キーの誤りは Google の文を持って終わる
        let transport = Scripted::new(vec![Step::Status(400, json!({ "status": "INVALID_ARGUMENT", "message": "API key not valid. Please pass a valid API key.", "details": [{ "reason": "API_KEY_INVALID" }] }))]);
        let outcome = run_job(&["a"], &LIMITS, &transport, true);
        assert_eq!(
            finished_detail(&outcome.events),
            Some(ErrorDetail { status: "INVALID_ARGUMENT".into(), message: "API key not valid. Please pass a valid API key.".into() })
        );
        // 通信の失敗は Win32 の番号を詳しい行に持つ
        let transport = Scripted::new(vec![Step::Fail(TransportError::Network(12007))]);
        let outcome = run_job(&["a"], &LIMITS, &transport, true);
        assert_eq!(finished_detail(&outcome.events), Some(ErrorDetail { status: String::new(), message: "network error 12007".into() }));
    }

    #[test]
    fn fallback_all_models_overloaded_fails_once_each() {
        let attempts = RETRY.attempts as usize + 1;
        let steps = (0..attempts * crate::translate::GEMINI_MODELS.len()).map(|_| overloaded()).collect();
        let transport = Scripted::new(steps);
        let outcome = run_job(&["a", "b", "c"], &TWO_PER_BATCH, &transport, true);
        // 各モデルを 1 回ずつ（再試行を含めて）試し、どれにも戻らない。2 組目は送らない
        let expected: Vec<&str> = [A, B, C].iter().flat_map(|model| std::iter::repeat_n(*model, attempts)).collect();
        assert_eq!(sent_models(&transport), expected);
        assert_eq!(
            switches(&outcome.events),
            vec![(A.to_owned(), B.to_owned(), ErrorKind::Overloaded), (B.to_owned(), C.to_owned(), ErrorKind::Overloaded)]
        );
        assert!(translated_ids(&outcome.events).is_empty());
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Overloaded));
        assert_eq!(finished_detail(&outcome.events).expect("detail").status, "UNAVAILABLE");
    }

    #[test]
    fn fallback_off_keeps_the_chosen_model() {
        let transport = Scripted::new(vec![overloaded(), overloaded(), overloaded(), Step::Echo]);
        let outcome = run_job(&["a"], &LIMITS, &transport, false);
        assert_eq!(sent_models(&transport), [A, A, A]);
        assert!(switches(&outcome.events).is_empty());
        assert_eq!(finished(&outcome.events), Some(ErrorKind::Overloaded));
        let detail = finished_detail(&outcome.events).expect("detail");
        assert_eq!(detail.status, "UNAVAILABLE");
        assert!(detail.message.starts_with("This model is currently experiencing high demand."));
    }

    #[test]
    fn next_model_wraps_around_and_skips_used() {
        let list = crate::translate::GEMINI_MODELS;
        let models = Models::new(B);
        assert_eq!(models.next(&list), Some(C));
        models.switch(C);
        // 末尾の次は先頭
        assert_eq!(models.next(&list), Some(A));
        models.switch(A);
        // 全部使った
        assert_eq!(models.next(&list), None);
        // 一覧に 1 つしか無ければ切り替え先は無い
        assert_eq!(Models::new(A).next(&[A]), None);
    }
}
