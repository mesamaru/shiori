// index.js
// Discord Bot 本体
//
// 役割（discord-ai-project-plan.md の①②に対応）：
//   ① メッセージ監視・保存
//      - 新規メッセージ → DB保存
//      - 編集メッセージ → 更新して保存（edited_at を記録）
//      - 削除メッセージ → is_deleted フラグを立てる
//   ② ルールベース一次判定（rules.js）
//      - キーワードにマッチしたメッセージのみ is_rule_flagged = true にする
//      - AI呼び出しはここでは行わない（③のバッチ処理は別実装）
//   ② 差分管理（redis.js）
//      - ルールベースでフラグが立ったメッセージのIDを、チャンネルごとの
//        Redis一時集合（pending_diff:{channel_id}）に積んでおく
//   ③ 手動バッチ処理（ai-batch.js / commands.js）
//      - /analyze コマンドが実行された時だけ解析を走らせる
//      - 定期実行はしない（確定仕様：手動実行のみ）
//      - 判定エンジンは .env の AI_PROVIDER で切替（rules=無料 / claude=従量課金）
//   ④ 確認フロー（clarify.js）
//      - 判定できなかった事項をBotがチャンネルへ質問として投稿
//      - その投稿への返信を検知して回答を記録し、次回の /analyze で反映する
//   ⑤ 通知（notify.js）
//      - タスクの登録・進捗変化をチャンネルへ投稿、担当タスクの完了は本人へDM
//      - notifications テーブルで重複通知を防ぐ
//
// 対象チャンネルは watched_channels テーブルで管理し、運用側が
// 後から追加・変更できるようにする（固定チャンネルにしない）。

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, MessageFlags } = require('discord.js');
const { initDatabase } = require('./db/db-init');
const { evaluateMessage } = require('./rules');
const { redis, pushPendingDiff } = require('./redis');
const { registerCommands } = require('./commands');
const { runAiBatch } = require('./ai-batch');
const { postOpenClarifications, handleClarificationReply } = require('./clarify');
const { sendNotifications } = require('./notify');
const { startWebServer } = require('./web/server');

const WATCHED_CHANNELS_REFRESH_MS = Number(process.env.WATCHED_CHANNELS_REFRESH_MS) || 60000;

// .env の WATCHED_CHANNEL_IDS（カンマ区切り）。DBに watched_channels が
// 1件も無い場合のフォールバックとして使う。
const FALLBACK_CHANNEL_IDS = (process.env.WATCHED_CHANNEL_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

let dbPool;
let watchedChannelIds = new Set(FALLBACK_CHANNEL_IDS);
let refreshTimer = null;
let webServer = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Web管理画面でタスクの担当者をサーバーメンバー一覧から選べるようにするために必要。
    // Discord Developer Portal側でも「SERVER MEMBERS INTENT」の有効化が別途必要（特権インテント）。
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

/**
 * watched_channels テーブルから有効なチャンネルID一覧を読み込み、
 * メモリ上のキャッシュを更新する。DBが空ならフォールバックのままにする。
 */
async function refreshWatchedChannels() {
  try {
    const [rows] = await dbPool.query(
      'SELECT channel_id FROM watched_channels WHERE is_active = TRUE'
    );
    if (rows.length > 0) {
      watchedChannelIds = new Set(rows.map((row) => row.channel_id));
    } else if (FALLBACK_CHANNEL_IDS.length > 0) {
      watchedChannelIds = new Set(FALLBACK_CHANNEL_IDS);
    } else {
      watchedChannelIds = new Set();
    }
  } catch (err) {
    console.error('[watched_channels] 読み込みに失敗しました:', err.message);
  }
}

function isWatchedChannel(channelId) {
  return watchedChannelIds.has(channelId);
}

/**
 * フラグが立ったメッセージをRedisの差分候補集合に積む。
 * Redis側の障害はDB保存の成否とは切り離してログするだけに留める。
 */
async function queueIfFlagged(channelId, messageId, flagged) {
  if (!flagged) return;
  try {
    await pushPendingDiff(channelId, messageId);
  } catch (err) {
    console.error('[redis] 差分候補の追加に失敗しました:', err.message);
  }
}

/**
 * 新規メッセージをDBへ保存する。ルールベース判定の結果を is_rule_flagged に記録する。
 */
async function saveNewMessage(message) {
  const { flagged } = evaluateMessage(message.content);

  await dbPool.query(
    `INSERT INTO messages
       (message_id, channel_id, author_id, author_name, content, is_rule_flagged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       is_rule_flagged = VALUES(is_rule_flagged)`,
    [
      message.id,
      message.channelId,
      message.author.id,
      message.author.username,
      message.content,
      flagged,
      message.createdAt,
    ]
  );

  await queueIfFlagged(message.channelId, message.id, flagged);
}

/**
 * 編集メッセージを反映する。該当行が無ければ新規として保存する
 * （Bot起動前に投稿されたメッセージが編集された場合など）。
 */
async function saveEditedMessage(message) {
  const { flagged } = evaluateMessage(message.content);
  const editedAt = message.editedAt || new Date();

  const [result] = await dbPool.query(
    `UPDATE messages
        SET content = ?, is_rule_flagged = ?, edited_at = ?
      WHERE message_id = ?`,
    [message.content, flagged, editedAt, message.id]
  );

  if (result.affectedRows === 0) {
    // 元メッセージ未保存 → 新規行として保存しておく
    await dbPool.query(
      `INSERT INTO messages
         (message_id, channel_id, author_id, author_name, content, is_rule_flagged, created_at, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         content = VALUES(content),
         is_rule_flagged = VALUES(is_rule_flagged),
         edited_at = VALUES(edited_at)`,
      [
        message.id,
        message.channelId,
        message.author.id,
        message.author.username,
        message.content,
        flagged,
        message.createdAt,
        editedAt,
      ]
    );
  }

  // 編集によって新たにルールへマッチした場合も差分候補として積む
  await queueIfFlagged(message.channelId, message.id, flagged);
}

/**
 * 削除フラグを立てる。行が無ければ何もしない（未保存メッセージの削除は追跡不要）。
 */
async function markMessageDeleted(messageId) {
  await dbPool.query('UPDATE messages SET is_deleted = TRUE WHERE message_id = ?', [messageId]);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[bot] ログイン完了: ${readyClient.user.tag}`);

  await refreshWatchedChannels();
  refreshTimer = setInterval(refreshWatchedChannels, WATCHED_CHANNELS_REFRESH_MS);

  console.log(`[bot] 監視対象チャンネル数: ${watchedChannelIds.size}`);

  await registerCommands(readyClient);

  // Web管理画面（WEB_PASSWORD が設定されている場合のみ起動する）
  try {
    webServer = await startWebServer(dbPool, readyClient);
  } catch (err) {
    console.error('[web] 起動に失敗しました:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'analyze') return;

  // claudeモードでは3秒以内に終わらないため、先に応答を保留する
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await runAiBatch(dbPool, [...watchedChannelIds]);
    const modeLabel = result.provider === 'claude' ? 'Claude API' : 'ルールベース（無料）';

    if (result.skipped) {
      await interaction.editReply('差分がないため、解析をスキップしました。');
      return;
    }

    // 新しく作られた確認事項をチャンネルへ投稿する（フェーズ4）
    const posted = await postOpenClarifications(client, dbPool);

    // タスクの変更をメンバーへ通知する（フェーズ5）
    const notified = await sendNotifications(client, dbPool, result.events);

    const { applied, usage } = result;
    const lines = [
      `解析が完了しました（判定: ${modeLabel} / 対象メッセージ: ${result.messageCount}件）`,
      `- 新規タスク: ${applied.newTasks}件`,
      `- 進捗更新: ${applied.updates}件`,
      `- 担当者/プロジェクト確定: ${applied.assignments}件`,
      `- 新たな要確認事項: ${applied.clarifications}件`,
    ];
    // 投稿数には、前回までに作られて未投稿だった分も含まれる
    if (posted > 0) {
      lines.push(`- チャンネルへ投稿した質問: ${posted}件（未投稿だった分を含む）`);
    }
    if (notified.channel > 0 || notified.dm > 0) {
      lines.push(`- 通知: チャンネル ${notified.channel}件 / DM ${notified.dm}件`);
    }
    if (result.resolutionCount > 0) {
      lines.push(`- 取り込んだ確認回答: ${result.resolutionCount}件`);
    }
    // usageはClaude APIを使ったときだけ返る
    if (usage) {
      lines.push(`- トークン: 入力 ${usage.input_tokens} / 出力 ${usage.output_tokens}`);
    }
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error('[batch] 実行に失敗しました:', err);
    await interaction.editReply(`解析に失敗しました: ${err.message}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!isWatchedChannel(message.channelId)) return;

  try {
    await saveNewMessage(message);
  } catch (err) {
    console.error('[messageCreate] 保存に失敗しました:', err.message);
  }

  // Botの確認メッセージへの返信なら、回答として記録する。
  // 保存とは独立した処理なので、保存が失敗しても回答の記録は試みる。
  try {
    await handleClarificationReply(dbPool, message);
  } catch (err) {
    console.error('[clarify] 回答の記録に失敗しました:', err.message);
  }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) {
      newMessage = await newMessage.fetch();
    }
  } catch (err) {
    console.error('[messageUpdate] メッセージ取得に失敗しました:', err.message);
    return;
  }

  if (newMessage.author?.bot) return;
  if (!isWatchedChannel(newMessage.channelId)) return;
  // 内容が変わらない編集（ピン留め等のシステム更新）は無視する
  if (oldMessage.content === newMessage.content) return;

  try {
    await saveEditedMessage(newMessage);
  } catch (err) {
    console.error('[messageUpdate] 更新の保存に失敗しました:', err.message);
  }
});

client.on(Events.MessageDelete, async (message) => {
  if (!isWatchedChannel(message.channelId)) return;

  try {
    await markMessageDeleted(message.id);
  } catch (err) {
    console.error('[messageDelete] 削除フラグの更新に失敗しました:', err.message);
  }
});

async function shutdown(signal) {
  console.log(`[bot] ${signal} を受信しました。終了処理を開始します...`);
  if (refreshTimer) clearInterval(refreshTimer);
  // 接続を閉じ切ってから次へ進む（閉じ途中でプロセスを落とさないため）
  if (webServer) await new Promise((resolve) => webServer.close(resolve));
  client.destroy();
  if (dbPool) await dbPool.end();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  try {
    dbPool = await initDatabase();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('[bot] 起動に失敗しました:', err);
    process.exit(1);
  }
})();
