// commands.js
// スラッシュコマンドの定義と登録
//
// discord-ai-project-plan.md の確定仕様「バッチ処理は手動実行のみ」に対応する
// トリガーとして /analyze を提供する。
// （判定エンジンがルールベースかClaude APIかは .env の AI_PROVIDER で決まるため、
//   コマンド名はエンジン非依存の名前にしている）
//
// 登録はBotが参加している各ギルドに対して行う（ギルドコマンドは即時反映される。
// グローバル登録は反映まで最大1時間かかるため運用上使いにくい）。

const { SlashCommandBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');

const analyzeCommand = new SlashCommandBuilder()
  .setName('analyze')
  .setDescription('前回以降の差分を解析してタスクを更新します（差分が無ければ何もしません）')
  // claudeモード時に誰でも叩けるとAPIコストが発生するため、サーバー管理権限に限定する
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

/**
 * Botが参加している全ギルドにスラッシュコマンドを登録する。
 * PUTは既存のコマンド一覧を丸ごと置き換えるため、古いコマンドは自動的に消える。
 */
async function registerCommands(client) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const body = [analyzeCommand.toJSON()];

  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
      console.log(`[commands] 登録しました (guild: ${guildId})`);
    } catch (err) {
      console.error(`[commands] 登録に失敗しました (guild: ${guildId}):`, err.message);
    }
  }
}

module.exports = { registerCommands };
