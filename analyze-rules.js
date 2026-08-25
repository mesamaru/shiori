// analyze-rules.js
// 判定エンジン（ルールベース版）— APIコスト完全ゼロ
//
// Claude APIを使わずに、正規表現と文字列類似度だけで
// 「新規タスク」「進捗更新」「要確認事項」を導き出す。
//
// 設計方針：
//   ルールで確実に判断できるものだけを自動反映し、
//   曖昧なものは推測せず pending_clarifications に回して人間に確認する。
//   （フェーズ4の確認フローが、AIの代わりに人間の判断を拾う役割を担う）
//
// analyze-claude.js と同じ形のオブジェクトを返すため、
// ai-batch.js からは同じように呼び出せる。

const { evaluateMessage, CATEGORIES } = require('./rules');

// タイトル一致とみなす類似度のしきい値
const CONFIDENT_MATCH = 0.5; // これ以上なら「そのタスクの話」と断定する
const AMBIGUOUS_MATCH = 0.25; // これ以上なら候補として拾い、確認に回す
const RIVAL_GAP = 0.15; // 1位と2位の差がこれ未満なら断定せず確認に回す

// 「〜やります」「〜対応します」等から、その前にある作業内容を抜き出す
const TASK_DECLARATION = /(.+?)(?:を|は)?\s*(?:やります|やる|やっときます|対応します|対応する|担当します|着手します|進めます|作ります|作成します|実装します|修正します)/;

// タイトル先頭に紛れ込みやすい語（時間・接続詞・メンションなど）を落とす。
// <@123>形式のメンションやチャンネル参照はタスク名の一部ではないので除去する。
const TITLE_NOISE =
  /^(?:じゃあ|では|それでは|これから|今日|明日|明後日|来週|今週|とりあえず|まず|一旦|自分が|私が|僕が|俺が|<@[!&]?\d+>|<#\d+>|@\S+|[\s、,]+)+/;

/**
 * 文字列を文字バイグラムの集合にする。
 * 日本語は単語境界が無く形態素解析器も使えないため、
 * 2文字単位の重なりで類似度を測る。
 */
function toBigrams(text) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

/**
 * タスクタイトルが、メッセージ本文にどれだけ含まれているかを 0〜1 で返す。
 * 「ログイン機能の実装」というタスクに対して
 * 「ログイン機能の実装終わりました」なら高スコアになる。
 */
function containmentScore(title, message) {
  const titleGrams = toBigrams(title);
  if (titleGrams.size === 0) return 0;

  const messageGrams = toBigrams(message);
  let hits = 0;
  for (const gram of titleGrams) {
    if (messageGrams.has(gram)) hits += 1;
  }
  return hits / titleGrams.size;
}

/**
 * ルール判定のカテゴリを、DBのステータス値へ変換する
 */
function categoryToStatus(categories) {
  if (categories.includes(CATEGORIES.DONE)) return 'done';
  if (categories.includes(CATEGORIES.BLOCKER)) return 'blocked';
  if (categories.includes(CATEGORIES.PROGRESS)) return 'in_progress';
  return null;
}

/**
 * 「〇〇やります」形式の発言からタスクタイトルを抜き出す。
 * 抽出できなければ null。
 */
function extractTaskTitle(content) {
  const match = TASK_DECLARATION.exec(content);
  if (!match) return null;

  const title = match[1].replace(TITLE_NOISE, '').trim();

  // 短すぎる／長すぎるものはタスク名として不適切なので採用しない
  if (title.length < 2 || title.length > 100) return null;
  return title;
}

/**
 * 既存タスクの中から、メッセージが指していそうなものを探す。
 * @returns {{ task: object|null, ambiguous: boolean, candidates: object[] }}
 */
function findRelatedTask(tasks, content) {
  const scored = tasks
    .map((task) => ({ task, score: containmentScore(task.title, content) }))
    .filter((entry) => entry.score >= AMBIGUOUS_MATCH)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { task: null, ambiguous: false, candidates: [] };
  }

  const top = scored[0];
  const runnerUp = scored[1];

  // 1位が十分高く、かつ2位と差が開いている場合だけ断定する
  const isConfident =
    top.score >= CONFIDENT_MATCH && (!runnerUp || top.score - runnerUp.score >= RIVAL_GAP);

  if (isConfident) {
    return { task: top.task, ambiguous: false, candidates: scored.map((s) => s.task) };
  }
  return { task: null, ambiguous: true, candidates: scored.map((s) => s.task) };
}

/**
 * 本文中のメンションから担当者を読み取る。
 * メンションが無ければ発言者本人を担当とみなす。
 */
function resolveAssignee(message) {
  const mention = /<@!?(\d+)>/.exec(message.content);
  if (mention) {
    // 「@誰か これお願い」なのか単に言及しただけなのかはルールでは判断できない
    return { assigneeId: mention[1], unconfirmed: true };
  }
  // 「〜やります」は一人称の宣言なので、発言者を担当と見てよい
  return { assigneeId: message.author_id, unconfirmed: false };
}

/**
 * プロジェクトを決定する。
 * 1件しか無ければそれで確定、複数あるならルールでは選べないので確認に回す。
 */
function resolveProject(projects) {
  if (projects.length === 1) return { projectId: projects[0].id, needsClarification: false };
  if (projects.length === 0) return { projectId: null, needsClarification: false };
  return { projectId: null, needsClarification: true };
}

// 回答が肯定・否定のどちらかを判定するパターン
const AFFIRMATIVE = /^(?:はい|うん|そう|そうです|合ってます|合っている|正しい|ok|yes|👍|o\.?k\.?)/i;
const NEGATIVE = /^(?:いいえ|いや|違います|違う|ちがう|no|誤り)/i;

/**
 * フェーズ4の回答（resolved_answer）を解釈して、タスクへの反映内容に変換する。
 *
 * ルールベースでは以下を処理する：
 *   task_match    … 回答が指すタスクを特定し、元メッセージのステータス変化を適用する
 *   assignee      … 肯定なら担当者を確定、メンションがあればその人に付け替える
 *   project_match … 回答が指すプロジェクトへ紐付ける
 *
 * 回答から判断できない場合は何も反映しない（再度の確認は作らず、握りつぶさない）。
 */
function applyResolutions(resolutions, tasks, projects, result) {
  for (const r of resolutions) {
    const answer = (r.resolved_answer || '').trim();
    if (!answer) continue;

    if (r.clarification_type === 'task_match') {
      // 「どのタスクの話ですか？」への回答からタスクを特定する
      const { task } = findRelatedTask(tasks, answer);
      if (!task) continue;

      // 元メッセージ（例:「完了しました！」）からステータスを決める
      const { matchedCategories } = evaluateMessage(r.source_content || '');
      const status = categoryToStatus(matchedCategories);
      if (!status || task.status === status) continue;

      result.task_updates.push({
        task_id: task.id,
        new_status: status,
        change_summary: `確認回答「${answer.slice(0, 40)}」により ${task.status} → ${status}`,
        source_message_id: r.source_message_id,
      });
      continue;
    }

    if (r.clarification_type === 'assignee') {
      const target = r.related_task_id
        ? tasks.find((t) => t.id === r.related_task_id)
        : findRelatedTask(tasks, r.question).task;
      if (!target) continue;

      const mention = /<@!?(\d+)>/.exec(answer);
      if (mention) {
        // 「いや、<@999>です」のように別の担当者を指定された場合
        result.task_assignments.push({
          task_id: target.id,
          assignee_id: mention[1],
          project_id: null,
          change_summary: `確認回答により担当者を <@${mention[1]}> に設定`,
          source_message_id: r.source_message_id,
        });
      } else if (AFFIRMATIVE.test(answer)) {
        // 「はい」なら現在の担当者で確定（未確認フラグを下ろすだけ）
        result.task_assignments.push({
          task_id: target.id,
          assignee_id: target.assignee_id,
          project_id: null,
          change_summary: '確認回答により担当者を確定',
          source_message_id: r.source_message_id,
        });
      }
      // 否定のみで代わりの担当者が示されない場合は、確定できないので何もしない
      continue;
    }

    if (r.clarification_type === 'project_match') {
      const target = r.related_task_id
        ? tasks.find((t) => t.id === r.related_task_id)
        : findRelatedTask(tasks, r.question).task;
      if (!target) continue;

      // 回答文に名前が含まれるプロジェクトを探す
      const scored = projects
        .map((p) => ({ p, score: containmentScore(p.name, answer) }))
        .filter((entry) => entry.score >= CONFIDENT_MATCH)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0) continue;

      result.task_assignments.push({
        task_id: target.id,
        assignee_id: null,
        project_id: scored[0].p.id,
        change_summary: `確認回答によりプロジェクト「${scored[0].p.name}」に紐付け`,
        source_message_id: r.source_message_id,
      });
    }
  }
}

/**
 * 差分メッセージを解析する。
 * analyze-claude.js と同じ形の結果を返す。
 *
 * @param {object[]} messages 差分メッセージ（DBの行）
 * @param {object[]} tasks アクティブなタスク
 * @param {object[]} projects プロジェクト一覧
 * @param {object[]} [resolutions] フェーズ4で解決済みの確認事項
 * @returns {{ result: object, usage: null }}
 */
function analyze(messages, tasks, projects, resolutions = []) {
  const result = { new_tasks: [], task_updates: [], task_assignments: [], clarifications: [] };

  // 先に確認回答を反映する（同じバッチ内の新規メッセージより確度が高い情報のため）
  applyResolutions(resolutions, tasks, projects, result);

  // このバッチ内で新規追加したタイトル。同じ内容が複数回宣言された場合の重複を防ぐ
  const newTitles = [];

  for (const message of messages) {
    const { matchedCategories } = evaluateMessage(message.content);
    const status = categoryToStatus(matchedCategories);

    // --- 1. 既存タスクへの進捗報告か？ ---
    if (status) {
      const { task, ambiguous, candidates } = findRelatedTask(tasks, message.content);

      if (task) {
        if (task.status !== status) {
          result.task_updates.push({
            task_id: task.id,
            new_status: status,
            change_summary: `ルール判定: 「${message.content.slice(0, 60)}」から ${task.status} → ${status}`,
            source_message_id: message.id,
          });
        }
        continue;
      }

      if (ambiguous) {
        const names = candidates.slice(0, 3).map((t) => `「${t.title}」`).join('・');
        result.clarifications.push({
          clarification_type: 'task_match',
          question: `「${message.content.slice(0, 60)}」は、どのタスクについての報告ですか？（候補: ${names}）`,
          related_task_id: candidates[0].id,
          source_message_id: message.id,
          channel_id: message.channel_id,
        });
        continue;
      }
    }

    // --- 2. 新規タスクの宣言か？ ---
    const title = extractTaskTitle(message.content);
    if (title) {
      // 既存タスクや、このバッチで既に拾ったものと重複していないか確認
      const duplicatesExisting = tasks.some(
        (t) => containmentScore(t.title, title) >= CONFIDENT_MATCH
      );
      const duplicatesNew = newTitles.some(
        (t) => containmentScore(t, title) >= CONFIDENT_MATCH
      );
      if (duplicatesExisting || duplicatesNew) continue;

      const { assigneeId, unconfirmed } = resolveAssignee(message);
      const { projectId, needsClarification } = resolveProject(projects);

      result.new_tasks.push({
        title,
        project_id: projectId,
        status: status === 'done' ? 'done' : 'todo',
        assignee_id: assigneeId,
        assignee_unconfirmed: unconfirmed,
        source_message_id: message.id,
      });
      newTitles.push(title);

      if (needsClarification) {
        result.clarifications.push({
          clarification_type: 'project_match',
          question: `新しいタスク「${title}」は、どのプロジェクトのものですか？`,
          related_task_id: null,
          source_message_id: message.id,
          channel_id: message.channel_id,
        });
      }
      if (unconfirmed) {
        result.clarifications.push({
          clarification_type: 'assignee',
          question: `タスク「${title}」の担当者は <@${assigneeId}> で合っていますか？`,
          related_task_id: null,
          source_message_id: message.id,
          channel_id: message.channel_id,
        });
      }
      continue;
    }

    // --- 3. ステータス変化を示す発言だが、対象タスクが特定できなかった ---
    if (status) {
      result.clarifications.push({
        clarification_type: 'task_match',
        question: `「${message.content.slice(0, 60)}」は、どのタスクについての報告ですか？（該当するタスクが見つかりませんでした）`,
        related_task_id: null,
        source_message_id: message.id,
        channel_id: message.channel_id,
      });
    }
  }

  return { result, usage: null };
}

module.exports = { analyze, containmentScore, extractTaskTitle };
