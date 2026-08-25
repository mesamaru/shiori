// db-init.js
// Bot起動時にMariaDBへ接続し、schema.sqlの内容をそのまま実行してテーブルを保証する。
// すでにテーブルが存在する場合は IF NOT EXISTS により何も起こらない。
//
// 必要パッケージ:
//   npm install mysql2 dotenv
//
// .env に以下を設定:
//   DB_HOST=proxmox上のMariaDBのIP
//   DB_PORT=3306
//   DB_USER=discord_bot
//   DB_PASSWORD=xxxxx
//   DB_NAME=discord_to_ai

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function initDatabase() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true, // schema.sql内の複数CREATE文をまとめて実行するために必要
    waitForConnections: true,
    connectionLimit: 10,
  });

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  console.log('[db-init] スキーマ適用を開始します...');
  await pool.query(schemaSql);
  console.log('[db-init] スキーマ適用が完了しました（既存テーブルはスキップ）。');

  return pool; // Bot本体で使い回すコネクションプールを返す
}

module.exports = { initDatabase };

// -----------------------------------------
// Bot本体（index.js等）での使用例:
//
// const { initDatabase } = require('./db/db-init');
//
// (async () => {
//   const dbPool = await initDatabase();
//   // ここでdiscord.jsクライアントを起動し、dbPoolを各ハンドラに渡す
// })();
// -----------------------------------------
