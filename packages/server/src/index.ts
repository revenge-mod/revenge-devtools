import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import * as readline from 'node:readline'
import * as util from 'node:util'
import {
	DEFAULT_SETTINGS,
	LogLevel,
	MCPCommand,
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
import { handleMcpHttpRequest } from './mcp'
import type {
	HelloMessage,
	HiMessage,
	LogMessage,
	MCPResultMessage,
	Message,
	RunMessage,
	Settings,
} from '@revenge-mod/devtools-shared/types'
import type { WebSocket } from 'ws'
import type { ListClientsFn, RunMcpCommandFn } from './mcp'

function parseArgs() {
	const args = process.argv.slice(2)
	let port = 7864
	let watchPath: string | null = null
	let mcp = false
	let mcpPort: number | null = null
	let mcpPath = '/mcp'

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
		} else if (arg === '--mcp') {
			mcp = true
		} else if (arg === '--mcp-port') {
			mcp = true
			const portValue = args[++i]
			if (portValue) {
				mcpPort = Number(portValue)
				if (Number.isNaN(mcpPort)) {
					logger.error('Invalid MCP port number')
					process.exit(1)
				}
			}
		} else if (arg === '--mcp-path') {
			const pathValue = args[++i]
			if (pathValue)
				mcpPath = pathValue.startsWith('/') ? pathValue : `/${pathValue}`
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
			console.log(
				'  --mcp                    Enable the MCP server on the main port at the MCP path',
			)
			console.log(
				'  --mcp-port <port>        Enable the MCP server on a separate port',
			)
			console.log(
				'  --mcp-path <path>        Path for the MCP endpoint (default: /mcp)',
			)
			console.log('  --help, -h               Show this help')
			process.exit(0)
		}
	}

	return { port, watchPath, mcp, mcpPort, mcpPath }
}

const {
	port: PORT,
	watchPath: WATCH_PATH,
	mcp: MCP_ENABLED,
	mcpPort: MCP_PORT,
	mcpPath: MCP_PATH,
} = parseArgs()

interface ClientData {
	id: string
	info?: string
	alias?: string
	version: number
	authenticated: boolean
}

const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/

const clients = new Map<WebSocket, ClientData>()
const mappings = new Map<string, string>()
const settings: Settings = { ...DEFAULT_SETTINGS }

//#region MCP

interface PendingMcp {
	clientId: string
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout>
}

const pendingMcp = new Map<string, PendingMcp>()

const APPROVAL_REQUIRED_COMMANDS = new Set<string>([MCPCommand.Eval])
const sessionApprovedCommands = new Set<string>()
let approvalQueue: Promise<unknown> = Promise.resolve()
let denyActiveApproval: (() => void) | null = null

function formatMcpArgs(args: Record<string, unknown>): string {
	if (!Object.keys(args).length) return ''

	const preview = util.inspect(args, {
		colors: true,
		depth: 3,
		breakLength: Infinity,
		compact: true,
	})

	return preview.length > 256 ? `${preview.slice(0, 256)}\u2026` : preview
}

/**
 * Ask the developer to approve a sensitive MCP command via the REPL.
 * Prompts are serialized so concurrent requests never overlap.
 * CTRL+C while the prompt is shown denies the request.
 *
 * @returns `true` if allowed (once or for the session), `false` if denied.
 */
function requestApproval(
	command: string,
	clientId: string,
	args: Record<string, unknown>,
): Promise<boolean> {
	const ask = () =>
		new Promise<boolean>(resolve => {
			if (sessionApprovedCommands.has(command)) return resolve(true)

			clearPromptLine()
			logger.warn(`MCP wants to run "${command}" on client ${clientId}:`)
			logger.log(
				util.inspect(args, { colors: true, depth: 5, breakLength: 80 }),
			)

			const controller = new AbortController()

			denyActiveApproval = () => {
				denyActiveApproval = null
				controller.abort()
				logger.warn(`"${command}" denied`)
				resolve(false)
				rl.prompt()
			}

			rl.question(
				'Allow? [y]es once / [s]ession / [n]o > ',
				{ signal: controller.signal },
				answer => {
					denyActiveApproval = null
					const a = answer.trim().toLowerCase()
					if (a === 's' || a === 'session') {
						sessionApprovedCommands.add(command)
						logger.success(`"${command}" allowed for this session`)
						resolve(true)
					} else if (a === 'y' || a === 'yes' || a === 'allow') {
						resolve(true)
					} else {
						logger.warn(`"${command}" denied`)
						resolve(false)
					}
					rl.prompt()
				},
			)
		})

	const result = approvalQueue.then(ask, ask)
	approvalQueue = result
	return result
}

/**
 * Resolve the target client for an MCP command.
 *
 * @param clientId - Optional explicit client ID or alias. Exact ID matches
 * take precedence; alias matches resolve to the oldest connection.
 * @returns The matching authenticated client's WebSocket and ID.
 * @throws If no client matches, or if ambiguous when no ID is given.
 */
function resolveTargetClient(clientId?: string): {
	ws: WebSocket
	data: ClientData
} {
	const authed = [...clients.entries()].filter(
		([ws, data]) => data.authenticated && ws.readyState === ws.OPEN,
	)

	if (clientId) {
		const match =
			authed.find(([, data]) => data.id === clientId) ??
			authed.find(([, data]) => data.alias === clientId)
		if (!match)
			throw new Error(`No connected client with ID or alias "${clientId}"`)
		return { ws: match[0], data: match[1] }
	}

	if (authed.length === 0) throw new Error('No clients connected')
	if (authed.length > 1)
		throw new Error(
			`Multiple clients connected; specify a clientId. Connected: ${authed
				.map(([, d]) => d.id)
				.join(', ')}`,
		)

	return { ws: authed[0]![0], data: authed[0]![1] }
}

/**
 * Send an MCP command to a client and await its result. Commands requiring
 * approval prompt the developer first; denial rejects back to the caller.
 */
const runMcpCommand: RunMcpCommandFn = async (command, args, clientId) => {
	const { ws, data } = resolveTargetClient(clientId)

	const target = data.alias ? `${data.id} (${data.alias})` : data.id
	const preview = formatMcpArgs(args)
	logger.server(`MCP → ${target}: ${command}${preview ? ` ${preview}` : ''}`)

	if (
		APPROVAL_REQUIRED_COMMANDS.has(command) &&
		!sessionApprovedCommands.has(command)
	) {
		const allowed = await requestApproval(command, data.id, args)
		if (!allowed)
			throw new Error(
				`The developer denied this "${command}" request. Do not retry the same code; ask the developer for permission or use other tools instead.`,
			)
	}

	const id = crypto.randomUUID()

	const message: Message = {
		type: MessageType.MCPRun,
		data: { id, command, args },
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingMcp.delete(id)
			reject(new Error(`MCP command "${command}" timed out`))
		}, settings.server.mcp.commandTimeout)

		pendingMcp.set(id, { clientId: data.id, resolve, reject, timer })
		ws.send(serialize(message))
	})
}

function handleMcpResult(msg: MCPResultMessage) {
	const pending = pendingMcp.get(msg.data.id)
	if (!pending) return

	clearTimeout(pending.timer)
	pendingMcp.delete(msg.data.id)

	if (msg.data.ok) pending.resolve(msg.data.result)
	else pending.reject(new Error(msg.data.error ?? 'MCP command failed'))
}

function rejectPendingForClient(clientId: string, reason: string) {
	for (const [id, pending] of pendingMcp.entries()) {
		if (pending.clientId !== clientId) continue
		clearTimeout(pending.timer)
		pendingMcp.delete(id)
		pending.reject(new Error(reason))
	}
}

/**
 * List currently connected clients (read directly from server state).
 */
const listClients: ListClientsFn = () =>
	[...clients.values()].map(data => ({
		id: data.id,
		info: data.info,
		alias: data.alias,
		version: data.version,
		authenticated: data.authenticated,
	}))

/**
 * Read the request body and forward it to the stateless MCP HTTP handler.
 */
function routeMcpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
	const chunks: Buffer[] = []
	req.on('data', chunk => chunks.push(chunk as Buffer))
	req.on('end', async () => {
		let body: unknown
		const raw = Buffer.concat(chunks).toString('utf8')
		if (raw) {
			try {
				body = JSON.parse(raw)
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' })
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32700, message: 'Parse error' },
						id: null,
					}),
				)
				return
			}
		}

		try {
			await handleMcpHttpRequest(req, res, body, runMcpCommand, listClients)
		} catch (e) {
			logger.error('MCP request error:', e)
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' })
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32603, message: 'Internal server error' },
						id: null,
					}),
				)
			}
		}
	})
}

//#endregion MCP

/**
 * Node HTTP request handler. Routes the MCP endpoint (when enabled on the main
 * port) and otherwise returns the WebSocket-upgrade-required response.
 */
function httpRequestHandler(
	req: http.IncomingMessage,
	res: http.ServerResponse,
) {
	const url = req.url ?? '/'
	const pathOnly = url.split('?')[0]

	if (MCP_ENABLED && MCP_PORT === null && pathOnly === MCP_PATH) {
		routeMcpRequest(req, res)
		return
	}

	res.writeHead(426, { 'Content-Type': 'text/plain' })
	res.end('WebSocket connection required')
}

const server = http.createServer(httpRequestHandler)

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

				case MessageType.MCPResult:
					if (!clientInfo.authenticated) {
						ws.close(1008, 'Not authenticated')
						return
					}
					handleMcpResult(msg as MCPResultMessage)
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
			rejectPendingForClient(clientInfo.id, 'Client disconnected')
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

let sigintArmed = false

rl.on('SIGINT', () => {
	process.stdout.write('^C\n')

	if (denyActiveApproval) {
		denyActiveApproval()
		return
	}

	const line: string = (rl as any).line ?? ''

	if (line) {
		;(rl as any).line = ''
		;(rl as any).cursor = 0
		sigintArmed = false
		rl.prompt()
		return
	}

	if (sigintArmed) {
		logger.warn('Shutting down...')
		process.exit(0)
	}

	sigintArmed = true
	logger.log('(Press CTRL+C again to exit)')
	rl.prompt()
})

server.listen(PORT, () => {
	logger.success(`Server running on: ws://localhost:${PORT}`)

	if (MCP_ENABLED) {
		if (MCP_PORT !== null) {
			const mcpServer = http.createServer(routeMcpRequest)
			mcpServer.listen(MCP_PORT, () => {
				logger.success(
					`MCP server running on: http://localhost:${MCP_PORT}${MCP_PATH}`,
				)
			})
		} else {
			logger.success(
				`MCP server running on: http://localhost:${PORT}${MCP_PATH}`,
			)
		}
	}

	logger.log('Type .help for commands')
	logger.log('Press CTRL+C twice to exit')
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
	clientData.info = msg.data.info
	clientData.authenticated = true

	if (msg.data.alias != null) {
		if (ALIAS_PATTERN.test(msg.data.alias)) {
			clientData.alias = msg.data.alias
			logger.server(`Client ${clientData.id} alias: ${msg.data.alias}`)
		} else {
			logger.warn(
				`Client ${clientData.id} sent invalid alias "${msg.data.alias}" (must match ${ALIAS_PATTERN}); ignoring`,
			)
		}
	}

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

/**
 * Broadcast a message to all authenticated clients.
 *
 * @param message - Message to send to all clients
 */
export function broadcast(message: Message) {
	const payload = serialize(message)
	for (const [ws, data] of clients.entries()) {
		if (data.authenticated && ws.readyState === ws.OPEN) {
			ws.send(payload)
		}
	}
}

/**
 * Send a message to a specific client by ID.
 *
 * @param clientId - ID of the client to send to
 * @param message - Message to send
 * @returns `true` if the message was sent, `false` if client not found
 */
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

		// So the native watcher is only required when watching enabled
		import('@parcel/watcher').then(({ default: watcher }) => {
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
		})
	}
}

rl.on('line', line => {
	sigintArmed = false
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
			logger.log(
				'  .run <client> <code> - Execute code on a specific client (ID or alias)',
			)
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
					logger.log(
						`  ${data.id}${data.alias ? ` (${data.alias})` : ''} - v${data.version}${data.info ? ` - ${data.info}` : ''}`,
					)
				}
			}
			break
		}

		case '.run': {
			const rest = trimmed.slice('.run'.length).trim()
			const spaceIndex = rest.search(/\s/)
			if (spaceIndex === -1) {
				logger.warn('Usage: .run <client_id> <code>')
				break
			}

			const target = rest.slice(0, spaceIndex)
			const code = rest.slice(spaceIndex + 1).trim()

			try {
				const { ws, data } = resolveTargetClient(target)
				const runMsg: RunMessage = {
					type: MessageType.Run,
					data: {
						code,
						mappings: Object.fromEntries(mappings),
					},
				}
				ws.send(serialize(runMsg))
				logger.server(
					`Sent code to ${data.alias ? `${data.id} (${data.alias})` : data.id}`,
				)
			} catch (e) {
				logger.error((e as Error).message)
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
