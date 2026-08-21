import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
const MAX_REDIRECTS = 5

export interface ServerStatus {
  installed: boolean
  running: boolean
  url: string
  pid?: number
  version?: string
  contextSize?: number
  build?: ServerBuild
  error?: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface ReleaseInfo {
  tag_name: string
  assets: ReleaseAsset[]
}

export type ServerBuild = 'auto' | 'cuda' | 'cpu'

export class ServerManager {
  private readonly serverDir: string
  private readonly port: number
  private readonly contextSize: number
  private readonly autoContextSize: boolean
  private readonly serverUrl: string
  private serverBuild: ServerBuild
  private process: ChildProcess | undefined
  private lastError: string | undefined
  private activeContextSize: number | undefined
  private activeModelPath: string | undefined

  constructor(serverDir: string, port: number, contextSize = 8192, serverUrl = '', autoContextSize = true, serverBuild: ServerBuild = 'auto') {
    this.serverDir = path.resolve(serverDir)
    this.port = port
    this.contextSize = contextSize
    this.serverUrl = serverUrl
    this.autoContextSize = autoContextSize
    this.serverBuild = serverBuild
    fs.mkdirSync(this.serverDir, { recursive: true })
  }

  getStatus(): ServerStatus {
    const executable = this.findExecutable()
    const running = this.process?.exitCode === null
    return {
      installed: executable !== undefined,
      running,
      url: `http://127.0.0.1:${this.port}`,
      ...(this.process?.pid === undefined ? {} : { pid: this.process.pid }),
      ...(this.readVersion() === undefined ? {} : { version: this.readVersion() }),
      ...(this.activeContextSize === undefined ? {} : { contextSize: this.activeContextSize }),
      build: this.serverBuild,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  async install(build = this.serverBuild, onProgress?: (progress: number) => void): Promise<ServerStatus> {
    if (build !== this.serverBuild && this.process?.exitCode === null) this.stop()
    if (this.findExecutable() !== undefined && build === this.serverBuild) return this.getStatus()
    try {
      if (build !== this.serverBuild && this.findExecutable() !== undefined) {
        fs.rmSync(this.serverDir, { recursive: true, force: true })
        fs.mkdirSync(this.serverDir, { recursive: true })
        this.lastError = undefined
      }
      this.serverBuild = build
      const asset = this.serverUrl
        ? { name: path.basename(new URL(this.serverUrl).pathname), browser_download_url: this.serverUrl }
        : await this.findReleaseAsset(build)
      const archivePath = path.join(this.serverDir, asset.name || 'llama-server-download')
      await this.download(asset.browser_download_url, archivePath, onProgress)
      await this.extract(archivePath)
      fs.rmSync(archivePath, { force: true })
      if (this.findExecutable() === undefined) {
        throw new Error('The archive does not contain llama-server.exe. Choose a full llama.cpp binary archive')
      }
      this.lastError = undefined
      return this.getStatus()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Could not install the local server'
      throw error
    }
  }

  start(modelPath: string): ServerStatus {
    if (this.process?.exitCode === null) {
      if (this.activeModelPath === modelPath) return this.getStatus()
      this.stop()
    }
    const executable = this.findExecutable()
    if (!executable) throw new Error('Download the llama-server runtime first')
    if (!fs.existsSync(modelPath)) throw new Error('Model file not found')
    const contextSize = this.resolveContextSize(modelPath)
    this.activeContextSize = contextSize
    this.activeModelPath = modelPath

    const logPath = path.join(this.serverDir, 'llama-server.log')
    const logFile = fs.openSync(logPath, 'a')
    try {
      this.process = spawn(executable, [
        '--model', modelPath,
        '--host', '127.0.0.1',
        '--port', String(this.port),
        '--ctx-size', String(contextSize),
      ], { cwd: this.serverDir, stdio: ['ignore', logFile, logFile], windowsHide: true })
    } finally {
      fs.closeSync(logFile)
    }
    this.lastError = undefined
    this.process.once('exit', (code, signal) => {
      if (code !== 0) {
        this.lastError = `llama-server exited with code ${code ?? 'unknown'}${signal ? ` after signal ${signal}` : ''}. Check llama-server.log`
      }
    })
    this.process.once('error', (error) => {
      this.lastError = `Could not start llama-server: ${error.message}`
    })
    return this.getStatus()
  }

  private resolveContextSize(modelPath: string): number {
    if (!this.autoContextSize) return this.contextSize
    const modelName = path.basename(modelPath).toLowerCase()
    const compactModels = ['tinyllama', 'phi-2', 'phi-3', 'phi-4']
    const recommended = compactModels.some(name => modelName.includes(name)) ? 8192 : 16384
    return Math.max(this.contextSize, recommended)
  }

  stop(): ServerStatus {
    if (this.process?.exitCode === null) {
      this.process.kill()
      this.process = undefined
      this.activeContextSize = undefined
      this.activeModelPath = undefined
    }
    return this.getStatus()
  }

  private async findReleaseAsset(build = this.serverBuild): Promise<ReleaseAsset> {
    const release = await this.requestJson<ReleaseInfo>(GITHUB_RELEASES_URL)
    const platform = process.platform === 'win32' ? 'win' : process.platform
    const architecture = process.arch === 'x64' ? 'x64' : process.arch
    const candidates = release.assets.filter(asset => {
      const name = asset.name.toLowerCase()
      return name.startsWith('llama-')
        && name.includes(`-bin-${platform}-`)
        && name.includes(`-${architecture}.`)
        && /\.(zip|tar\.gz|tgz)$/.test(name)
    })

    const cudaCandidates = candidates.filter(candidate => candidate.name.toLowerCase().includes('cuda'))
    const cpuCandidates = candidates.filter(candidate => !candidate.name.toLowerCase().includes('cuda'))
    const asset = build === 'cuda'
      ? cudaCandidates[0]
      : build === 'cpu'
        ? cpuCandidates[0]
        : cudaCandidates[0] ?? cpuCandidates[0]
    if (!asset) {
      if (build === 'cuda') {
        throw new Error(`No CUDA llama-server archive found for ${platform}/${architecture}. Build llama.cpp with CUDA manually or choose the automatic/CPU build.`)
      }
      throw new Error(`No llama-server archive found for ${platform}/${architecture}`)
    }
    return asset
  }

  private findExecutable(): string | undefined {
    const executableName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const pending = [this.serverDir]
    while (pending.length > 0) {
      const current = pending.pop() as string
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name)
        if (entry.isDirectory()) pending.push(entryPath)
        else if (entry.name.toLowerCase() === executableName) return entryPath
      }
    }
    return undefined
  }

  private readVersion(): string | undefined {
    const versionPath = path.join(this.serverDir, 'version.txt')
    return fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : undefined
  }

  private async extract(archivePath: string): Promise<void> {
    const extension = archivePath.toLowerCase()
    if (extension.endsWith('.zip')) {
      if (process.platform === 'win32') {
        await this.runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${this.serverDir.replace(/'/g, "''")}' -Force`])
      } else {
        await this.runCommand('unzip', ['-o', archivePath, '-d', this.serverDir])
      }
      return
    }
    await this.runCommand('tar', ['-xzf', archivePath, '-C', this.serverDir])
  }

  private runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Extraction command exited with code ${code}`)))
    })
  }

  private requestJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'dsh-local-llm' } }, response => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          this.requestJson<T>(new URL(response.headers.location, url).toString()).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`GitHub returned HTTP ${status}`))
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          try { resolve(JSON.parse(body) as T) } catch { reject(new Error('GitHub returned invalid JSON')) }
        })
      }).on('error', reject)
    })
  }

  private download(url: string, destination: string, onProgress?: (progress: number) => void, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects while downloading the server'))
      https.get(url, { headers: { 'User-Agent': 'dsh-local-llm' } }, response => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          return this.download(new URL(response.headers.location, url).toString(), destination, onProgress, redirects + 1).then(resolve, reject)
        }
        if (status !== 200) {
          response.resume()
          return reject(new Error(`Server download failed: HTTP ${status}`))
        }
        const total = Number(response.headers['content-length'] ?? 0)
        let received = 0
        const temporary = `${destination}.part`
        const file = fs.createWriteStream(temporary)
        response.on('data', chunk => {
          received += chunk.length
          if (total > 0) onProgress?.(Math.min(100, received / total * 100))
        })
        response.pipe(file)
        file.on('finish', () => file.close(error => {
          if (error) return reject(error)
          fs.rename(temporary, destination, renameError => renameError ? reject(renameError) : resolve())
        }))
        file.on('error', error => { fs.rmSync(temporary, { force: true }); reject(error) })
        response.on('error', error => { file.destroy(); fs.rmSync(temporary, { force: true }); reject(error) })
      }).on('error', reject)
    })
  }
}
