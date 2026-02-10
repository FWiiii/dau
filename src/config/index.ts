import { z } from "zod";

const syncEnvSchema = z.object({
  TWITTER_USERS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim().replace(/^@/, ""))
        .filter(Boolean),
    ),
  TWITTER_COOKIES_JSON: z.string().min(2),
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(10),
  TELEGRAM_STRING_SESSION: z.string().default(""),
  TZ: z.string().default("Asia/Shanghai"),
  STATE_DB_PATH: z.string().default("/data/state.sqlite"),
  BACKFILL_PAGES_PER_RUN: z.coerce.number().int().positive().default(10),
  MAX_MEDIA_PER_RUN: z.coerce.number().int().positive().default(300),
  DOWNLOAD_TMP_DIR: z.string().default("/tmp/work"),
  JOB_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(3300),
  MAX_UPLOAD_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
});

const telegramAuthSchema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(10),
  TELEGRAM_STRING_SESSION: z.string().default(""),
});

const twitterCookiesSchema = z.object({
  TWITTER_COOKIES_JSON: z.string().min(2),
});

const schedulerEnvSchema = z.object({
  TZ: z.string().default("Asia/Shanghai"),
  SYNC_DAILY_AT: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .default("09:00"),
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().positive().default(30),
  SCHEDULER_RUN_ON_START: z
    .string()
    .optional()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase())),
});

export interface AppConfig {
  twitterUsers: string[];
  twitterCookies: string[];
  telegramApiId: number;
  telegramApiHash: string;
  telegramStringSession: string;
  timezone: string;
  stateDbPath: string;
  backfillPagesPerRun: number;
  maxMediaPerRun: number;
  downloadTmpDir: string;
  jobLockTtlSeconds: number;
  maxUploadVideoBytes: number;
}

export interface TelegramAuthConfig {
  telegramApiId: number;
  telegramApiHash: string;
  telegramStringSession: string;
}

export interface TwitterCookiesCheckReport {
  totalEntries: number;
  validEntries: number;
  invalidEntries: number;
  cookieNames: string[];
  domains: string[];
  hasAuthToken: boolean;
  hasCt0: boolean;
  normalizedDomainRewrites: number;
  issues: string[];
}

export interface SchedulerConfig {
  timezone: string;
  dailyAt: string;
  dailyAtHour: number;
  dailyAtMinute: number;
  tickSeconds: number;
  runOnStart: boolean;
}

function normalizeCookieDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed === "x.com" || trimmed === ".x.com") {
    return ".twitter.com";
  }

  return domain;
}

function normalizeCookieString(cookie: string): string {
  return cookie.replace(
    /Domain\s*=\s*\.?x\.com/gi,
    "Domain=.twitter.com",
  );
}

function extractCookieName(cookie: string): string | null {
  const [first] = cookie.split(";");
  if (!first || !first.includes("=")) {
    return null;
  }

  return first.split("=")[0]?.trim() ?? null;
}

function extractCookieDomain(cookie: string): string | null {
  const matched = cookie.match(/\bDomain\s*=\s*([^;]+)/i);
  return matched?.[1]?.trim() ?? null;
}

function getCookieNameFromObject(cookie: Record<string, unknown>): string | null {
  const name = cookie.key ?? cookie.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function parseCookies(raw: string): string[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("TWITTER_COOKIES_JSON must be a JSON array");
  }

  const normalizedCookies = parsed.map((cookie) => {
    if (typeof cookie === "string") {
      return normalizeCookieString(cookie);
    }

    if (cookie && typeof cookie === "object") {
      const name =
        (cookie as Record<string, unknown>).key ??
        (cookie as Record<string, unknown>).name;
      const value = (cookie as Record<string, unknown>).value;
      const domainRaw = (cookie as Record<string, unknown>).domain;
      const path = (cookie as Record<string, unknown>).path ?? "/";

      if (
        typeof name === "string" &&
        typeof value === "string" &&
        typeof domainRaw === "string"
      ) {
        const domain = normalizeCookieDomain(domainRaw);
        return `${name}=${value}; Domain=${domain}; Path=${path};`;
      }
    }

    throw new Error("Invalid cookie entry in TWITTER_COOKIES_JSON");
  });

  const cookieNames = new Set(
    normalizedCookies
      .map((cookie) => extractCookieName(cookie))
      .filter((item): item is string => Boolean(item)),
  );

  if (!cookieNames.has("auth_token") || !cookieNames.has("ct0")) {
    throw new Error(
      "TWITTER_COOKIES_JSON must include auth_token and ct0 cookies",
    );
  }

  return normalizedCookies;
}

export function inspectTwitterCookies(
  raw: string,
): TwitterCookiesCheckReport {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("TWITTER_COOKIES_JSON must be a JSON array");
  }

  const cookieNames = new Set<string>();
  const domains = new Set<string>();
  const issues: string[] = [];
  let validEntries = 0;
  let normalizedDomainRewrites = 0;

  for (const [index, entry] of parsed.entries()) {
    if (typeof entry === "string") {
      const normalized = normalizeCookieString(entry);
      if (normalized !== entry) {
        normalizedDomainRewrites += 1;
      }

      const name = extractCookieName(normalized);
      const domain = extractCookieDomain(normalized);
      if (!name) {
        issues.push(`entry[${index}] string cookie missing name`);
        continue;
      }

      cookieNames.add(name);
      if (domain) {
        domains.add(domain);
      }
      validEntries += 1;
      continue;
    }

    if (entry && typeof entry === "object") {
      const objectEntry = entry as Record<string, unknown>;
      const name = getCookieNameFromObject(objectEntry);
      const domainRaw = objectEntry.domain;

      if (!name) {
        issues.push(`entry[${index}] object cookie missing name/key`);
        continue;
      }

      if (typeof domainRaw !== "string" || domainRaw.length === 0) {
        issues.push(`entry[${index}] object cookie missing domain`);
        continue;
      }

      const normalizedDomain = normalizeCookieDomain(domainRaw);
      if (normalizedDomain !== domainRaw) {
        normalizedDomainRewrites += 1;
      }

      cookieNames.add(name);
      domains.add(normalizedDomain);
      validEntries += 1;
      continue;
    }

    issues.push(`entry[${index}] has unsupported format`);
  }

  const hasAuthToken = cookieNames.has("auth_token");
  const hasCt0 = cookieNames.has("ct0");
  if (!hasAuthToken) {
    issues.push("required cookie missing: auth_token");
  }
  if (!hasCt0) {
    issues.push("required cookie missing: ct0");
  }

  return {
    totalEntries: parsed.length,
    validEntries,
    invalidEntries: parsed.length - validEntries,
    cookieNames: [...cookieNames].sort(),
    domains: [...domains].sort(),
    hasAuthToken,
    hasCt0,
    normalizedDomainRewrites,
    issues,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = syncEnvSchema.parse(environment);

  return {
    twitterUsers: parsed.TWITTER_USERS,
    twitterCookies: parseCookies(parsed.TWITTER_COOKIES_JSON),
    telegramApiId: parsed.TELEGRAM_API_ID,
    telegramApiHash: parsed.TELEGRAM_API_HASH,
    telegramStringSession: parsed.TELEGRAM_STRING_SESSION,
    timezone: parsed.TZ,
    stateDbPath: parsed.STATE_DB_PATH,
    backfillPagesPerRun: parsed.BACKFILL_PAGES_PER_RUN,
    maxMediaPerRun: parsed.MAX_MEDIA_PER_RUN,
    downloadTmpDir: parsed.DOWNLOAD_TMP_DIR,
    jobLockTtlSeconds: parsed.JOB_LOCK_TTL_SECONDS,
    maxUploadVideoBytes: parsed.MAX_UPLOAD_VIDEO_BYTES,
  };
}

export function loadTelegramAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramAuthConfig {
  const parsed = telegramAuthSchema.parse(environment);

  return {
    telegramApiId: parsed.TELEGRAM_API_ID,
    telegramApiHash: parsed.TELEGRAM_API_HASH,
    telegramStringSession: parsed.TELEGRAM_STRING_SESSION,
  };
}

export function loadTwitterCookiesForCheck(
  environment: NodeJS.ProcessEnv = process.env,
): TwitterCookiesCheckReport {
  const parsed = twitterCookiesSchema.parse(environment);
  return inspectTwitterCookies(parsed.TWITTER_COOKIES_JSON);
}

export function loadTwitterCookies(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const parsed = twitterCookiesSchema.parse(environment);
  return parseCookies(parsed.TWITTER_COOKIES_JSON);
}

export function loadSchedulerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const parsed = schedulerEnvSchema.parse(environment);
  const [hourRaw, minuteRaw] = parsed.SYNC_DAILY_AT.split(":");
  const dailyAtHour = Number(hourRaw);
  const dailyAtMinute = Number(minuteRaw);

  return {
    timezone: parsed.TZ,
    dailyAt: parsed.SYNC_DAILY_AT,
    dailyAtHour,
    dailyAtMinute,
    tickSeconds: parsed.SCHEDULER_TICK_SECONDS,
    runOnStart: parsed.SCHEDULER_RUN_ON_START,
  };
}
