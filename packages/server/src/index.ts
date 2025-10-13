import * as readline from 'node:readline'
import {
	DEFAULT_SETTINGS,
	LogLevel,
	MessageType,
	PROTOCOL_VERSION,
} from '@revenge-mod/devtools-shared/constants'
import {
	clearPromptLine,
	createClientLogger,
	logger,
	setPrompt,
} from '@revenge-mod/devtools-shared/logger'
import { deserialize, serialize } from '@revenge-mod/devtools-shared/serializer'
import type {
	HelloMessage,
	HiMessage,
	LogMessage,
	Message,
	RunMessage,
	Settings,
} from '@revenge-mod/devtools-shared/types'
import type { ServerWebSocket } from 'bun'

const PORT = process.env.PORT ? Number(process.env.PORT) : 7864

interface ClientData {
	id: string
	version: number
	authenticated: boolean
}

const clients = new Map<ServerWebSocket<ClientData>, ClientData>()
const mappings = new Map<string, string>()
const settings: Settings = { ...DEFAULT_SETTINGS }

Bun.serve<ClientData>({
	port: PORT,
	fetch(req, server) {
		const upgraded = server.upgrade(req, {
			data: {
				id: crypto.getRandomValues(new Uint8Array(4)).toHex(),
				version: 0,
				authenticated: false,
			},
		})

		if (!upgraded)
			return new Response('WebSocket upgrade failed', { status: 500 })

		return
	},

	websocket: {
		open(ws) {
			logger.server(`Connection open: ${ws.remoteAddress}`)
		},

		message(ws, data) {
			try {
				const msg = deserialize<Message>(data.toString())

				switch (msg.type) {
					case MessageType.Hello:
						handleHello(ws, msg as HelloMessage)
						break

					case MessageType.Log:
						if (!ws.data.authenticated) {
							ws.close(1008, 'Not authenticated')
							return
						}
						handleLog(ws, msg as LogMessage)
						break

					default:
						logger.warn(`Unknown message type: ${msg.type}`)
				}
			} catch (e) {
				logger.error('Parse error:', e)
			}
		},

		close(ws, code, reason) {
			logger.server(`Client disconnected: ${ws.data.id} (${code}: ${reason})`)
			clients.delete(ws)
		},
	},
})

function handleHello(ws: ServerWebSocket<ClientData>, msg: HelloMessage) {
	if (msg.data.version !== PROTOCOL_VERSION)
		logger.server(
			`Client rejected (v${msg.data.version} != v${PROTOCOL_VERSION}): ${ws.data.id}`,
		)

	logger.server(`Client connected: ${ws.data.id} (v${msg.data.version})`)

	ws.data.version = msg.data.version
	ws.data.authenticated = true
	clients.set(ws, ws.data)

	const response: HiMessage = {
		type: MessageType.Hi,
		data: {
			version: PROTOCOL_VERSION,
			supported: true,
			settings,
		},
	}

	ws.send(serialize(response))
}

function handleLog(ws: ServerWebSocket<ClientData>, msg: LogMessage) {
	const clientLog = createClientLogger(ws.data.id)

	switch (msg.data.level) {
		case LogLevel.Debug:
			clientLog.debug(...msg.data.message)
			break
		case LogLevel.Default:
			clientLog.log(...msg.data.message)
			break
		case LogLevel.Warn:
			clientLog.warn(...msg.data.message)
			break
		case LogLevel.Error:
			clientLog.error(...msg.data.message)
			break
		default:
			clientLog.log(...msg.data.message)
	}
}

export function broadcast(message: Message) {
	const payload = serialize(message)
	for (const ws of clients.keys()) {
		if (ws.data.authenticated) {
			ws.send(payload)
		}
	}
}

export function sendToClient(clientId: string, message: Message) {
	const payload = serialize(message)
	for (const [ws, data] of clients.entries()) {
		if (data.id === clientId && data.authenticated) {
			ws.send(payload)
			return true
		}
	}
	return false
}

logger.success(`Server running on: ws://localhost:${PORT}`)
logger.log('Type .help for commands')
logger.log('Press CTRL+C to exit')

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: '> ',
})

rl.on('line', line => {
	const trimmed = line.trim()
	clearPromptLine()

	if (!trimmed) {
		rl.prompt()
		return
	}

	const [command, ...args] = trimmed.split(/\s+/)

	switch (command) {
		case '.help':
		case '?': {
			logger.log('Commands:')
			logger.log('  .clients, .ls        - List connected clients')
			logger.log('  .map+ var path       - Add variable mapping')
			logger.log('  .map- var            - Remove variable mapping')
			logger.log('  .map                 - Show current mappings')
			logger.log('  .setting key [value] - Get/set setting')
			logger.log('  .help, ?             - Show this help')
			logger.log('  .exit, .quit, .q     - Exit server')
			logger.log('  <code>               - Execute code on all clients')
			break
		}

		case '.exit':
		case '.quit':
		// biome-ignore lint/suspicious/noFallthroughSwitchClause: process.exit()
		case '.q': {
			logger.warn('Shutting down...')
			process.exit(0)
		}

		case '.ls':
		case '.clients': {
			if (clients.size === 0) logger.log('No clients connected')
			else {
				logger.log(`Connected clients (${clients.size}):`)
				for (const [_ws, data] of clients.entries()) {
					logger.log(`  ${data.id} - v${data.version}`)
				}
			}
			break
		}

		case '.map': {
			if (mappings.size === 0) {
				logger.log('No mappings')
			} else {
				logger.log(`Current mappings (${mappings.size}):`)
				for (const [key, path] of mappings.entries()) {
					logger.log(`  ${key} -> ${path}`)
				}
			}
			break
		}

		case '.map+': {
			const parts = trimmed.slice(5).split(' ')
			if (parts.length < 2) {
				logger.warn('Usage: map+ <var> <path>')
			} else {
				const varName = args.shift()!
				const mapping = args.join(' ')
				mappings.set(varName, mapping)
				logger.success(`Mapped: ${varName} -> ${mapping}`)
			}
			break
		}

		case '.map-': {
			const mapping = args[0]!
			if (mappings.has(mapping)) {
				mappings.delete(mapping)
				logger.success(`Removed mapping: ${mapping}`)
			} else {
				logger.warn(`No mapping found: ${mapping}`)
			}
			break
		}

		case '.setting': {
			if (args.length === 0) {
				logger.log('Current settings:')
				for (const [key, value] of Object.entries(settings)) {
					logger.log(`  ${key}: ${Bun.inspect(value, { colors: true })}`)
				}
				break
			}

			const path = args[0]!
			const value = args.slice(1).join(' ')

			// Get value
			if (!value) {
				const current = getNestedValue(settings, path)
				const defaultVal = getNestedValue(DEFAULT_SETTINGS, path)
				logger.log(
					`${path}: ${Bun.inspect(current, { colors: true })} (default: ${Bun.inspect(defaultVal, { colors: true })})`,
				)
				break
			}

			// Try to parse as number if possible
			const parsedValue = !Number.isNaN(Number(value)) ? Number(value) : value
			setNestedValue(settings, path, parsedValue)
			logger.success(`Set ${path} = ${parsedValue}`)

			const msg: HiMessage = {
				type: MessageType.Hi,
				data: {
					settings,
					version: PROTOCOL_VERSION,
					// safe to assume all clients connected are supported
					supported: true,
				},
			}

			broadcast(msg)

			break
		}

		default: {
			if (!clients.size) {
				logger.error('No clients connected')
				break
			}

			const runMsg: RunMessage = {
				type: MessageType.Run,
				data: {
					code: trimmed,
					mappings: Object.fromEntries(mappings),
				},
			}

			broadcast(runMsg)
		}
	}

	rl.prompt()
})

function getNestedValue(obj: any, path: string): any {
	return path.split('.').reduce((acc, key) => acc?.[key], obj)
}

function setNestedValue(obj: any, path: string, value: any): void {
	const keys = path.split('.')
	const lastKey = keys.pop()!
	const target = keys.reduce((acc, key) => {
		if (!(key in acc)) acc[key] = {}
		return acc[key]
	}, obj)
	target[lastKey] = value
}

rl.on('close', () => {
	process.exit(0)
})

// Update prompt state for logger
setInterval(() => {
	const line = (rl as any).line || ''
	setPrompt('> ', line)
}, 100)

rl.prompt()
