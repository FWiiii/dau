import "dotenv/config";

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { loadTelegramAuthConfig } from "./config/index.js";

export async function runTelegramAuthFlow(): Promise<void> {
  const config = loadTelegramAuthConfig();
  const session = new StringSession(config.telegramStringSession);
  const client = new TelegramClient(
    session,
    config.telegramApiId,
    config.telegramApiHash,
    {
      connectionRetries: 5,
    },
  );

  const cli = readline.createInterface({ input, output });

  try {
    await client.start({
      phoneNumber: async () => cli.question("Telegram phone number: "),
      password: async () => cli.question("2FA password (if any): "),
      phoneCode: async () => cli.question("Login code: "),
      onError: async (error) => {
        output.write(`Auth error: ${String(error)}\n`);
        return false;
      },
    });

    output.write("\nTelegram auth success. Save this value:\n\n");
    output.write(`${client.session.save()}\n\n`);
    output.write("Use it as TELEGRAM_STRING_SESSION in Zeabur env.\n");
  } finally {
    await client.disconnect();
    cli.close();
  }
}
