// web/server.js
// Web管理画面（tududi のUIをベースにしたレイアウト）
//
// タスクの閲覧に加え、ブラウザからの編集（完了トグル・タスク追加・
// プロジェクト管理・監視チャンネル管理）を提供する。
//
// 外部公開を前提とするため、以下のセキュリティ対策を入れている：
//   - パスワード認証（timing-safe比較。文字数の違いも情報になるためハッシュ経由で比較）
//   - ログイン試行の回数制限（総当たり対策）
//   - CSRFトークン（編集操作があるため必須）
//   - Cookieは httpOnly / sameSite=lax、HTTPS配下では secure
//
// 注意：HTTPS終端はリバースプロキシ側で行う想定。
// 平文HTTPで外部公開するとパスワードが盗聴されるため、必ずHTTPS経由で公開すること。

const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const {
  escapeHtml,
  statusLabel,
  formatDate,
  relativeDate,
  layout,
  loginPage,
  taskList,
  whoChip,
  STATUS_ORDER,
} = require('./render');
const auth = require('./auth');

const VALID_STATUSES = new Set(STATUS_ORDER);

// --- ログイン試行制限 ---
// 単一プロセスなのでメモリ上で管理する。プロセス再起動でリセットされるが、
// 総当たりを現実的でない速度まで落とすには十分。
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, until }

function checkRateLimit(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.until && Date.now() < entry.until) {
    const mins = Math.ceil((entry.until - Date.now()) / 60000);
    return { allowed: false, message: `試行回数が上限に達しました。${mins}分後に再試行してください。` };
  }
  if (entry.until && Date.now() >= entry.until) attempts.delete(ip);
  return { allowed: true };
}

function recordFailure(ip) {
  const entry = attempts.get(ip) ?? { count: 0, until: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  attempts.set(ip, entry);
}

/** DiscordのIDは数字のみ。不正な値は null にして保存しない */
function safeDiscordId(value) {
  const v = String(value ?? '').trim();
  return /^\d{1,32}$/.test(v) ? v : null;
}

/**
 * Web管理画面を起動する。
 *
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {import('discord.js').Client} discordClient DiscordのユーザーIDから表示名を引くのに使う
 * @returns {Promise<import('http').Server|null>} 起動しなかった場合は null
 */
async function startWebServer(dbPool, discordClient) {
  // 初回起動時は .env の ADMIN_EMAIL / ADMIN_PASSWORD から管理者を作る
  await auth.bootstrapAdmin(dbPool);

  if ((await auth.countUsers(dbPool)) === 0) {
    console.log(
      '[web] アカウントが1件もありません。.env に ADMIN_EMAIL と ADMIN_PASSWORD を設定して再起動してください。'
    );
    return null;
  }

  const discordEnabled = auth.isDiscordConfigured();
  if (!discordEnabled) {
    console.log(
      '[web] Discordログインは無効です（DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / WEB_BASE_URL が必要）。'
    );
  }

  const port = Number(process.env.WEB_PORT || process.env.SERVER_PORT) || 3000;
  const behindProxy = process.env.WEB_BEHIND_PROXY === 'true';
  const secureCookie = process.env.WEB_SECURE_COOKIE === 'true';

  const app = express();
  if (behindProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(
    cookieSession({
      name: 'd2a_session',
      keys: [process.env.WEB_SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
      maxAge: 12 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
    })
  );

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    // アバター画像のためDiscordのCDNだけ許可する（スクリプトは一切許可しない）
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; " +
        "img-src 'self' data: https://cdn.discordapp.com; " +
        "form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // --- 認証 ---

  /** ログイン成功時のセッション初期化。セッション固定攻撃を防ぐためIDを作り直す */
  function establishSession(req, user) {
    req.session = null;
    req.session = {
      userId: user.id,
      csrf: crypto.randomBytes(32).toString('hex'),
    };
  }

  app.get('/login', (req, res) => {
    if (req.session?.userId) return res.redirect('/');
    const messages = {
      unlinked: 'このDiscordアカウントは登録されていません。管理者に登録を依頼してください。',
      disabled: 'このアカウントは停止されています。',
      oauth_failed: 'Discordとの連携に失敗しました。もう一度お試しください。',
      state: 'セッションが切れました。もう一度ログインしてください。',
    };
    res.type('html').send(
      loginPage({ error: messages[req.query.error] ?? null, discordEnabled })
    );
  });

  app.post('/login', async (req, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      const limit = checkRateLimit(ip);
      if (!limit.allowed) {
        return res.status(429).type('html').send(loginPage({ error: limit.message, discordEnabled }));
      }

      const user = await auth.authenticate(dbPool, req.body.email ?? '', req.body.password ?? '');
      if (!user) {
        recordFailure(ip);
        console.warn(`[web] ログイン失敗 (ip: ${ip})`);
        return res.status(401).type('html').send(
          loginPage({ error: 'メールアドレスまたはパスワードが違います。', discordEnabled })
        );
      }

      attempts.delete(ip);
      establishSession(req, user);
      await auth.touchLogin(dbPool, user.id);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  // --- Discord OAuth2 ---

  app.get('/auth/discord', (req, res) => {
    if (!discordEnabled) return res.redirect('/login');

    const state = crypto.randomBytes(24).toString('hex');
    // 認可画面から戻ってきた時に、ログイン目的か連携目的かを判別する
    const mode = req.session?.userId ? 'link' : 'login';
    req.session.oauth = { state, mode };
    res.redirect(auth.buildAuthorizeUrl(state));
  });

  app.get('/auth/discord/callback', async (req, res, next) => {
    try {
      if (!discordEnabled) return res.redirect('/login');

      const pending = req.session?.oauth;
      // stateが一致しない＝別サイトから誘導された可能性があるため中断する
      if (!pending?.state || pending.state !== req.query.state) {
        return res.redirect('/login?error=state');
      }
      req.session.oauth = null;

      if (!req.query.code) return res.redirect('/login?error=oauth_failed');

      let discordUser;
      try {
        discordUser = await auth.fetchDiscordUser(String(req.query.code));
      } catch (err) {
        console.error('[web] Discord OAuth失敗:', err.message);
        return res.redirect(
          pending.mode === 'link' ? '/profile?error=oauth' : '/login?error=oauth_failed'
        );
      }

      if (pending.mode === 'link') {
        // ログイン中のアカウントに自分のDiscordを紐付ける
        const existing = await auth.findUserByDiscordId(dbPool, discordUser.id);
        if (existing && existing.id !== req.session.userId) {
          return res.redirect('/profile?error=taken');
        }
        await auth.linkDiscordAccount(dbPool, req.session.userId, discordUser);
        return res.redirect('/profile?ok=1');
      }

      // ログイン：管理者が事前に登録したアカウントだけを通す（確定仕様）
      const user = await auth.findUserByDiscordId(dbPool, discordUser.id);
      if (!user) return res.redirect('/login?error=unlinked');
      if (!user.is_active) return res.redirect('/login?error=disabled');

      // 表示名やアバターは変わるので、ログインのたびに最新化する
      await auth.linkDiscordAccount(dbPool, user.id, discordUser);
      establishSession(req, user);
      await auth.touchLogin(dbPool, user.id);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  // 以降のルートはすべて認証必須。ログイン中のユーザーを req.user に載せる
  app.use(async (req, res, next) => {
    try {
      if (!req.session?.userId) return res.redirect('/login');

      const user = await auth.findUserById(dbPool, req.session.userId);
      if (!user || !user.is_active) {
        // アカウントが削除・停止されたらセッションも無効にする
        req.session = null;
        return res.redirect('/login?error=disabled');
      }

      req.user = user;
      req.user.avatar_url = auth.avatarUrl(user.discord_user_id, user.discord_avatar);
      if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
      next();
    } catch (err) {
      next(err);
    }
  });

  /** 管理者だけが通れるルート用 */
  async function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
      const nav = await loadNav();
      return res.status(403).type('html').send(
        layout({
          title: '権限がありません',
          active: '',
          nav,
          me: req.user,
          me: req.user,
          csrfToken: req.session.csrf,
          error: 'この操作は管理者のみ実行できます。',
          body: '<p><a class="link" href="/">タスク一覧へ戻る</a></p>',
        })
      );
    }
    next();
  }

  // 更新系リクエストはCSRFトークンを検証する
  app.use(async (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!req.body?._csrf || req.body._csrf !== req.session.csrf) {
      const nav = await loadNav();
      return res.status(403).type('html').send(
        layout({
          title: 'エラー',
          active: '',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          error: 'セッションが無効です。ページを再読み込みしてからやり直してください。',
          body: '<p><a class="link" href="/">タスク一覧へ戻る</a></p>',
        })
      );
    }
    next();
  });

  // --- サイドバー用のデータ ---

  /**
   * サイドバーはどの画面でも出るので、件数とプロジェクト一覧をまとめて取る。
   */
  async function loadNav() {
    const [[counts]] = await dbPool.query(
      `SELECT
         COUNT(*) AS all_count,
         SUM(status = 'todo') AS todo,
         SUM(status = 'in_progress') AS in_progress,
         SUM(status = 'blocked') AS blocked,
         SUM(status = 'done') AS done,
         SUM(status <> 'done') AS active
       FROM tasks`
    );
    const [projects] = await dbPool.query(
      `SELECT p.id, p.name,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_count
         FROM projects p ORDER BY p.name`
    );
    const [[{ openClarifications }]] = await dbPool.query(
      `SELECT COUNT(*) AS openClarifications FROM pending_clarifications WHERE status = 'open'`
    );

    return {
      projects,
      openClarifications,
      counts: {
        all: counts.all_count ?? 0,
        todo: counts.todo ?? 0,
        in_progress: counts.in_progress ?? 0,
        blocked: counts.blocked ?? 0,
        done: counts.done ?? 0,
        active: counts.active ?? 0,
      },
    };
  }

  async function getProjectNames() {
    const [rows] = await dbPool.query('SELECT id, name FROM projects');
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * 担当者のDiscord IDに、登録済みアカウントの表示名とアバターを紐付ける。
   *
   * アカウント未登録のDiscordユーザーが担当になっている場合は、
   * Discord API から名前とアイコンだけ引いて表示する（誰なのか分かるように）。
   */
  async function attachAssignees(tasks) {
    const ids = [...new Set(tasks.map((t) => t.assignee_id).filter(Boolean))];
    const profiles = await auth.loadDiscordProfiles(dbPool, ids);

    for (const [id, p] of profiles) {
      p.avatar_url = auth.avatarUrl(id, p.discord_avatar);
    }

    // 未登録のIDはDiscord側から補う
    for (const id of ids) {
      if (profiles.has(id)) continue;
      try {
        const u = await discordClient.users.fetch(id);
        profiles.set(id, {
          display_name: u.globalName || u.username,
          discord_username: u.username,
          avatar_url: u.displayAvatarURL({ extension: 'png', size: 64 }),
          unregistered: true,
        });
      } catch {
        /* 取得できなければ whoChip 側で「未登録」として表示される */
      }
    }

    for (const t of tasks) {
      t.assignee_profile = t.assignee_id ? profiles.get(t.assignee_id) ?? null : null;
    }
    return tasks;
  }

  /** 画面からの変更もDiscord経由の変更と同じように履歴へ残す */
  async function recordHistory(conn, taskId, changeType, oldStatus, newStatus, summary) {
    await conn.query(
      `INSERT INTO task_history (task_id, change_type, old_status, new_status, change_summary)
       VALUES (?, ?, ?, ?, ?)`,
      [taskId, changeType, oldStatus, newStatus, summary]
    );
  }

  const noticeOf = (req) => (req.query.ok ? '更新しました。' : null);

  // --- ホーム（進行中のタスク） ---
  app.get('/', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const [tasks] = await dbPool.query(
        `SELECT id, project_id, title, status, assignee_id, assignee_unconfirmed, updated_at
           FROM tasks WHERE status <> 'done' ORDER BY updated_at DESC`
      );
      await attachAssignees(tasks);
      const projectNames = await getProjectNames();

      const [recent] = await dbPool.query(
        `SELECT h.change_type, h.old_status, h.new_status, h.change_summary, h.changed_at, t.title
           FROM task_history h JOIN tasks t ON t.id = h.task_id
          ORDER BY h.id DESC LIMIT 10`
      );

      const historyItems = recent.length
        ? recent
            .map(
              (h) => `<li>
                <div>${escapeHtml(h.title)}
                  ${h.old_status ? `<span class="muted">— ${escapeHtml(statusLabel(h.old_status))} → ${escapeHtml(statusLabel(h.new_status))}</span>` : ''}
                </div>
                <div class="when">${escapeHtml(h.change_summary)} · ${escapeHtml(relativeDate(h.changed_at))}</div>
              </li>`
            )
            .join('')
        : '<li class="muted">まだ履歴はありません。</li>';

      res.type('html').send(
        layout({
          title: '進行中',
          subtitle: `${tasks.length}件`,
          active: 'home',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: `
            ${taskList(tasks, req.session.csrf, projectNames, {
              emptyText: '進行中のタスクはありません。',
              quickAdd: {},
            })}
            <div class="card">
              <h2>最近の変更</h2>
              <ul class="hist" style="margin-top:10px">${historyItems}</ul>
            </div>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  // --- タスク一覧（ステータス絞り込み） ---
  app.get('/tasks', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const filter = VALID_STATUSES.has(req.query.status) ? req.query.status : null;

      const [tasks] = filter
        ? await dbPool.query(
            `SELECT id, project_id, title, status, assignee_id, assignee_unconfirmed, updated_at
               FROM tasks WHERE status = ? ORDER BY updated_at DESC`,
            [filter]
          )
        : await dbPool.query(
            `SELECT id, project_id, title, status, assignee_id, assignee_unconfirmed, updated_at
               FROM tasks ORDER BY FIELD(status,'blocked','in_progress','todo','done'), updated_at DESC`
          );

      await attachAssignees(tasks);
      const projectNames = await getProjectNames();

      res.type('html').send(
        layout({
          title: filter ? statusLabel(filter) : 'すべてのタスク',
          subtitle: `${tasks.length}件`,
          active: filter ?? 'all',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: taskList(tasks, req.session.csrf, projectNames, {
            emptyText: '該当するタスクはありません。',
            quickAdd: filter && filter !== 'done' ? { status: filter } : {},
          }),
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/tasks', async (req, res, next) => {
    try {
      const title = String(req.body.title ?? '').trim().slice(0, 255);
      const status = VALID_STATUSES.has(req.body.status) ? req.body.status : 'todo';
      const projectId = req.body.project_id ? Number(req.body.project_id) : null;
      const assigneeId = safeDiscordId(req.body.assignee_id);
      const back = req.body.back && String(req.body.back).startsWith('/') ? req.body.back : '/tasks';

      if (!title) return res.redirect(back);

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [ins] = await conn.query(
          'INSERT INTO tasks (project_id, title, status, assignee_id) VALUES (?, ?, ?, ?)',
          [Number.isFinite(projectId) ? projectId : null, title, status, assigneeId]
        );
        await recordHistory(conn, ins.insertId, 'created', null, status, `Web画面から追加: ${title}`);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      res.redirect(`${back}${back.includes('?') ? '&' : '?'}ok=1`);
    } catch (err) {
      next(err);
    }
  });

  // --- 完了トグル（チェックボックス） ---
  app.post('/tasks/:id/toggle', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.redirect('/');

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [[current]] = await conn.query('SELECT status FROM tasks WHERE id = ?', [id]);
        if (current) {
          // 完了 ↔ 未着手 を行き来する。tududi のチェックボックスと同じ操作感
          const next = current.status === 'done' ? 'todo' : 'done';
          await conn.query('UPDATE tasks SET status = ? WHERE id = ?', [next, id]);
          await recordHistory(
            conn,
            id,
            'status_changed',
            current.status,
            next,
            `Web画面から変更: ${statusLabel(current.status)} → ${statusLabel(next)}`
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      // 押した画面に戻す（Refererは同一オリジンのパスのみ採用する）
      const ref = req.get('referer');
      let back = '/';
      try {
        if (ref) {
          const url = new URL(ref);
          if (url.host === req.get('host')) back = url.pathname + url.search;
        }
      } catch {
        /* 不正なRefererは無視してトップへ戻す */
      }
      res.redirect(back);
    } catch (err) {
      next(err);
    }
  });

  // --- タスク詳細 ---
  app.get('/tasks/:id', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).send('Not found');

      const [[task]] = await dbPool.query('SELECT * FROM tasks WHERE id = ?', [id]);
      if (!task) {
        return res.status(404).type('html').send(
          layout({
            title: '見つかりません',
            active: 'all',
            nav,
            me: req.user,
          csrfToken: req.session.csrf,
            body: '<div class="card"><div class="empty">このタスクは存在しません。</div></div>',
          })
        );
      }

      await attachAssignees([task]);
      const [projects] = await dbPool.query('SELECT id, name FROM projects ORDER BY name');
      const [history] = await dbPool.query(
        `SELECT change_type, old_status, new_status, change_summary, changed_at
           FROM task_history WHERE task_id = ? ORDER BY id DESC`,
        [id]
      );
      const [[source]] = await dbPool.query(
        'SELECT content, author_name, created_at FROM messages WHERE id = ?',
        [task.source_message_id ?? 0]
      );

      const historyItems = history.length
        ? history
            .map(
              (h) => `<li>
                <div>${h.old_status ? `${escapeHtml(statusLabel(h.old_status))} → ${escapeHtml(statusLabel(h.new_status))}` : escapeHtml(h.change_type)}</div>
                <div class="when">${escapeHtml(h.change_summary)} · ${escapeHtml(formatDate(h.changed_at))}</div>
              </li>`
            )
            .join('')
        : '<li class="muted">履歴はありません。</li>';

      res.type('html').send(
        layout({
          title: task.title,
          active: task.project_id ? `project:${task.project_id}` : 'all',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: `
            ${
              source
                ? `<div class="card"><div class="body">
                    <div class="muted" style="margin-bottom:4px">元になったDiscordの発言</div>
                    <div>「${escapeHtml(source.content)}」</div>
                    <div class="muted" style="font-size:12.5px">${escapeHtml(source.author_name)} · ${escapeHtml(formatDate(source.created_at))}</div>
                  </div></div>`
                : ''
            }

            <div class="card">
              <h2>編集</h2>
              <div class="body">
                <form method="post" action="/tasks/${task.id}/edit">
                  <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                  <div class="field">
                    <label>タイトル</label>
                    <input name="title" value="${escapeHtml(task.title)}" required maxlength="255">
                  </div>
                  <div class="grid">
                    <div class="field">
                      <label>状態</label>
                      <select name="status">
                        ${STATUS_ORDER.map((s) => `<option value="${s}"${s === task.status ? ' selected' : ''}>${escapeHtml(statusLabel(s))}</option>`).join('')}
                      </select>
                    </div>
                    <div class="field">
                      <label>プロジェクト</label>
                      <select name="project_id">
                        <option value="">未割当</option>
                        ${projects.map((p) => `<option value="${p.id}"${p.id === task.project_id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                      </select>
                    </div>
                    <div class="field">
                      <label>担当者のDiscord ID</label>
                      <input name="assignee_id" value="${escapeHtml(task.assignee_id || '')}" pattern="\\d*" maxlength="32" placeholder="任意">
                    </div>
                  </div>
                  <button type="submit">保存</button>
                </form>
              </div>
            </div>

            <div class="card">
              <h2>変更履歴</h2>
              <ul class="hist" style="margin-top:10px">${historyItems}</ul>
            </div>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/tasks/:id/edit', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.redirect('/tasks');

      const title = String(req.body.title ?? '').trim().slice(0, 255);
      const status = VALID_STATUSES.has(req.body.status) ? req.body.status : null;
      const projectId = req.body.project_id ? Number(req.body.project_id) : null;
      const assigneeId = safeDiscordId(req.body.assignee_id);
      if (!title || !status) return res.redirect(`/tasks/${id}`);

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [[current]] = await conn.query('SELECT status FROM tasks WHERE id = ?', [id]);
        if (!current) {
          await conn.rollback();
          return res.redirect('/tasks');
        }
        await conn.query(
          `UPDATE tasks
              SET title = ?, status = ?, project_id = ?, assignee_id = ?, assignee_unconfirmed = FALSE
            WHERE id = ?`,
          [title, status, Number.isFinite(projectId) ? projectId : null, assigneeId, id]
        );
        if (current.status !== status) {
          await recordHistory(
            conn,
            id,
            'status_changed',
            current.status,
            status,
            `Web画面から変更: ${statusLabel(current.status)} → ${statusLabel(status)}`
          );
        } else {
          await recordHistory(conn, id, 'note_added', null, null, 'Web画面から内容を編集');
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      res.redirect(`/tasks/${id}?ok=1`);
    } catch (err) {
      next(err);
    }
  });

  // --- プロジェクト別のタスク ---
  app.get('/projects/:id', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).send('Not found');

      const [[project]] = await dbPool.query('SELECT id, name, description FROM projects WHERE id = ?', [id]);
      if (!project) {
        return res.status(404).type('html').send(
          layout({
            title: '見つかりません',
            active: 'projects',
            nav,
            me: req.user,
          csrfToken: req.session.csrf,
            body: '<div class="card"><div class="empty">このプロジェクトは存在しません。</div></div>',
          })
        );
      }

      const [tasks] = await dbPool.query(
        `SELECT id, project_id, title, status, assignee_id, assignee_unconfirmed, updated_at
           FROM tasks WHERE project_id = ?
          ORDER BY FIELD(status,'blocked','in_progress','todo','done'), updated_at DESC`,
        [id]
      );
      await attachAssignees(tasks);
      const projectNames = await getProjectNames();

      res.type('html').send(
        layout({
          title: project.name,
          subtitle: `${tasks.length}件`,
          active: `project:${id}`,
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: `
            ${project.description ? `<div class="card"><div class="body muted">${escapeHtml(project.description)}</div></div>` : ''}
            ${taskList(tasks, req.session.csrf, projectNames, {
              emptyText: 'このプロジェクトにタスクはありません。',
              showProject: false,
              quickAdd: { projectId: id },
            })}`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  // --- プロジェクト管理 ---
  app.get('/projects', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const [projects] = await dbPool.query(
        `SELECT p.id, p.name, p.description, p.created_at,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
           FROM projects p ORDER BY p.id DESC`
      );

      const rows = projects.length
        ? projects
            .map(
              (p) => `<li>
                <span class="grow"><a class="link" href="/projects/${p.id}">${escapeHtml(p.name)}</a>
                  ${p.description ? `<span class="muted"> — ${escapeHtml(p.description)}</span>` : ''}
                </span>
                <span class="muted">${escapeHtml(p.task_count)}件</span>
              </li>`
            )
            .join('')
        : '<li class="muted">プロジェクトが登録されていません。</li>';

      res.type('html').send(
        layout({
          title: 'プロジェクト',
          active: 'projects',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: `
            <div class="card">
              <ul class="rows">${rows}</ul>
              <form class="quick-add" method="post" action="/projects">
                <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                <input type="text" name="name" placeholder="新しいプロジェクト名…" required maxlength="100">
                <input type="text" name="description" placeholder="説明（任意）" maxlength="500" style="flex:1">
                <button type="submit">追加</button>
              </form>
            </div>
            <p class="muted">プロジェクトが1件だけの場合、Discordから検出された新規タスクは自動的にそのプロジェクトへ紐付きます。複数ある場合は確認事項が作られます。</p>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/projects', async (req, res, next) => {
    try {
      const name = String(req.body.name ?? '').trim().slice(0, 100);
      const description = String(req.body.description ?? '').trim().slice(0, 500) || null;
      if (name) {
        await dbPool.query('INSERT INTO projects (name, description) VALUES (?, ?)', [name, description]);
      }
      res.redirect('/projects?ok=1');
    } catch (err) {
      next(err);
    }
  });

  // --- 確認事項 ---
  app.get('/clarifications', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const [rows] = await dbPool.query(
        `SELECT id, clarification_type, question, resolved_answer, status, created_at, resolved_at
           FROM pending_clarifications ORDER BY status = 'resolved', id DESC LIMIT 100`
      );

      const items = rows.length
        ? rows
            .map(
              (c) => `<li>
                <span class="status-dot ${c.status === 'open' ? 'st-blocked' : 'st-done'}" style="margin-top:8px"></span>
                <span class="grow">
                  <div>${escapeHtml(c.question)}</div>
                  <div class="when muted" style="font-size:12.5px">
                    ${escapeHtml(c.clarification_type)} ·
                    ${c.status === 'open' ? '未解決' : `回答: ${escapeHtml(c.resolved_answer || '')}`} ·
                    ${escapeHtml(relativeDate(c.resolved_at || c.created_at))}
                  </div>
                </span>
                ${
                  c.status === 'open'
                    ? `<form method="post" action="/clarifications/${c.id}/dismiss" style="margin:0">
                        <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                        <button class="ghost" type="submit">対応不要</button>
                       </form>`
                    : ''
                }
              </li>`
            )
            .join('')
        : '<li class="muted">確認事項はありません。</li>';

      res.type('html').send(
        layout({
          title: '確認事項',
          subtitle: `未解決 ${nav.openClarifications}件`,
          active: 'clarifications',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: noticeOf(req),
          body: `
            <div class="card"><ul class="rows">${items}</ul></div>
            <p class="muted">回答はDiscord上でBotの質問メッセージに返信して行います。ここでは状況の確認と、不要になった質問の取り下げができます。</p>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/clarifications/:id/dismiss', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (Number.isInteger(id)) {
        // 回答としては扱わず、質問だけを閉じる（Redisのキューには積まない）
        await dbPool.query(
          `UPDATE pending_clarifications
              SET status = 'resolved', resolved_answer = 'Web画面から対応不要として取り下げ', resolved_at = NOW()
            WHERE id = ? AND status = 'open'`,
          [id]
        );
      }
      res.redirect('/clarifications?ok=1');
    } catch (err) {
      next(err);
    }
  });

  // --- 監視チャンネル ---
  app.get('/channels', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const [rows] = await dbPool.query(
        'SELECT id, channel_id, channel_name, is_active, created_at FROM watched_channels ORDER BY id'
      );

      const items = rows.length
        ? rows
            .map(
              (c) => `<li>
                <span class="status-dot ${c.is_active ? 'st-in_progress' : 'st-todo'}"></span>
                <span class="grow">
                  <div>${escapeHtml(c.channel_name || '(名前未設定)')}</div>
                  <div class="muted" style="font-size:12.5px">${escapeHtml(c.channel_id)} · ${c.is_active ? '監視中' : '停止中'}</div>
                </span>
                <form method="post" action="/channels/${c.id}/toggle" style="margin:0">
                  <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                  <button class="ghost" type="submit">${c.is_active ? '停止' : '再開'}</button>
                </form>
              </li>`
            )
            .join('')
        : '<li class="muted">監視チャンネルが登録されていません。</li>';

      res.type('html').send(
        layout({
          title: '監視チャンネル',
          active: 'channels',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: req.query.ok ? '更新しました。Botへの反映まで最大60秒かかります。' : null,
          body: `
            <div class="card">
              <ul class="rows">${items}</ul>
              <form class="quick-add" method="post" action="/channels">
                <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                <input type="text" name="channel_id" placeholder="チャンネルID（開発者モードで右クリック→IDをコピー）" required pattern="\\d+" maxlength="32">
                <input type="text" name="channel_name" placeholder="表示名（任意）" maxlength="100" style="flex:0 0 160px">
                <button type="submit">追加</button>
              </form>
            </div>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/channels', async (req, res, next) => {
    try {
      const channelId = safeDiscordId(req.body.channel_id);
      const channelName = String(req.body.channel_name ?? '').trim().slice(0, 100) || null;
      if (channelId) {
        await dbPool.query(
          `INSERT INTO watched_channels (channel_id, channel_name) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE channel_name = VALUES(channel_name), is_active = TRUE`,
          [channelId, channelName]
        );
      }
      res.redirect('/channels?ok=1');
    } catch (err) {
      next(err);
    }
  });

  app.post('/channels/:id/toggle', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (Number.isInteger(id)) {
        await dbPool.query('UPDATE watched_channels SET is_active = NOT is_active WHERE id = ?', [id]);
      }
      res.redirect('/channels?ok=1');
    } catch (err) {
      next(err);
    }
  });

  // --- マイページ（自分のアカウント設定） ---
  app.get('/profile', async (req, res, next) => {
    try {
      const nav = await loadNav();
      const me = req.user;

      const errors = {
        oauth: 'Discordとの連携に失敗しました。',
        taken: 'そのDiscordアカウントは既に別のユーザーが使用しています。',
        password: '現在のパスワードが違います。',
        short: 'パスワードは8文字以上にしてください。',
      };

      // 自分が担当しているタスク
      const [myTasks] = me.discord_user_id
        ? await dbPool.query(
            `SELECT id, project_id, title, status, assignee_id, assignee_unconfirmed, updated_at
               FROM tasks WHERE assignee_id = ? AND status <> 'done'
              ORDER BY updated_at DESC`,
            [me.discord_user_id]
          )
        : [[]];
      await attachAssignees(myTasks);
      const projectNames = await getProjectNames();

      const discordSection = me.discord_user_id
        ? `<div class="body">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              ${
                me.avatar_url
                  ? `<img class="avatar lg" src="${escapeHtml(me.avatar_url)}" alt="" width="34" height="34">`
                  : ''
              }
              <div>
                <div>${escapeHtml(me.discord_username || '')}</div>
                <div class="muted" style="font-size:12.5px">ID: ${escapeHtml(me.discord_user_id)}</div>
              </div>
            </div>
            <form method="post" action="/profile/unlink" style="margin:0">
              <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
              <button class="ghost" type="submit">連携を解除</button>
            </form>
            <p class="muted" style="font-size:12.5px;margin-bottom:0">
              このDiscordアカウントで発言したタスクが、あなたの担当として表示されます。
            </p>
          </div>`
        : `<div class="body">
            <p class="muted" style="margin-top:0">
              Discordを連携すると、Discord上で自分が宣言したタスクが自動的に自分の担当として紐付き、
              名前とアイコンで表示されるようになります。
            </p>
            ${
              discordEnabled
                ? '<a class="btn-discord" href="/auth/discord">Discordアカウントを連携</a>'
                : '<p class="muted">Discord連携は現在無効です（管理者が設定を行う必要があります）。</p>'
            }
          </div>`;

      res.type('html').send(
        layout({
          title: 'マイページ',
          active: 'profile',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: req.query.ok ? '更新しました。' : null,
          error: errors[req.query.error] ?? null,
          body: `
            <div class="card">
              <h2>アカウント</h2>
              <div class="body">
                <div class="muted" style="font-size:12.5px">メールアドレス</div>
                <div>${escapeHtml(me.email)}</div>
                <div class="divider"></div>
                <form method="post" action="/profile/name">
                  <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                  <div class="field">
                    <label>表示名</label>
                    <input name="display_name" value="${escapeHtml(me.display_name)}" required maxlength="100">
                  </div>
                  <button type="submit">保存</button>
                </form>
              </div>
            </div>

            <div class="card">
              <h2>Discord連携</h2>
              ${discordSection}
            </div>

            <div class="card">
              <h2>パスワード変更</h2>
              <div class="body">
                <form method="post" action="/profile/password">
                  <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                  <div class="grid">
                    <div class="field">
                      <label>現在のパスワード</label>
                      <input type="password" name="current" autocomplete="current-password" ${me.password_hash ? 'required' : ''}>
                    </div>
                    <div class="field">
                      <label>新しいパスワード（8文字以上）</label>
                      <input type="password" name="next" autocomplete="new-password" minlength="8" required>
                    </div>
                  </div>
                  <button type="submit">変更</button>
                </form>
              </div>
            </div>

            <div class="card">
              <h2>担当中のタスク</h2>
              ${
                me.discord_user_id
                  ? taskList(myTasks, req.session.csrf, projectNames, {
                      emptyText: '担当中のタスクはありません。',
                    }).replace('<div class="card">', '').replace(/<\/div>$/, '')
                  : '<div class="empty">Discordを連携すると、担当タスクがここに表示されます。</div>'
              }
            </div>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/profile/name', async (req, res, next) => {
    try {
      const name = String(req.body.display_name ?? '').trim().slice(0, 100);
      if (name) {
        await dbPool.query('UPDATE users SET display_name = ? WHERE id = ?', [name, req.user.id]);
      }
      res.redirect('/profile?ok=1');
    } catch (err) {
      next(err);
    }
  });

  app.post('/profile/password', async (req, res, next) => {
    try {
      const next_ = String(req.body.next ?? '');
      if (next_.length < 8) return res.redirect('/profile?error=short');

      // パスワード未設定（Discord連携のみ）のアカウントは現在のパスワード確認を省く
      if (req.user.password_hash) {
        const ok = await auth.verifyPassword(String(req.body.current ?? ''), req.user.password_hash);
        if (!ok) return res.redirect('/profile?error=password');
      }
      await auth.setPassword(dbPool, req.user.id, next_);
      res.redirect('/profile?ok=1');
    } catch (err) {
      next(err);
    }
  });

  app.post('/profile/unlink', async (req, res, next) => {
    try {
      // パスワードが無い状態で連携を外すとログイン手段が無くなるため止める
      if (!req.user.password_hash) return res.redirect('/profile?error=short');
      await auth.unlinkDiscordAccount(dbPool, req.user.id);
      res.redirect('/profile?ok=1');
    } catch (err) {
      next(err);
    }
  });

  // --- ユーザー管理（管理者のみ） ---
  app.get('/users', requireAdmin, async (req, res, next) => {
    try {
      const nav = await loadNav();
      const [users] = await dbPool.query(
        `SELECT id, email, display_name, role, discord_user_id, discord_username,
                discord_avatar, is_active, last_login_at, created_at
           FROM users ORDER BY role = 'member', id`
      );

      const errors = {
        email: 'そのメールアドレスは既に登録されています。',
        invalid: '入力内容に不備があります。',
        last_admin: '管理者が0人になる操作はできません。',
        self: '自分自身に対しては実行できません。',
      };

      const rows = users
        .map((u) => {
          const avatar = auth.avatarUrl(u.discord_user_id, u.discord_avatar);
          return `<li>
            ${
              avatar
                ? `<img class="avatar lg" src="${escapeHtml(avatar)}" alt="" width="34" height="34">`
                : `<span class="avatar lg ph">${escapeHtml((u.display_name || u.email).slice(0, 1))}</span>`
            }
            <span class="grow">
              <div>
                ${escapeHtml(u.display_name)}
                ${u.role === 'admin' ? '<span class="tag">管理者</span>' : ''}
                ${u.is_active ? '' : '<span class="muted">（停止中）</span>'}
              </div>
              <div class="muted" style="font-size:12.5px">
                ${escapeHtml(u.email)}
                ${
                  u.discord_user_id
                    ? ` · Discord: ${escapeHtml(u.discord_username || u.discord_user_id)}`
                    : ' · Discord未連携'
                }
                ${u.last_login_at ? ` · 最終ログイン ${escapeHtml(relativeDate(u.last_login_at))}` : ' · 未ログイン'}
              </div>
            </span>
            ${
              u.id === req.user.id
                ? '<span class="muted" style="font-size:12.5px">自分</span>'
                : `<form method="post" action="/users/${u.id}/toggle" style="margin:0">
                     <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                     <button class="ghost" type="submit">${u.is_active ? '停止' : '再開'}</button>
                   </form>`
            }
          </li>`;
        })
        .join('');

      res.type('html').send(
        layout({
          title: 'ユーザー管理',
          subtitle: `${users.length}人`,
          active: 'users',
          nav,
          me: req.user,
          csrfToken: req.session.csrf,
          notice: req.query.ok ? '更新しました。' : null,
          error: errors[req.query.error] ?? null,
          body: `
            <div class="card"><ul class="rows">${rows}</ul></div>

            <div class="card">
              <h2>ユーザーを追加</h2>
              <div class="body">
                <form method="post" action="/users">
                  <input type="hidden" name="_csrf" value="${escapeHtml(req.session.csrf)}">
                  <div class="grid">
                    <div class="field">
                      <label>メールアドレス</label>
                      <input type="email" name="email" required maxlength="255">
                    </div>
                    <div class="field">
                      <label>表示名</label>
                      <input name="display_name" required maxlength="100">
                    </div>
                    <div class="field">
                      <label>初期パスワード（8文字以上）</label>
                      <input type="password" name="password" minlength="8" required autocomplete="new-password">
                    </div>
                    <div class="field">
                      <label>権限</label>
                      <select name="role">
                        <option value="member">メンバー</option>
                        <option value="admin">管理者</option>
                      </select>
                    </div>
                    <div class="field">
                      <label>DiscordユーザーID（任意）</label>
                      <input name="discord_user_id" pattern="\\d*" maxlength="32" placeholder="後から本人が連携も可">
                    </div>
                  </div>
                  <button type="submit">追加</button>
                </form>
                <p class="muted" style="font-size:12.5px;margin-bottom:0">
                  Discordログインは、ここで登録されたアカウントのDiscordが紐付いている場合のみ使えます。
                  IDを空にした場合は、本人がログイン後にマイページから連携できます。
                </p>
              </div>
            </div>`,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  app.post('/users', requireAdmin, async (req, res, next) => {
    try {
      const email = String(req.body.email ?? '').trim().toLowerCase();
      const displayName = String(req.body.display_name ?? '').trim().slice(0, 100);
      const password = String(req.body.password ?? '');
      const role = req.body.role === 'admin' ? 'admin' : 'member';
      const discordUserId = safeDiscordId(req.body.discord_user_id);

      if (!email.includes('@') || !displayName || password.length < 8) {
        return res.redirect('/users?error=invalid');
      }
      if (await auth.findUserByEmail(dbPool, email)) {
        return res.redirect('/users?error=email');
      }

      await auth.createUser(dbPool, { email, password, displayName, role, discordUserId });
      res.redirect('/users?ok=1');
    } catch (err) {
      // DiscordIDの一意制約に引っかかった場合など
      if (err.code === 'ER_DUP_ENTRY') return res.redirect('/users?error=email');
      next(err);
    }
  });

  app.post('/users/:id/toggle', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.redirect('/users');
      if (id === req.user.id) return res.redirect('/users?error=self');

      const target = await auth.findUserById(dbPool, id);
      if (!target) return res.redirect('/users');

      // 最後の管理者を止めると誰も管理できなくなるため防ぐ
      if (target.role === 'admin' && target.is_active) {
        const [[{ c }]] = await dbPool.query(
          "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = TRUE"
        );
        if (c <= 1) return res.redirect('/users?error=last_admin');
      }

      await dbPool.query('UPDATE users SET is_active = NOT is_active WHERE id = ?', [id]);
      res.redirect('/users?ok=1');
    } catch (err) {
      next(err);
    }
  });

  // --- エラーハンドラ ---
  // 内部エラーの詳細は画面に出さず、ログにだけ残す
  app.use(async (err, req, res, _next) => {
    console.error('[web] エラー:', err);
    let nav = { projects: [], openClarifications: 0, counts: {} };
    try {
      nav = await loadNav();
    } catch {
      /* DBが落ちている場合はサイドバー無しで表示する */
    }
    res.status(500).type('html').send(
      layout({
        title: 'エラー',
        active: '',
        nav,
        me: req.user ?? null,
        csrfToken: req.session?.csrf ?? '',
        error: 'サーバー内部でエラーが発生しました。',
        body: '<p><a class="link" href="/">タスク一覧へ戻る</a></p>',
      })
    );
  });

  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[web] 管理画面を起動しました (port: ${port})`);
      if (!secureCookie) {
        console.log('[web] 注意: HTTPSで公開する場合は WEB_SECURE_COOKIE=true を設定してください。');
      }
      resolve(server);
    });
  });
}

module.exports = { startWebServer };
