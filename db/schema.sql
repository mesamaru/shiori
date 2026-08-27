-- =========================================
-- 栞 (Shiori) プロジェクト DBスキーマ
-- 全テーブル IF NOT EXISTS 形式（Bot起動時に自動実行される想定）
-- =========================================

-- Web管理画面のアカウント。
-- メール＋パスワードでログインし、任意でDiscordアカウントを紐付けられる。
-- discord_user_id は tasks.assignee_id と同じDiscordユーザーIDが入るため、
-- これを介して「どのタスクを誰が担当しているか」を人間が読める形で表示できる。
CREATE TABLE IF NOT EXISTS users (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email            VARCHAR(255) NOT NULL UNIQUE,
    password_hash    VARCHAR(255),
    display_name     VARCHAR(100) NOT NULL,
    role             ENUM('admin','member') NOT NULL DEFAULT 'member',
    discord_user_id  VARCHAR(32) UNIQUE,
    discord_username VARCHAR(100),
    discord_avatar   VARCHAR(64),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at    DATETIME,
    INDEX idx_discord (discord_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS watched_channels (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    channel_id      VARCHAR(32) NOT NULL UNIQUE,
    channel_name    VARCHAR(100),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projects (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    message_id      VARCHAR(32) NOT NULL UNIQUE,
    channel_id      VARCHAR(32) NOT NULL,
    author_id       VARCHAR(32) NOT NULL,
    author_name     VARCHAR(100),
    content         TEXT NOT NULL,
    is_rule_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    is_ai_processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      DATETIME NOT NULL,
    edited_at       DATETIME,
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
    inserted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_channel_created (channel_id, created_at),
    INDEX idx_flagged_unprocessed (is_rule_flagged, is_ai_processed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
    id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id           BIGINT UNSIGNED,
    title                VARCHAR(255) NOT NULL,
    status               ENUM('todo','in_progress','blocked','done') NOT NULL DEFAULT 'todo',
    assignee_id          VARCHAR(32),
    assignee_unconfirmed BOOLEAN NOT NULL DEFAULT FALSE,
    source_message_id    BIGINT UNSIGNED,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (source_message_id) REFERENCES messages(id),
    INDEX idx_project_status (project_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 既存テーブルへのカラム追加。CREATE TABLEと同様、毎回の起動時に実行されても
-- エラーにならないよう IF NOT EXISTS を付けている（MariaDB独自拡張）。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes MEDIUMTEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes_format ENUM('plain','markdown') NOT NULL DEFAULT 'plain';

CREATE TABLE IF NOT EXISTS task_history (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id            BIGINT UNSIGNED NOT NULL,
    change_type        ENUM('created','status_changed','note_added') NOT NULL,
    old_status         VARCHAR(20),
    new_status         VARCHAR(20),
    change_summary     TEXT,
    source_message_id  BIGINT UNSIGNED,
    changed_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (source_message_id) REFERENCES messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id      BIGINT UNSIGNED,
    notify_type  ENUM('channel','dm') NOT NULL,
    target_id    VARCHAR(32) NOT NULL,
    content      TEXT NOT NULL,
    sent_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pending_clarifications (
    id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    related_task_id          BIGINT UNSIGNED,
    clarification_type       ENUM('assignee','project_match','task_match','status') NOT NULL,
    question                 TEXT NOT NULL,
    source_message_id        BIGINT UNSIGNED,
    bot_question_message_id  VARCHAR(32),
    channel_id               VARCHAR(32) NOT NULL,
    status                   ENUM('open','resolved') NOT NULL DEFAULT 'open',
    resolved_answer          TEXT,
    resolved_by_message_id   VARCHAR(32),
    created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at              DATETIME,
    FOREIGN KEY (related_task_id) REFERENCES tasks(id),
    FOREIGN KEY (source_message_id) REFERENCES messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
