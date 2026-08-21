import React from 'react'
import { ModelManager } from './components/ModelManager.js'
import './styles.css'

interface ClientContext {
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (options: { name: string; id: string; order?: number }, component: React.ComponentType<{ wide: boolean }>) => unknown
  }
}

interface SidebarActionProps {
  wide: boolean
}

export const inject = ['slots']

function LocalModelsAction({ wide }: SidebarActionProps) {
  if (!wide) return <span title="Local models">🤖</span>
  return (
    <div className="dsh-local-llm-ui">
      <h2>🤖 Local models (GGUF)</h2>
        <h2>🤖 Local models (GGUF)</h2>
      <ModelManager />
    </div>
  )
}

export function apply(ctx: ClientContext) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-local-llm',
    order: 10,
  }, LocalModelsAction))
}

export default { apply, inject }