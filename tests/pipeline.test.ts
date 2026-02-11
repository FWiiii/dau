import { describe, expect, it } from "vitest";

import { SyncPipeline } from "../src/core/pipeline.js";
import type {
  AccountState,
  ListTweetsWithMediaParams,
  ListTweetsWithMediaResult,
  MediaTweet,
  StateRepo,
  TelegramClient,
  TwitterClient,
} from "../src/types.js";

class InMemoryStateRepo implements StateRepo {
  private accountState = new Map<string, AccountState>();
  private uploaded = new Set<string>();
  private lockHolder: string | null = null;

  async init(): Promise<void> {
    return;
  }

  async getAccountState(username: string): Promise<AccountState> {
    return (
      this.accountState.get(username) ?? {
        username,
        latestSeenTweetId: null,
        backfillCursor: null,
        backfillDone: false,
        rateLimitedUntil: null,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async upsertAccountState(
    state: Omit<AccountState, "updatedAt"> & { updatedAt?: string },
  ): Promise<void> {
    this.accountState.set(state.username, {
      ...state,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
    });
  }

  async isMediaUploaded(mediaKey: string): Promise<boolean> {
    return this.uploaded.has(mediaKey);
  }

  async markMediaUploaded(record: {
    mediaKey: string;
  }): Promise<void> {
    this.uploaded.add(record.mediaKey);
  }

  async acquireJobLock(
    _jobName: string,
    holderId: string,
    _ttlSeconds: number,
  ): Promise<boolean> {
    if (this.lockHolder) {
      return false;
    }
    this.lockHolder = holderId;
    return true;
  }

  async releaseJobLock(_jobName: string, holderId: string): Promise<void> {
    if (this.lockHolder === holderId) {
      this.lockHolder = null;
    }
  }

  async close(): Promise<void> {
    return;
  }
}

class FakeTwitter implements TwitterClient {
  constructor(private readonly tweet: MediaTweet) {}

  async listTweetsWithMedia(
    params: ListTweetsWithMediaParams,
  ): Promise<ListTweetsWithMediaResult> {
    if (params.direction === "newer") {
      return { tweets: [this.tweet], nextCursor: undefined };
    }
    return { tweets: [], nextCursor: undefined };
  }

  async healthCheck(_username: string): Promise<void> {
    return;
  }
}

class FakeTelegram implements TelegramClient {
  public reports: string[] = [];
  public uploads = 0;

  async sendTweetMediaGroup(): Promise<{ messageIds: string[] }> {
    this.uploads += 1;
    return { messageIds: ["1"] };
  }

  async sendTextMessage(message: string): Promise<void> {
    this.reports.push(message);
  }

  async healthCheck(): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    return;
  }
}

describe("SyncPipeline", () => {
  it("returns skippedByLock when lock is not acquired", async () => {
    const repo = new InMemoryStateRepo();
    await repo.acquireJobLock("daily-sync", "held", 100);

    const twitter = new FakeTwitter({
      id: "1",
      username: "alice",
      text: "",
      tweetUrl: "https://x.com/alice/status/1",
      postedAt: new Date().toISOString(),
      media: [],
    });
    const telegram = new FakeTelegram();

    const pipeline = new SyncPipeline({
      config: {
        twitterUsers: ["alice"],
        twitterCookies: [],
        telegramApiId: 1,
        telegramApiHash: "hash",
        telegramStringSession: "session",
        timezone: "Asia/Shanghai",
        stateDbPath: ":memory:",
        backfillPagesPerRun: 1,
        maxMediaPerRun: 10,
        downloadTmpDir: "/tmp/work",
        jobLockTtlSeconds: 10,
        twitterRateLimitCooldownSeconds: 7200,
        maxUploadVideoBytes: 10,
      },
      stateRepo: repo,
      twitterClient: twitter,
      telegramClient: telegram,
    });

    const result = await pipeline.run();
    expect(result.skippedByLock).toBe(true);
    expect(result.accounts).toHaveLength(0);
  });
});
