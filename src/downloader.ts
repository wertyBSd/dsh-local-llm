import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'

const MAX_REDIRECTS = 5

export interface DownloadOptions {
  url: string
  dest: string
  onProgress?: (progress: number) => void
}

export class ModelDownloader {
  private downloadDir: string
  private downloads = new Map<string, Promise<string>>()

  constructor(downloadDir: string) {
    this.downloadDir = path.resolve(downloadDir)
    // Create the directory if it does not exist.
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true })
    }
  }

  /**
  * Download a model from Hugging Face.
   */
  async downloadModel(modelName: string, onProgress?: (progress: number) => void): Promise<string> {
    const fileName = this.getFileName(modelName)
    const modelPath = this.getModelPath(fileName)
    
    // Avoid downloading a model that already exists.
    if (fs.existsSync(modelPath)) {
      console.log(`✅ Model ${modelName} already exists`)
      return modelPath
    }

    const activeDownload = this.downloads.get(fileName)
    if (activeDownload) return activeDownload

    const download = this.downloadModelFile(modelName, fileName, modelPath, onProgress)
    this.downloads.set(fileName, download)
    try {
      return await download
    } finally {
      this.downloads.delete(fileName)
    }
  }

  private async downloadModelFile(modelName: string, fileName: string, modelPath: string, onProgress?: (progress: number) => void): Promise<string> {
    console.log(`📥 Downloading model ${fileName}...`)

    // Build the Hugging Face download URL.
    const url = this.getHuggingFaceUrl(modelName)
    
    await this.downloadFile(url, modelPath, onProgress)
    
    console.log(`✅ Model ${fileName} downloaded successfully`)
    return modelPath
  }

  /**
  * Get the Hugging Face download URL.
   */
  private getHuggingFaceUrl(modelName: string): string {
    // Use the supplied URL when the model value is already a URL.
    if (modelName.startsWith('http://') || modelName.startsWith('https://')) {
      return modelName
    }

    // Resolve short names through the built-in URL catalog.
    
    // Popular model examples.
    const knownModels: Record<string, string> = {
      'mistral-7b-instruct-v0.3-Q4_K_M.gguf': 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
      'llama-3-8b-instruct-q4_K_M.gguf': 'https://huggingface.co/bartowski/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q4_K_M.gguf',
      'deepseek-coder-6.7b-instruct-q4_K_M.gguf': 'https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/resolve/main/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
      'qwen-2.5-7b-instruct-q4_K_M.gguf': 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf': 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
      'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf': 'https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
      'gemma-2-9b-it-Q4_K_M.gguf': 'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
      'Phi-3.5-mini-instruct-Q4_K_M.gguf': 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
      'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf': 'https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/resolve/main/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
      'StarCoder2-7B-Q4_K_M.gguf': 'https://huggingface.co/bartowski/StarCoder2-7B-GGUF/resolve/main/StarCoder2-7B-Q4_K_M.gguf',
      'TinyLlama-1.1B-Chat-v1.0-Q4_K_M.gguf': 'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf'
    }

    if (knownModels[modelName]) {
      return knownModels[modelName]
    }

    // Unknown models must be supplied as direct URLs.
    throw new Error(`Unknown model: ${modelName}. Provide a direct URL or add it to knownModels`)
  }

  /**
  * Download a file and report progress.
   */
  private downloadFile(url: string, dest: string, onProgress?: (progress: number) => void): Promise<void> {
    return this.downloadFileFromUrl(url, dest, onProgress, 0)
  }

  private downloadFileFromUrl(url: string, dest: string, onProgress: ((progress: number) => void) | undefined, redirectCount: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (redirectCount > MAX_REDIRECTS) {
        reject(new Error('Too many redirects while downloading'))
        return
      }

      const protocol = url.startsWith('https://') ? https : http
      
      protocol.get(url, (response) => {
        const statusCode = response.statusCode || 0
        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume()
          const nextUrl = new URL(response.headers.location, url).toString()
          this.downloadFileFromUrl(nextUrl, dest, onProgress, redirectCount + 1)
            .then(resolve)
            .catch(reject)
          return
        }

        // Check the response status.
        if (statusCode !== 200) {
          response.resume()
          reject(new Error(`Download failed: ${statusCode} ${response.statusMessage || ''}`.trim()))
          return
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10)
        let downloadedSize = 0

        // Write to a temporary file until the download completes.
        const temporaryPath = `${dest}.part`
        const file = fs.createWriteStream(temporaryPath)
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length
          if (totalSize > 0 && onProgress) {
            const progress = (downloadedSize / totalSize) * 100
            onProgress(Math.min(progress, 100))
          }
        })

        response.pipe(file)

        file.on('finish', () => {
          file.close((error) => {
            if (error) {
              fs.unlink(temporaryPath, () => {})
              reject(error)
              return
            }
            fs.rename(temporaryPath, dest, (renameError) => {
              if (renameError) {
                fs.unlink(temporaryPath, () => {})
                reject(renameError)
                return
              }
              resolve()
            })
          })
        })

        file.on('error', (err) => {
          fs.unlink(temporaryPath, () => {})
          reject(err)
        })

        response.on('error', (err) => {
          file.destroy()
          fs.unlink(temporaryPath, () => {})
          reject(err)
        })
      }).on('error', (err) => {
        reject(err)
      })
    })
  }

  /**
  * Check whether a model exists.
   */
  isModelDownloaded(modelName: string): boolean {
    const modelPath = this.getModelPath(this.getFileName(modelName))
    return fs.existsSync(modelPath)
  }

  /**
  * List downloaded models.
   */
  getDownloadedModels(): string[] {
    if (!fs.existsSync(this.downloadDir)) {
      return []
    }
    return fs.readdirSync(this.downloadDir).filter(file => 
      file.endsWith('.gguf')
    )
  }

  /**
  * Delete a model.
   */
  removeModel(modelName: string): boolean {
    const modelPath = this.getModelPath(this.getFileName(modelName))
    if (!fs.existsSync(modelPath)) {
      return false
    }
    fs.unlinkSync(modelPath)
    return true
  }

  getModelPath(modelName: string): string {
    return path.join(this.downloadDir, this.getFileName(modelName))
  }

  private getFileName(modelName: string): string {
    let fileName = modelName
    try {
      if (modelName.startsWith('http://') || modelName.startsWith('https://')) {
        fileName = path.basename(new URL(modelName).pathname)
      }
    } catch {
      throw new Error('Invalid model URL')
    }

    if (!fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName || !fileName.endsWith('.gguf')) {
      throw new Error('The model name must be a filename ending in .gguf')
    }
    return fileName
  }
}