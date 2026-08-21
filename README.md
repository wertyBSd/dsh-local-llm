# dsh-local-llm

A DeepSeek Harness plugin for managing local GGUF models and serving them through `llama-server`.

> The `llama-server` runtime is downloaded from the plugin UI and started only when the user clicks the start button. Requests made before the server is ready return a clear error.

## Features

- Download GGUF models from Hugging Face or a direct URL.
- Search the built-in model catalog.
- Add any model by pasting a direct `.gguf` URL.
- Display downloaded models and file sizes.
- Stream download progress to the UI through SSE.
- Delete downloaded models.
- Prevent path traversal through model filenames.
- Follow HTTP redirects and clean up incomplete downloads.
- Deduplicate concurrent downloads of the same model.
- Automatically choose a suitable context size for the selected model.
- Provide an `on`/`off` server indicator in the sidebar footer.

## Requirements

- Node.js 18 or newer.
- DeepSeek Harness with the `llm` and `webServer` services.
- A local inference runtime for text generation.

The `@deepseek-ai/cordis` package provides the Cordis runtime. The `llm` and `webServer` services must be provided by Harness or its plugins.

## Installation and Build

```bash
npm install
npm run build
```

The host plugin entry point is `dist/index.js`. The sidebar client bundle is `dist/client.js`.

The package manifest exposes `dsh.bundle` and `dsh.client`. After restarting Harness, the plugin is loaded into the client graph.

For a local Windows installation, run:

```powershell
Set-Location C:\git\dsh-local-llm
npm install
npm run build

Set-Location C:\git\deepseek-harness
pnpm dsh plugin --profile web add C:\git\dsh-local-llm
pnpm dsh --profile web --dump-config | Select-String dsh-local-llm
```

The verification output should contain `name: dsh-local-llm`. Stop any running Harness process completely and start it again:

```powershell
pnpm dsh web
```

Refreshing the browser page is not enough because the client plugin graph is built when the web profile starts.

Development commands:

```bash
npm run dev       # watch TypeScript compilation
npm run dev:ui    # watch UI build
```

## Configuration

Example configuration:

```json
{
  "model": "mistral-7b-instruct-v0.3-Q4_K_M.gguf",
  "modelPath": "",
  "runtimeUrl": "http://127.0.0.1:8080",
  "contextSize": 8192,
  "autoContextSize": true,
  "port": 8080,
  "downloadDir": "./models"
}
```

Parameters:

- `model` - a built-in model name or a direct URL to a `.gguf` file.
- `modelPath` - a path to an existing model file. If omitted, the configured model is downloaded automatically.
- `runtimeUrl` - the URL of an OpenAI-compatible local runtime such as `llama-server`.
- `contextSize` - the minimum context size passed to `llama-server`, in tokens. The default is `8192`.
- `autoContextSize` - automatically choose a model-dependent context size. Enabled by default.
- `port` - a plugin configuration value; the Harness web server owns its HTTP port.
- `downloadDir` - the model directory. Defaults to `./models`.

Built-in model names include:

- `mistral-7b-instruct-v0.3-Q4_K_M.gguf`;
- `llama-3-8b-instruct-q4_K_M.gguf`;
- `deepseek-coder-6.7b-instruct-q4_K_M.gguf`;
- `qwen-2.5-7b-instruct-q4_K_M.gguf`.

## Local Server

The server is not downloaded or started automatically. Open `Local models`, click `Download and install server`, wait for installation to finish, select a downloaded model, and click `Start`. The plugin downloads `llama-server` from the official `ggml-org/llama.cpp` release and binds it to `127.0.0.1`.

Server parameters:

- `serverDir` - the binary and log directory. Defaults to `./llama-server`.
- `serverUrl` - an optional direct server archive URL. If empty, a compatible archive is selected from the latest GitHub release.
- `serverBuild` - selects the runtime build: `auto` prefers CUDA and falls back to CPU, `cuda` requires a CUDA archive, and `cpu` forces a non-CUDA archive. Defaults to `auto`.

The model manager includes a server build selector. Stop the server before switching builds, choose `CUDA`, `CPU`, or `Automatic`, and click `Install selected build`. Switching from one installed build to another replaces the runtime files in `serverDir`.
- `serverPort` - the `llama-server` port. Defaults to `8080`.
- `contextSize` - the minimum context size in tokens. Harness system instructions and tools may require a larger value.
- `autoContextSize` - when enabled, compact models use at least `8192` tokens and other models use at least `16384`; the configured `contextSize` remains the lower bound.

The server is restarted automatically when a different model is selected, so the new model's context size takes effect. The active context size is included in the server status. The server log is written to `llama-server/llama-server.log`.

## Localization

The model manager is available in English, Russian, Chinese, French, Spanish, Italian, Polish, German, Hindi, and Japanese. English is used by default. The selected language is stored in the browser and applies to the model window, errors, server controls, and the `local models` indicator.

## API

- `GET /api/local-llm/models` - list downloaded models.
- `POST /api/local-llm/download` with `{ "model": "model-file.gguf" }` - download a model.
- `GET /api/local-llm/progress?model=...` - receive download progress as SSE.
- `POST /api/local-llm/delete` with `{ "model": "model-file.gguf" }` - delete a model.
- `GET /api/local-llm/server/status` - get server status.
- `POST /api/local-llm/server/install` - download and extract the server.
- `POST /api/local-llm/server/start` with `{ "model": "model-file.gguf" }` - start the server with a model.
- `POST /api/local-llm/server/stop` - stop the server.

## Harness Integration

The plugin registers `local-llm` in the configurable provider directory and activates it through `registerAdapter(['local-llm'], ...)`. The provider becomes available in the Harness model selector after restarting the web profile.

The adapter sends streaming requests to `${runtimeUrl}/v1/chat/completions`. If `runtimeUrl` is empty, it uses the server started by the plugin at `http://127.0.0.1:8080`. Harness tools are converted to the OpenAI function-tool format, and the adapter waits for `/health` before sending a request.

The optional sidebar placement immediately after `New session` requires the local `DeepSeek Harness` shell slot `sidebar.after-new-session`. Without that local shell patch, the plugin remains compatible with the standard footer action slot.

## Known Limitations

- The built-in catalog uses fixed Hugging Face URLs.
- Downloaded files are not verified against a checksum.
- SSE behavior depends on the DeepSeek Harness web server implementation.
- Text generation is unavailable until the server is installed, started, and ready.

## License

MIT
