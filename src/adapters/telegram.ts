import { TelegramClient as GramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { logger } from "../logger.js";
import type {
  LocalMediaFile,
  SendTweetMediaGroupInput,
  SendTweetMediaGroupResult,
  TelegramClient,
} from "../types.js";

interface TelegramAdapterOptions {
  apiId: number;
  apiHash: string;
  stringSession: string;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toCaption(input: SendTweetMediaGroupInput, chunkIndex: number): string {
  return [
    `@${input.username}`,
    `${new Date(input.postedAt).toISOString()}`,
    input.tweetUrl,
    chunkIndex > 0 ? `part ${chunkIndex + 1}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export class TelegramSavedMessagesClient implements TelegramClient {
  private readonly client: GramClient;
  private connected = false;

  constructor(options: TelegramAdapterOptions) {
    this.client = new GramClient(
      new StringSession(options.stringSession),
      options.apiId,
      options.apiHash,
      {
        connectionRetries: 5,
      },
    );
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.connect();
    const authorized = await this.client.isUserAuthorized();
    if (!authorized) {
      throw new Error(
        "Telegram session is not authorized. Run auth:telegram first.",
      );
    }

    this.connected = true;
  }

  async healthCheck(): Promise<void> {
    await this.ensureConnected();
    await this.client.sendMessage("me", {
      message: "health check ok",
    });
  }

  async sendTextMessage(message: string): Promise<void> {
    await this.ensureConnected();
    await this.client.sendMessage("me", { message });
  }

  async sendTweetMediaGroup(
    input: SendTweetMediaGroupInput,
  ): Promise<SendTweetMediaGroupResult> {
    await this.ensureConnected();

    const chunks = chunkArray(input.mediaFiles, 10);
    const messageIds: string[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const files = chunks[index].map((item: LocalMediaFile) => item.path);
      const caption = toCaption(input, index);

      const result = await this.client.sendFile("me", {
        file: files,
        caption,
        supportsStreaming: true,
      });

      const messages = Array.isArray(result) ? result : [result];
      for (const message of messages) {
        const id = (message as { id?: number }).id;
        if (typeof id === "number") {
          messageIds.push(String(id));
        }
      }
    }

    logger.debug(
      {
        username: input.username,
        tweetUrl: input.tweetUrl,
        sentMessages: messageIds.length,
      },
      "Uploaded media group to Telegram",
    );

    return { messageIds };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await this.client.disconnect();
    this.connected = false;
  }
}
