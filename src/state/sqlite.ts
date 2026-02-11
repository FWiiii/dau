import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AccountState, StateRepo, StoredMediaRecord } from "../types.js";

interface SqliteStateRepoOptions {
  dbPath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteStateRepo implements StateRepo {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStateRepoOptions) {
    const dbDirectory = path.dirname(options.dbPath);
    mkdirSync(dbDirectory, { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_state (
        username TEXT PRIMARY KEY,
        latest_seen_tweet_id TEXT,
        backfill_cursor TEXT,
        backfill_done INTEGER NOT NULL DEFAULT 0,
        rate_limited_until TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_registry (
        media_key TEXT PRIMARY KEY,
        tweet_id TEXT NOT NULL,
        username TEXT NOT NULL,
        media_url TEXT NOT NULL,
        media_type TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        telegram_message_ids TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_lock (
        job_name TEXT PRIMARY KEY,
        locked_until TEXT NOT NULL,
        holder_id TEXT NOT NULL
      );
    `);

    const accountStateColumns = this.db
      .prepare(
        "PRAGMA table_info(account_state)",
      )
      .all() as Array<{ name: string }>;

    const hasRateLimitedUntil = accountStateColumns.some(
      (column) => column.name === "rate_limited_until",
    );
    if (!hasRateLimitedUntil) {
      this.db.exec(
        "ALTER TABLE account_state ADD COLUMN rate_limited_until TEXT;",
      );
    }
  }

  async getAccountState(username: string): Promise<AccountState> {
    const row = this.db
      .prepare(
        `
        SELECT
          username,
          latest_seen_tweet_id,
          backfill_cursor,
          backfill_done,
          rate_limited_until,
          updated_at
        FROM account_state
        WHERE username = ?
      `,
      )
      .get(username) as
      | {
          username: string;
          latest_seen_tweet_id: string | null;
          backfill_cursor: string | null;
          backfill_done: number;
          rate_limited_until: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return {
        username,
        latestSeenTweetId: null,
        backfillCursor: null,
        backfillDone: false,
        rateLimitedUntil: null,
        updatedAt: nowIso(),
      };
    }

    return {
      username: row.username,
      latestSeenTweetId: row.latest_seen_tweet_id,
      backfillCursor: row.backfill_cursor,
      backfillDone: row.backfill_done === 1,
      rateLimitedUntil: row.rate_limited_until,
      updatedAt: row.updated_at,
    };
  }

  async upsertAccountState(
    state: Omit<AccountState, "updatedAt"> & { updatedAt?: string },
  ): Promise<void> {
    const updatedAt = state.updatedAt ?? nowIso();
    this.db
      .prepare(
        `
        INSERT INTO account_state (
          username,
          latest_seen_tweet_id,
          backfill_cursor,
          backfill_done,
          rate_limited_until,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          latest_seen_tweet_id = excluded.latest_seen_tweet_id,
          backfill_cursor = excluded.backfill_cursor,
          backfill_done = excluded.backfill_done,
          rate_limited_until = excluded.rate_limited_until,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        state.username,
        state.latestSeenTweetId,
        state.backfillCursor,
        state.backfillDone ? 1 : 0,
        state.rateLimitedUntil,
        updatedAt,
      );
  }

  async isMediaUploaded(mediaKey: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS found FROM media_registry WHERE media_key = ?")
      .get(mediaKey) as { found: number } | undefined;

    return Boolean(row?.found);
  }

  async markMediaUploaded(record: StoredMediaRecord): Promise<void> {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO media_registry (
          media_key,
          tweet_id,
          username,
          media_url,
          media_type,
          uploaded_at,
          telegram_message_ids,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.mediaKey,
        record.tweetId,
        record.username,
        record.mediaUrl,
        record.mediaType,
        record.uploadedAt,
        JSON.stringify(record.telegramMessageIds),
        record.status,
      );
  }

  async acquireJobLock(
    jobName: string,
    holderId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const now = Date.now();
    const lockUntil = new Date(now + ttlSeconds * 1000).toISOString();

    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;

      const current = this.db
        .prepare(
          "SELECT holder_id, locked_until FROM job_lock WHERE job_name = ?",
        )
        .get(jobName) as
        | { holder_id: string; locked_until: string }
        | undefined;

      if (current && new Date(current.locked_until).getTime() > now) {
        this.db.exec("COMMIT;");
        return false;
      }

      this.db
        .prepare(
          `
          INSERT INTO job_lock (job_name, locked_until, holder_id)
          VALUES (?, ?, ?)
          ON CONFLICT(job_name) DO UPDATE SET
            locked_until = excluded.locked_until,
            holder_id = excluded.holder_id
        `,
        )
        .run(jobName, lockUntil, holderId);

      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      if (transactionStarted) {
        this.db.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  async releaseJobLock(jobName: string, holderId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM job_lock WHERE job_name = ? AND holder_id = ?")
      .run(jobName, holderId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
