import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import * as readline from 'node:readline'
import * as util from 'node:util'
import watcher from '@parcel/watcher'
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
import { WebSocketServer } from 'ws'
import type {
	HelloMessage,
	HiMessage,
	LogMessage,
	Message,
	RunMessage,
	Settings,
} from '@revenge-mod/devtools-shared/types'
import type { WebSocket } from 'ws'

function parseArgs() {
	const args = process.argv.slice(2)
	let port = 7864
	let watchPath: string | null = null

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === '--port' || arg === '-p') {
			const portValue = args[++i]
			if (portValue) {
				port = Number(portValue)
				if (Number.isNaN(port)) {
					logger.error('Invalid port number')
					process.exit(1)
				}
			}
		} else if (arg === '--watch' || arg === '-w') {
			// Check if next arg exists and is not another flag
			const nextArg = args[i + 1]
			if (nextArg && !nextArg.startsWith('-')) {
				watchPath = args[++i]!
			} else {
				// --watch specified without path, use current directory
				watchPath = process.cwd()
			}
		} else if (arg === '--help' || arg === '-h') {
			console.log('Usage: revenge-devtools [options]')
			console.log('')
			console.log('Options:')
			console.log(
				'  --port, -p <port>        Port to listen on (default: 7864)',
			)
			console.log(
				'  --watch, -w [path]       Enable file watching (default: current directory if no path provided)',
			)
			console.log('  --help, -h               Show this help')
			process.exit(0)
		}
	}

	return { port, watchPath }
}

const { port: PORT, watchPath: WATCH_PATH } = parseArgs()

interface ClientData {
	id: string
	version: number
	authenticated: boolean
}

const clients = new Map<WebSocket, ClientData>()
const mappings = new Map<string, string>()
const settings: Settings = { ...DEFAULT_SETTINGS }

const server = http.createServer((_req, res) => {
	res.writeHead(426, { 'Content-Type': 'text/plain' })
	res.end('WebSocket connection required')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
	const clientData: ClientData = {
		id: crypto.randomUUID().slice(0, 8),
		version: 0,
		authenticated: false,
	}

	clients.set(ws, clientData)

	const remoteAddress = req.socket.remoteAddress || 'unknown'
	logger.server(`Connection open: ${remoteAddress}`)

	ws.on('message', data => {
		try {
			const msg = deserialize<Message>(data.toString())
			const clientInfo = clients.get(ws)!

			switch (msg.type) {
				case MessageType.Hello:
					handleHello(ws, msg as HelloMessage)
					break

				case MessageType.Log:
					if (!clientInfo.authenticated) {
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
	})

	ws.on('close', (code, reason) => {
		const clientInfo = clients.get(ws)
		if (clientInfo) {
			logger.server(
				`Client disconnected: ${clientInfo.id} (${code}: ${reason.toString()})`,
			)
		}
		clients.delete(ws)
	})

	ws.on('error', error => {
		logger.error('WebSocket error:', error)
	})
})

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: '> ',
})

server.listen(PORT, () => {
	logger.success(`Server running on: ws://localhost:${PORT}`)
	logger.log('Type .help for commands')
	logger.log('Press CTRL+C to exit')
	rl.prompt()
})

function handleHello(ws: WebSocket, msg: HelloMessage) {
	const clientData = clients.get(ws)!

	if (msg.data.version !== PROTOCOL_VERSION) {
		logger.server(
			`Client rejected (v${msg.data.version} != v${PROTOCOL_VERSION}): ${clientData.id}`,
		)

		return ws.close(4000, 'Protocol version mismatch')
	}

	logger.server(`Client connected: ${clientData.id} (v${msg.data.version})`)

	clientData.version = msg.data.version
	clientData.authenticated = true

	const response: HiMessage = {
		type: MessageType.Hi,
		data: {
			version: PROTOCOL_VERSION,
			supported: true,
			settings: settings.client,
		},
	}

	ws.send(serialize(response))
}

function handleLog(ws: WebSocket, msg: LogMessage) {
	const clientData = clients.get(ws)!
	const clientLog = createClientLogger(clientData.id)

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
	for (const [ws, data] of clients.entries()) {
		if (data.authenticated && ws.readyState === ws.OPEN) {
			ws.send(payload)
		}
	}
}

export function sendToClient(clientId: string, message: Message) {
	const payload = serialize(message)
	for (const [ws, data] of clients.entries()) {
		if (
			data.id === clientId &&
			data.authenticated &&
			ws.readyState === ws.OPEN
		) {
			ws.send(payload)
			return true
		}
	}
	return false
}

if (WATCH_PATH) {
	const absoluteWatchPath = path.isAbsolute(WATCH_PATH)
		? WATCH_PATH
		: path.resolve(process.cwd(), WATCH_PATH)

	if (!fs.existsSync(absoluteWatchPath)) {
		logger.error(`Watch path does not exist: ${absoluteWatchPath}`)
	} else {
		logger.log(`Watching for file changes: ${absoluteWatchPath}`)

		watcher
			.subscribe(absoluteWatchPath, (err, events) => {
				if (err) {
					logger.error('Watcher error:', err)
					return
				}

				if (!events.length) return

				clearPromptLine()

				if (settings.server.watch.command) {
					const runMsg: RunMessage = {
						type: MessageType.Run,
						data: {
							code: settings.server.watch.command,
							mappings: Object.fromEntries(mappings),
						},
					}
					broadcast(runMsg)
					logger.server('Broadcasted watch command to clients')
				}

				rl.prompt()
			})
			.then(subscription => {
				process.on('SIGINT', async () => {
					await subscription.unsubscribe()
					process.exit(0)
				})
			})
			.catch(err => {
				logger.error('Failed to start file watcher:', err)
			})
	}
}

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

				logger.log('  client:')
				printNestedSettings(settings.client, '    ')

				logger.log('  server:')
				printNestedSettings(settings.server, '    ')

				break
			}

			const path = args[0]!
			const value = args.slice(1).join(' ')

			// Get value
			if (!value) {
				const current = getNestedValue(settings, path)
				const defaultVal = getNestedValue(DEFAULT_SETTINGS, path)
				logger.log(
					`${path}: ${util.inspect(current, { colors: true })} (default: ${util.inspect(defaultVal, { colors: true })})`,
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
					settings: settings.client,
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

function printNestedSettings(obj: any, indent: string): void {
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			logger.log(`${indent}${key}:`)
			printNestedSettings(value, `${indent}  `)
		} else {
			logger.log(`${indent}${key}: ${util.inspect(value, { colors: true })}`)
		}
	}
}

rl.on('close', () => {
	process.exit(0)
})

// Update prompt state for logger
setInterval(() => {
	const line = (rl as any).line || ''
	setPrompt('> ', line)
}, 100)
