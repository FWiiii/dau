export type MediaType = "photo" | "video" | "gif";

export interface TweetMedia {
  id: string;
  url: string;
  type: MediaType;
}

export interface MediaTweet {
  id: string;
  username: string;
  text: string;
  tweetUrl: string;
  postedAt: string;
  media: TweetMedia[];
}

export interface ListTweetsWithMediaParams {
  username: string;
  cursor?: string;
  direction: "newer" | "older";
  limitPages: number;
}

export interface ListTweetsWithMediaResult {
  tweets: MediaTweet[];
  nextCursor?: string;
  rateLimitHint?: string;
}

export interface LocalMediaFile {
  mediaKey: string;
  mediaUrl: string;
  mediaType: MediaType;
  path: string;
  fileSizeBytes: number;
}

export interface SendTweetMediaGroupInput {
  tweetUrl: string;
  username: string;
  postedAt: string;
  mediaFiles: LocalMediaFile[];
}

export interface SendTweetMediaGroupResult {
  messageIds: string[];
}

export interface AccountState {
  username: string;
  latestSeenTweetId: string | null;
  backfillCursor: string | null;
  backfillDone: boolean;
  updatedAt: string;
}

export interface StoredMediaRecord {
  mediaKey: string;
  tweetId: string;
  username: string;
  mediaUrl: string;
  mediaType: MediaType;
  uploadedAt: string;
  telegramMessageIds: string[];
  status: "uploaded" | "skipped_oversize";
}

export interface TwitterClient {
  listTweetsWithMedia(
    params: ListTweetsWithMediaParams,
  ): Promise<ListTweetsWithMediaResult>;
  healthCheck(username: string): Promise<void>;
  checkSession(): Promise<{ loggedIn: boolean; reason?: string; host?: string }>;
}

export interface TelegramClient {
  sendTweetMediaGroup(
    input: SendTweetMediaGroupInput,
  ): Promise<SendTweetMediaGroupResult>;
  sendTextMessage(message: string): Promise<void>;
  healthCheck(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface StateRepo {
  init(): Promise<void>;
  getAccountState(username: string): Promise<AccountState>;
  upsertAccountState(
    state: Omit<AccountState, "updatedAt"> & { updatedAt?: string },
  ): Promise<void>;
  isMediaUploaded(mediaKey: string): Promise<boolean>;
  markMediaUploaded(record: StoredMediaRecord): Promise<void>;
  acquireJobLock(
    jobName: string,
    holderId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  releaseJobLock(jobName: string, holderId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AccountRunSummary {
  username: string;
  uploaded: number;
  skipped: number;
  failed: number;
  incrementalTweetsSelected: number;
  backfillTweetsSelected: number;
  incrementalTweetsCandidates: number;
  backfillTweetsCandidates: number;
  backfillDone: boolean;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  skippedByLock: boolean;
  accounts: AccountRunSummary[];
}
