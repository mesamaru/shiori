// web/auth.js
// アカウント管理と認証
//
// 提供するもの：
//   - メール＋パスワードによるログイン
//   - Discord OAuth2 によるログイン／アカウント連携
//   - 管理者アカウントの初期作成（.env からのブートストラップ）
//
// 方針（確定仕様）：
//   Discordログインは「管理者が事前に登録したアカウント」だけが使える。
//   未登録のDiscordアカウントでログインしようとしても弾く。
//
// パスワードは scrypt でハッシュ化する。
// scryptSync はイベントループを止めてしまい、同一プロセスで動いている
// Discord Bot の応答まで遅延させるため、必ず非同期版を使うこと。

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_KEYLEN = 64;
const DISCORD_API = 'https://discord.com/api/v10';

// --- パスワード ---

/**
 * パスワードをハッシュ化する。
 * 保存形式: scrypt$<salt(hex)>$<hash(hex)>
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * パスワードを検証する。
 * 保存値の形式が壊れていた場合も例外を投げず false を返す。
 */
async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = await scrypt(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- ユーザー ---

async function findUserByEmail(dbPool, email) {
  const [rows] = await dbPool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [
    String(email).trim().toLowerCase(),
  ]);
  return rows[0] ?? null;
}

async function findUserByDiscordId(dbPool, discordUserId) {
  const [rows] = await dbPool.query(
    'SELECT * FROM users WHERE discord_user_id = ? LIMIT 1',
    [discordUserId]
  );
  return rows[0] ?? null;
}

async function findUserById(dbPool, id) {
  const [rows] = await dbPool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] ?? null;
}

async function countUsers(dbPool) {
  const [[row]] = await dbPool.query('SELECT COUNT(*) AS c FROM users');
  return row.c;
}

/**
 * ユーザーを作成する。パスワードは任意（Discord連携のみで使う人もいるため）。
 */
async function createUser(dbPool, { email, password, displayName, role, discordUserId }) {
  const passwordHash = password ? await hashPassword(password) : null;
  const [result] = await dbPool.query(
    `INSERT INTO users (email, password_hash, display_name, role, discord_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      String(email).trim().toLowerCase(),
      passwordHash,
      displayName,
      role === 'admin' ? 'admin' : 'member',
      discordUserId || null,
    ]
  );
  return result.insertId;
}

async function setPassword(dbPool, userId, password) {
  await dbPool.query('UPDATE users SET password_hash = ? WHERE id = ?', [
    await hashPassword(password),
    userId,
  ]);
}

async function touchLogin(dbPool, userId) {
  await dbPool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
}

/**
 * .env の ADMIN_EMAIL / ADMIN_PASSWORD から最初の管理者を作る。
 * 既にユーザーが1人でもいる場合は何もしない（毎回起動時に上書きしないため）。
 */
async function bootstrapAdmin(dbPool) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return { created: false, reason: 'not_configured' };

  if ((await countUsers(dbPool)) > 0) return { created: false, reason: 'already_exists' };

  if (password.length < 8) {
    console.error('[web] ADMIN_PASSWORD が短すぎます（8文字以上にしてください）。');
    return { created: false, reason: 'weak_password' };
  }

  await createUser(dbPool, {
    email,
    password,
    displayName: process.env.ADMIN_NAME || '管理者',
    role: 'admin',
  });
  console.log(`[web] 管理者アカウントを作成しました: ${email}`);
  return { created: true };
}

/**
 * メール＋パスワードで認証する。
 *
 * 存在しないメールでも、存在するが停止中のアカウントでも、
 * パスワード誤りと同じ結果と所要時間になるようにしている
 * （どのメールが登録済みかを推測されないため）。
 */
async function authenticate(dbPool, email, password) {
  const user = await findUserByEmail(dbPool, email);

  if (!user || !user.password_hash || !user.is_active) {
    // タイミング差からアカウントの有無が漏れないよう、ダミーのハッシュ計算を行う
    await verifyPassword(password, `scrypt$${'00'.repeat(16)}$${'00'.repeat(SCRYPT_KEYLEN)}`);
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  return user;
}

// --- Discord OAuth2 ---

function isDiscordConfigured() {
  return Boolean(
    process.env.DISCORD_CLIENT_ID &&
      process.env.DISCORD_CLIENT_SECRET &&
      process.env.WEB_BASE_URL
  );
}

function redirectUri() {
  return `${String(process.env.WEB_BASE_URL).replace(/\/+$/, '')}/auth/discord/callback`;
}

/**
 * Discordの認可画面へのURLを組み立てる。
 * state はCSRF対策。呼び出し側でセッションに保存して、戻ってきた際に突き合わせる。
 */
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * 認可コードをアクセストークンに交換し、ログインした本人の情報を取得する。
 * 取得する情報は identify スコープの範囲（ID・ユーザー名・アバター）のみ。
 */
async function fetchDiscordUser(code) {
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Discordのトークン取得に失敗しました (${tokenRes.status})`);
  }
  const token = await tokenRes.json();

  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discordのユーザー情報取得に失敗しました (${userRes.status})`);
  }
  return userRes.json();
}

/**
 * 取得したDiscordプロフィールをusersテーブルへ反映する。
 * ユーザー名やアバターは変わりうるので、ログインのたびに更新する。
 */
async function linkDiscordAccount(dbPool, userId, discordUser) {
  await dbPool.query(
    `UPDATE users
        SET discord_user_id = ?, discord_username = ?, discord_avatar = ?
      WHERE id = ?`,
    [discordUser.id, discordUser.global_name || discordUser.username, discordUser.avatar, userId]
  );
}

async function unlinkDiscordAccount(dbPool, userId) {
  await dbPool.query(
    `UPDATE users SET discord_user_id = NULL, discord_username = NULL, discord_avatar = NULL
      WHERE id = ?`,
    [userId]
  );
}

/**
 * DiscordのアバターURLを組み立てる。
 * アバター未設定の場合はDiscordの既定アイコンを返す。
 */
function avatarUrl(discordUserId, avatarHash, size = 64) {
  if (!discordUserId) return null;
  if (!avatarHash) {
    // 既定アイコンは5種類。IDから決まる
    const index = Number(BigInt(discordUserId) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.${ext}?size=${size}`;
}

/**
 * DiscordユーザーID → アカウント情報 の対応表を作る。
 * タスク一覧で担当者を表示するために使う。
 */
async function loadDiscordProfiles(dbPool, discordIds) {
  const ids = [...new Set(discordIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const [rows] = await dbPool.query(
    `SELECT discord_user_id, display_name, discord_username, discord_avatar, role
       FROM users WHERE discord_user_id IN (?)`,
    [ids]
  );
  return new Map(rows.map((r) => [r.discord_user_id, r]));
}

module.exports = {
  hashPassword,
  verifyPassword,
  findUserByEmail,
  findUserByDiscordId,
  findUserById,
  countUsers,
  createUser,
  setPassword,
  touchLogin,
  bootstrapAdmin,
  authenticate,
  isDiscordConfigured,
  buildAuthorizeUrl,
  fetchDiscordUser,
  linkDiscordAccount,
  unlinkDiscordAccount,
  avatarUrl,
  loadDiscordProfiles,
};
