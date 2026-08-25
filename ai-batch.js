// ai-batch.js
// フェーズ3: 手動バッチ処理（差分抽出 → 判定 → タスクDB更新）
//
// discord-ai-project-plan.md の③④に対応。
//   - ユーザーが明示的に /analyze コマンドを実行した時だけ動く（定期実行なし）
//   - Redisに溜まった差分候補（pending_diff）だけを判定対象にする
//   - 差分が無ければ判定処理自体をスキップする
//
// 判定エンジンは .env の AI_PROVIDER で差し替えられる。
//   rules  … ルールベース判定（APIコストゼロ・デフォルト）
//   claude … Claude API（従量課金。課金できるようになったらこちらへ切替）
//
// どちらのエンジンも同じ形の結果を返すため、この先のDB反映処理は共通。

const {
  getPendingDiff,
  clearPendingDiff,
  setCursor,
  getResolvedClarifications,
  clearResolvedClarifications,
} = require('./redis');

const PROVIDER = (process.env.AI_PROVIDER || 'rules').toLowerCase();

// DBのENUM定義と一致する許容値。
// 判定エンジン側（特にAI）が想定外の文字列を返してもINSERTが落ちないよう、
// 反映前に必ず検証する。
const VALID_STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);
const VALID_CLARIFICATION_TYPES = new Set([
  'assignee',
  'project_match',
  'task_match',
  'status',
]);

/**
 * 設定に応じた判定エンジンを返す
 */
function getAnalyzer() {
  if (PROVIDER === 'claude') return require('./analyze-claude');
  if (PROVIDER === 'rules') return require('./analyze-rules');
  throw new Error(`AI_PROVIDER の値が不正です: ${PROVIDER}（rules または claude）`);
}

/**
 * AIへ渡す差分メッセージをDBから取得する。
 * Redisのpending_diffに積まれたDiscord message_idを、DBの行に引き当てる。
 */
async function fetchDiffMessages(dbPool, discordMessageIds) {
  if (discordMessageIds.length === 0) return [];

  const [rows] = await dbPool.query(
    `SELECT id, message_id, channel_id, author_id, author_name, content, created_at
       FROM messages
      WHERE message_id IN (?)
        AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [discordMessageIds]
  );
  return rows;
}

/**
 * フェーズ4で解決した確認事項を、元になったメッセージ本文とセットで取得する。
 * 「『完了しました』はどのタスク？」→「検索機能の追加です」のように、
 * 質問の元メッセージが無いと何を反映すべきか決まらないため JOIN している。
 */
async function fetchResolvedClarifications(dbPool, ids) {
  if (ids.length === 0) return [];

  const [rows] = await dbPool.query(
    `SELECT pc.id, pc.clarification_type, pc.question, pc.resolved_answer,
            pc.related_task_id, pc.source_message_id, pc.channel_id,
            m.content AS source_content
       FROM pending_clarifications pc
       LEFT JOIN messages m ON m.id = pc.source_message_id
      WHERE pc.id IN (?)
        AND pc.status = 'resolved'
      ORDER BY pc.id ASC`,
    [ids]
  );
  return rows;
}

/**
 * 判定材料としてアクティブなタスクとプロジェクト一覧を取得する。
 * 完了済み（done）タスクはトークン節約のため除外する。
 */
async function fetchContext(dbPool) {
  const [tasks] = await dbPool.query(
    `SELECT id, project_id, title, status, assignee_id
       FROM tasks
      WHERE status <> 'done'
      ORDER BY id ASC`
  );
  const [projects] = await dbPool.query(
    `SELECT id, name, description FROM projects ORDER BY id ASC`
  );
  return { tasks, projects };
}

/**
 * 判定結果をDBへ反映する。
 * 途中で失敗しても中途半端な状態が残らないよう、1トランザクションでまとめて実行する。
 */
async function applyResult(
  dbPool,
  result,
  validMessageIds,
  validTaskIds,
  channelByMessageId
) {
  const conn = await dbPool.getConnection();
  const applied = { newTasks: 0, updates: 0, assignments: 0, clarifications: 0 };
  // フェーズ5の通知用。「何が起きたか」を反映と同時に記録しておく
  const events = [];

  try {
    await conn.beginTransaction();

    // --- 新規タスク ---
    for (const task of result.new_tasks) {
      if (!VALID_STATUSES.has(task.status)) {
        console.warn(`[batch] 不正なstatusのため新規タスクをスキップ: ${task.status}`);
        continue;
      }
      // 実在しないメッセージidを指していた場合は外部キー違反になるため参照を落とす
      const sourceId = validMessageIds.has(task.source_message_id)
        ? task.source_message_id
        : null;

      const [insert] = await conn.query(
        `INSERT INTO tasks
           (project_id, title, status, assignee_id, assignee_unconfirmed, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          task.project_id,
          task.title,
          task.status,
          task.assignee_id,
          task.assignee_unconfirmed,
          sourceId,
        ]
      );

      await conn.query(
        `INSERT INTO task_history
           (task_id, change_type, new_status, change_summary, source_message_id)
         VALUES (?, 'created', ?, ?, ?)`,
        [insert.insertId, task.status, `新規タスクを検出: ${task.title}`, sourceId]
      );
      applied.newTasks += 1;

      events.push({
        kind: 'task_created',
        taskId: insert.insertId,
        title: task.title,
        newStatus: task.status,
        assigneeId: task.assignee_id,
        channelId: channelByMessageId.get(task.source_message_id) ?? null,
      });
    }

    // --- 既存タスクの進捗更新 ---
    for (const update of result.task_updates) {
      if (!validTaskIds.has(update.task_id)) continue; // 実在しないタスクidは無視
      if (!VALID_STATUSES.has(update.new_status)) {
        console.warn(`[batch] 不正なstatusのため更新をスキップ: ${update.new_status}`);
        continue;
      }

      const [[current]] = await conn.query(
        'SELECT status, title, assignee_id FROM tasks WHERE id = ?',
        [update.task_id]
      );
      if (!current || current.status === update.new_status) continue; // 変化なしなら履歴を残さない

      const sourceId = validMessageIds.has(update.source_message_id)
        ? update.source_message_id
        : null;

      await conn.query('UPDATE tasks SET status = ? WHERE id = ?', [
        update.new_status,
        update.task_id,
      ]);
      await conn.query(
        `INSERT INTO task_history
           (task_id, change_type, old_status, new_status, change_summary, source_message_id)
         VALUES (?, 'status_changed', ?, ?, ?, ?)`,
        [update.task_id, current.status, update.new_status, update.change_summary, sourceId]
      );
      applied.updates += 1;

      events.push({
        kind: 'status_changed',
        taskId: update.task_id,
        title: current.title,
        oldStatus: current.status,
        newStatus: update.new_status,
        assigneeId: current.assignee_id,
        channelId: channelByMessageId.get(update.source_message_id) ?? null,
      });
    }

    // --- 担当者・プロジェクトの確定（主にフェーズ4の回答からの反映） ---
    for (const assign of result.task_assignments ?? []) {
      if (!validTaskIds.has(assign.task_id)) continue;

      const sets = [];
      const params = [];
      if (assign.assignee_id !== undefined && assign.assignee_id !== null) {
        // 回答で担当者が確定したので、未確認フラグも同時に下ろす
        sets.push('assignee_id = ?', 'assignee_unconfirmed = FALSE');
        params.push(assign.assignee_id);
      }
      if (assign.project_id !== undefined && assign.project_id !== null) {
        sets.push('project_id = ?');
        params.push(assign.project_id);
      }
      if (sets.length === 0) continue;

      params.push(assign.task_id);
      await conn.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);

      const sourceId = validMessageIds.has(assign.source_message_id)
        ? assign.source_message_id
        : null;
      await conn.query(
        `INSERT INTO task_history
           (task_id, change_type, change_summary, source_message_id)
         VALUES (?, 'note_added', ?, ?)`,
        [assign.task_id, assign.change_summary, sourceId]
      );
      applied.assignments += 1;
    }

    // --- 確認事項（フェーズ4で該当チャンネルへ投稿される） ---
    for (const c of result.clarifications) {
      if (!VALID_CLARIFICATION_TYPES.has(c.clarification_type)) {
        console.warn(
          `[batch] 不正なclarification_typeのためスキップ: ${c.clarification_type}`
        );
        continue;
      }
      const sourceId = validMessageIds.has(c.source_message_id) ? c.source_message_id : null;
      const relatedTaskId = validTaskIds.has(c.related_task_id) ? c.related_task_id : null;

      await conn.query(
        `INSERT INTO pending_clarifications
           (related_task_id, clarification_type, question, source_message_id, channel_id)
         VALUES (?, ?, ?, ?, ?)`,
        [relatedTaskId, c.clarification_type, c.question, sourceId, c.channel_id]
      );
      applied.clarifications += 1;
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { applied, events };
}

/**
 * 指定チャンネル群に対してバッチ処理を実行する。
 *
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {string[]} channelIds 監視対象チャンネルIDの配列
 * @returns {Promise<{skipped: boolean, provider: string, messageCount: number, applied?: object, usage?: object}>}
 */
async function runAiBatch(dbPool, channelIds) {
  // 1. Redisから差分候補を集める
  const diffByChannel = new Map();
  for (const channelId of channelIds) {
    const ids = await getPendingDiff(channelId);
    if (ids.length > 0) diffByChannel.set(channelId, ids);
  }

  // 1b. フェーズ4で解決した確認事項も差分として取り込む
  const resolvedIds = await getResolvedClarifications();
  const resolutions = await fetchResolvedClarifications(dbPool, resolvedIds);

  const allDiscordIds = [...diffByChannel.values()].flat();
  if (allDiscordIds.length === 0 && resolutions.length === 0) {
    // 差分が無ければ判定処理自体を行わない（claudeモード時のコスト最小化の要）
    return { skipped: true, provider: PROVIDER, messageCount: 0 };
  }

  // 2. DBから本文と判定材料を取得
  const messages = await fetchDiffMessages(dbPool, allDiscordIds);
  if (messages.length === 0 && resolutions.length === 0) {
    // 全て削除済みだった場合。判定は行わずキューだけ掃除する
    for (const channelId of diffByChannel.keys()) {
      await clearPendingDiff(channelId);
    }
    return { skipped: true, provider: PROVIDER, messageCount: 0 };
  }

  const { tasks, projects } = await fetchContext(dbPool);

  // 3. 判定エンジンへ依頼（rules なら同期的に、claude ならAPI経由）
  const { result, usage } = await getAnalyzer().analyze(
    messages,
    tasks,
    projects,
    resolutions
  );

  // 4. 結果をDBへ反映
  const validMessageIds = new Set(messages.map((m) => m.id));
  const validTaskIds = new Set(tasks.map((t) => t.id));

  // 通知の投稿先を決めるため、メッセージidからチャンネルidを引けるようにしておく。
  // 確認回答（resolutions）は元メッセージが今回の差分に含まれないこともあるため、
  // そちらのチャンネル情報も併せて登録する。
  const channelByMessageId = new Map();
  for (const m of messages) channelByMessageId.set(m.id, m.channel_id);
  for (const r of resolutions) {
    if (r.source_message_id) channelByMessageId.set(r.source_message_id, r.channel_id);
  }

  const { applied, events } = await applyResult(
    dbPool,
    result,
    validMessageIds,
    validTaskIds,
    channelByMessageId
  );

  // 5. 処理済みマークとカーソル更新、キューの掃除
  if (messages.length > 0) {
    await dbPool.query('UPDATE messages SET is_ai_processed = TRUE WHERE id IN (?)', [
      messages.map((m) => m.id),
    ]);
  }

  for (const [channelId, ids] of diffByChannel) {
    // Discordのmessage_idは時系列で単調増加するsnowflakeなので、最大値が最後に処理した位置になる
    const latest = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    await setCursor(channelId, latest);
    await clearPendingDiff(channelId);
  }

  // 取り込み済みの解決済み確認事項をキューから外す（DBの記録は残る）
  if (resolvedIds.length > 0) {
    await clearResolvedClarifications();
  }

  return {
    skipped: false,
    provider: PROVIDER,
    messageCount: messages.length,
    resolutionCount: resolutions.length,
    applied,
    events, // フェーズ5の通知処理へ渡す
    usage,
  };
}

module.exports = { runAiBatch, PROVIDER };
