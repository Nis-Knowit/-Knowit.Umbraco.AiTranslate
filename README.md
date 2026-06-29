# AI Translate for Umbraco

A guided AI translation dashboard for Umbraco 17+. Translate content page-by-page or
across a whole site into other languages, using your existing **Umbraco.AI** profile.

## Demo

<video src="https://github.com/Nis-Knowit/-Knowit.Umbraco.AiTranslate/raw/main/Demo.mp4" controls width="100%"></video>

> ▶️ [Watch the demo](https://github.com/Nis-Knowit/-Knowit.Umbraco.AiTranslate/raw/main/Demo.mp4)

## Features

- **Guided wizard** — _From → To → Pages → Translate_.
- **Create a language on the fly** and translate a whole new site into it.
- **Pick pages** from a content tree with per-pair status, or translate the whole site.
- **Overwrite** existing translations or keep them, with a toggle.
- **Media** references are copied across to the target language (toggle).
- **Links** (MultiUrlPicker) keep their destination — only the title is translated.
- **Setup guide** when no AI profile is configured, with a live connection check.
- **Settings** to point at any AI **profile alias** and managed **prompt alias**.
- Translations are always saved as **drafts** for human review before publishing.

## Requirements

- Umbraco CMS **17.4+**
- **Umbraco.AI** (this package depends on it) with a working **profile**.

## Installation

```bash
dotnet add package Knowit.Umbraco.AiTranslate
```

The dashboard appears in the **Content** section as **AI Translate**.

## Configuration

By default the dashboard uses:

- Profile alias: `content-assistant`
- Prompt alias: `ai-translate`

Both are editable from the dashboard's **⚙ Settings** panel (stored per browser).
To customise the translation instructions, create a prompt with the configured prompt
alias in the **AI** section; otherwise a sensible built-in prompt is used.

## License

MIT
