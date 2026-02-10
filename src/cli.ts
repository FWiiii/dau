import "dotenv/config";

import {
  loadConfig,
  loadTwitterCookies,
  loadTwitterCookiesForCheck,
} from "./config/index.js";
import { logger } from "./logger.js";
import { TelegramSavedMessagesClient } from "./adapters/telegram.js";
import { TwitterScraperClient } from "./adapters/twitter.js";
import { SyncPipeline } from "./core/pipeline.js";
import { SqliteStateRepo } from "./state/sqlite.js";
import { runTelegramAuthFlow } from "./telegram-auth.js";
import { runSchedulerDaemon } from "./scheduler.js";

async function runSync(): Promise<void> {
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

    const result = await pipeline.run();
    logger.info({ result }, "Sync run completed");
  } finally {
    await telegramClient.disconnect();
    await stateRepo.close();
  }
}

async function runHealthCheck(): Promise<void> {
  const config = loadConfig();
  const twitterClient = new TwitterScraperClient({
    cookies: config.twitterCookies,
  });
  const telegramClient = new TelegramSavedMessagesClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    stringSession: config.telegramStringSession,
  });

  try {
    if (config.twitterUsers.length > 0) {
      await twitterClient.healthCheck(config.twitterUsers[0]);
    }
    await telegramClient.healthCheck();
    logger.info("Health check passed");
  } finally {
    await telegramClient.disconnect();
  }
}

async function runCookiesCheck(): Promise<void> {
  const report = loadTwitterCookiesForCheck();
  const twitterClient = new TwitterScraperClient({
    cookies: loadTwitterCookies(),
  });

  let runtimeAuthOk = false;
  let runtimeAuthError = "";
  let runtimeAuthHost = "";
  try {
    const session = await twitterClient.checkSession();
    runtimeAuthOk = session.loggedIn;
    runtimeAuthHost = session.host ?? "";
    if (!runtimeAuthOk) {
      runtimeAuthError = session.reason ?? "graphql_auth_probe=false";
    }
  } catch (error) {
    runtimeAuthOk = false;
    runtimeAuthError = error instanceof Error ? error.message : String(error);
  }

  const lines = [
    "X cookies check",
    `total_entries: ${report.totalEntries}`,
    `valid_entries: ${report.validEntries}`,
    `invalid_entries: ${report.invalidEntries}`,
    `has_auth_token: ${report.hasAuthToken}`,
    `has_ct0: ${report.hasCt0}`,
    `domain_rewrites(x.com->twitter.com): ${report.normalizedDomainRewrites}`,
    `runtime_auth_ok: ${runtimeAuthOk}`,
    `runtime_auth_host: ${runtimeAuthHost || "(none)"}`,
    `runtime_auth_error: ${runtimeAuthError || "(none)"}`,
    `domains: ${report.domains.join(", ") || "(none)"}`,
    `cookie_names: ${report.cookieNames.join(", ") || "(none)"}`,
  ];

  if (report.issues.length > 0) {
    lines.push("issues:");
    for (const issue of report.issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push("issues: none");
  }

  const status =
    report.hasAuthToken &&
    report.hasCt0 &&
    report.invalidEntries === 0 &&
    runtimeAuthOk
      ? "PASS"
      : "FAIL";
  lines.push(`result: ${status}`);

  process.stdout.write(`${lines.join("\n")}\n`);

  if (status === "FAIL") {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    throw new Error("Missing command. Use sync:run | auth:telegram | health:check");
  }

  if (command === "sync:run") {
    await runSync();
    return;
  }

  if (command === "auth:telegram") {
    await runTelegramAuthFlow();
    return;
  }

  if (command === "health:check") {
    await runHealthCheck();
    return;
  }

  if (command === "cookies:check") {
    await runCookiesCheck();
    return;
  }

  if (command === "sync:daemon") {
    await runSchedulerDaemon();
    return;
  }

  throw new Error(
    `Unknown command: ${command}. Use sync:run | sync:daemon | auth:telegram | health:check | cookies:check`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Response status: 401") || message.includes("(401)")) {
    logger.error(
      {
        err: error,
        hint:
          "X auth failed (401). cookies format may be valid but credentials are invalid/expired. Re-export auth_token + ct0 from the same active login session.",
      },
      "Command failed",
    );
    process.exit(1);
  }

  if (message.includes("Response status: 403") || message.includes("(403)")) {
    logger.error(
      {
        err: error,
        hint:
          "X auth failed (403). Refresh TWITTER_COOKIES_JSON, ensure auth_token+ct0 exist, and use twitter.com/.twitter.com domain cookies.",
      },
      "Command failed",
    );
    process.exit(1);
  }

  logger.error({ err: error }, "Command failed");
  process.exit(1);
});
