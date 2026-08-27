// web/export.js
// サーバー全体のDiscordチャット履歴をCSVへエクスポートする（管理者専用機能）。
//
// discord.jsのAPIで、Botが参加している全ギルド・全チャンネル（スレッド含む）を
// 巡回し、取得できる全メッセージをページングしながらCSVへ書き出す。
// 大規模サーバーでは長時間かかるため、バックグラウンドジョブとして実行し、
// Web画面はその進捗をポーリング表示する。
//
// 設計上の判断：
//   - 1プロセスにつき同時実行は1件まで（Discord側のレート制限を無用に圧迫しないため）
//   - 進捗はメモリ上のみで管理（プロセス再起動で失われるが、実行し直せばよい）
//   - チャンネルごとに権限チェックし、読めないチャンネルはスキップして続行する
//     （1チャンネルの権限不足で全体を止めない）
//   - 出力ファイルは .gitignore 済みの exports/ に保存し、git pullで消えない

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PermissionsBitField } = require('discord.js');

const HEADER = [
  'guild_id',
  'guild_name',
  'channel_id',
  'channel_name',
  'channel_type',
  'thread_parent_id',
  'message_id',
  'author_id',
  'author_name',
  'author_is_bot',
  'content',
  'attachments',
  'created_at',
  'edited_at',
  'pinned',
];

function exportsDir() {
  return path.join(__dirname, '..', 'exports');
}

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * CSVの1フィールドをエスケープする。
 * カンマ・ダブルクォート・改行を含む場合だけクォートで囲む。
 */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(',') + '\r\n';
}

let state = idleState();

function idleState() {
  return {
    status: 'idle', // idle | running | done | cancelled | error
    processedChannels: 0,
    totalChannels: 0,
    processedMessages: 0,
    currentChannelName: '',
    errors: [],
    startedAt: null,
    finishedAt: null,
    resultFile: null,
    error: null,
    cancelled: false,
  };
}

function getExportState() {
  return state;
}

function cancelExport() {
  if (state.status === 'running') state.cancelled = true;
}

/**
 * チャンネル本体＋その配下のスレッド（アクティブ・アーカイブ済み）を集める。
 * フォーラムチャンネルは本体に投稿できないため、スレッド（＝投稿）だけが対象になる。
 */
async function collectChannels(guild) {
  const list = [];

  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread()) continue;
    if (typeof channel.isTextBased === 'function' && channel.isTextBased()) {
      list.push(channel);
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (!('threads' in channel)) continue;
    try {
      const active = await channel.threads.fetchActive();
      for (const t of active.threads.values()) list.push(t);
    } catch {
      /* スレッド一覧取得の権限が無い等は無視して続行 */
    }
    try {
      const archived = await channel.threads.fetchArchived();
      for (const t of archived.threads.values()) list.push(t);
    } catch {
      /* 同上 */
    }
  }

  return list;
}

function canReadChannel(channel, me) {
  if (typeof channel.permissionsFor !== 'function') return true;
  const perms = channel.permissionsFor(me);
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ViewChannel) &&
    perms.has(PermissionsBitField.Flags.ReadMessageHistory)
  );
}

/**
 * 1チャンネル分のメッセージを、新しい方から古い方へページングしながら書き出す。
 */
async function exportChannel(channel, writeRow) {
  let before;
  for (;;) {
    if (state.cancelled) return;

    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, before });
    } catch (err) {
      state.errors.push(`${channel.name || channel.id}: ${err.message}`);
      return;
    }
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      writeRow([
        channel.guild?.id ?? '',
        channel.guild?.name ?? '',
        channel.id,
        channel.name ?? '',
        String(channel.type),
        channel.isThread?.() ? channel.parentId ?? '' : '',
        msg.id,
        msg.author?.id ?? '',
        msg.author?.username ?? '',
        msg.author?.bot ? '1' : '0',
        msg.content ?? '',
        [...msg.attachments.values()].map((a) => a.url).join(' | '),
        msg.createdAt.toISOString(),
        msg.editedAt ? msg.editedAt.toISOString() : '',
        msg.pinned ? '1' : '0',
      ]);
      state.processedMessages += 1;
    }

    before = batch.last().id;
  }
}

async function runExport(discordClient) {
  await fsp.mkdir(exportsDir(), { recursive: true });

  const filename = `shiori-export-${timestampForFilename()}.csv`;
  const filePath = path.join(exportsDir(), filename);
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });

  // Excelで開いた時に文字化けしないようUTF-8 BOMを先頭に付ける
  stream.write('\uFEFF');
  stream.write(csvRow(HEADER));
  const writeRow = (fields) => stream.write(csvRow(fields));

  try {
    for (const guild of discordClient.guilds.cache.values()) {
      if (state.cancelled) break;

      const channels = await collectChannels(guild);
      state.totalChannels += channels.length;

      for (const channel of channels) {
        if (state.cancelled) break;
        state.currentChannelName = `${guild.name} / ${channel.name || channel.id}`;

        if (!canReadChannel(channel, discordClient.user)) {
          state.processedChannels += 1;
          continue;
        }

        await exportChannel(channel, writeRow);
        state.processedChannels += 1;
      }
    }

    state.status = state.cancelled ? 'cancelled' : 'done';
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  } finally {
    await new Promise((resolve) => stream.end(resolve));
    state.finishedAt = new Date();
    state.resultFile = filename;
  }
}

/**
 * エクスポートを開始する。既に実行中なら何もしない。
 * @returns {boolean} 開始できたら true
 */
function startExport(discordClient) {
  if (state.status === 'running') return false;

  state = { ...idleState(), status: 'running', startedAt: new Date() };
  runExport(discordClient).catch((err) => {
    state.status = 'error';
    state.error = err.message;
  });
  return true;
}

module.exports = { startExport, cancelExport, getExportState, exportsDir };
