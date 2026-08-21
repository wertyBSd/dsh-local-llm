import React, { useState, useEffect } from 'react'

interface ModelInfo {
  name: string
  size: number
  downloaded: boolean
  path?: string
}

export const ModelManager: React.FC = () => {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [downloading, setDownloading] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState('mistral-7b-instruct-v0.3-Q4_K_M.gguf')

  const availableModels = [
    { name: 'mistral-7b-instruct-v0.3-Q4_K_M.gguf', size: '4.5 GB' },
    { name: 'llama-3-8b-instruct-q4_K_M.gguf', size: '4.7 GB' },
    { name: 'deepseek-coder-6.7b-instruct-q4_K_M.gguf', size: '4.2 GB' },
    { name: 'qwen-2.5-7b-instruct-q4_K_M.gguf', size: '4.3 GB' }
  ]

  useEffect(() => {
    fetch('/api/local-llm/models')
      .then(res => {
        if (!res.ok) throw new Error('Could not load the model list')
        return res.json()
      })
      .then((data: ModelInfo[]) => setModels(data))
      .catch(console.error)
  }, [])

  const handleDownload = async (modelName: string) => {
    setDownloading(modelName)
    setProgress(0)
    setError(null)
    const eventSource = new EventSource(`/api/local-llm/progress?model=${encodeURIComponent(modelName)}`)

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.model === modelName) setProgress(Math.min(100, Math.max(0, Number(data.progress) || 0)))
      } catch {
        setError('Could not process download progress')
      }
    }

    try {
      const response = await fetch('/api/local-llm/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      })

      if (!response.ok) throw new Error('Model download failed')
      const data = await fetch('/api/local-llm/models').then(res => res.json()) as ModelInfo[]
      setModels(data)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Model download error')
    } finally {
      eventSource.close()
      setDownloading(null)
    }
  }

  const handleDelete = async (modelName: string) => {
    if (!window.confirm(`Delete model ${modelName}?`)) return

    try {
      const response = await fetch('/api/local-llm/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName })
      })

      if (!response.ok) throw new Error('Model deletion failed')

      const data = await fetch('/api/local-llm/models').then(res => res.json()) as ModelInfo[]
      setModels(data)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Model deletion error')
    }
  }

  return (
    <div className="model-manager">
      <div className="model-selector">
        <select 
          value={selectedModel} 
          onChange={(e) => setSelectedModel(e.target.value)}
        >
          {availableModels.map(model => (
            <option key={model.name} value={model.name}>
              {model.name} ({model.size})
            </option>
          ))}
        </select>
        <button 
          onClick={() => handleDownload(selectedModel)}
          disabled={!!downloading}
          className="btn-download"
        >
          {downloading === selectedModel ? '⏳ Downloading...' : '📥 Download'}
        </button>
      </div>

      {downloading && (
        <div className="progress-bar">
          <div 
            className="progress-fill" 
            style={{ width: `${progress}%` }}
          >
            {Math.round(progress)}%
          </div>
        </div>
      )}

      {error && <p className="error-message" role="alert">{error}</p>}

      <div className="models-list">
        <h3>📁 Downloaded models</h3>
        {models.length === 0 ? (
          <p className="empty-message">No downloaded models</p>
        ) : (
          <ul>
            {models.map(model => (
              <li key={model.name} className="model-item">
                <span className="model-name">{model.name}</span>
                <span className="model-size">
                  {(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB
                </span>
                <button 
                  onClick={() => handleDelete(model.name)}
                  className="btn-delete"
                >
                  🗑️ Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}