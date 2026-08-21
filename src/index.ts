import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ModelDownloader } from './downloader.js'
import { ServerManager, type ServerBuild } from './server-manager.js'

export const name = 'dsh-local-llm'
export const inject = ['llm', 'webServer', 'settings']

export interface Config {
  model?: string
  modelPath?: string
  runtimeUrl?: string
  serverDir?: string
  serverUrl?: string
  serverBuild?: ServerBuild
  serverPort?: number
  contextSize?: number
  autoContextSize?: boolean
  port?: number
  downloadDir?: string
}

export const Config: z<Config> = z.object({
  model: z.string().default(''),
  modelPath: z.string().default(''),
  runtimeUrl: z.string().default(''),
  serverDir: z.string().default('./llama-server'),
  serverUrl: z.string().default(''),
  serverBuild: z.union([z.const('auto'), z.const('cuda'), z.const('cpu')]).default('auto'),
  serverPort: z.number().step(1).min(1).max(65535).default(8080),
  contextSize: z.number().step(1).min(2048).max(131072).default(8192),
  autoContextSize: z.boolean().default(true),
  port: z.number().step(1).min(1).max(65535).default(8080),
  downloadDir: z.string().default('./models')
})

interface PluginContext extends Context {
  webServer: {
    register: (route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) => () => void
  }
  settings: {
    register: (namespace: string, schema: z<Config>, options?: { base?: Partial<Config> }) => unknown
  }
  llm: {
    registerConfigurableProviders: (entries: readonly {
      provider: string
      displayName: string
      settingsNs: string
      settingsPath: readonly string[]
    }[]) => unknown
    registerAdapter: (providers: string[], adapter: {
      providerInfo: (provider: string) => { id: string; name: string }
      providerRetryPolicy: (provider: string) => unknown
      listModels: (provider: string) => Promise<readonly unknown[]>
      resolveModel: (provider: string, model: string) => Promise<unknown>
      stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
    }) => unknown
  }
}

interface ChatMessage {
  role?: string
  content?: string
}

interface Message {
  role: string
  content: Array<{ type: string; text?: string }>
}

interface GenerateOptions {
  model: string
  messages: Message[]
  system?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
  tools?: unknown[]
  signal?: AbortSignal
}

type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'finish'; reason: { kind: 'stop' } }

function textFromMessage(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function serializeMessages(messages: Message[], system?: string): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  const append = (role: 'system' | 'user' | 'assistant', content: string): void => {
    const previous = result[result.length - 1]
    if (previous?.role === role) {
      previous.content = `${previous.content}\n\n${content}`
    } else {
      result.push({ role, content })
    }
  }
  if (system !== undefined && system.length > 0) append('system', system)
  for (const message of messages) {
    const content = textFromMessage(message)
    if (content.length === 0 && message.role === 'assistant') continue
    const role = message.role === 'assistant'
      ? 'assistant'
      : message.role === 'system' && result.length === 0
        ? 'system'
        : 'user'
    append(role, content)
  }
  return result
}

function serializeTools(tools: unknown[]): Array<{ type: 'function'; function: Record<string, unknown> }> {
  return tools.flatMap((tool): Array<{ type: 'function'; function: Record<string, unknown> }> => {
    if (!tool || typeof tool !== 'object') return []
    const value = tool as Record<string, unknown>
    if (value.type === 'function' && value.function && typeof value.function === 'object') {
      return [value as { type: 'function'; function: Record<string, unknown> }]
    }
    if (typeof value.name !== 'string' || value.name.length === 0) return []
    return [{
      type: 'function',
      function: {
        name: value.name,
        description: typeof value.description === 'string' ? value.description : '',
        parameters: value.parameters && typeof value.parameters === 'object'
          ? value.parameters
          : { type: 'object', properties: {} }
      }
    }]
  })
}

async function waitForServerReady(runtimeUrl: string, signal?: AbortSignal): Promise<void> {
  const healthUrl = `${runtimeUrl.replace(/\/$/, '')}/health`
  for (let attempt = 0; attempt < 60; attempt++) {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    try {
      const response = await fetch(healthUrl, { signal })
      if (response.ok) return
    } catch (error) {
      if (signal?.aborted) throw error
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Request aborted', 'AbortError'))
      }, { once: true })
    })
  }
  throw new Error('The local model did not load within 120 seconds')
}

async function* readCompletionStream(response: Response): AsyncIterable<StreamChunk> {
  if (!response.body) throw new Error('llama-server returned an empty response stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let started = false
  let textContent = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''
      for (const event of events) {
        const line = event.split(/\r?\n/).find(item => item.startsWith('data:'))
        if (!line) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { continue }
        const delta = chunk.choices?.[0]?.delta
        const text = typeof delta?.content === 'string' ? delta.content : ''
        if (text.length > 0) {
          if (!started) {
            started = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          textContent += text
          yield { type: 'text-delta', index: 0, text }
        }
        const usage = chunk.usage
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: Number(usage.prompt_tokens) || 0,
              outputTokens: Number(usage.completion_tokens) || 0,
            }
          }
        }
      }
      if (done) break
    }
    if (started) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: textContent } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } finally {
    reader.releaseLock()
  }
}

export function apply(ctx: PluginContext, config: Config) {
  console.log('📥 Plugin loaded with configuration:', config)

  ctx.settings.register('dsh-local-llm', Config, { base: config })

  const downloader = new ModelDownloader(config.downloadDir || './models')
  const server = new ServerManager(
    config.serverDir || './llama-server',
    config.serverPort || 8080,
    config.contextSize || 8192,
    config.serverUrl || '',
    config.autoContextSize !== false,
    config.serverBuild || 'auto'
  )
  
  const progressClients = new Set<ServerResponse>()
  const sendJson = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const value: unknown = JSON.parse(body || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch {
      throw new Error('Request body must be a valid JSON object')
    }
  }
  const registerRoute = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => {
    ctx.inject(['webServer'], (webCtx) => {
      const injectedContext = webCtx as Context & Pick<PluginContext, 'webServer'>
      ctx.effect(() => injectedContext.webServer.register({ kind: 'exact', path, handler }), `dsh-local-llm: ${path}`)
    })
  }

  registerRoute('/api/local-llm/models', async (_req, res) => {
    const downloaded = downloader.getDownloadedModels()
    sendJson(res, 200, downloaded.map(name => ({
      name,
      size: getFileSize(downloader.getModelPath(name)),
      downloaded: true
    })))
  })

  registerRoute('/api/local-llm/progress', async (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    progressClients.add(res)
    res.on('close', () => progressClients.delete(res))
  })

  registerRoute('/api/local-llm/download', async (req, res) => {
    try {
      const { model } = await readJson(req)
      if (typeof model !== 'string' || !model.trim()) {
        throw new Error('A model is required')
      }
      await downloader.downloadModel(model, (progress) => {
        const event = `data: ${JSON.stringify({ model, progress })}\n\n`
        for (const client of progressClients) client.write(event)
      })
      sendJson(res, 200, { success: true })
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: error instanceof Error ? error.message : 'Model download error'
      })
    }
  })

  registerRoute('/api/local-llm/delete', async (req, res) => {
    const { model } = await readJson(req)
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('A model is required')
    }
    const success = downloader.removeModel(model)
    sendJson(res, 200, { success })
  })

  registerRoute('/api/local-llm/server/status', async (_req, res) => {
    sendJson(res, 200, server.getStatus())
  })

  registerRoute('/api/local-llm/server/install', async (_req, res) => {
    try {
      sendJson(res, 200, await server.install(progress => {
        const event = `data: ${JSON.stringify({ type: 'server', progress })}\n\n`
        for (const client of progressClients) client.write(event)
      }))
    } catch (error) {
      sendJson(res, 200, {
        installed: false,
        running: false,
        url: `http://127.0.0.1:${config.serverPort || 8080}`,
        error: error instanceof Error ? error.message : 'Could not install the local server'
      })
    }
  })

  registerRoute('/api/local-llm/server/start', async (req, res) => {
    try {
      const { model } = await readJson(req)
      if (typeof model !== 'string' || !model.trim()) throw new Error('A model is required to start the server')
      sendJson(res, 200, server.start(downloader.getModelPath(model)))
    } catch (error) {
      sendJson(res, 200, {
        installed: server.getStatus().installed,
        running: false,
        url: server.getStatus().url,
        error: error instanceof Error ? error.message : 'Could not start the local server'
      })
    }
  })

  registerRoute('/api/local-llm/server/stop', async (_req, res) => {
    sendJson(res, 200, server.stop())
  })

  let modelPath = config.modelPath ? path.resolve(config.modelPath) : ''

  if (!modelPath && config.model) {
    console.log(`📥 Starting download of model ${config.model}...`)
    downloader.downloadModel(config.model, (progress) => {
      if (Math.round(progress) % 10 === 0) {
        console.log(`📥 Download progress: ${Math.round(progress)}%`)
      }
    }).then((path) => {
      modelPath = path
      console.log(`✅ Model ready: ${modelPath}`)
    }).catch((error) => {
      console.error('❌ Model download failed:', error)
    })
  }
  console.log('✅ Plugin ready!')
  ctx.llm.registerConfigurableProviders([
    {
      provider: 'local-llm',
      displayName: 'Local model',
      settingsNs: 'dsh-local-llm',
      settingsPath: []
    }
  ])

  ctx.llm.registerAdapter(['local-llm'], {
    providerInfo: () => ({ id: 'local-llm', name: 'Local model' }),
    providerRetryPolicy: () => undefined,
    listModels: async (provider: string) => downloader.getDownloadedModels().map(model => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'] as const
    })),
    resolveModel: async (_provider: string, model: string) => ({
      provider: 'local-llm',
      id: model,
      name: model
    }),
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const selectedModel = options.model || config.model
      const selectedPath = selectedModel ? downloader.getModelPath(selectedModel) : modelPath
      if (!selectedPath || !fs.existsSync(selectedPath)) {
        throw new Error('The model is not downloaded. Select a model in the UI and download it first')
      }
      const runtimeUrl = config.runtimeUrl || `http://127.0.0.1:${config.serverPort || 8080}`
      await waitForServerReady(runtimeUrl, options.signal)
      const response = await fetch(`${runtimeUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: selectedModel,
          messages: serializeMessages(options.messages, options.system),
          stream: true,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
          ...(options.stop === undefined ? {} : { stop: options.stop }),
          ...(options.tools === undefined ? {} : { tools: serializeTools(options.tools) })
        }),
        signal: options.signal
      })
      if (!response.ok) {
        const details = await response.text()
        throw new Error(`llama-server returned HTTP ${response.status}: ${details || response.statusText}`)
      }
      yield* readCompletionStream(response)
    }
  })

  console.log('✅ Plugin ready!')
}

export default { apply, name, Config, inject }

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}
