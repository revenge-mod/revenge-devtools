import {
	DEFAULT_SETTINGS,
	LogLevel,
	MessageType,
	PROTOCOL_VERSION,
} from '@revenge-mod/devtools-shared/constants'
import {
	createDepthLimitedProxy,
	deserialize,
	serialize,
} from '@revenge-mod/devtools-shared/serializer'
import type {
	ClientSettings,
	HelloMessage,
	HiMessage,
	LogLevel as LogLevelType,
	LogMessage,
	Message,
	MessageType as MsgType,
	RunMessage,
} from '@revenge-mod/devtools-shared/types'

type MessageHandler = (msg: Message) => void

export class DevToolsClient {
	static version = PROTOCOL_VERSION
	ws: WebSocket | null = null
	settings: ClientSettings = DEFAULT_SETTINGS.client
	private scope: Record<string, any> = { devTools: this, vars: {} }
	private connected: boolean = false
	private authenticated: boolean = false
	private handlers = new Map<number, Set<MessageHandler>>()

	connect(url: string, info?: string) {
		const isOpen = this.ws?.readyState === WebSocket.OPEN
		if (isOpen) return

		try {
			this.ws = new WebSocket(url)

			this.ws.onopen = () => {
				this.connected = true
				this.sendHello(info)
			}

			this.ws.onmessage = event => {
				try {
					const msg = deserialize<Message>(event.data)
					this.handleMessage(msg)
				} catch (e) {
					console.error('[DevTools] Parse error:', e)
				}
			}

			this.ws.onerror = error => {
				console.error('[DevTools] WebSocket error:', error)
			}

			this.ws.onclose = () => {
				this.connected = false
				this.authenticated = false
			}
		} catch (e) {
			console.error('[DevTools] Connection error:', e)
		}
	}

	disconnect() {
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}

		this.connected = false
		this.authenticated = false
	}

	clearVars() {
		this.scope.vars = {}
	}

	expose(key: string, value: any) {
		this.scope[key] = value
	}

	private sendHello(info?: string) {
		const msg: HelloMessage = {
			type: MessageType.Hello,
			data: {
				version: PROTOCOL_VERSION,
				info,
			},
		}
		this.send(msg)
	}

	private handleMessage(msg: Message) {
		switch (msg.type) {
			case MessageType.Hi:
				this.handleHi(msg as HiMessage)
				break

			case MessageType.Run:
				this.handleRun(msg as RunMessage)
				break
		}

		const handlers = this.handlers.get(msg.type)
		if (handlers) {
			for (const handler of handlers) {
				handler(msg)
			}
		}
	}

	private handleHi(msg: HiMessage) {
		if (!msg.data.supported) {
			console.error('[DevTools] Version not supported by server')
			this.disconnect()
			return
		}

		if (this.authenticated)
			console.debug('[DevTools] Reloaded settings from server')

		this.authenticated = true
		this.settings = msg.data.settings
	}

	private handleRun(msg: RunMessage) {
		try {
			const mappings = msg.data.mappings || {}
			const scope = { ...this.scope }
			for (const [key, mapping] of Object.entries(mappings)) {
				scope[key] = this.resolveMapping(mapping as string)
			}

			// Wrap code to auto-return last expression
			const wrappedCode = this.wrapCodeWithAutoReturn(msg.data.code)
			const func = this.withScope(scope, wrappedCode)
			const result = func(...Object.values(scope))

			this.log(LogLevel.Default, [
				createDepthLimitedProxy(result, this.settings.log.inspectDepth),
			])
		} catch (e: any) {
			this.log(LogLevel.Error, [e.stack ?? e.message ?? String(e)])
		}
	}

	private wrapCodeWithAutoReturn(code: string): string {
		const trimmed = code.trim()
		if (trimmed.startsWith('return ')) return code

		const hasStatements =
			/[;{}]|^(let|const|var|if|for|while|function|class)\s/.test(trimmed)

		if (!hasStatements) return `return (${trimmed})`

		const lines = trimmed
			.split(/[;\n]+/)
			.map(l => l.trim())
			.filter(Boolean)

		if (!lines.length) return code

		const lastLine = lines[lines.length - 1]!
		const previousLines = lines.slice(0, -1)

		// Check if last line is a statement (not an expression)
		const isLastLineStatement =
			/^(let|const|var|if|for|while|function|class|return)\s/.test(lastLine)

		if (isLastLineStatement) return code

		const statementsCode = previousLines.join('\n')
		return statementsCode
			? `${statementsCode}\nreturn (${lastLine})`
			: `return (${lastLine})`
	}

	private withScope(scope: Record<string, unknown>, code: string) {
		return new Function(...Object.keys(scope), code)
	}

	private resolveMapping(path: string): any {
		try {
			return this.withScope(
				this.scope,
				this.wrapCodeWithAutoReturn(path),
			)(...Object.values(this.scope))
		} catch {
			return undefined
		}
	}

	private send(msg: Message) {
		const isOpen = this.ws?.readyState === WebSocket.OPEN
		if (isOpen && this.ws) {
			this.ws.send(serialize(msg))
		}
	}

	log(level: LogLevelType, message: any[]) {
		if (!this.authenticated) return
		if (level < this.settings.log.level) return

		const msg: LogMessage = {
			type: MessageType.Log,
			data: { level, message },
		}

		this.send(msg)
	}

	on(type: MsgType, handler: MessageHandler) {
		if (!this.handlers.has(type)) {
			this.handlers.set(type, new Set())
		}
		this.handlers.get(type)!.add(handler)
	}

	off(type: MsgType, handler: MessageHandler) {
		const handlers = this.handlers.get(type)
		if (handlers) {
			handlers.delete(handler)
		}
	}

	isConnected() {
		return this.connected && this.authenticated
	}
}
