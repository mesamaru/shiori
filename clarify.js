// clarify.js
// フェーズ4: 確認フロー
//
// discord-ai-project-plan.md / cowork-instructions.md のフェーズ4に対応。
//   1. pending_clarifications が作成されたら、該当チャンネルへBotが確認メッセージを投稿
//   2. ユーザーがその投稿へ「返信（reply）」した内容を検知し、
//      resolved_answer に保存して status='resolved' に更新
//   3. 解決済みの確認事項は Redis のキューへ積み、次回の /analyze で差分として取り込む
//
// 判定エンジンがルールベース（無料）の場合、曖昧なものは必ずここへ回ってくるため、
// このフローが人間の判断を拾う唯一の経路になる。

const { pushResolvedClarification } = require('./redis');

// 確認種別ごとの見出し。Discord上で何を聞かれているか一目で分かるようにする。
const TYPE_LABELS = {
  assignee: '担当者の確認',
  project_match: 'プロジェクトの確認',
  task_match: '対象タスクの確認',
  status: 'ステータスの確認',
};

/**
 * まだ投稿していない確認事項をチャンネルへ投稿し、
 * 投稿したメッセージIDを bot_question_message_id に記録する。
 *
 * bot_question_message_id が NULL のものだけを対象にするため、
 * 途中でBotが落ちても再実行すれば続きから投稿でき、二重投稿にならない。
 *
 * @returns {Promise<number>} 投稿した件数
 */
async function postOpenClarifications(client, dbPool) {
  const [rows] = await dbPool.query(
    `SELECT id, clarification_type, question, channel_id
       FROM pending_clarifications
      WHERE status = 'open'
        AND bot_question_message_id IS NULL
      ORDER BY id ASC`
  );

  let posted = 0;

  for (const row of rows) {
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[clarify] 投稿できないチャンネルです: ${row.channel_id}`);
        continue;
      }

      const label = TYPE_LABELS[row.clarification_type] ?? '確認';
      const sent = await channel.send(
        [
          `**${label}**`,
          row.question,
          '',
          '_このメッセージに返信（リプライ）して回答してください。_',
        ].join('\n')
      );

      await dbPool.query(
        'UPDATE pending_clarifications SET bot_question_message_id = ? WHERE id = ?',
        [sent.id, row.id]
      );
      posted += 1;
    } catch (err) {
      console.error(`[clarify] 確認メッセージの投稿に失敗しました (id: ${row.id}):`, err.message);
    }
  }

  return posted;
}

/**
 * メッセージがBotの確認メッセージへの返信かどうかを判定し、
 * そうであれば回答として記録する。
 *
 * @returns {Promise<boolean>} 確認事項の回答として処理したら true
 */
async function handleClarificationReply(dbPool, message) {
  // 返信でなければ対象外
  const repliedToId = message.reference?.messageId;
  if (!repliedToId) return false;

  const [rows] = await dbPool.query(
    `SELECT id, clarification_type
       FROM pending_clarifications
      WHERE bot_question_message_id = ?
        AND status = 'open'`,
    [repliedToId]
  );
  if (rows.length === 0) return false; // Botの確認メッセージ以外への返信

  const clarification = rows[0];

  await dbPool.query(
    `UPDATE pending_clarifications
        SET resolved_answer = ?,
            resolved_by_message_id = ?,
            status = 'resolved',
            resolved_at = NOW()
      WHERE id = ?`,
    [message.content, message.id, clarification.id]
  );

  // 次回の /analyze で取り込むためキューへ積む。
  // Redis側が落ちていてもDBの記録は残るので、回答自体が失われることはない。
  try {
    await pushResolvedClarification(clarification.id);
  } catch (err) {
    console.error('[clarify] 解決キューへの追加に失敗しました:', err.message);
  }

  console.log(`[clarify] 確認事項 #${clarification.id} が解決されました`);
  return true;
}

module.exports = { postOpenClarifications, handleClarificationReply };
