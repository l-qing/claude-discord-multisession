export type ReplyOpts = { reply_to?: string; files?: string[] }

export type FetchedMessage = {
  id: string
  ts: string
  author_id: string
  author_name: string
  content: string
  attachment_count: number
}

export type DownloadedAttachment = {
  path: string
  name: string
  type: string
  bytes: number
}

export type ThreadInfo = {
  thread_id: string
  thread_name: string
  thread_url?: string
}

/**
 * Discord operations exposed to the daemon's UDS handlers. The real
 * implementation wraps discord.js; tests use FakeDiscordOps.
 */
export interface DiscordOps {
  reply(chat_id: string, text: string, opts?: ReplyOpts): Promise<string[]>
  react(chat_id: string, message_id: string, emoji: string): Promise<void>
  edit(chat_id: string, message_id: string, text: string): Promise<string>
  fetch(chat_id: string, limit: number): Promise<FetchedMessage[]>
  downloadAttachments(chat_id: string, message_id: string, dir: string): Promise<DownloadedAttachment[]>
  createThread(parent_channel_id: string, name: string): Promise<ThreadInfo>
  verifyThreadParent(thread_id: string): Promise<string | null>
  postPermissionPrompt(chat_id: string, request_id: string, tool_name: string): Promise<void>
  postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string): Promise<void>
}

export class FakeDiscordOps implements DiscordOps {
  calls: Array<Record<string, unknown>> = []
  private msgCounter = 0
  private threadCounter = 0
  private threadParents = new Map<string, string>()

  async reply(chat_id: string, text: string, opts: ReplyOpts = {}) {
    this.calls.push({ kind: 'reply', chat_id, text, reply_to: opts.reply_to, files: opts.files ?? [] })
    return [`fake-msg-${++this.msgCounter}`]
  }
  async react(chat_id: string, message_id: string, emoji: string) {
    this.calls.push({ kind: 'react', chat_id, message_id, emoji })
  }
  async edit(chat_id: string, message_id: string, text: string) {
    this.calls.push({ kind: 'edit', chat_id, message_id, text })
    return message_id
  }
  async fetch(chat_id: string, limit: number) {
    this.calls.push({ kind: 'fetch', chat_id, limit })
    return [] as FetchedMessage[]
  }
  async downloadAttachments(chat_id: string, message_id: string, _dir: string) {
    this.calls.push({ kind: 'download', chat_id, message_id })
    return [] as DownloadedAttachment[]
  }
  async createThread(parent_channel_id: string, name: string) {
    const thread_id = `fake-thread-${++this.threadCounter}`
    this.threadParents.set(thread_id, parent_channel_id)
    this.calls.push({ kind: 'createThread', parent_channel_id, name, thread_id })
    return { thread_id, thread_name: name }
  }
  async verifyThreadParent(thread_id: string) {
    return this.threadParents.get(thread_id) ?? null
  }
  async postPermissionPrompt(chat_id: string, request_id: string, tool_name: string) {
    this.calls.push({ kind: 'permPrompt', chat_id, request_id, tool_name })
  }
  async postPermissionPromptDM(allowFrom: string[], request_id: string, tool_name: string) {
    this.calls.push({ kind: 'permPromptDM', allowFrom, request_id, tool_name })
  }
}
