import "dotenv/config";

import { loadConfig, loadSchedulerConfig } from "./config/index.js";
import { logger } from "./logger.js";
import { TelegramSavedMessagesClient } from "./adapters/telegram.js";
import { TwitterScraperClient } from "./adapters/twitter.js";
import { SyncPipeline } from "./core/pipeline.js";
import { SqliteStateRepo } from "./state/sqlite.js";
import type { RunSummary } from "./types.js";

function currentDateParts(timezone: string): {
  dateKey: string;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const map = new Map(parts.map((item) => [item.type, item.value]));

  const year = map.get("year") ?? "0000";
  const month = map.get("month") ?? "01";
  const day = map.get("day") ?? "01";
  const hour = Number(map.get("hour") ?? "0");
  const minute = Number(map.get("minute") ?? "0");

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
  };
}

async function runSyncOnce(trigger: string): Promise<RunSummary> {
  const config = loadConfig();
  const twitterClient = new TwitterScraperClient({
    cookies: config.twitterCookies,
  });
  const telegramClient = new TelegramSavedMessagesClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    stringSession: config.telegramStringSession,
  });
  const stateRepo = new SqliteStateRepo({ dbPath: config.stateDbPath });

  try {
    const pipeline = new SyncPipeline({
      config,
      twitterClient,
      telegramClient,
      stateRepo,
    });

    logger.info({ trigger }, "Starting scheduled sync run");
    const result = await pipeline.run();
    logger.info({ trigger, result }, "Scheduled sync run completed");
    return result;
  } finally {
    await telegramClient.disconnect();
    await stateRepo.close();
  }
}

export async function runSchedulerDaemon(): Promise<void> {
  const scheduler = loadSchedulerConfig();

  logger.info(
    {
      timezone: scheduler.timezone,
      dailyAt: scheduler.dailyAt,
      tickSeconds: scheduler.tickSeconds,
      runOnStart: scheduler.runOnStart,
    },
    "Scheduler daemon started",
  );

  let isRunning = false;
  let lastRunDateKey = "";

  const executeDueRun = async (): Promise<void> => {
    if (isRunning) {
      logger.warn("Skip scheduler tick because previous run is still in progress");
      return;
    }

    const now = currentDateParts(scheduler.timezone);
    const dueToday =
      now.hour > scheduler.dailyAtHour ||
      (now.hour === scheduler.dailyAtHour && now.minute >= scheduler.dailyAtMinute);

    if (!dueToday || lastRunDateKey === now.dateKey) {
      return;
    }

    isRunning = true;
    try {
      const result = await runSyncOnce(`daily-${now.dateKey}`);
      if (!result.skippedByLock) {
        lastRunDateKey = now.dateKey;
      } else {
        logger.warn(
          { dateKey: now.dateKey },
          "Daily run skipped by lock, scheduler will retry on next tick",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Scheduled sync run failed");

      if (message.includes("Response status: 401") || message.includes("code 32")) {
        logger.error(
          "X auth failed in scheduler run. Refresh TWITTER_COOKIES_JSON auth_token + ct0 from the same session.",
        );
      }
    } finally {
      isRunning = false;
    }
  };

  if (scheduler.runOnStart) {
    isRunning = true;
    try {
      const startupResult = await runSyncOnce("startup");
      const now = currentDateParts(scheduler.timezone);
      const dueToday =
        now.hour > scheduler.dailyAtHour ||
        (now.hour === scheduler.dailyAtHour && now.minute >= scheduler.dailyAtMinute);
      if (dueToday && !startupResult.skippedByLock) {
        lastRunDateKey = now.dateKey;
      } else if (startupResult.skippedByLock) {
        logger.warn(
          { dateKey: now.dateKey },
          "Startup run skipped by lock, scheduler will retry on next tick",
        );
      }
    } catch (error) {
      logger.error({ err: error }, "Startup sync run failed");
    } finally {
      isRunning = false;
    }
  }

  setInterval(() => {
    void executeDueRun();
  }, scheduler.tickSeconds * 1000);

  await executeDueRun();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSchedulerDaemon().catch((error) => {
    logger.error({ err: error }, "Scheduler daemon crashed");
    process.exit(1);
  });
}
