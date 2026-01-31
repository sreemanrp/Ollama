import dotenv from "dotenv";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  ActivityType,
  PermissionsBitField
} from "discord.js";
import Redis from "ioredis";
import { Ollama } from "ollama";

dotenv.config();

// piggy back on the logger setup
process.on("unhandledRejection", err => {
  console.error(err);
});

process.on("uncaughtException", err => {
  console.error(err);
});

const THREAD_IDLE_TTL = 10 * 60;
const HEARTBEAT_INTERVAL = 30_000;
const RECONNECT_BASE_DELAY = 2_000;
const RECONNECT_MAX_DELAY = 60_000;

class Response {
  constructor(message) {
    this.message = message;
    this.channel = message.channel;

    this.r = null;
    this.buffer = "";
  }

  async write(s, end = "") {
    if ((this.buffer + s + end).length > 2000) {
      this.r = null;
      this.buffer = "";
    }

    this.buffer += s;

    const value = this.buffer.trim();
    if (!value) return;

    if (this.r) {
      await this.r.edit(value + end);
      return;
    }

    if (this.channel.type === ChannelType.GuildText) {
      this.channel = await this.channel.threads.create({
        name: "Ollama Says",
        startMessage: this.message,
        autoArchiveDuration: 60
      });
    }

    this.r = await this.channel.send(value);
  }
}

class Discollama {
  constructor({ client, ollama, redis, model }) {
    this.ollama = ollama;
    this.client = client;
    this.redis = redis;
    this.model = model;

    this.lastHeartbeat = Date.now();
    this.reconnectAttempts = 0;
    this.shuttingDown = false;

    // register event handlers
    this.client.on("clientReady", this.onReady.bind(this));
    this.client.on("messageCreate", this.onMessage.bind(this));

    this.client.on("shardDisconnect", () => {
      this.scheduleReconnect();
    });
  }

  async onReady() {
    const activity = {
      name: "Discollama",
      state: "Ask me anything!",
      type: ActivityType.Custom
    };

    await this.client.user.setPresence({
      activities: [activity],
      status: "online"
    });

    this.warmUpModel();
    this.startIdleThreadWatcher();
    this.startHeartbeatWatchdog();

    console.log(
      "Ready! Invite URL:",
      `https://discord.com/oauth2/authorize?client_id=${this.client.application.id}&permissions=${new PermissionsBitField([
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.CreatePublicThreads
      ]).bitfield}&scope=bot`
    );
  }

  async onMessage(message) {
    // don't respond to ourselves
    if (message.author.bot) return;

    // don't respond to messages that don't mention us
    if (!message.mentions.has(this.client.user)) return;

    this.lastHeartbeat = Date.now();

    let content = message.content
      .replace(`<@${this.client.user.id}>`, "")
      .trim();

    if (!content) content = "Hi!";

    const channel = message.channel;
    let context = [];

    if (message.reference?.messageId) {
      context = await this.load({ messageId: message.reference.messageId });

      if (!context.length) {
        const referenceMessage = await message.channel.messages.fetch(
          message.reference.messageId
        );

        content = [
          content,
          "Use this to answer the question if it is relevant, otherwise ignore it:",
          referenceMessage.content
        ].join("\n");
      }
    }

    if (!context.length) {
      context = await this.load({ channelId: channel.id });
    }

    const r = new Response(message);
    let lastPart;

    for await (const part of this.generate(content, context)) {
      await r.write(part.response, "...");
      lastPart = part;
    }

    await r.write("");
    await this.save(r.channel.id, message.id, lastPart.context);

    if (r.channel.isThread()) {
      await this.touchThread(r.channel.id);
    }
  }

  async *generate(content, context) {
    let buffer = "";
    let lastFlush = Date.now();
    let firstToken = true;

    const stream = await this.ollama.generate({
      model: this.model,
      prompt: content,
      context,
      keep_alive: -1,
      stream: true
    });

    for await (const part of stream) {
      buffer += part.response || "";

      if (firstToken || part.done || Date.now() - lastFlush > 300) {
        firstToken = false;
        yield { ...part, response: buffer };
        buffer = "";
        lastFlush = Date.now();
      }
    }
  }

  async save(channelId, messageId, ctx) {
    this.redis.set(
      `discollama:channel:${channelId}`,
      messageId,
      "EX",
      60 * 60 * 24 * 7
    );

    this.redis.set(
      `discollama:message:${messageId}`,
      JSON.stringify(ctx),
      "EX",
      60 * 60 * 24 * 7
    );
  }

  async load({ channelId, messageId }) {
    if (channelId) {
      messageId = await this.redis.get(
        `discollama:channel:${channelId}`
      );
    }

    const ctx = await this.redis.get(
      `discollama:message:${messageId}`
    );

    return ctx ? JSON.parse(ctx) : [];
  }

  async warmUpModel() {
    try {
      this.ollama.generate({
        model: this.model,
        prompt: "Hello",
        keep_alive: -1
      });
    } catch {}
  }

  async touchThread(threadId) {
    await this.redis.set(
      `discollama:thread:${threadId}`,
      Date.now(),
      "EX",
      THREAD_IDLE_TTL
    );
  }

  startIdleThreadWatcher() {
    setInterval(async () => {
      const keys = await this.redis.keys("discollama:thread:*");

      for (const key of keys) {
        const threadId = key.split(":")[2];
        const ts = await this.redis.get(key);

        if (!ts) {
          try {
            const thread = await this.client.channels.fetch(threadId);
            if (thread?.isThread()) {
              await thread.setArchived(true);
            }
            await this.redis.del(key);
          } catch {}
        }
      }
    }, 60_000);
  }

  startHeartbeatWatchdog() {
    setInterval(() => {
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_INTERVAL * 2) {
        this.selfHeal();
      }
    }, HEARTBEAT_INTERVAL);
  }

  scheduleReconnect() {
    if (this.shuttingDown) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY
    );

    setTimeout(() => this.selfHeal(), delay);
  }

  selfHeal() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      this.redis.quit();
    } catch {}

    setTimeout(() => process.exit(1), 1000);
  }

  run(token) {
    try {
      this.client.login(token);
    } catch {
      this.redis.quit();
    }
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  rest: { timeout: 15_000 }
});

const redis = new Redis(
  process.env.REDIS_PORT || 6379,
  process.env.REDIS_HOST || "127.0.0.1"
);

const ollama = new Ollama({
  host: "http://127.0.0.1:11434"
});

new Discollama({
  client,
  ollama,
  redis,
  model: process.env.OLLAMA_MODEL || "llama2"
}).run(process.env.DISCORD_TOKEN);
