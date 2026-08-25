// web/render.js
// 画面描画（tududi のUIをベースにしたレイアウト）
//
// tududi から取り入れている要素：
//   - 左サイドバーにビュー切替とプロジェクト一覧を並べる構成
//   - 丸いチェックボックス＋タイトル＋右側にメタ情報チップ、というタスク行
//   - 余白を広めに取った落ち着いた配色
//   - prefers-color-scheme によるライト/ダークの自動切替
//
// 本家との違い：
//   Areas / タグ / 期限 / 優先度 は今のDBスキーマに無いため設けていない。
//   代わりに Discord 連携由来の「確認事項」「監視チャンネル」をサイドバーに置いている。
//
// DBから来る値はすべてユーザー入力由来なので、埋め込む前に必ず escapeHtml() を通すこと。

const STATUS_LABELS = {
  todo: '未着手',
  in_progress: '進行中',
  blocked: 'ブロック中',
  done: '完了',
};

const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'done'];

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 「3分前」「昨日」のような相対表記。tududi の落ち着いた見せ方に合わせ、
 * 一覧では絶対時刻ではなくこちらを使う。
 */
function relativeDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨日';
  if (day < 7) return `${day}日前`;
  return formatDate(value).slice(0, 10);
}

const STYLES = `
:root {
  --bg: #f7f7f5;
  --surface: #ffffff;
  --surface-2: #fafaf9;
  --border: #e6e5e1;
  --text: #2c2c2a;
  --muted: #8a8a85;
  --accent: #4f46e5;
  --accent-soft: #eef2ff;
  --todo: #a1a1aa;
  --in_progress: #4f46e5;
  --blocked: #dc2626;
  --done: #16a34a;
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 1px 8px rgba(0,0,0,.03);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --surface: #1e1f23;
    --surface-2: #232429;
    --border: #2e3035;
    --text: #e4e4e7;
    --muted: #8b8d93;
    --accent: #818cf8;
    --accent-soft: #282a3d;
    --todo: #6b6d74;
    --in_progress: #818cf8;
    --blocked: #f87171;
    --done: #4ade80;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans",
               "Noto Sans JP", "Yu Gothic UI", sans-serif;
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }

/* --- レイアウト --- */
.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 250px; flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 20px 12px;
  display: flex; flex-direction: column; gap: 22px;
}
.brand {
  display: flex; align-items: center; gap: 9px;
  padding: 0 10px 2px; font-weight: 600; font-size: 15px;
}
.brand .dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent); flex-shrink: 0;
}
.brand-sub {
  font-size: 11.5px; font-weight: 500; color: var(--muted);
  letter-spacing: .06em; margin-left: 2px;
}
.side-group > .side-title {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--muted); padding: 0 10px; margin-bottom: 5px; font-weight: 600;
}
.side-link {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border-radius: 7px;
  font-size: 14px; color: var(--text);
}
.side-link:hover { background: var(--surface-2); }
.side-link.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.side-link .ico { width: 15px; text-align: center; flex-shrink: 0; opacity: .75; }
.side-link .count {
  margin-left: auto; font-size: 12px; color: var(--muted);
  background: var(--surface-2); border-radius: 10px; padding: 0 7px;
}
.side-link.active .count { background: transparent; color: var(--accent); }
.side-link .swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.side-empty { padding: 4px 10px; font-size: 13px; color: var(--muted); }

.content { flex: 1; min-width: 0; padding: 28px 32px 60px; }
.content-inner { max-width: 780px; margin: 0 auto; }
.page-head {
  display: flex; align-items: flex-end; gap: 12px;
  margin-bottom: 22px; flex-wrap: wrap;
}
.page-head h1 { font-size: 24px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
.page-head .sub { color: var(--muted); font-size: 14px; }
.page-head .spacer { flex: 1; }

/* --- カード --- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: var(--shadow); margin-bottom: 18px;
}
.card > h2 {
  font-size: 13px; font-weight: 600; color: var(--muted);
  margin: 0; padding: 14px 18px 0;
  letter-spacing: .02em;
}
.card > .body { padding: 14px 18px 18px; }

/* --- タスク行 --- */
.task-list { list-style: none; margin: 0; padding: 0; }
.task {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 11px 18px; border-top: 1px solid var(--border);
}
.task:first-child { border-top: none; }
.task:hover { background: var(--surface-2); }
.check-form { margin: 0; padding-top: 2px; }
.check {
  width: 19px; height: 19px; border-radius: 50%;
  border: 1.5px solid var(--border); background: transparent;
  cursor: pointer; padding: 0; display: block; position: relative;
  transition: border-color .12s;
}
.check:hover { border-color: var(--accent); }
.check.done { background: var(--done); border-color: var(--done); }
.check.done::after {
  content: ''; position: absolute; left: 5.5px; top: 2px;
  width: 4px; height: 9px; border: solid #fff;
  border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.task-main { flex: 1; min-width: 0; }
.task-title { display: block; font-size: 14.5px; word-break: break-word; }
.task.is-done .task-title { color: var(--muted); text-decoration: line-through; }
.task-title:hover { color: var(--accent); }
.task-meta {
  display: flex; flex-wrap: wrap; gap: 6px 10px;
  margin-top: 3px; font-size: 12.5px; color: var(--muted);
}
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; white-space: nowrap;
}
.chip .swatch { width: 7px; height: 7px; border-radius: 2px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.st-todo { background: var(--todo); }
.st-in_progress { background: var(--in_progress); }
.st-blocked { background: var(--blocked); }
.st-done { background: var(--done); }
.task-actions { padding-top: 1px; }
.empty { padding: 26px 18px; text-align: center; color: var(--muted); font-size: 14px; }

/* --- フォーム --- */
.quick-add { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
.quick-add input[type=text] { flex: 1; }
input, select, textarea {
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 8px 11px; font-size: 14px; font-family: inherit;
  width: 100%; outline: none;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent); background: var(--surface);
}
input::placeholder { color: var(--muted); }
button {
  background: var(--accent); color: #fff; border: none; border-radius: 8px;
  padding: 8px 15px; font-size: 14px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
button:hover { filter: brightness(1.08); }
button.ghost {
  background: transparent; border: 1px solid var(--border); color: var(--muted);
  padding: 5px 11px; font-size: 13px;
}
button.ghost:hover { color: var(--text); border-color: var(--muted); filter: none; }
.field { margin-bottom: 12px; }
label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }

/* --- 補助 --- */
.muted { color: var(--muted); font-size: 13.5px; }
.notice, .error {
  padding: 11px 15px; border-radius: 9px; margin-bottom: 18px; font-size: 14px;
}
.notice { background: color-mix(in srgb, var(--done) 12%, transparent); color: var(--done); }
.error { background: color-mix(in srgb, var(--blocked) 12%, transparent); color: var(--blocked); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px,1fr)); gap: 10px; margin-bottom: 18px; }
.stat {
  background: var(--surface); border: 1px solid var(--border); border-radius: 11px;
  padding: 13px 15px; box-shadow: var(--shadow);
}
.stat .num { font-size: 22px; font-weight: 600; line-height: 1.2; }
.stat .lbl { font-size: 12px; color: var(--muted); }
.hist { list-style: none; margin: 0; padding: 0; }
.hist li { padding: 10px 18px; border-top: 1px solid var(--border); font-size: 13.5px; }
.hist li:first-child { border-top: none; }
.hist .when { color: var(--muted); font-size: 12px; }
.link { color: var(--accent); }
.link:hover { text-decoration: underline; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows li {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 18px; border-top: 1px solid var(--border); font-size: 14px;
}
.rows li:first-child { border-top: none; }
.rows .grow { flex: 1; min-width: 0; }

/* --- アバター／ユーザー --- */
.avatar {
  width: 20px; height: 20px; border-radius: 50%;
  object-fit: cover; flex-shrink: 0; background: var(--surface-2);
  display: inline-block; vertical-align: -5px;
}
.avatar.lg { width: 34px; height: 34px; vertical-align: middle; }
.avatar.ph {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--muted); border: 1px solid var(--border);
}
.who { display: inline-flex; align-items: center; gap: 5px; }
.me {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 10px; border-radius: 8px; background: var(--surface-2);
  font-size: 13px; margin: 0 0 8px;
}
.me .grow { flex: 1; min-width: 0; }
.me .nm { font-weight: 500; }
.me .rl { color: var(--muted); font-size: 11.5px; }
.tag {
  font-size: 10.5px; padding: 1px 7px; border-radius: 9px;
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
}
.divider { height: 1px; background: var(--border); margin: 14px 0; }
.btn-discord {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  background: #5865f2; color: #fff; border-radius: 8px; padding: 9px 15px;
  font-size: 14px; width: 100%; border: none; cursor: pointer;
}
.btn-discord:hover { filter: brightness(1.08); }

/* --- モバイル --- */
@media (max-width: 820px) {
  .shell { flex-direction: column; }
  .sidebar {
    width: auto; border-right: none; border-bottom: 1px solid var(--border);
    flex-direction: row; overflow-x: auto; gap: 16px; padding: 12px;
    align-items: center;
  }
  .side-group { display: flex; align-items: center; gap: 4px; }
  .side-group > .side-title { display: none; }
  .side-link { white-space: nowrap; padding: 6px 10px; }
  .brand { padding: 0 6px 0 4px; }
  .content { padding: 18px 14px 50px; }
  .task, .quick-add, .rows li, .hist li { padding-left: 14px; padding-right: 14px; }
}
`;

/**
 * 担当者のアバター＋名前。
 * Discord連携済みのアカウントがあれば表示名とアイコンを、
 * 無ければDiscordのIDだけを控えめに出す。
 */
function whoChip(profile, discordId, { size = '' } = {}) {
  if (!discordId) return '<span class="chip">担当未定</span>';

  if (!profile) {
    // アカウント未登録のDiscordユーザー
    return `<span class="chip who">
      <span class="avatar ph ${size}">?</span>${escapeHtml(discordId)}
      <span class="muted">（未登録）</span>
    </span>`;
  }

  const name = profile.display_name || profile.discord_username || discordId;
  return `<span class="chip who">
    ${
      profile.avatar_url
        ? `<img class="avatar ${size}" src="${escapeHtml(profile.avatar_url)}" alt="" width="20" height="20">`
        : `<span class="avatar ph ${size}">${escapeHtml(name.slice(0, 1))}</span>`
    }
    ${escapeHtml(name)}
  </span>`;
}

/**
 * サイドバー下部に出す「今ログインしている人」の表示
 */
function meBox(me) {
  if (!me) return '';
  const name = me.display_name || me.email;
  return `<div class="me">
    ${
      me.avatar_url
        ? `<img class="avatar" src="${escapeHtml(me.avatar_url)}" alt="" width="20" height="20">`
        : `<span class="avatar ph">${escapeHtml(name.slice(0, 1))}</span>`
    }
    <span class="grow">
      <div class="nm">${escapeHtml(name)}</div>
      <div class="rl">${me.role === 'admin' ? '管理者' : 'メンバー'}</div>
    </span>
  </div>`;
}

/**
 * サイドバー。tududi の「ビュー → プロジェクト → その他」という並びに合わせる。
 */
function sidebar({ active, projects, counts, openClarifications, me }) {
  const view = (href, icon, label, count, key) => `
    <a class="side-link ${active === key ? 'active' : ''}" href="${href}">
      <span class="ico">${icon}</span><span>${escapeHtml(label)}</span>
      ${count !== undefined && count !== null ? `<span class="count">${escapeHtml(count)}</span>` : ''}
    </a>`;

  const projectLinks = projects.length
    ? projects
        .map(
          (p) => `
      <a class="side-link ${active === `project:${p.id}` ? 'active' : ''}" href="/projects/${p.id}">
        <span class="ico"><span class="swatch" style="background:var(--accent)"></span></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="count">${escapeHtml(p.open_count ?? 0)}</span>
      </a>`
        )
        .join('')
    : '<div class="side-empty">プロジェクトなし</div>';

  return `
  <aside class="sidebar">
    <div class="brand"><span class="dot"></span><span>栞 <span class="brand-sub">Shiori</span></span></div>

    <div class="side-group">
      <div class="side-title">タスク</div>
      ${view('/', '◎', '進行中', counts.active, 'home')}
      ${view('/tasks?status=todo', '○', '未着手', counts.todo, 'todo')}
      ${view('/tasks?status=in_progress', '◐', '対応中', counts.in_progress, 'in_progress')}
      ${view('/tasks?status=blocked', '■', 'ブロック', counts.blocked, 'blocked')}
      ${view('/tasks?status=done', '✓', '完了', counts.done, 'done')}
      ${view('/tasks', '≡', 'すべて', counts.all, 'all')}
    </div>

    <div class="side-group">
      <div class="side-title">プロジェクト</div>
      ${projectLinks}
      ${view('/projects', '＋', '管理', null, 'projects')}
    </div>

    <div class="side-group">
      <div class="side-title">Discord</div>
      ${view('/clarifications', '?', '確認事項', openClarifications || null, 'clarifications')}
      ${view('/channels', '#', '監視チャンネル', null, 'channels')}
    </div>

    <div class="side-group">
      <div class="side-title">アカウント</div>
      ${view('/profile', '◍', 'マイページ', null, 'profile')}
      ${me?.role === 'admin' ? view('/users', '⚙', 'ユーザー管理', null, 'users') : ''}
    </div>

    <div class="side-group" style="margin-top:auto">
      ${meBox(me)}
      <form method="post" action="/logout" style="margin:0">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <button class="ghost" type="submit" style="width:100%">ログアウト</button>
      </form>
    </div>
  </aside>`;
}

/**
 * 共通レイアウト
 */
function layout({ title, subtitle, active, body, notice, error, nav, csrfToken, actions, me }) {
  const side = sidebar({ ...nav, active, me }).replace('__CSRF__', escapeHtml(csrfToken));

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · 栞</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
  ${side}
  <div class="content"><div class="content-inner">
    <div class="page-head">
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<span class="sub">${escapeHtml(subtitle)}</span>` : ''}
      <span class="spacer"></span>
      ${actions ?? ''}
    </div>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${body}
  </div></div>
</div>
</body>
</html>`;
}

/**
 * ログイン画面。メール＋パスワードと、設定済みならDiscordログインを併記する。
 */
function loginPage({ error, notice, discordEnabled }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ログイン · 栞</title>
<style>${STYLES}
.login { max-width: 350px; margin: 12vh auto; padding: 0 16px; }
.login .brand { justify-content: center; margin-bottom: 20px; font-size: 17px; }
.or {
  display: flex; align-items: center; gap: 10px;
  color: var(--muted); font-size: 12px; margin: 16px 0;
}
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--border); }
</style>
</head>
<body>
<div class="login">
  <div class="brand"><span class="dot"></span><span>栞 <span class="brand-sub">Shiori</span></span></div>
  <div class="card"><div class="body">
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
    <form method="post" action="/login">
      <div class="field">
        <label for="email">メールアドレス</label>
        <input type="email" id="email" name="email" autocomplete="username" autofocus required>
      </div>
      <div class="field">
        <label for="password">パスワード</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required>
      </div>
      <button type="submit" style="width:100%">ログイン</button>
    </form>
    ${
      discordEnabled
        ? `<div class="or">または</div>
           <a class="btn-discord" href="/auth/discord">Discordでログイン</a>
           <p class="muted" style="font-size:12px;margin:10px 0 0;text-align:center">
             管理者に登録されたアカウントのみ利用できます
           </p>`
        : ''
    }
  </div></div>
</div>
</body>
</html>`;
}

/**
 * タスク1件の行。tududi 同様、丸いチェックボックスで完了を切り替える。
 */
function taskItem(task, csrfToken, projectNames, { showProject = true } = {}) {
  const isDone = task.status === 'done';
  const meta = [];

  meta.push(
    `<span class="chip"><span class="status-dot st-${escapeHtml(task.status)}"></span>${escapeHtml(statusLabel(task.status))}</span>`
  );

  if (showProject) {
    const name = projectNames.get(task.project_id);
    meta.push(
      name
        ? `<span class="chip"><span class="swatch" style="background:var(--accent)"></span>${escapeHtml(name)}</span>`
        : '<span class="chip">未割当</span>'
    );
  }

  meta.push(
    whoChip(task.assignee_profile, task.assignee_id) +
      (task.assignee_unconfirmed ? '<span class="chip muted">未確認</span>' : '')
  );

  if (task.updated_at) {
    meta.push(`<span class="chip">${escapeHtml(relativeDate(task.updated_at))}</span>`);
  }

  return `<li class="task ${isDone ? 'is-done' : ''}">
    <form class="check-form" method="post" action="/tasks/${task.id}/toggle">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button class="check ${isDone ? 'done' : ''}" type="submit"
              title="${isDone ? '未完了に戻す' : '完了にする'}"
              aria-label="${isDone ? '未完了に戻す' : '完了にする'}"></button>
    </form>
    <div class="task-main">
      <a class="task-title" href="/tasks/${task.id}">${escapeHtml(task.title)}</a>
      <div class="task-meta">${meta.join('')}</div>
    </div>
  </li>`;
}

/**
 * タスク一覧（＋その場で追加できる入力欄）
 */
function taskList(tasks, csrfToken, projectNames, opts = {}) {
  const { emptyText = 'タスクはありません。', quickAdd = null, showProject = true } = opts;

  const items = tasks.length
    ? `<ul class="task-list">${tasks.map((t) => taskItem(t, csrfToken, projectNames, { showProject })).join('')}</ul>`
    : `<div class="empty">${escapeHtml(emptyText)}</div>`;

  const form = quickAdd
    ? `<form class="quick-add" method="post" action="/tasks">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        ${quickAdd.projectId ? `<input type="hidden" name="project_id" value="${escapeHtml(quickAdd.projectId)}">` : ''}
        ${quickAdd.status ? `<input type="hidden" name="status" value="${escapeHtml(quickAdd.status)}">` : ''}
        <input type="text" name="title" placeholder="新しいタスクを追加…" required maxlength="255">
        <button type="submit">追加</button>
      </form>`
    : '';

  return `<div class="card">${items}${form}</div>`;
}

module.exports = {
  escapeHtml,
  statusLabel,
  formatDate,
  relativeDate,
  layout,
  loginPage,
  taskList,
  taskItem,
  whoChip,
  STATUS_ORDER,
  STATUS_LABELS,
};
