// notify.js
// フェーズ5: 通知
//
// discord-ai-project-plan.md / cowork-instructions.md のフェーズ5に対応。
//   - タスクの新規登録・進捗更新があれば通知を送る
//   - 全体共有すべき情報（新規タスク登録、進捗変化） → 該当チャンネルへ投稿
//   - 個人に紐づく情報（担当タスクの完了通知）        → 担当者へDM
//   - 同じ変更に対する重複通知を防ぐため notifications テーブルを参照する
//
// 重複防止の考え方：
//   notifications に「同じタスク・同じ宛先・同じ本文」の記録が既にあれば送らない。
//   本文にはステータス変化が含まれるため、同じ変更は一度しか通知されず、
//   別の変更（todo→done など）は別の本文になるので通知される。

const STATUS_LABELS = {
  todo: '未着手',
  in_progress: '進行中',
  blocked: 'ブロック中',
  done: '完了',
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

/**
 * 既に同じ通知を送っていないか確認する
 */
async function alreadySent(dbPool, taskId, notifyType, targetId, content) {
  const [rows] = await dbPool.query(
    `SELECT id FROM notifications
      WHERE task_id = ? AND notify_type = ? AND target_id = ? AND content = ?
      LIMIT 1`,
    [taskId, notifyType, targetId, content]
  );
  return rows.length > 0;
}

/**
 * 通知を1件送信し、送信できたら notifications テーブルへ記録する。
 * 送信に失敗した場合は記録しない（次回の実行で再試行できるようにするため）。
 */
async function send(client, dbPool, { taskId, notifyType, targetId, content }) {
  if (await alreadySent(dbPool, taskId, notifyType, targetId, content)) return false;

  try {
    if (notifyType === 'channel') {
      const channel = await client.channels.fetch(targetId);
      if (!channel?.isTextBased()) return false;
      await channel.send(content);
    } else {
      const user = await client.users.fetch(targetId);
      await user.send(content);
    }
  } catch (err) {
    // DMを拒否している、チャンネルが消えた等。通知できなくても本処理は止めない
    console.error(`[notify] 送信に失敗しました (${notifyType} → ${targetId}):`, err.message);
    return false;
  }

  await dbPool.query(
    `INSERT INTO notifications (task_id, notify_type, target_id, content)
     VALUES (?, ?, ?, ?)`,
    [taskId, notifyType, targetId, content]
  );
  return true;
}

/**
 * バッチ処理で発生した変更イベントをもとに通知を送る。
 *
 * @param {import('discord.js').Client} client
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {object[]} events runAiBatch が返した変更イベント
 * @returns {Promise<{channel: number, dm: number}>} 実際に送信した件数
 */
async function sendNotifications(client, dbPool, events) {
  const sent = { channel: 0, dm: 0 };

  for (const event of events) {
    if (event.kind === 'task_created') {
      // 新規タスクの登録は全体共有 → チャンネルへ投稿
      if (event.channelId) {
        const assignee = event.assigneeId ? `<@${event.assigneeId}>` : '未定';
        const content = `新しいタスクを登録しました\n**${event.title}**\n担当: ${assignee} ／ 状態: ${statusLabel(event.newStatus)}`;
        if (await send(client, dbPool, {
          taskId: event.taskId,
          notifyType: 'channel',
          targetId: event.channelId,
          content,
        })) {
          sent.channel += 1;
        }
      }
      continue;
    }

    if (event.kind === 'status_changed') {
      // 進捗変化は全体共有 → チャンネルへ投稿
      if (event.channelId) {
        const content = `タスクの進捗が更新されました\n**${event.title}**\n${statusLabel(event.oldStatus)} → ${statusLabel(event.newStatus)}`;
        if (await send(client, dbPool, {
          taskId: event.taskId,
          notifyType: 'channel',
          targetId: event.channelId,
          content,
        })) {
          sent.channel += 1;
        }
      }

      // 担当タスクの完了は個人に紐づく情報 → 担当者へDM
      if (event.newStatus === 'done' && event.assigneeId) {
        const content = `担当タスク **${event.title}** が完了として記録されました。\n意図と異なる場合は、該当チャンネルでご連絡ください。`;
        if (await send(client, dbPool, {
          taskId: event.taskId,
          notifyType: 'dm',
          targetId: event.assigneeId,
          content,
        })) {
          sent.dm += 1;
        }
      }
    }
  }

  return sent;
}

module.exports = { sendNotifications };
