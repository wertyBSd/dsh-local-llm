import './ui-components/styles.css'
import en from './locales/en.json' with { type: 'json' }
import ru from './locales/ru.json' with { type: 'json' }
import zh from './locales/zh.json' with { type: 'json' }
import fr from './locales/fr.json' with { type: 'json' }
import es from './locales/es.json' with { type: 'json' }
import it from './locales/it.json' with { type: 'json' }
import pl from './locales/pl.json' with { type: 'json' }
import de from './locales/de.json' with { type: 'json' }
import hi from './locales/hi.json' with { type: 'json' }
import ja from './locales/ja.json' with { type: 'json' }

type ModuleRequire = (specifier: string) => unknown

type ReactApi = typeof import('react')
type ReactNode = ReturnType<ReactApi['createElement']>

type ModelInfo = {
  name: string
  size: number
  downloaded: boolean
}

type ServerStatus = {
  installed: boolean
  running: boolean
  url: string
  pid?: number
  build?: 'auto' | 'cuda' | 'cpu'
  error?: string
}

type ServerBuild = 'auto' | 'cuda' | 'cpu'

type Locale = 'en' | 'ru' | 'zh' | 'fr' | 'es' | 'it' | 'pl' | 'de' | 'hi' | 'ja'

const translations: Record<Locale, Record<string, string>> = { en, ru, zh, fr, es, it, pl, de, hi, ja }

function initialLocale(): Locale {
  const stored = localStorage.getItem('dsh-local-llm-locale')
  const supported: Locale[] = ['en', 'ru', 'zh', 'fr', 'es', 'it', 'pl', 'de', 'hi', 'ja']
  return stored !== null && supported.includes(stored as Locale) ? stored as Locale : 'en'
}

function text(locale: Locale, key: string, values: Record<string, string> = {}): string {
  return Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, value), translations[locale][key] || translations.en[key] || key)
}

function modelContextSize(modelName: string): number {
  const stored = Number(localStorage.getItem(`dsh-local-llm-context:${modelName}`))
  if (Number.isInteger(stored) && stored >= 2048 && stored <= 131072) return stored
  const name = modelName.toLowerCase()
  if (name.includes('tinyllama')) return 2048
  if (name.includes('phi-2') || name.includes('phi-3') || name.includes('phi-4')) return 8192
  return 16384
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error.length > 0) return new Error(body.error)
  } catch {
    // Use the localized fallback when the server did not return JSON.
  }
  return new Error(fallback)
}

function createClientPlugin(moduleRequire: ModuleRequire) {
  const React = moduleRequire('react') as ReactApi
  const { useEffect, useState } = React

  function ModelManager(): ReactNode {
    const [locale, setLocale] = useState<Locale>(initialLocale)
    const [models, setModels] = useState<ModelInfo[]>([])
    const [downloading, setDownloading] = useState<string | null>(null)
    const [progress, setProgress] = useState(0)
    const [error, setError] = useState<string | null>(null)
    const [server, setServer] = useState<ServerStatus | null>(null)
    const [serverBusy, setServerBusy] = useState(false)
    const [serverProgress, setServerProgress] = useState(0)
    const [serverBuild, setServerBuild] = useState<ServerBuild>(() => {
      const stored = localStorage.getItem('dsh-local-llm-server-build')
      return stored === 'cuda' || stored === 'cpu' ? stored : 'auto'
    })
    const [modelSearch, setModelSearch] = useState('')
    const [customModelUrl, setCustomModelUrl] = useState('')
    const [customContextSize, setCustomContextSize] = useState('8192')
    const [selectedContextSize, setSelectedContextSize] = useState<number | undefined>(undefined)
    const [selectedModel, setSelectedModel] = useState('mistral-7b-instruct-v0.3-Q4_K_M.gguf')
    const t = (key: string, values?: Record<string, string>) => text(locale, key, values)
    const changeLocale = (value: Locale) => {
      setLocale(value)
      localStorage.setItem('dsh-local-llm-locale', value)
    }
    const availableModels = [
      ['mistral-7b-instruct-v0.3-Q4_K_M.gguf', '4.5 GB'],
      ['llama-3-8b-instruct-q4_K_M.gguf', '4.7 GB'],
      ['deepseek-coder-6.7b-instruct-q4_K_M.gguf', '4.2 GB'],
      ['qwen-2.5-7b-instruct-q4_K_M.gguf', '4.3 GB'],
      ['Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', '4.9 GB'],
      ['Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', '4.7 GB'],
      ['gemma-2-9b-it-Q4_K_M.gguf', '5.8 GB'],
      ['Phi-3.5-mini-instruct-Q4_K_M.gguf', '2.2 GB'],
      ['DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf', '4.1 GB'],
      ['StarCoder2-7B-Q4_K_M.gguf', '4.4 GB'],
      ['TinyLlama-1.1B-Chat-v1.0-Q4_K_M.gguf', '0.7 GB']
    ]
    const visibleModels = availableModels.filter(([name]) =>
      !models.some(model => model.name === name)
      && name.toLowerCase().includes(modelSearch.trim().toLowerCase()))
    const selectedModelDownloaded = models.some(model => model.name === selectedModel)

    const refreshModels = async () => {
      const response = await fetch('/api/local-llm/models')
      if (!response.ok) throw new Error(t('modelsLoadError'))
      const downloadedModels = await response.json() as ModelInfo[]
      setModels(downloadedModels)
      if (downloadedModels.length > 0 && !downloadedModels.some(model => model.name === selectedModel)) {
        setSelectedModel(downloadedModels[0].name)
      }
    }

    useEffect(() => {
      void refreshModels().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('modelsLoadError'))
      })
    }, [])

    const refreshServer = async () => {
      const response = await fetch('/api/local-llm/server/status')
      if (!response.ok) throw new Error(t('serverLoadError'))
      const result = await response.json() as ServerStatus
      setServer(result)
      if (result.build) setServerBuild(result.build)
    }

    useEffect(() => {
      void refreshServer().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('serverLoadError'))
      })
    }, [])

    const installServer = async () => {
      setServerBusy(true)
      setServerProgress(0)
      setError(null)
      const eventSource = new EventSource('/api/local-llm/progress')
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { type?: string; progress?: number }
          if (data.type === 'server') setServerProgress(Math.min(100, Math.max(0, Number(data.progress) || 0)))
        } catch {
          setError(t('progressServerError'))
        }
      }
      try {
        const response = await fetch('/api/local-llm/server/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ build: serverBuild })
        })
        if (!response.ok) throw new Error(t('serverDownloadError'))
        const result = await response.json() as ServerStatus
        if (result.error) throw new Error(result.error)
        setServer(result)
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('serverInstallError'))
      } finally {
        eventSource.close()
        setServerBusy(false)
      }
    }

    const toggleServer = async () => {
      setServerBusy(true)
      setError(null)
      try {
        if (!server?.running && !models.some(model => model.name === selectedModel)) {
          throw new Error(t('modelNotDownloaded'))
        }
        const response = await fetch(`/api/local-llm/server/${server?.running ? 'stop' : 'start'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(server?.running ? {} : {
            model: selectedModel,
            ...(selectedContextSize === undefined ? {} : { contextSize: selectedContextSize })
          })
        })
        if (!response.ok) throw new Error(server?.running ? t('stopError') : t('startError'))
        const result = await response.json() as ServerStatus
        if (result.error) throw new Error(result.error)
        setServer(result)
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('serverControlError'))
      } finally {
        setServerBusy(false)
      }
    }

    const handleDownload = async () => {
      setDownloading(selectedModel)
      setProgress(0)
      setError(null)
      const eventSource = new EventSource(`/api/local-llm/progress?model=${encodeURIComponent(selectedModel)}`)
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { model?: string; progress?: number }
          if (data.model === selectedModel) setProgress(Math.min(100, Math.max(0, Number(data.progress) || 0)))
        } catch {
          setError(t('progressDownloadError'))
        }
      }
      try {
        const response = await fetch('/api/local-llm/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: selectedModel })
        })
        if (!response.ok) throw await responseError(response, t('modelDownloadError'))
        await refreshModels()
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('modelDownloadControlError'))
      } finally {
        eventSource.close()
        setDownloading(null)
      }
    }

    const handleCustomDownload = () => {
      const url = customModelUrl.trim()
      if (!/^https?:\/\/[^\s]+\.gguf(?:\?[^\s]*)?$/i.test(url)) {
        setError(t('urlError'))
        return
      }
      setSelectedModel(url)
      const contextSize = Number(customContextSize)
      if (!Number.isInteger(contextSize) || contextSize < 2048 || contextSize > 131072) {
        setError(t('contextSizeError'))
        return
      }
      setSelectedContextSize(contextSize)
      localStorage.setItem(`dsh-local-llm-context:${url}`, String(contextSize))
      localStorage.setItem(`dsh-local-llm-context:${new URL(url).pathname.split('/').pop() || url}`, String(contextSize))
      setCustomModelUrl('')
      void handleDownloadFor(url)
    }

    const handleDownloadFor = async (model: string) => {
      setSelectedModel(model)
      setDownloading(model)
      setProgress(0)
      setError(null)
      const eventSource = new EventSource(`/api/local-llm/progress?model=${encodeURIComponent(model)}`)
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as { model?: string; progress?: number }
          if (data.model === model) setProgress(Math.min(100, Math.max(0, Number(data.progress) || 0)))
        } catch {
          setError(t('progressDownloadError'))
        }
      }
      try {
        const response = await fetch('/api/local-llm/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model })
        })
        if (!response.ok) throw await responseError(response, t('modelDownloadError'))
        await refreshModels()
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('modelDownloadControlError'))
      } finally {
        eventSource.close()
        setDownloading(null)
      }
    }

    const handleDelete = async (modelName: string) => {
      if (!window.confirm(t('deleteConfirm', { model: modelName }))) return
      try {
        const response = await fetch('/api/local-llm/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName })
        })
        if (!response.ok) throw new Error(t('deleteError'))
        await refreshModels()
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('deleteError'))
      }
    }

    return React.createElement('div', { className: 'model-manager' },
      React.createElement('div', { className: 'language-picker' },
        React.createElement('label', { htmlFor: 'dsh-local-llm-language' }, t('language')),
        React.createElement('select', {
          id: 'dsh-local-llm-language',
          value: locale,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => changeLocale(event.target.value as Locale)
        },
        React.createElement('option', { value: 'en' }, 'English'),
        React.createElement('option', { value: 'ru' }, 'Русский'),
        React.createElement('option', { value: 'zh' }, '中文'),
        React.createElement('option', { value: 'fr' }, 'Français'),
        React.createElement('option', { value: 'es' }, 'Español'),
        React.createElement('option', { value: 'it' }, 'Italiano'),
        React.createElement('option', { value: 'pl' }, 'Polski'),
        React.createElement('option', { value: 'de' }, 'Deutsch'),
        React.createElement('option', { value: 'hi' }, 'हिन्दी'),
        React.createElement('option', { value: 'ja' }, '日本語'))),
      React.createElement('div', { className: 'model-selector' },
        React.createElement('input', {
          className: 'model-search',
          value: modelSearch,
          placeholder: t('search'),
          'aria-label': t('search'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setModelSearch(event.target.value)
        }),
        React.createElement('select', {
          value: selectedModel,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            setSelectedModel(event.target.value)
            setSelectedContextSize(undefined)
          }
        }, visibleModels.length === 0
          ? React.createElement('option', { value: selectedModel }, t('allModelsDownloaded'))
          : visibleModels.map(([name, size]) => React.createElement('option', { key: name, value: name }, `${name} (${size})`))),
        !selectedModelDownloaded && React.createElement('button', { onClick: handleDownload, disabled: downloading !== null, className: 'btn-download' },
          downloading === selectedModel ? `⏳ ${t('downloading')}` : `📥 ${t('download')}`)
      ),
      React.createElement('div', { className: 'custom-model' },
        React.createElement('input', {
          className: 'model-search',
          value: customModelUrl,
          placeholder: t('directUrl'),
          'aria-label': t('directUrl'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCustomModelUrl(event.target.value)
        }),
        React.createElement('input', {
          type: 'number',
          min: 2048,
          max: 131072,
          step: 1024,
          value: customContextSize,
          'aria-label': t('contextSize'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCustomContextSize(event.target.value)
        }),
        React.createElement('span', { className: 'context-size-hint' }, t('contextSizeHint')),
        React.createElement('button', {
          type: 'button',
          onClick: handleCustomDownload,
          disabled: downloading !== null || customModelUrl.trim().length === 0,
          className: 'btn-download'
        }, `⬇ ${t('addByLink')}`)
      ),
      downloading && React.createElement('div', { className: 'progress-bar' },
        React.createElement('div', { className: 'progress-fill', style: { width: `${progress}%` } }, `${Math.round(progress)}%`)),
      error && React.createElement('p', { className: 'error-message', role: 'alert' }, error),
      React.createElement('div', { className: 'server-controls' },
        React.createElement('div', { className: 'server-status' },
          React.createElement('strong', null, t('server')),
          React.createElement('span', { className: server?.running ? 'server-online' : 'server-offline' },
            server?.running ? `${t('running')}: ${server.url}` : server?.installed ? t('installedStopped') : t('notInstalled'))),
        React.createElement('label', { className: 'server-build-picker', htmlFor: 'dsh-local-llm-server-build' }, t('serverBuild')),
        React.createElement('select', {
          id: 'dsh-local-llm-server-build',
          value: serverBuild,
          disabled: serverBusy || server?.running === true,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            const value = event.target.value as ServerBuild
            setServerBuild(value)
            localStorage.setItem('dsh-local-llm-server-build', value)
          }
        },
        React.createElement('option', { value: 'auto' }, t('serverBuildAuto')),
        React.createElement('option', { value: 'cuda' }, t('serverBuildCuda')),
        React.createElement('option', { value: 'cpu' }, t('serverBuildCpu'))),
        serverBusy && React.createElement('div', { className: 'server-progress' },
          React.createElement('div', { className: 'server-progress-label' }, t('percent', { value: String(Math.round(serverProgress)) })),
          React.createElement('div', { className: 'progress-bar' },
            React.createElement('div', { className: 'progress-fill', style: { width: `${serverProgress}%` } }))),
        React.createElement('div', { className: 'server-buttons' },
          (!server?.installed || server.build !== serverBuild) && React.createElement('button', { type: 'button', onClick: () => void installServer(), disabled: serverBusy || server?.running === true, className: 'btn-download' },
            serverBusy ? `⏳ ${t('installingServer')}` : `⬇ ${server?.installed ? t('switchServerBuild') : t('installServer')}`),
          server?.installed && (server.running || selectedModelDownloaded) && React.createElement('button', { type: 'button', onClick: () => void toggleServer(), disabled: serverBusy, className: server.running ? 'btn-stop' : 'btn-download' },
            server.running ? `■ ${t('stop')}` : `▶ ${t('start')}`))),
      React.createElement('div', { className: 'models-list' },
        React.createElement('h3', null, `📁 ${t('downloadedModels')}`),
        models.length === 0
          ? React.createElement('p', { className: 'empty-message' }, t('noModels'))
          : React.createElement('ul', null, models.map(model => React.createElement('li', { key: model.name, className: 'model-item' },
            React.createElement('button', {
              type: 'button',
              className: 'model-name model-select-button',
              onClick: () => setSelectedModel(model.name),
              title: selectedModel === model.name ? t('selectedModel') : t('selectModel')
            }, `${selectedModel === model.name ? '● ' : ''}${model.name}`),
            React.createElement('span', { className: 'model-size' }, `${t('modelContext', { value: String(modelContextSize(model.name)) })} · ${(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB`),
            React.createElement('button', { onClick: () => void handleDelete(model.name), className: 'btn-delete' }, `🗑️ ${t('delete')}`))))
      )
    )
  }

  function LocalModelsAction({ wide }: { wide: boolean }): ReactNode {
    const [open, setOpen] = useState(false)
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button',
        className: 'dsh-local-llm-entry',
        'data-dsh-local-llm-entry': '',
        'aria-label': text(initialLocale(), 'localModels'),
        onClick: () => setOpen(true)
      },
      React.createElement('span', { className: 'dsh-local-llm-entry-icon', 'aria-hidden': true }, '🤖'),
      wide && React.createElement('span', { className: 'dsh-local-llm-entry-label' }, text(initialLocale(), 'localModels'))),
      open && React.createElement('div', {
        className: 'dsh-local-llm-dialog-backdrop',
        role: 'presentation',
        onClick: () => setOpen(false)
      }, React.createElement('section', {
        className: 'dsh-local-llm-dialog',
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': 'dsh-local-llm-dialog-title',
        onClick: (event: React.MouseEvent) => event.stopPropagation()
      },
      React.createElement('div', { className: 'dsh-local-llm-dialog-header' },
        React.createElement('h2', { id: 'dsh-local-llm-dialog-title' }, text(initialLocale(), 'localModels')),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-local-llm-dialog-close',
          'aria-label': text(initialLocale(), 'close'),
          onClick: () => setOpen(false)
        }, '×')),
      React.createElement(ModelManager)))
    )
  }

  function LocalModelsIndicator({ wide }: { wide: boolean }): ReactNode {
    const [running, setRunning] = useState(false)
    const [locale, setLocale] = useState<Locale>(initialLocale)

    useEffect(() => {
      const onStorage = () => setLocale(initialLocale())
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    }, [])

    useEffect(() => {
      let active = true
      const refresh = async () => {
        try {
          const response = await fetch('/api/local-llm/server/status')
          if (!response.ok) return
          const status = await response.json() as ServerStatus
          if (active) setRunning(status.running)
        } catch {
          if (active) setRunning(false)
        }
      }
      void refresh()
      const timer = window.setInterval(() => { void refresh() }, 3000)
      return () => {
        active = false
        window.clearInterval(timer)
      }
    }, [])

    return React.createElement('div', {
      className: `dsh-local-llm-indicator ${running ? 'is-running' : 'is-stopped'}`,
      title: `local models: ${running ? 'on' : 'off'}`,
      'aria-label': `local models: ${running ? 'on' : 'off'}`
    },
    React.createElement('span', { className: 'dsh-local-llm-indicator-light', 'aria-hidden': true }),
    wide && React.createElement('span', null, `${text(locale, 'modelServer', { state: running ? text(locale, 'on') : text(locale, 'off') })}`))
  }

  return {
    inject: ['slots'],
    apply(ctx: { slots: { inject: (name: string, factory: () => unknown) => unknown; register: (options: { name: string; id: string; order?: number; priority?: number }, component: (props: { wide: boolean }) => ReactNode) => unknown } }) {
      ctx.slots.inject('sidebar.after-new-session', () => ctx.slots.register({
        name: 'sidebar.after-new-session',
        id: 'dsh-local-llm',
        order: 10
      }, LocalModelsAction))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-local-llm-indicator',
        order: 10
      }, LocalModelsIndicator))
    }
  }
}

type ModuleLoaderWindow = typeof globalThis & {
  __ModuleLoader__?: { load: (handoff: { id: string; factory: (moduleRequire: ModuleRequire) => Record<string, unknown> }) => void }
}

const moduleLoader = (globalThis as ModuleLoaderWindow).__ModuleLoader__
if (!moduleLoader) throw new Error('dsh-local-llm: __ModuleLoader__ is not installed')
moduleLoader.load({ id: 'dsh-local-llm', factory: createClientPlugin })
