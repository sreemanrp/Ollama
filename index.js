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

class Response {
  constructor(message) {
    this.message = message;
    this.channel = message.channel;

    this.r = null;
    this.buffer = "";
  }

  async write(s, end = "") {
    // reset buffer if message exceeds Discord limit
    if ((this.buffer + s + end).length > 2000) {
      this.r = null;
      this.buffer = "";
    }

    this.buffer += s;

    const value = this.buffer.trim();
    if (!value) return;

    if (this.r) {
      // edit existing message
      await this.r.edit(value + end);
      return;
    }

    if (this.channel.type === ChannelType.GuildText) {
      // create thread on first response
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
  constructor({ client, ollama, redis }) {
    this.client = client;
    this.ollama = ollama;
    this.redis = redis;

    // default models
    this.chatModel = process.env.OLLAMA_CHAT_MODEL || "qwen3:4b";
    this.codeModel = process.env.OLLAMA_CODE_MODEL || "qwen2.5-coder";

    // register event handlers
    this.client.on("clientReady", this.onReady.bind(this));
    this.client.on("messageCreate", this.onMessage.bind(this));
  }

  async onReady() {
    const activity = {
      name: "Ollama",
      state: "Ask me anything!",
      type: ActivityType.Custom
    };

    await this.client.user.setPresence({
      activities: [activity],
      status: "online"
    });

    // warm up models to reduce first-response latency
    this.ollama.generate({ model: this.chatModel, prompt: "Hello", keep_alive: -1 }).catch(() => {});
    this.ollama.generate({ model: this.codeModel, prompt: "Hello", keep_alive: -1 }).catch(() => {});

    console.log(
      "Ready! Invite URL:",
      `https://discord.com/oauth2/authorize?client_id=${this.client.application.id}&permissions=${new PermissionsBitField([
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.CreatePublicThreads
      ]).bitfield}&scope=bot`
    );
  }

  // decide which model to use (chat vs coder)
  pickModel(content) {
    const codeHints = [
      "```",
      "error",
      "bug",
      "fix",
      "function",
      "class",
      "const ",
      "let ",
      "var ",
      "import ",
      "export ",
      "python",
      "javascript",
      "node",
      "discord.js"
    ];

    const lower = content.toLowerCase();
    return codeHints.some(k => lower.includes(k))
      ? this.codeModel
      : this.chatModel;
  }

  async onMessage(message) {
    if (message.author.bot) {
      // don't respond to ourselves
      return;
    }

    if (!message.mentions.has(this.client.user)) {
      // don't respond to messages that don't mention us
      return;
    }

    let content = message.content
      .replace(`<@${this.client.user.id}>`, "")
      .trim();

    if (!content) content = "Hi!";

    const channel = message.channel;
    let context = [];

    // load context from replied message
    if (message.reference?.messageId) {
      context = await this.load({ messageId: message.reference.messageId });

      if (!context.length) {
        const referenceMessage = await channel.messages.fetch(
          message.reference.messageId
        );

        content = [
          content,
          "Use this to answer the question if it is relevant, otherwise ignore it:",
          referenceMessage.content
        ].join("\n");
      }
    }

    // fallback to channel context
    if (!context.length) {
      context = await this.load({ channelId: channel.id });
    }

    const model = this.pickModel(content);

    // thinking reaction (Python equivalent)
    let thinkingActive = true;
    try {
      await message.react("🤔");
      message.channel.sendTyping().catch(() => {});
    } catch {}

    const r = new Response(message);
    let lastPart;

    for await (const part of this.generate(model, content, context)) {
      if (thinkingActive) {
        thinkingActive = false;
        try {
          await message.reactions.resolve("🤔")?.users.remove(this.client.user.id);
        } catch {}
      }

      await r.write(part.response, "...");
      lastPart = part;
    }

    await r.write("");

    if (lastPart?.context) {
      await this.save(r.channel.id, message.id, lastPart.context);
    }
  }

  async *generate(model, content, context) {
    let buffer = "";
    let lastFlush = Date.now();
    let firstToken = true;

    const stream = await this.ollama.generate({
      model,
      prompt: content,
      context,
      keep_alive: -1,
      stream: true,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_predict: 512
      }
    });

    for await (const part of stream) {
      buffer += part.response || "";

      if (firstToken || part.done || Date.now() - lastFlush > 200) {
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

    if (!messageId) return [];

    const ctx = await this.redis.get(
      `discollama:message:${messageId}`
    );

    return ctx ? JSON.parse(ctx) : [];
  }

  run(token) {
    this.client.login(token);
  }
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Redis client
const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null
});

// Ollama client
const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434"
});

// run bot
new Discollama({
  client,
  ollama,
  redis
}).run(process.env.DISCORD_TOKEN);
