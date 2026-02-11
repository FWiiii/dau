import { logger } from "../logger.js";
import { TwitterRateLimitError } from "../errors.js";
import type {
  ListTweetsWithMediaParams,
  ListTweetsWithMediaResult,
  MediaTweet,
  TweetMedia,
  TwitterClient,
} from "../types.js";

interface TwitterAdapterOptions {
  cookies: string[];
}

interface TwitterApiErrorItem {
  message?: string;
  code?: number;
}

interface TwitterApiErrorResponse {
  errors?: TwitterApiErrorItem[];
  error?: string;
}

interface UserByScreenNameResponse {
  data?: {
    user?: {
      result?: {
        rest_id?: string;
      };
    };
  };
  errors?: TwitterApiErrorItem[];
}

interface TimelineEntry {
  entryId?: string;
  content?: {
    cursorType?: string;
    value?: string;
    itemContent?: unknown;
    items?: Array<{
      item?: {
        itemContent?: unknown;
      };
    }>;
  };
}

interface TimelineInstruction {
  entries?: TimelineEntry[];
}

interface UserTweetsTimelineResponse {
  data?: {
    user?: {
      result?: {
        timeline_v2?: {
          timeline?: {
            instructions?: TimelineInstruction[];
          };
        };
      };
    };
  };
  errors?: TwitterApiErrorItem[];
}

interface TweetResultRaw {
  __typename?: string;
  tweet?: TweetResultRaw;
  rest_id?: string;
  legacy?: {
    id_str?: string;
    full_text?: string;
    created_at?: string;
    entities?: {
      media?: Array<{
        id_str?: string;
        media_url_https?: string;
        type?: string;
        ext_alt_text?: string;
        video_info?: {
          variants?: Array<{
            bitrate?: number;
            url?: string;
            content_type?: string;
          }>;
        };
      }>;
    };
  };
  core?: {
    user_results?: {
      result?: {
        legacy?: {
          screen_name?: string;
        };
      };
    };
  };
}

interface ParsedTimeline {
  tweets: MediaTweet[];
  nextCursor?: string;
}

interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
}

interface GraphqlAuthCandidate {
  authToken: string;
  ct0: string;
  guestToken?: string;
}

interface GraphqlAuthBundle {
  cookieHeaderBase: string;
  authCandidates: GraphqlAuthCandidate[];
}

interface GraphqlOperationResult<T> {
  payload: T;
  host: TwitterHost;
}

type TwitterHost = "twitter.com" | "x.com";

class TwitterGraphqlRequestError extends Error {
  readonly host: TwitterHost;
  readonly status: number;
  readonly apiErrorCode?: number;

  constructor(params: {
    host: TwitterHost;
    status: number;
    message: string;
    apiErrorCode?: number;
  }) {
    super(params.message);
    this.name = "TwitterGraphqlRequestError";
    this.host = params.host;
    this.status = params.status;
    this.apiErrorCode = params.apiErrorCode;
  }
}

const graphqlHosts: TwitterHost[] = ["twitter.com", "x.com"];

const defaultWebBearerToken =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const bearerTokenCandidates = Array.from(
  new Set(
    [
      process.env.TWITTER_WEB_BEARER_TOKEN,
      defaultWebBearerToken,
      "AAAAAAAAAAAAAAAAAAAAAFQODgEAAAAAVHTp76lzh3rFzcHbmHVvQxYYpTw%3DckAlMINMjmCwxUcaXbAN4XqJVdgMJaHqNOFgPMK0zN1qLqLQCF",
    ].filter((value): value is string => Boolean(value && value.trim())),
  ),
);

const userByScreenNameQueryId = "G3KGOASz96M-Qu0nwmGXNg";
const userTweetsQueryId = "HuTx74BxAnezK1gWvYY7zg";

const userByScreenNameFeatures = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const userTweetsFeatures = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_text_conversations_enabled: false,
  vibe_api_enabled: false,
  blue_business_profile_image_shape_enabled: false,
  interactive_text_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const userTweetsFieldToggles = {
  withArticlePlainText: false,
};

function parseCookieFirstPair(cookie: string): { name: string; value: string } | null {
  const first = cookie.split(";")[0]?.trim();
  if (!first) {
    return null;
  }

  const index = first.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const name = first.slice(0, index).trim();
  const value = first.slice(index + 1).trim();
  if (!name || !value) {
    return null;
  }

  return { name, value };
}

function parseCookieRecord(cookie: string): CookieRecord | null {
  const segments = cookie
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const first = segments[0];
  const index = first.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const name = first.slice(0, index).trim();
  const value = first.slice(index + 1).trim();
  if (!name || !value) {
    return null;
  }

  let domain: string | undefined;
  for (const segment of segments.slice(1)) {
    const divider = segment.indexOf("=");
    if (divider <= 0) {
      continue;
    }

    const key = segment.slice(0, divider).trim().toLowerCase();
    const val = segment.slice(divider + 1).trim();
    if (key === "domain" && val) {
      domain = val;
    }
  }

  return {
    name,
    value,
    domain,
  };
}

function parseSessionCookies(cookies: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const cookie of cookies) {
    const parsed = parseCookieFirstPair(cookie);
    if (!parsed) {
      continue;
    }

    map[parsed.name] = parsed.value;
  }

  return map;
}

function normalizeGuestToken(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  return raw.replace(/^v1%3A/i, "").replace(/^v1:/i, "");
}

function buildGraphqlAuthBundle(cookies: string[]): GraphqlAuthBundle {
  const records = cookies
    .map((cookie) => parseCookieRecord(cookie))
    .filter((record): record is CookieRecord => Boolean(record));

  const cookieMap = parseSessionCookies(cookies);
  const guestToken = normalizeGuestToken(cookieMap.gt ?? cookieMap.guest_id);

  const authByDomain = new Map<string, string[]>();
  const ct0ByDomain = new Map<string, string[]>();

  for (const record of records) {
    const domainKey = (record.domain ?? "").replace(/^\./, "").toLowerCase() || "*";

    if (record.name === "auth_token") {
      const list = authByDomain.get(domainKey) ?? [];
      list.push(record.value);
      authByDomain.set(domainKey, list);
    }

    if (record.name === "ct0") {
      const list = ct0ByDomain.get(domainKey) ?? [];
      list.push(record.value);
      ct0ByDomain.set(domainKey, list);
    }
  }

  const candidateDomains = new Set<string>([
    ...Array.from(authByDomain.keys()),
    ...Array.from(ct0ByDomain.keys()),
    "*",
  ]);

  const allAuthTokens = Array.from(
    new Set(
      [...Array.from(authByDomain.values()).flat(), cookieMap.auth_token].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  const allCt0Tokens = Array.from(
    new Set(
      [...Array.from(ct0ByDomain.values()).flat(), cookieMap.ct0].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );

  const authCandidates: GraphqlAuthCandidate[] = [];

  for (const domain of candidateDomains) {
    const auths = authByDomain.get(domain) ?? authByDomain.get("*") ?? [];
    const ct0s = ct0ByDomain.get(domain) ?? ct0ByDomain.get("*") ?? [];

    for (const authToken of auths) {
      for (const ct0 of ct0s) {
        if (!authToken || !ct0) {
          continue;
        }

        authCandidates.push({ authToken, ct0, guestToken });
      }
    }
  }

  for (const authToken of allAuthTokens) {
    for (const ct0 of allCt0Tokens) {
      authCandidates.push({ authToken, ct0, guestToken });
    }
  }

  if (authCandidates.length === 0) {
    const authToken = cookieMap.auth_token;
    const ct0 = cookieMap.ct0;
    if (!authToken || !ct0) {
      throw new Error("graphql requires login cookies: auth_token and ct0.");
    }

    authCandidates.push({ authToken, ct0, guestToken });
  }

  const uniqueCandidates = Array.from(
    new Map(
      authCandidates.map((candidate) => [
        `${candidate.authToken}|${candidate.ct0}`,
        candidate,
      ]),
    ).values(),
  );

  const cookieHeaderBase = Object.entries(cookieMap)
    .filter(
      ([name, value]) =>
        Boolean(name) &&
        Boolean(value) &&
        name !== "auth_token" &&
        name !== "ct0",
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  return {
    cookieHeaderBase,
    authCandidates: uniqueCandidates,
  };
}

function normalizeMedia(raw: TweetResultRaw, usernameHint: string): MediaTweet | null {
  const legacy = raw.legacy;
  if (!legacy) {
    return null;
  }

  const tweetId = legacy.id_str ?? raw.rest_id;
  if (!tweetId) {
    return null;
  }

  const username =
    raw.core?.user_results?.result?.legacy?.screen_name ?? usernameHint;

  const mediaEntries = legacy.entities?.media ?? [];
  const media: TweetMedia[] = [];

  for (const item of mediaEntries) {
    if (!item.id_str || !item.type) {
      continue;
    }

    if (item.type === "photo" && item.media_url_https) {
      media.push({
        id: item.id_str,
        type: "photo",
        url: item.media_url_https,
      });
      continue;
    }

    if ((item.type === "video" || item.type === "animated_gif") && item.video_info?.variants) {
      let bestUrl: string | undefined;
      let bestBitrate = -1;

      for (const variant of item.video_info.variants) {
        if (!variant.url) {
          continue;
        }

        if (variant.content_type && !variant.content_type.includes("mp4")) {
          continue;
        }

        const bitrate = variant.bitrate ?? 0;
        if (bitrate >= bestBitrate) {
          bestBitrate = bitrate;
          bestUrl = variant.url;
        }
      }

      if (bestUrl) {
        media.push({
          id: item.id_str,
          type: item.type === "animated_gif" ? "gif" : "video",
          url: bestUrl,
        });
      }
    }
  }

  if (media.length === 0) {
    return null;
  }

  const postedAt = legacy.created_at
    ? new Date(legacy.created_at).toISOString()
    : new Date().toISOString();

  return {
    id: tweetId,
    username,
    text: legacy.full_text ?? "",
    tweetUrl: `https://x.com/${username}/status/${tweetId}`,
    postedAt,
    media,
  };
}

function getTweetResultFromContent(content: unknown): TweetResultRaw | null {
  if (!content || typeof content !== "object") {
    return null;
  }

  const raw = content as {
    tweet_results?: { result?: TweetResultRaw };
    tweetResult?: { result?: TweetResultRaw };
  };

  let result = raw.tweet_results?.result ?? raw.tweetResult?.result;
  if (!result) {
    return null;
  }

  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    result = result.tweet;
  }

  if (result.__typename !== "Tweet" && result.__typename !== "TweetWithVisibilityResults") {
    return null;
  }

  return result;
}

function extractBottomCursor(entry: TimelineEntry): string | undefined {
  const content = entry.content;
  if (!content) {
    return undefined;
  }

  if (content.cursorType === "Bottom" && content.value) {
    return content.value;
  }

  const itemContent =
    content.itemContent && typeof content.itemContent === "object"
      ? (content.itemContent as { cursorType?: unknown; value?: unknown })
      : undefined;

  if (
    itemContent?.cursorType === "Bottom" &&
    typeof itemContent.value === "string" &&
    itemContent.value
  ) {
    return itemContent.value;
  }

  if (entry.entryId?.startsWith("cursor-bottom-")) {
    if (content.value) {
      return content.value;
    }
    if (typeof itemContent?.value === "string" && itemContent.value) {
      return itemContent.value;
    }
  }

  return undefined;
}

function parseTimeline(response: UserTweetsTimelineResponse, username: string): ParsedTimeline {
  const instructions =
    response.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];

  const tweets: MediaTweet[] = [];
  let nextCursor: string | undefined;

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const content = entry.content;
      if (!content) {
        continue;
      }

      const cursor = extractBottomCursor(entry);
      if (cursor) {
        nextCursor = cursor;
      }

      const candidates: unknown[] = [];
      if (content.itemContent) {
        candidates.push(content.itemContent);
      }
      for (const item of content.items ?? []) {
        if (item.item?.itemContent) {
          candidates.push(item.item.itemContent);
        }
      }

      for (const candidate of candidates) {
        const result = getTweetResultFromContent(candidate);
        if (!result) {
          continue;
        }

        const normalized = normalizeMedia(result, username);
        if (normalized) {
          tweets.push(normalized);
        }
      }
    }
  }

  return { tweets, nextCursor };
}

function extractApiError(payload: unknown): {
  message: string | null;
  code?: number;
} {
  if (!payload || typeof payload !== "object") {
    return {
      message: null,
    };
  }

  const { errors, error } = payload as TwitterApiErrorResponse;
  if (!errors || errors.length === 0) {
    return {
      message: error ?? null,
    };
  }

  const first = errors[0];
  const codePart = typeof first.code === "number" ? ` (code ${first.code})` : "";
  return {
    message: `${first.message ?? "Unknown API error"}${codePart}`,
    code: first.code,
  };
}

function isRateLimitError(
  error: unknown,
  messageOverride?: string,
): boolean {
  if (error instanceof TwitterGraphqlRequestError) {
    if (error.status === 429 || error.apiErrorCode === 88) {
      return true;
    }
  }

  const message =
    messageOverride ?? (error instanceof Error ? error.message : String(error));
  return /\(429\)|rate limit/i.test(message);
}

function buildGraphqlUrl(
  host: TwitterHost,
  queryId: string,
  operationName: string,
  variables: Record<string, unknown>,
  features: Record<string, unknown>,
  fieldToggles?: Record<string, unknown>,
): string {
  const params = new URLSearchParams();
  params.set("variables", JSON.stringify(variables));
  params.set("features", JSON.stringify(features));
  if (fieldToggles) {
    params.set("fieldToggles", JSON.stringify(fieldToggles));
  }

  return `https://${host}/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;
}

export class TwitterScraperClient implements TwitterClient {
  private preferredHost: TwitterHost | null = null;
  private readonly authBundle: GraphqlAuthBundle;
  private authCandidateIndex = 0;
  private bearerTokenIndex = 0;

  constructor(options: TwitterAdapterOptions) {
    this.authBundle = buildGraphqlAuthBundle(options.cookies);
  }

  private getHostOrder(): TwitterHost[] {
    if (!this.preferredHost) {
      return graphqlHosts;
    }

    return [
      this.preferredHost,
      ...graphqlHosts.filter((host) => host !== this.preferredHost),
    ];
  }

  private currentAuthCandidate(): GraphqlAuthCandidate {
    return (
      this.authBundle.authCandidates[this.authCandidateIndex] ??
      this.authBundle.authCandidates[0]
    );
  }

  private rotateAuthCandidate(): boolean {
    if (this.authCandidateIndex + 1 >= this.authBundle.authCandidates.length) {
      return false;
    }

    this.authCandidateIndex += 1;
    return true;
  }

  private currentBearerToken(): string {
    return (
      bearerTokenCandidates[this.bearerTokenIndex] ??
      bearerTokenCandidates[0] ??
      defaultWebBearerToken
    );
  }

  private rotateBearerToken(): boolean {
    if (this.bearerTokenIndex + 1 >= bearerTokenCandidates.length) {
      return false;
    }

    this.bearerTokenIndex += 1;
    return true;
  }

  private createHeaders(host: TwitterHost): Headers {
    const hostBase = `https://${host}`;

    const auth = this.currentAuthCandidate();
    const cookieParts = [`auth_token=${auth.authToken}`, `ct0=${auth.ct0}`];
    if (this.authBundle.cookieHeaderBase) {
      cookieParts.push(this.authBundle.cookieHeaderBase);
    }

    const cookieHeader = cookieParts.join("; ");
    if (!cookieHeader || !auth.ct0) {
      throw new Error(
        "Missing cookie header or ct0 token. TWITTER_COOKIES_JSON must include valid auth_token and ct0.",
      );
    }

    const headers = new Headers();
    headers.set("authorization", `Bearer ${this.currentBearerToken()}`);
    headers.set("x-twitter-active-user", "yes");
    headers.set("x-twitter-auth-type", "OAuth2Session");
    headers.set("x-twitter-client-language", "en");
    headers.set("x-csrf-token", auth.ct0);
    headers.set("cookie", cookieHeader);
    headers.set("accept", "application/json, text/plain, */*");
    headers.set("accept-language", "en-US,en;q=0.9");
    headers.set("origin", hostBase);
    headers.set("referer", `${hostBase}/`);
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    );

    if (auth.guestToken) {
      headers.set("x-guest-token", auth.guestToken);
    }

    return headers;
  }

  private async fetchGraphql<T>(
    host: TwitterHost,
    url: string,
  ): Promise<{ payload: T; status: number }> {
    const headers = this.createHeaders(host);
    const response = await fetch(url, {
      method: "GET",
      headers,
      credentials: "include",
    });

    const text = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const apiError = extractApiError(payload);
      const payloadSnippet =
        typeof payload === "string"
          ? payload.slice(0, 200).replace(/\s+/g, " ").trim()
          : "";
      const detail =
        apiError.message ??
        payloadSnippet ??
        `HTTP ${response.status} without JSON error body`;
      throw new TwitterGraphqlRequestError({
        host,
        status: response.status,
        apiErrorCode: apiError.code,
        message: `Twitter GraphQL request failed on ${host} (${response.status}): ${detail}`,
      });
    }

    const apiError = extractApiError(payload);
    if (apiError.message) {
      throw new TwitterGraphqlRequestError({
        host,
        status: response.status,
        apiErrorCode: apiError.code,
        message: `Twitter GraphQL API error on ${host}: ${apiError.message}`,
      });
    }

    return {
      payload: payload as T,
      status: response.status,
    };
  }

  private async executeGraphqlWithFallback<T>(
    buildUrl: (host: TwitterHost) => string,
  ): Promise<GraphqlOperationResult<T>> {
    const errors: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hostOrder = this.getHostOrder();
      let sawAuthFailure = false;
      const rateLimitedHosts = new Set<TwitterHost>();

      for (const host of hostOrder) {
        try {
          const result = await this.fetchGraphql<T>(host, buildUrl(host));
          this.preferredHost = host;
          return {
            payload: result.payload,
            host,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          if (message.includes("(401)") || message.includes("code 32")) {
            sawAuthFailure = true;
          }
          if (isRateLimitError(error, message)) {
            rateLimitedHosts.add(host);
          }
        }
      }

      if (rateLimitedHosts.size === hostOrder.length) {
        throw new TwitterRateLimitError(
          `Twitter GraphQL failed on all hosts: ${errors.join(" | ")}`,
          [...rateLimitedHosts.values()],
        );
      }

      if (sawAuthFailure && this.rotateAuthCandidate()) {
        errors.push("auth cookie pair rotate succeeded, retrying request once.");
        continue;
      }

      if (sawAuthFailure && this.rotateBearerToken()) {
        errors.push("bearer rotate succeeded, retrying request once.");
        continue;
      }

      break;
    }

    throw new Error(`Twitter GraphQL failed on all hosts: ${errors.join(" | ")}`);
  }

  private async getUserIdByScreenName(username: string): Promise<string> {
    const { payload, host } = await this.executeGraphqlWithFallback<UserByScreenNameResponse>(
      (candidateHost) =>
        buildGraphqlUrl(
          candidateHost,
          userByScreenNameQueryId,
          "UserByScreenName",
          {
            screen_name: username,
            withSafetyModeUserFields: true,
          },
          userByScreenNameFeatures,
          { withAuxiliaryUserLabels: false },
        ),
    );

    const userId = payload.data?.user?.result?.rest_id;
    if (!userId) {
      throw new Error(`Failed to resolve user id for @${username} on ${host}`);
    }

    return userId;
  }

  async checkSession(): Promise<{ loggedIn: boolean; reason?: string; host?: string }> {
    try {
      const result = await this.executeGraphqlWithFallback<UserByScreenNameResponse>((host) =>
        buildGraphqlUrl(
          host,
          userByScreenNameQueryId,
          "UserByScreenName",
          {
            screen_name: "x",
            withSafetyModeUserFields: true,
          },
          userByScreenNameFeatures,
          { withAuxiliaryUserLabels: false },
        ),
      );

      return {
        loggedIn: true,
        host: result.host,
      };
    } catch (error) {
      return {
        loggedIn: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async healthCheck(username: string): Promise<void> {
    const session = await this.checkSession();
    if (!session.loggedIn) {
      throw new Error(
        `X cookie auth failed against GraphQL endpoint. ${session.reason ?? "Unknown reason"}. Refresh auth_token + ct0 from the same active session.`,
      );
    }

    await this.getUserIdByScreenName(username);
  }

  async listTweetsWithMedia(
    params: ListTweetsWithMediaParams,
  ): Promise<ListTweetsWithMediaResult> {
    const userId = await this.getUserIdByScreenName(params.username);
    const perPageCount = 20;
    const maxPages = Math.max(1, params.limitPages);
    let cursor = params.cursor;
    const allTweets: MediaTweet[] = [];
    let hostUsed: TwitterHost | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const variables: Record<string, unknown> = {
        userId,
        count: perPageCount,
        includePromotedContent: true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      };

      if (cursor) {
        variables.cursor = cursor;
      }

      const { payload, host } =
        await this.executeGraphqlWithFallback<UserTweetsTimelineResponse>((candidateHost) =>
          buildGraphqlUrl(
            candidateHost,
            userTweetsQueryId,
            "UserTweets",
            variables,
            userTweetsFeatures,
            userTweetsFieldToggles,
          ),
        );

      hostUsed = host;
      const parsed = parseTimeline(payload, params.username);
      allTweets.push(...parsed.tweets);

      if (!parsed.nextCursor || parsed.nextCursor === cursor) {
        cursor = parsed.nextCursor;
        break;
      }

      cursor = parsed.nextCursor;
    }

    const dedupedById = new Map<string, MediaTweet>();
    for (const tweet of allTweets) {
      dedupedById.set(tweet.id, tweet);
    }
    const tweets = [...dedupedById.values()].sort(
      (left, right) => Number(right.id) - Number(left.id),
    );

    logger.debug(
      {
        username: params.username,
        direction: params.direction,
        host: hostUsed,
        requestedPages: maxPages,
        fetchedMediaTweets: tweets.length,
        nextCursor: cursor,
      },
      "Fetched tweets with media via GraphQL",
    );

    return {
      tweets,
      nextCursor: params.direction === "older" ? cursor : undefined,
    };
  }
}
