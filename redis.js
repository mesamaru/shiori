// redis.js
// フェーズ2: Redisによる差分管理
//
// 用途（discord-ai-project-plan.md の「Redis（一時データ）想定キー」に対応）：
//   cursor:{channel_id}       → 最後にAIへ渡したmessage_id
//                                （フェーズ3のAIバッチ処理が処理完了後に更新する）
//   pending_diff:{channel_id} → 差分候補（ルールベースでフラグが立った未処理メッセージ）の一時集合
//                                AIバッチ処理前に溜めておき、手動実行時にまとめて取り出す
//   resolved_clarifications   → 返信で解決した確認事項のidを積む集合（フェーズ4）
//                                次回の /analyze で差分として取り込まれる
//
// MariaDBが永続的な正本、Redisはあくまで「次にAIへ渡すべき差分」を素早く
// 参照するための軽量キャッシュという位置づけ（本体のメッセージデータはRedisに複製しない）。

const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

redis.on('error', (err) => {
  console.error('[redis] 接続エラー:', err.message);
});

redis.on('connect', () => {
  console.log('[redis] 接続しました');
});

function cursorKey(channelId) {
  return `cursor:${channelId}`;
}

function pendingDiffKey(channelId) {
  return `pending_diff:${channelId}`;
}

/**
 * チャンネルの「最後にAIへ渡したmessage_id」を取得する
 */
async function getCursor(channelId) {
  return redis.get(cursorKey(channelId));
}

/**
 * チャンネルの「最後にAIへ渡したmessage_id」を更新する（フェーズ3から呼び出す想定）
 */
async function setCursor(channelId, messageId) {
  return redis.set(cursorKey(channelId), messageId);
}

/**
 * 差分候補としてmessage_idを一時集合へ追加する。
 * Set構造のため同じmessage_idが積まれても重複しない
 * （同じメッセージが編集で複数回フラグ対象になっても1件扱いにできる）。
 */
async function pushPendingDiff(channelId, messageId) {
  return redis.sadd(pendingDiffKey(channelId), messageId);
}

/**
 * チャンネルに溜まっている差分候補のmessage_id一覧を取得する
 */
async function getPendingDiff(channelId) {
  return redis.smembers(pendingDiffKey(channelId));
}

/**
 * AIバッチ処理が完了した差分候補を集合から取り除く（フェーズ3から呼び出す想定）
 */
async function clearPendingDiff(channelId) {
  return redis.del(pendingDiffKey(channelId));
}

// --- フェーズ4: 解決済み確認事項のキュー ---
//
// pending_clarifications の永続的な正本はMariaDBに残るが、
// 「まだ /analyze に取り込んでいない解決済み確認事項」という一時的な状態は
// 差分候補と同じくRedisで管理する（スキーマ変更を伴わずに済む）。

const RESOLVED_CLARIFICATIONS_KEY = 'resolved_clarifications';

/**
 * 返信で解決した確認事項のidを積む
 */
async function pushResolvedClarification(clarificationId) {
  return redis.sadd(RESOLVED_CLARIFICATIONS_KEY, String(clarificationId));
}

/**
 * 未取り込みの解決済み確認事項のid一覧を取得する
 */
async function getResolvedClarifications() {
  return redis.smembers(RESOLVED_CLARIFICATIONS_KEY);
}

/**
 * 取り込みが完了した確認事項を集合から取り除く
 */
async function clearResolvedClarifications() {
  return redis.del(RESOLVED_CLARIFICATIONS_KEY);
}

module.exports = {
  redis,
  getCursor,
  setCursor,
  pushPendingDiff,
  getPendingDiff,
  clearPendingDiff,
  pushResolvedClarification,
  getResolvedClarifications,
  clearResolvedClarifications,
};
