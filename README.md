# 栞 (Shiori)

Discordの会話に目印を挟み、タスクとして拾い上げるBot。

プロジェクトに関する会話をリアルタイムで収集し、「〇〇やります」「完了しました」といった発言から
タスクの新規登録や進捗更新を自動で行う。判定できなかったものは推測せず、Discord上で本人に聞き返す。

タスクの閲覧・編集はDiscordからでも、付属のWeb管理画面からでも行える。

## 特徴

- **APIコストゼロで動く** — 判定エンジンはルールベースがデフォルト。Claude APIは任意で、環境変数1つで切り替わる
- **推測しない** — 確信が持てない判定は `pending_clarifications` に回し、Botがチャンネルで質問する。返信するだけで解決する
- **手動実行のみ** — 解析は `/analyze` コマンドを叩いた時だけ動く。定期実行はしない
- **Web管理画面** — アカウント管理、Discordログイン、タスクのCRUDに対応

## 動作の流れ

```
Discordメッセージ
   ↓
① Bot が監視・保存（MariaDB）
   ↓
② ルールベース一次判定 → 該当メッセージを差分候補として Redis に積む
   ↓
③ /analyze 実行時のみ、差分だけを解析
   ├─ 判定できた   → タスクの登録・更新
   └─ 判定できない → 確認事項を作成し、チャンネルで質問
   ↓
④ 返信を検知して回答を記録、次回の解析で反映
   ↓
⑤ 変更をチャンネルへ投稿／担当者へDM
```

## 構成

| ファイル | 役割 |
|---|---|
| `index.js` | Bot本体。Discordイベントの配線 |
| `rules.js` | キーワードによる一次判定 |
| `redis.js` | カーソル・差分候補・解決済み確認事項のキュー |
| `ai-batch.js` | 差分抽出 → 判定 → DB反映のオーケストレーション |
| `analyze-rules.js` | 判定エンジン（ルールベース・無料） |
| `analyze-claude.js` | 判定エンジン（Claude API） |
| `clarify.js` | 確認フロー（質問の投稿と返信の検知） |
| `notify.js` | 通知（チャンネル投稿・DM・重複防止） |
| `commands.js` | スラッシュコマンドの登録 |
| `check-redis.js` | Redisの中身を確認する単発スクリプト |
| `db/schema.sql` | テーブル定義 |
| `db/db-init.js` | 起動時のスキーマ自動適用 |
| `web/server.js` | Web管理画面のルーティングと認証 |
| `web/render.js` | 画面描画 |
| `web/auth.js` | アカウント管理・Discord OAuth2 |

## 必要なもの

- Node.js 18 以降
- MariaDB 10.4 以降（推奨: 11.4 LTS）
- Redis 7.x

## セットアップ

```bash
npm install
cp .env.example .env
# .env を実際の値で編集する
npm start
```

テーブルは起動時に `db/schema.sql` から自動作成される（`IF NOT EXISTS` なので既存環境でも安全）。

### 監視対象チャンネルの登録

Botは `watched_channels` テーブルに登録されたチャンネルだけを監視する。
Web管理画面の「監視チャンネル」から追加できるほか、SQLでも登録できる。

```sql
INSERT INTO watched_channels (channel_id, channel_name, is_active)
VALUES ('チャンネルID', '表示名', TRUE);
```

### Discord側の設定

- Developer Portal → Bot → **MESSAGE CONTENT INTENT** を有効化（必須）
- Botの権限: `View Channels` / `Send Messages` / `Read Message History`
- Discordログインを使う場合は OAuth2 の Redirects に `<WEB_BASE_URL>/auth/discord/callback` を登録

## 判定エンジンの切り替え

`.env` の1行で切り替わる。

```bash
AI_PROVIDER=rules    # ルールベース。APIコストゼロ（デフォルト）
AI_PROVIDER=claude   # Claude API。従量課金が発生する
```

ルールベースは日本語に形態素解析器を使わず、**文字バイグラムの重なり率**でメッセージと既存タスクを
突き合わせている。確信度が高い時だけ自動反映し、曖昧な場合は確認事項に回す。

## Web管理画面

`ADMIN_EMAIL` と `ADMIN_PASSWORD` を設定して起動すると、初回のみ管理者アカウントが作成される。
以降のユーザー追加は画面から行う。

- メール＋パスワード、またはDiscordアカウントでログイン
- Discordログインは、管理者が登録済みのアカウントのみ利用できる
- 一般ユーザーは全タスクを編集可能。ユーザー管理と監視チャンネル設定は管理者のみ

> **外部公開する場合は必ずHTTPS経由にすること。** 平文HTTPではログインパスワードが盗聴される。
> リバースプロキシでHTTPS終端し、`WEB_SECURE_COOKIE=true` と `WEB_BEHIND_PROXY=true` を設定する。

## ライセンス

MIT
