//! 未保存の印と、閉じる（別のファイルを開く）判断の状態機械。
//!
//! 判断は Rust の印だけで決め、JS へ問い合わせない。レンダラが固まっても閉じられる。
//! ウィンドウにもダイアログにも触らず、やることは [`Effect`] で返す。

use serde::Deserialize;

/// 画面が送る文書の状態。`seq` が大きい物だけを採る。Tauri の IPC は到着順を保証しないので、
/// 下ろす通知が後の立てる通知を追い越すと、未保存が消える。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReport {
    pub seq: u64,
    pub unsaved: bool,
    /// 保存が止まっている。「保存」の選択肢を出さない。
    pub save_blocked: bool,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    Close,
    Open(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Save,
    Discard,
    Cancel,
}

pub const WITH_SAVE: [Choice; 3] = [Choice::Save, Choice::Discard, Choice::Cancel];
pub const WITHOUT_SAVE: [Choice; 2] = [Choice::Discard, Choice::Cancel];

#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    None,
    Close,
    Open {
        path: String,
        discard_confirmed: bool,
    },
    Ask {
        choices: &'static [Choice],
    },
    /// 画面に保存させる。終わりは `save_finished` で届く。
    Save {
        id: u64,
    },
    /// 保存の返事を待っている間に閉じる操作が来た。待つか、保存せず閉じるかを聞く。
    AskStuck,
    /// 確認か保存の途中なので、別のファイルは開かない。
    OpenBusy,
}

#[derive(Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Asking(Intent),
    Saving {
        id: u64,
        intent: Intent,
        /// `AskStuck` の答えを待っている。
        stuck_asked: bool,
        /// `AskStuck` の間に届いた保存の結果。
        finished: Option<bool>,
    },
}

#[derive(Debug)]
pub struct UnsavedState {
    seq: u64,
    unsaved: bool,
    save_blocked: bool,
    next_id: u64,
    phase: Phase,
}

impl Default for UnsavedState {
    fn default() -> Self {
        Self {
            seq: 0,
            unsaved: false,
            save_blocked: false,
            next_id: 1,
            phase: Phase::Idle,
        }
    }
}

impl UnsavedState {
    /// 新しい版を採ったら true。
    pub fn report(&mut self, report: &DocumentReport) -> bool {
        if report.seq <= self.seq {
            return false;
        }
        self.seq = report.seq;
        self.unsaved = report.unsaved;
        self.save_blocked = report.save_blocked;
        true
    }

    /// 画面を読み直した。文書も `seq` も作り直される。
    pub fn page_loaded(&mut self) {
        *self = Self {
            next_id: self.next_id,
            ..Self::default()
        };
    }

    fn ask(&mut self, intent: Intent) -> Effect {
        self.phase = Phase::Asking(intent);
        Effect::Ask {
            choices: if self.save_blocked {
                &WITHOUT_SAVE
            } else {
                &WITH_SAVE
            },
        }
    }

    fn proceed(&mut self, intent: Intent, discard_confirmed: bool) -> Effect {
        self.phase = Phase::Idle;
        match intent {
            Intent::Close => Effect::Close,
            Intent::Open(path) => Effect::Open {
                path,
                discard_confirmed,
            },
        }
    }

    /// 閉じる、開くの要求。
    pub fn request(&mut self, intent: Intent) -> Effect {
        match (&mut self.phase, &intent) {
            (Phase::Idle, _) if self.unsaved => self.ask(intent),
            (Phase::Idle, _) => self.proceed(intent, false),
            (
                Phase::Saving {
                    stuck_asked: stuck_asked @ false,
                    ..
                },
                Intent::Close,
            ) => {
                *stuck_asked = true;
                Effect::AskStuck
            }
            (_, Intent::Open(_)) => Effect::OpenBusy,
            // 親の窓が無効なので普通は来ない。確認を重ねない
            (_, Intent::Close) => Effect::None,
        }
    }

    /// 未保存の確認の答え。
    pub fn answer(&mut self, choice: Choice) -> Effect {
        let Phase::Asking(intent) = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return Effect::None;
        };
        match choice {
            Choice::Cancel => Effect::None,
            Choice::Discard => self.proceed(intent, true),
            Choice::Save => {
                let id = self.next_id;
                self.next_id += 1;
                self.phase = Phase::Saving {
                    id,
                    intent,
                    stuck_asked: false,
                    finished: None,
                };
                Effect::Save { id }
            }
        }
    }

    /// 保存の終わり。古い `id` は無視する。
    pub fn save_finished(&mut self, finished_id: u64, ok: bool) -> Effect {
        match &mut self.phase {
            Phase::Saving {
                id,
                stuck_asked: true,
                finished,
                ..
            } if *id == finished_id => {
                *finished = Some(ok);
                Effect::None
            }
            Phase::Saving { id, .. } if *id == finished_id => {
                let intent = self.take_saving_intent();
                self.finish(intent, ok)
            }
            _ => Effect::None,
        }
    }

    /// `AskStuck` の答え。
    pub fn answer_stuck(&mut self, close_without_saving: bool) -> Effect {
        let Phase::Saving {
            stuck_asked: stuck_asked @ true,
            finished,
            ..
        } = &mut self.phase
        else {
            return Effect::None;
        };
        *stuck_asked = false;
        let finished = *finished;
        if close_without_saving {
            self.phase = Phase::Idle;
            return Effect::Close;
        }
        match finished {
            Some(ok) => {
                let intent = self.take_saving_intent();
                self.finish(intent, ok)
            }
            None => Effect::None,
        }
    }

    fn take_saving_intent(&mut self) -> Intent {
        match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Saving { intent, .. } => intent,
            _ => unreachable!("the caller has checked for the Saving phase"),
        }
    }

    fn finish(&mut self, intent: Intent, ok: bool) -> Effect {
        if !ok {
            // 理由は画面が出した。閉じず、開かず、編集を残す
            self.phase = Phase::Idle;
            Effect::None
        } else if self.unsaved {
            // 保存の間に打った
            self.ask(intent)
        } else {
            self.proceed(intent, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(seq: u64, unsaved: bool, save_blocked: bool) -> DocumentReport {
        DocumentReport {
            seq,
            unsaved,
            save_blocked,
            title: String::new(),
        }
    }

    fn with_mark(unsaved: bool) -> UnsavedState {
        let mut state = UnsavedState::default();
        state.report(&report(1, unsaved, false));
        state
    }

    fn open() -> Intent {
        Intent::Open("a.json".into())
    }

    const OPENED: fn(bool) -> Effect = |discard_confirmed| Effect::Open {
        path: "a.json".into(),
        discard_confirmed,
    };

    fn saving(intent: Intent) -> (UnsavedState, u64) {
        let mut state = with_mark(true);
        state.request(intent);
        match state.answer(Choice::Save) {
            Effect::Save { id } => (state, id),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn idle_without_a_mark_goes_ahead() {
        assert_eq!(with_mark(false).request(Intent::Close), Effect::Close);
        assert_eq!(with_mark(false).request(open()), OPENED(false));
    }

    #[test]
    fn idle_with_a_mark_asks_for_both_requests() {
        let three = Effect::Ask { choices: &WITH_SAVE };
        assert_eq!(with_mark(true).request(Intent::Close), three);
        assert_eq!(with_mark(true).request(open()), three);
    }

    #[test]
    fn a_stopped_save_offers_no_save_button() {
        let mut state = UnsavedState::default();
        state.report(&report(1, true, true));
        assert_eq!(
            state.request(Intent::Close),
            Effect::Ask { choices: &WITHOUT_SAVE }
        );
    }

    #[test]
    fn requests_while_asking_do_not_stack_a_second_dialog() {
        let mut state = with_mark(true);
        state.request(Intent::Close);
        assert_eq!(state.request(Intent::Close), Effect::None);
        assert_eq!(state.request(open()), Effect::OpenBusy);
    }

    #[test]
    fn cancel_keeps_the_window_and_returns_to_idle() {
        let mut state = with_mark(true);
        state.request(Intent::Close);
        assert_eq!(state.answer(Choice::Cancel), Effect::None);
        assert_eq!(state.phase, Phase::Idle);
    }

    #[test]
    fn discard_closes_or_opens_with_the_decision() {
        let mut state = with_mark(true);
        state.request(Intent::Close);
        assert_eq!(state.answer(Choice::Discard), Effect::Close);
        assert_eq!(state.phase, Phase::Idle);

        let mut state = with_mark(true);
        state.request(open());
        assert_eq!(state.answer(Choice::Discard), OPENED(true));
    }

    #[test]
    fn an_answer_without_a_question_does_nothing() {
        assert_eq!(with_mark(true).answer(Choice::Discard), Effect::None);
        assert_eq!(with_mark(true).answer_stuck(true), Effect::None);
    }

    #[test]
    fn a_finished_save_without_a_mark_goes_ahead() {
        let (mut state, id) = saving(Intent::Close);
        state.report(&report(2, false, false));
        assert_eq!(state.save_finished(id, true), Effect::Close);

        let (mut state, id) = saving(open());
        state.report(&report(2, false, false));
        assert_eq!(state.save_finished(id, true), OPENED(false));
    }

    #[test]
    fn typing_during_the_save_asks_again() {
        let (mut state, id) = saving(Intent::Close);
        state.report(&report(2, true, false));
        assert_eq!(
            state.save_finished(id, true),
            Effect::Ask { choices: &WITH_SAVE }
        );
        assert_eq!(state.phase, Phase::Asking(Intent::Close));
    }

    #[test]
    fn a_failed_or_cancelled_save_does_not_close() {
        let (mut state, id) = saving(Intent::Close);
        assert_eq!(state.save_finished(id, false), Effect::None);
        assert_eq!(state.phase, Phase::Idle);
        // 印は残っているので、次の×でまた聞く
        assert_eq!(
            state.request(Intent::Close),
            Effect::Ask { choices: &WITH_SAVE }
        );
    }

    #[test]
    fn a_stale_save_id_is_ignored() {
        let (mut state, id) = saving(Intent::Close);
        state.report(&report(2, false, false));
        assert_eq!(state.save_finished(id + 1, true), Effect::None);
        assert!(matches!(state.phase, Phase::Saving { .. }));
    }

    #[test]
    fn close_while_the_save_is_silent_asks_once_and_never_closes_by_itself() {
        let (mut state, _) = saving(Intent::Close);
        assert_eq!(state.request(Intent::Close), Effect::AskStuck);
        assert_eq!(state.request(Intent::Close), Effect::None);
        assert_eq!(state.answer_stuck(false), Effect::None);
        // 待つの後の×はまた聞く
        assert_eq!(state.request(Intent::Close), Effect::AskStuck);
    }

    #[test]
    fn open_while_the_save_is_silent_is_refused() {
        let (mut state, _) = saving(Intent::Close);
        assert_eq!(state.request(open()), Effect::OpenBusy);
    }

    #[test]
    fn closing_without_saving_is_only_on_the_explicit_answer() {
        let (mut state, _) = saving(Intent::Close);
        state.request(Intent::Close);
        assert_eq!(state.answer_stuck(true), Effect::Close);
        assert_eq!(state.phase, Phase::Idle);
    }

    #[test]
    fn a_save_finished_during_the_stuck_question_applies_on_wait() {
        let (mut state, id) = saving(open());
        state.request(Intent::Close);
        state.report(&report(2, false, false));
        assert_eq!(state.save_finished(id, true), Effect::None);
        assert_eq!(state.answer_stuck(false), OPENED(false));
        assert_eq!(state.phase, Phase::Idle);
    }

    #[test]
    fn a_failure_during_the_stuck_question_stays_open_on_wait() {
        let (mut state, id) = saving(Intent::Close);
        state.request(Intent::Close);
        state.save_finished(id, false);
        assert_eq!(state.answer_stuck(false), Effect::None);
        assert_eq!(state.phase, Phase::Idle);
    }

    #[test]
    fn an_older_report_cannot_lower_the_mark() {
        let mut state = UnsavedState::default();
        assert!(state.report(&report(2, true, false)));
        assert!(!state.report(&report(1, false, false)));
        assert_eq!(
            state.request(Intent::Close),
            Effect::Ask { choices: &WITH_SAVE }
        );
    }

    #[test]
    fn a_reloaded_page_starts_over_without_reusing_a_save_id() {
        let (mut state, id) = saving(Intent::Close);
        state.page_loaded();
        assert_eq!(state.phase, Phase::Idle);
        assert!(state.report(&report(1, true, false)));
        state.report(&report(2, false, false));
        assert_eq!(state.save_finished(id, true), Effect::None);

        state.report(&report(3, true, false));
        state.request(Intent::Close);
        assert_eq!(state.answer(Choice::Save), Effect::Save { id: id + 1 });
    }
}
