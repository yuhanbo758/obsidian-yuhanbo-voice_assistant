# Yuhanbo Voice Assistant

Yuhanbo Voice Assistant is a desktop-only Obsidian plugin for voice recognition, speech synthesis, wake words, dictation, and optional AI conversations.

Yuhanbo Voice Assistant 是一款桌面端 Obsidian 语音助手，支持语音识别、语音合成、唤醒词、听写，以及可选的大模型对话。

## Features

- Record microphone audio and transcribe it with iFlytek online ASR.
- Read selected text or the current note with iFlytek online TTS.
- Start voice workflows with configurable wake words.
- Send recognized text to Google Gemini, OpenRouter, or iFlytek Spark.
- Insert conversation results into the active note.
- Optionally save generated audio and conversation notes inside the vault.

## Requirements

- Obsidian desktop `1.7.2` or later.
- Microphone permission granted to Obsidian.
- An iFlytek account and credentials for online speech features.
- Credentials for Google AI Studio, OpenRouter, or iFlytek Spark when using the corresponding AI provider.

Third-party services may impose quotas or charges. Review their terms and pricing before enabling them.

## Usage

1. Open **Settings → Community plugins → Yuhanbo Voice Assistant**.
2. Choose an AI provider and enter only the credentials required for the features you intend to use.
3. Configure speech recognition, TTS, wake words, recording, and optional vault save paths.
4. Run commands such as **开始对话**, **语音听写**, **持续听写**, or **语音朗读** from the command palette.

The plugin assigns no default hotkeys. You can configure your own under **Settings → Hotkeys**.

## Privacy, data transmission, and storage

This plugin connects directly from Obsidian to the providers you enable; the developer does not operate an intermediary server.

- Microphone audio is sent to iFlytek when you use online speech recognition, dictation, wake-word listening, or related microphone test functions.
- Text selected for speech synthesis is sent to iFlytek when you use online TTS.
- Recognized text, prompts, conversation history needed for a request, and the active AI request are sent to the selected provider: Google Gemini, OpenRouter, or iFlytek Spark.
- Provider credentials are stored locally and unencrypted in the plugin's Obsidian `data.json` through `Plugin.saveData`. Anyone with access to the vault configuration may be able to read them.
- When enabled, generated audio is written to the configured vault folder. Conversation summaries or transcripts can also be written to the configured vault folder.
- Wake-word and continuous-listening modes can keep the microphone active and make background network requests until stopped.
- The plugin contains no telemetry, analytics, advertising, or developer-controlled data collection.

Avoid speaking or sending sensitive information. Revoke provider credentials immediately if the vault configuration is exposed.

## Installation

### Community plugins

After community publication, install **Yuhanbo Voice Assistant** from **Settings → Community plugins → Browse**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release and copy them to:

```text
<vault>/.obsidian/plugins/yuhanbo-voice-assistant/
```

Reload Obsidian and enable the plugin.

## Development

```powershell
npm ci
npm run build
```

Pushes to `main` that change plugin release files trigger the automatic release workflow. It synchronizes version files, creates an exact-version GitHub Release, uploads the required Obsidian assets, and generates build-provenance attestations.

## License

[MIT](LICENSE) © Yuhanbo Yu
