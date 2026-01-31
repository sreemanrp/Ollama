# Ollama

`Ollama` is a Discord bot powered by a local large language model backed by
[Ollama](https://github.com/ollama/ollama).

## Dependencies

- Docker and Docker Compose

> Docker is optional if you are running the bot locally without containers.

## Run `index.js`

> [!NOTE]
> You must setup a [Discord Bot](https://discord.com/developers/applications) and set the environment variable `DISCORD_TOKEN` before `index.js` can access Discord.

`index.js` requires an [Ollama](https://github.com/ollama/ollama) server. Follow the steps in the
[ollama/ollama](https://github.com/ollama/ollama) repository to set up Ollama.

By default, it uses `127.0.0.1:11434`, which can be overwritten with `OLLAMA_HOST`.

> Note: Deploying this on Linux may require updating network configurations and `OLLAMA_HOST`.

## Customize `index.js`

The default LLM is defined using `OLLAMA_MODEL`.  
A custom personality can be added by changing the `SYSTEM` instruction in the Modelfile and running `ollama create`.

This can be changed in `compose.yaml`.

See [ollama/ollama](https://github.com/ollama/ollama/blob/main/docs/modelfile.md) for more details.

## Activating the Bot

Discord users can interact with the bot by mentioning it in a message to start a new conversation,
or by replying to a previous response to continue an ongoing conversation.

Each conversation is handled inside a dedicated thread created by the bot.

> [!WARNING]
>
> This repository is a **modified version** of [discollama](https://github.com/mxyng/discollama)
> 
> It has been updated, extended, and reworked to support newer features, improved stability, and long-running deployments.  
> The goal of this project is to keep it **open-source** and actively maintained for the
**Ollama community**.

## Credits

- [@mxyng](https://github.com/mxyng) — Original author of the base project

- [@Ollama](https://github.com/ollama) — Open-source LLM runtime and tooling
