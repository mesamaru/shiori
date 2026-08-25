// analyze-claude.js
// 判定エンジン（Claude API版）— 従量課金が発生する
//
// analyze-rules.js と同じ形の結果を返すため、ai-batch.js からは
// AI_PROVIDER の設定によって透過的に差し替えられる。
//
// このファイル内のSDK読み込みは関数内で遅延させている。
// AI_PROVIDER=rules（無料運用）のときに、APIキー未設定のまま
// クライアントを生成して落ちることを避けるため。

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

let anthropic = null;
let schema = null;

/**
 * SDKとスキーマを初回呼び出し時にだけ用意する
 */
function initClient() {
  if (anthropic) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY が設定されていません。無料で使う場合は .env の AI_PROVIDER を rules にしてください。'
    );
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const { z } = require('zod');

  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const BatchResultSchema = z.object({
    new_tasks: z
      .array(
        z.object({
          title: z.string().describe('タスクのタイトル。会話から読み取れる具体的な作業内容'),
          project_id: z
            .number()
            .nullable()
            .describe('既存プロジェクトのid。該当が無い/判断できない場合はnull'),
          status: z
            .enum(['todo', 'in_progress', 'blocked', 'done'])
            .describe('登録時点のステータス'),
          assignee_id: z
            .string()
            .nullable()
            .describe('担当者のDiscordユーザーID。本文のメンション<@123...>や発言者から判断。不明ならnull'),
          assignee_unconfirmed: z.boolean().describe('担当者が推測に留まる、または不明ならtrue'),
          source_message_id: z
            .number()
            .describe('根拠となったメッセージのid（Discordのidではなく渡されたidを使うこと）'),
        })
      )
      .describe('会話から新しく検出したタスク。既存タスクと重複するものは含めない'),

    task_updates: z
      .array(
        z.object({
          task_id: z.number().describe('更新対象の既存タスクのid'),
          new_status: z.enum(['todo', 'in_progress', 'blocked', 'done']),
          change_summary: z.string().describe('何がどう変わったかの短い要約（日本語）'),
          source_message_id: z.number().describe('根拠となったメッセージのid'),
        })
      )
      .describe('既存タスクのステータス変化。変化が無いものは含めない'),

    task_assignments: z
      .array(
        z.object({
          task_id: z.number().describe('更新対象の既存タスクのid'),
          assignee_id: z
            .string()
            .nullable()
            .describe('確定した担当者のDiscordユーザーID。変更しないならnull'),
          project_id: z
            .number()
            .nullable()
            .describe('確定したプロジェクトのid。変更しないならnull'),
          change_summary: z.string().describe('何を確定したかの短い要約（日本語）'),
          source_message_id: z.number().describe('根拠となったメッセージのid'),
        })
      )
      .describe(
        'resolutions（確認事項への回答）によって確定した担当者やプロジェクトの反映。回答が無ければ空配列'
      ),

    clarifications: z
      .array(
        z.object({
          clarification_type: z.enum(['assignee', 'project_match', 'task_match', 'status']),
          question: z.string().describe('ユーザーに確認したい内容（日本語の疑問文）'),
          related_task_id: z
            .number()
            .nullable()
            .describe('既存タスクに関する確認ならそのid。新規タスクに関する確認ならnull'),
          source_message_id: z.number().describe('根拠となったメッセージのid'),
          channel_id: z.string().describe('確認メッセージを投稿すべきチャンネルID'),
        })
      )
      .describe('判断がつかず人間に確認が必要な事項。確実に判断できたものは含めない'),
  });

  schema = zodOutputFormat(BatchResultSchema);
}

const SYSTEM_PROMPT = `あなたはDiscordのプロジェクト会話からタスクの状態を読み取るアシスタントです。

与えられるもの:
- messages: 前回の処理以降に投稿された、キーワード判定で「タスクに関係しそう」と判断されたメッセージ
- active_tasks: 現在進行中のタスク一覧（完了済みは含まれない）
- projects: 登録済みのプロジェクト一覧
- resolutions: 過去にあなたが出した確認事項に対して、ユーザーが返信で答えた内容
  （question=聞いた内容、resolved_answer=ユーザーの回答、source_content=元になった発言）

あなたの仕事:
1. 新規タスクの検出 — 「〇〇やります」等の発言から、active_tasksに存在しない作業を新規タスクとして拾う
2. 進捗更新の検出 — 既存タスクに対する「完了」「対応中」「詰まっている」等の発言からステータス変化を拾う
3. プロジェクトの判定 — 1つのチャンネルに複数プロジェクトの話題が混在することも、複数チャンネルに同じプロジェクトがまたがることもある
4. 担当者の判定 — 本文中のメンション（<@123456789>形式）や発言者から読み取る
5. 確認回答の反映 — resolutions の回答内容から、対象タスクのステータス・担当者・プロジェクトを確定させる
   （ステータスの確定は task_updates、担当者やプロジェクトの確定は task_assignments に入れる）

重要な原則:
- source_message_id には、必ず渡されたmessagesの "id" フィールドの値を使うこと（Discordのmessage_idではない）
- project_id / task_id も、渡されたデータの "id" を使うこと
- 確実に判断できないものは推測で登録せず、clarifications に確認事項として挙げること
- 雑談や無関係な発言は何も返さなくてよい。空配列で構わない
- 既に active_tasks にあるタスクを new_tasks に重複登録しないこと`;

/**
 * 差分メッセージをClaude APIで解析する。
 *
 * @param {object[]} messages 差分メッセージ（DBの行）
 * @param {object[]} tasks アクティブなタスク
 * @param {object[]} projects プロジェクト一覧
 * @param {object[]} [resolutions] フェーズ4で解決済みの確認事項
 * @returns {Promise<{ result: object, usage: object }>}
 */
async function analyze(messages, tasks, projects, resolutions = []) {
  initClient();

  const payload = {
    messages: messages.map((m) => ({
      id: m.id,
      channel_id: m.channel_id,
      author_id: m.author_id,
      author_name: m.author_name,
      content: m.content,
      created_at: m.created_at,
    })),
    active_tasks: tasks,
    projects,
    resolutions,
  };

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `以下のデータを判定してください。\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
    output_config: { format: schema },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `AIが応答を拒否しました: ${response.stop_details?.explanation ?? '理由不明'}`
    );
  }
  if (!response.parsed_output) {
    throw new Error('AIの応答を構造化データとして解釈できませんでした');
  }

  return { result: response.parsed_output, usage: response.usage };
}

module.exports = { analyze };
