// check-redis.js
// Redisに積まれた差分候補（pending_diff）とカーソル（cursor）の中身を確認するための
// 単発実行スクリプト。Bot本体とは独立して動く。
//
// Pterodactylでの使い方:
//   1. Startup タブの MAIN FILE を check-redis.js に変更
//      （MAIN FILE欄は16文字までのため、サブフォルダに置かずルート直下に配置している）
//   2. サーバーを起動 → Console に一覧が出力されて自動終了する
//   3. 確認後、MAIN FILE を index.js に戻す
//
// ローカル実行:
//   node check-redis.js

require('dotenv').config();
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

(async () => {
  try {
    console.log('[check] Redisの内容を確認します...');
    console.log(`[check] PING → ${await redis.ping()}`);

    const cursorKeys = await redis.keys('cursor:*');
    const diffKeys = await redis.keys('pending_diff:*');

    console.log(`\n--- cursor（最後にAIへ渡したmessage_id） ---`);
    if (cursorKeys.length === 0) {
      console.log('（まだありません。フェーズ3のAIバッチ処理が動くと作成されます）');
    }
    for (const key of cursorKeys) {
      console.log(`${key} = ${await redis.get(key)}`);
    }

    console.log(`\n--- pending_diff（AI判定待ちの差分候補） ---`);
    if (diffKeys.length === 0) {
      console.log('（まだありません。キーワードを含むメッセージを投稿すると積まれます）');
    }
    for (const key of diffKeys) {
      const members = await redis.smembers(key);
      console.log(`${key} … ${members.length}件`);
      for (const id of members) {
        console.log(`  - ${id}`);
      }
    }

    console.log('\n[check] 確認が完了しました。');
  } catch (err) {
    console.error('[check] エラー:', err.message);
  } finally {
    redis.disconnect();
  }
})();
