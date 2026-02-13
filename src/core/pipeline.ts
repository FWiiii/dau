import path from "node:path";

import type { AppConfig } from "../config/index.js";
import { isTwitterRateLimitError } from "../errors.js";
import { logger } from "../logger.js";
import type {
  AccountRunSummary,
  LocalMediaFile,
  MediaTweet,
  RunSummary,
  StateRepo,
  TelegramClient,
  TwitterClient,
} from "../types.js";
import { ensureDir, removeFileSafe } from "../utils/fs.js";
import { makeMediaKey } from "../utils/hash.js";
import { withRetry } from "../utils/retry.js";
import { downloadMedia } from "./downloader.js";

interface SyncPipelineDeps {
  config: AppConfig;
  twitterClient: TwitterClient;
  telegramClient: TelegramClient;
  stateRepo: StateRepo;
}

interface PipelineTotals {
  uploaded: number;
  skipped: number;
  failed: number;
}

interface ProcessTweetResult {
  uploaded: number;
  skipped: number;
  failed: number;
}

function createAccountSummary(username: string): AccountRunSummary {
  return {
    username,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    incrementalTweetsSelected: 0,
    backfillTweetsSelected: 0,
    incrementalTweetsCandidates: 0,
    backfillTweetsCandidates: 0,
    backfillDone: false,
    cooldownActive: false,
    cooldownUntil: null,
  };
}

function mergeUniqueTweets(tweets: MediaTweet[]): MediaTweet[] {
  const map = new Map<string, MediaTweet>();
  for (const tweet of tweets) {
    map.set(tweet.id, tweet);
  }

  return [...map.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

function formatFailureReport(error: unknown, context: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "❌ X media sync failed",
    `context: ${context}`,
    `error: ${message}`,
    "hint: verify cookies/session and rerun",
  ].join("\n");
}

function formatRunReport(summary: RunSummary): string {
  const lines = [
    "✅ X media sync report",
    `started: ${summary.startedAt}`,
    `finished: ${summary.finishedAt}`,
  ];

  for (const account of summary.accounts) {
    const cooldownSuffix =
      account.cooldownActive && account.cooldownUntil
        ? ` cooldownUntil=${account.cooldownUntil}`
        : "";
    lines.push(
      `@${account.username} uploaded=${account.uploaded} skipped=${account.skipped} failed=${account.failed} incremental=${account.incrementalTweetsSelected}/${account.incrementalTweetsCandidates} backfill=${account.backfillTweetsSelected}/${account.backfillTweetsCandidates} backfillDone=${account.backfillDone}${cooldownSuffix}`,
    );
  }

  return lines.join("\n");
}

export class SyncPipeline {
  constructor(private readonly deps: SyncPipelineDeps) {}

  private computeCooldownUntil(): string {
    return new Date(
      Date.now() + this.deps.config.twitterRateLimitCooldownSeconds * 1000,
    ).toISOString();
  }

  private async collectIncrementalTweets(
    username: string,
    latestSeenTweetId: string | null,
  ): Promise<{ tweets: MediaTweet[]; newestSeenId: string | null }> {
    const response = await this.deps.twitterClient.listTweetsWithMedia({
      username,
      direction: "newer",
      limitPages: this.deps.config.backfillPagesPerRun,
    });

    const tweets: MediaTweet[] = [];
    for (const tweet of response.tweets) {
      if (latestSeenTweetId && tweet.id === latestSeenTweetId) {
        break;
      }
      tweets.push(tweet);
    }

    const newestSeenId = response.tweets[0]?.id ?? latestSeenTweetId;

    return {
      tweets,
      newestSeenId,
    };
  }

  private async collectBackfillTweets(
    username: string,
    backfillCursor: string | null,
  ): Promise<{
    tweets: MediaTweet[];
    nextCursor: string | null;
    backfillDone: boolean;
  }> {
    const response = await this.deps.twitterClient.listTweetsWithMedia({
      username,
      direction: "older",
      cursor: backfillCursor ?? undefined,
      limitPages: this.deps.config.backfillPagesPerRun,
    });

    return {
      tweets: response.tweets,
      nextCursor: response.nextCursor ?? null,
      backfillDone: !response.nextCursor,
    };
  }

  private async processTweet(
    tweet: MediaTweet,
    username: string,
  ): Promise<ProcessTweetResult> {
    const result: ProcessTweetResult = {
      uploaded: 0,
      skipped: 0,
      failed: 0,
    };
    const downloadedFiles: LocalMediaFile[] = [];

    try {
      for (const media of tweet.media) {
        const mediaKey = makeMediaKey(tweet.id, media.url);
        const uploaded = await this.deps.stateRepo.isMediaUploaded(mediaKey);
        if (uploaded) {
          result.skipped += 1;
          continue;
        }

        const downloaded = await withRetry(
          () =>
            downloadMedia({
              mediaKey,
              mediaType: media.type,
              mediaUrl: media.url,
              downloadDir: path.join(this.deps.config.downloadTmpDir, username),
            }),
          {
            retries: 2,
            baseDelayMs: 1000,
            factor: 2,
          },
        );

        if (
          downloaded.mediaType !== "photo" &&
          downloaded.fileSizeBytes > this.deps.config.maxUploadVideoBytes
        ) {
          await this.deps.stateRepo.markMediaUploaded({
            mediaKey,
            tweetId: tweet.id,
            username,
            mediaUrl: media.url,
            mediaType: media.type,
            uploadedAt: new Date().toISOString(),
            telegramMessageIds: [],
            status: "skipped_oversize",
          });
          result.skipped += 1;
          await removeFileSafe(downloaded.path);
          continue;
        }

        downloadedFiles.push(downloaded);
      }

      if (downloadedFiles.length === 0) {
        return result;
      }

      const sendResult = await withRetry(
        () =>
          this.deps.telegramClient.sendTweetMediaGroup({
            tweetUrl: tweet.tweetUrl,
            username,
            postedAt: tweet.postedAt,
            mediaFiles: downloadedFiles,
          }),
        {
          retries: 2,
          baseDelayMs: 1500,
          factor: 2,
        },
      );

      for (const file of downloadedFiles) {
        await this.deps.stateRepo.markMediaUploaded({
          mediaKey: file.mediaKey,
          tweetId: tweet.id,
          username,
          mediaUrl: file.mediaUrl,
          mediaType: file.mediaType,
          uploadedAt: new Date().toISOString(),
          telegramMessageIds: sendResult.messageIds,
          status: "uploaded",
        });
        result.uploaded += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.error({ err: error, tweetId: tweet.id, username }, "Failed processing tweet media");
    } finally {
      await Promise.all(downloadedFiles.map((file) => removeFileSafe(file.path)));
    }

    return result;
  }

  async run(): Promise<RunSummary> {
    const holderId = `sync-${process.pid}-${Date.now()}`;
    const startedAt = new Date().toISOString();

    await this.deps.stateRepo.init();
    await ensureDir(this.deps.config.downloadTmpDir);

    const lockAcquired = await this.deps.stateRepo.acquireJobLock(
      "daily-sync",
      holderId,
      this.deps.config.jobLockTtlSeconds,
    );

    if (!lockAcquired) {
      const finishedAt = new Date().toISOString();
      return {
        startedAt,
        finishedAt,
        skippedByLock: true,
        accounts: [],
      };
    }

    const accountSummaries: AccountRunSummary[] = [];

    try {
      for (const username of this.deps.config.twitterUsers) {
        const summary = createAccountSummary(username);
        const totals: PipelineTotals = {
          uploaded: 0,
          skipped: 0,
          failed: 0,
        };

        const state = await this.deps.stateRepo.getAccountState(username);
        const now = Date.now();
        const rateLimitedUntilTs = state.rateLimitedUntil
          ? new Date(state.rateLimitedUntil).getTime()
          : Number.NaN;

        if (Number.isFinite(rateLimitedUntilTs) && rateLimitedUntilTs > now) {
          summary.cooldownActive = true;
          summary.cooldownUntil = state.rateLimitedUntil;
          summary.backfillDone = state.backfillDone;
          accountSummaries.push(summary);
          logger.warn(
            { username, cooldownUntil: state.rateLimitedUntil },
            "Skipping account because Twitter 429 cooldown is active",
          );
          continue;
        }

        try {
          const incremental = await this.collectIncrementalTweets(
            username,
            state.latestSeenTweetId,
          );
          summary.incrementalTweetsCandidates = incremental.tweets.length;

          const backfill = state.backfillDone
            ? {
                tweets: [] as MediaTweet[],
                nextCursor: null,
                backfillDone: true,
              }
            : await this.collectBackfillTweets(username, state.backfillCursor);
          summary.backfillTweetsCandidates = backfill.tweets.length;
          const merged = mergeUniqueTweets([...incremental.tweets, ...backfill.tweets]);
          const incrementalIds = new Set(incremental.tweets.map((tweet) => tweet.id));
          const incrementalCandidates = merged.filter((tweet) => incrementalIds.has(tweet.id));
          const backfillCandidates = merged.filter((tweet) => !incrementalIds.has(tweet.id));
          const selected: MediaTweet[] = [];
          let mediaBudget = this.deps.config.maxMediaPerRun;

          for (const tweet of [...incrementalCandidates, ...backfillCandidates]) {
            if (mediaBudget <= 0) {
              break;
            }

            const mediaCount = tweet.media.length;
            if (mediaCount > mediaBudget && selected.length > 0) {
              continue;
            }

            selected.push(tweet);
            mediaBudget -= mediaCount;
          }

          summary.incrementalTweetsSelected = selected.filter((tweet) =>
            incrementalIds.has(tweet.id),
          ).length;
          summary.backfillTweetsSelected =
            selected.length - summary.incrementalTweetsSelected;

          for (const tweet of selected) {
            const processed = await this.processTweet(tweet, username);
            totals.uploaded += processed.uploaded;
            totals.skipped += processed.skipped;
            totals.failed += processed.failed;
          }

          summary.uploaded = totals.uploaded;
          summary.skipped = totals.skipped;
          summary.failed = totals.failed;
          summary.backfillDone = backfill.backfillDone;

          await this.deps.stateRepo.upsertAccountState({
            username,
            latestSeenTweetId: incremental.newestSeenId,
            backfillCursor: backfill.nextCursor,
            backfillDone: backfill.backfillDone,
            rateLimitedUntil: null,
          });
        } catch (error) {
          if (isTwitterRateLimitError(error)) {
            const cooldownUntil = this.computeCooldownUntil();
            summary.failed = 1;
            summary.backfillDone = state.backfillDone;
            summary.cooldownActive = true;
            summary.cooldownUntil = cooldownUntil;

            await this.deps.stateRepo.upsertAccountState({
              username,
              latestSeenTweetId: state.latestSeenTweetId,
              backfillCursor: state.backfillCursor,
              backfillDone: state.backfillDone,
              rateLimitedUntil: cooldownUntil,
            });

            logger.warn(
              {
                username,
                cooldownUntil,
                cooldownSeconds: this.deps.config.twitterRateLimitCooldownSeconds,
              },
              "Twitter returned 429, cooldown has been activated",
            );
          } else {
            summary.failed = 1;
            summary.backfillDone = state.backfillDone;

            logger.error(
              { err: error, username },
              "Account sync failed, continue with next account",
            );

            await this.deps.telegramClient.sendTextMessage(
              formatFailureReport(error, `account:${username}`),
            );
          }
        }

        accountSummaries.push(summary);
      }

      const finishedAt = new Date().toISOString();
      const result: RunSummary = {
        startedAt,
        finishedAt,
        skippedByLock: false,
        accounts: accountSummaries,
      };

      await this.deps.telegramClient.sendTextMessage(formatRunReport(result));

      return result;
    } catch (error) {
      await this.deps.telegramClient.sendTextMessage(
        formatFailureReport(error, "pipeline.run"),
      );
      throw error;
    } finally {
      await this.deps.stateRepo.releaseJobLock("daily-sync", holderId);
    }
  }
}
