// rules.js
// ルールベース一次判定（キーワード検知）
//
// 目的：
//   全メッセージをAIに渡すとコストが膨らむため、まずは正規表現による
//   キーワードマッチングで「AI判定が必要そうなメッセージ（差分候補）」だけを
//   is_rule_flagged = true としてDBに記録する。
//   曖昧な判断（本当に完了したのか／新規タスクなのか等）はここでは行わず、
//   後段のAIバッチ処理に委ねる。
//
// 表記ゆれ対応：
//   全角英数字→半角、大文字→小文字に正規化してからマッチングする。

const CATEGORIES = {
  DONE: 'done',
  PROGRESS: 'progress',
  BLOCKER: 'blocker',
  NEW_TASK: 'new_task',
};

// カテゴリごとのキーワード（正規表現）。日本語の表記ゆれを吸収するため
// 送り仮名・語尾のゆれをある程度許容した書き方にしている。
const KEYWORD_PATTERNS = [
  // 完了・終了報告
  { category: CATEGORIES.DONE, pattern: /完了|終わ(った|りました|り)|done|finish(ed)?|できました|できた/i },

  // 進捗報告・着手
  { category: CATEGORIES.PROGRESS, pattern: /進捗|進行中|対応中|着手|やってます|やってる|作業中|in\s*progress/i },

  // ブロッカー・困りごと
  { category: CATEGORIES.BLOCKER, pattern: /ブロッカー|blocker|詰まって|困って|止まって|停滞|エラーが出|できません|わかりません/i },

  // 新規タスク宣言（「〇〇やる」等）
  { category: CATEGORIES.NEW_TASK, pattern: /やります|やる(ぞ|ね)?|対応します|担当します|todo|task/i },
];

/**
 * 全角英数字を半角に変換する
 * @param {string} str
 * @returns {string}
 */
function toHalfWidth(str) {
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/**
 * メッセージ本文をルールベースで判定する
 * @param {string} content
 * @returns {{ flagged: boolean, matchedCategories: string[] }}
 */
function evaluateMessage(content) {
  if (!content || typeof content !== 'string') {
    return { flagged: false, matchedCategories: [] };
  }

  const normalized = toHalfWidth(content);
  const matchedCategories = [];

  for (const { category, pattern } of KEYWORD_PATTERNS) {
    if (pattern.test(normalized)) {
      matchedCategories.push(category);
    }
  }

  return {
    flagged: matchedCategories.length > 0,
    matchedCategories,
  };
}

module.exports = { evaluateMessage, CATEGORIES };
