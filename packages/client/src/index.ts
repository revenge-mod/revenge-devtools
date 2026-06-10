import {
	DEFAULT_SETTINGS,
	LogLevel,
	MCPCommand,
	MessageType,
	PROTOCOL_VERSION,
} from '@revenge-mod/devtools-shared/constants'
import {
	deserialize,
	serialize,
	snapshot,
} from '@revenge-mod/devtools-shared/serializer'
import {
	getDisplayName,
	getRDTHook,
	isHostFiber,
	isValidFiber,
	onCommitFiberRoot,
	traverseFiber,
} from 'bippy'
import { CircularBuffer } from 'mnemonist'
import type {
	ClientSettings,
	HelloMessage,
	HiMessage,
	LogLevel as LogLevelType,
	LogMessage,
	MCPDiscordFluxListenArgs,
	MCPDiscordFluxPatchArgs,
	MCPDiscordFluxUnpatchArgs,
	MCPEvalArgs,
	MCPGetLogsArgs,
	MCPGetModulesArgs,
	MCPLookupModulesArgs,
	MCPPatchMethodArgs,
	MCPReactTreeHooksArgs,
	MCPReactTreeMatchArgs,
	MCPReactTreeTraverseStructureArgs,
	MCPRequireModuleArgs,
	MCPResultMessage,
	MCPRunMessage,
	MCPSaveVarArgs,
	MCPUnpatchMethodArgs,
	Message,
	MessageType as MsgType,
	RunMessage,
} from '@revenge-mod/devtools-shared/types'
import type { Fiber } from 'bippy'
import type { RevengeScope } from './revenge-types'

type MessageHandler = (msg: Message) => void

interface LogEntry {
	level: LogLevelType
	time: number
	message: any[]
}

/**
 * WebSocket client for connecting React Native apps to the Revenge Developer Tools server.
 *
 * Enables real-time debugging by:
 * - Sending logs to the server console
 * - Executing code remotely from the server
 * - Exposing variables for inspection
 *
 * @example
 * ```ts
 * import { DevToolsClient } from "@revenge-mod/devtools-client"
 * import { LogLevel } from '@revenge-mod/devtools-shared/constants'
 *
 * const client = new DevToolsClient()
 * client.connect("ws://localhost:7864", "My App")
 *
 * // Expose variables
 * client.expose('user', { name: 'John', age: 30 })
 *
 * // Send logs
 * client.log(LogLevel.Default, ["Hello from client"])
 * ```
 */
export class DevToolsClient {
	/** Protocol version used by this client */
	static version = PROTOCOL_VERSION

	/** WebSocket connection instance */
	ws: WebSocket | null = null

	/** Current client settings received from server */
	settings: ClientSettings = DEFAULT_SETTINGS.client

	private scope: Record<string, any> = { devTools: this, vars: { mcp: {} } }
	private connected: boolean = false
	private authenticated: boolean = false
	private handlers = new Map<number, Set<MessageHandler>>()
	private alias?: string

	private logs = new CircularBuffer<LogEntry>(Array, 1000)

	private reactRoot: Fiber | null = null
	private reactCommitHooked = false

	/** Store of active patches created via the `patch_method` MCP command. */
	private patches = new Map<number, () => void>()
	/** Monotonic counter for allocating patch IDs. */
	private patchIdCounter = 0

	/**
	 * Connect to the developer tools server.
	 *
	 * @param url - WebSocket server URL (e.g., "ws://localhost:7864")
	 * @param info - Optional information string to identify this client
	 * @param alias - Optional alias (alphanumeric, `-`, `_`) for targeting this client in MCP commands
	 *
	 * @example
	 * ```ts
	 * client.connect("ws://localhost:7864", "My React Native App")
	 * ```
	 */
	connect(url: string, info?: string, alias?: string) {
		const isOpen = this.ws?.readyState === WebSocket.OPEN
		if (isOpen) return

		this.alias = alias

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
				// Patch IDs are only meaningful within a session; drop the store.
				// (The patches themselves remain applied on the device.)
				this.patches.clear()
				this.patchIdCounter = 0
			}
		} catch (e) {
			console.error('[DevTools] Connection error:', e)
		}
	}

	/**
	 * Disconnect from the server and clean up the connection.
	 */
	disconnect() {
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}

		this.connected = false
		this.authenticated = false
	}

	/**
	 * Clear all saved variables. Not the scope itself!
	 */
	clearVars() {
		this.scope.vars = { mcp: {} }
	}

	/**
	 * Expose a variable to the server execution scope.
	 *
	 * @param key - Variable name to use in server scope
	 * @param value - Value to expose (will be serialized when accessed)
	 *
	 * @example
	 * ```ts
	 * client.expose('user', { name: 'John', age: 30 })
	 * client.expose('config', appConfig)
	 *
	 * // From server:
	 * // > user.name
	 * // "John"
	 * ```
	 */
	expose(key: string, value: any) {
		this.scope[key] = value
	}

	private sendHello(info?: string) {
		const msg: HelloMessage = {
			type: MessageType.Hello,
			data: {
				version: PROTOCOL_VERSION,
				info,
				alias: this.alias,
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

			case MessageType.MCPRun:
				this.handleMCPRun(msg as MCPRunMessage)
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

			const result = this.evalInScope(msg.data.code, scope)

			this.log(LogLevel.Default, [
				snapshot(result, this.settings.log.inspectDepth),
			])
		} catch (e: any) {
			this.log(LogLevel.Error, [this.formatError(e)])
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

	//#region MCP

	/**
	 * Evaluate a code string against a scope. The code is compiled as a single
	 * expression first, then with the auto-return heuristic, then as a raw
	 * function body (statements allowed, explicit `return` honored).
	 */
	private evalInScope(
		code: string,
		scope: Record<string, any> = this.scope,
	): any {
		const keys = Object.keys(scope)
		let func: ((...args: unknown[]) => unknown) | undefined
		let parseError: unknown

		for (const body of [
			`return (${code})`,
			this.wrapCodeWithAutoReturn(code),
			code,
		]) {
			try {
				func = new Function(...keys, body) as (...args: unknown[]) => unknown
				break
			} catch (e) {
				if (!(e instanceof SyntaxError)) throw e
				parseError ??= e
			}
		}

		if (!func)
			throw new SyntaxError(
				`${this.cleanParseError(parseError)} (code is evaluated as an expression first, then as a function body \u2014 use an explicit \`return\` for multi-statement code)`,
			)

		return func(...Object.values(scope))
	}

	/** Strip wrapper-relative line/column positions from a parse error message. */
	private cleanParseError(e: unknown): string {
		const message =
			(e as Error)?.message ?? (e == null ? 'Invalid code' : String(e))
		return message
			.replace(/^\d+:\d+:?\s*/, '')
			.replace(/\s*\(<anonymous>:\d+:\d+\)/g, '')
			.replace(/<anonymous>:\d+:\d+:?\s*/g, '')
			.trim()
	}

	/** Format an error with its stack trimmed to the first few frames. */
	private formatError(e: any): string {
		const stack = e?.stack
		if (typeof stack !== 'string')
			return e?.message ?? (e == null ? 'Unknown error' : String(e))

		const lines = stack.split('\n')
		const firstFrame = lines.findIndex(line => /^\s*at /.test(line))
		if (firstFrame === -1) return stack

		const frames = lines.slice(firstFrame)
		if (frames.length <= 5) return stack

		return [
			...lines.slice(0, firstFrame),
			...frames.slice(0, 5),
			`    \u2026 (${frames.length - 5} more frames)`,
		].join('\n')
	}

	/**
	 * Evaluate a single expression in the client scope, always returning its value.
	 */
	private evalExpression(code: string): any {
		return this.withScope(
			this.scope,
			`return (${code})`,
		)(...Object.values(this.scope))
	}

	private get revenge(): RevengeScope | undefined {
		return this.scope.revenge as RevengeScope | undefined
	}

	private get revengeDiscord(): NonNullable<RevengeScope['discord']> {
		const discord = this.revenge?.discord
		if (!discord)
			throw new Error(
				'Revenge Discord API is not available in the client scope',
			)
		return discord
	}

	private get revengeModulesFinders() {
		const finders = this.revenge?.modules?.finders
		if (!finders)
			throw new Error(
				'Revenge module finders are not available in the client scope',
			)
		return finders
	}

	private sendMCPResult(
		id: string,
		ok: boolean,
		result?: unknown,
		error?: string,
	) {
		const msg: MCPResultMessage = {
			type: MessageType.MCPResult,
			data: { id, ok, result, error },
		}
		this.send(msg)
	}

	private async handleMCPRun(msg: MCPRunMessage) {
		const { id, command, args } = msg.data

		try {
			let result: unknown

			switch (command) {
				case MCPCommand.GetModules:
					result = await this.mcpGetModules(args as MCPGetModulesArgs)
					break
				case MCPCommand.LookupModules:
					result = this.mcpLookupModules(args as MCPLookupModulesArgs)
					break
				case MCPCommand.RequireModule:
					result = this.mcpRequireModule(args as MCPRequireModuleArgs)
					break
				case MCPCommand.SaveVar:
					result = this.mcpSaveVar(args as MCPSaveVarArgs)
					break
				case MCPCommand.PatchMethod:
					result = this.mcpPatchMethod(args as MCPPatchMethodArgs)
					break
				case MCPCommand.UnpatchMethod:
					result = this.mcpUnpatchMethod(args as MCPUnpatchMethodArgs)
					break
				case MCPCommand.Eval:
					result = this.mcpEval(args as MCPEvalArgs)
					break
				case MCPCommand.DiscordReload:
					result = this.mcpDiscordReload()
					break
				case MCPCommand.DiscordFluxListen:
					result = await this.mcpDiscordFluxListen(
						args as MCPDiscordFluxListenArgs,
					)
					break
				case MCPCommand.DiscordFluxPatch:
					result = this.mcpDiscordFluxPatch(args as MCPDiscordFluxPatchArgs)
					break
				case MCPCommand.DiscordFluxUnpatch:
					result = this.mcpDiscordFluxUnpatch(args as MCPDiscordFluxUnpatchArgs)
					break
				case MCPCommand.GetLogs:
					result = this.mcpGetLogs(args as MCPGetLogsArgs)
					break
				case MCPCommand.ReactTreeGetRoot:
					result = this.mcpReactTreeGetRoot()
					break
				case MCPCommand.ReactTreeMatch:
					result = this.mcpReactTreeMatch(args as MCPReactTreeMatchArgs)
					break
				case MCPCommand.ReactTreeTraverseStructure:
					result = this.mcpReactTreeTraverseStructure(
						args as MCPReactTreeTraverseStructureArgs,
					)
					break
				case MCPCommand.ReactTreeHooks:
					result = this.mcpReactTreeHooks(args as MCPReactTreeHooksArgs)
					break
				default:
					throw new Error(`Unknown MCP command: ${command}`)
			}

			this.sendMCPResult(id, true, result)
		} catch (e: any) {
			this.sendMCPResult(id, false, undefined, this.formatError(e))
		}
	}

	private mcpGetModules(args: MCPGetModulesArgs): Promise<unknown> {
		const finders = this.revengeModulesFinders
		const filterFactory = finders.filters[args.filter]
		if (typeof filterFactory !== 'function')
			throw new Error(
				`Unknown filter "${args.filter}". Available: ${Object.keys(
					finders.filters,
				).join(', ')}`,
			)

		const filterArgs = this.evalInScope(args.args)
		if (!Array.isArray(filterArgs))
			throw new Error('`args` must evaluate to an array of filter arguments')

		const filter = filterFactory(...filterArgs)

		const max = args.max ?? 1
		const timeout = args.timeout ?? 5000
		const depth = args.depth ?? this.settings.log.inspectDepth

		return new Promise(resolve => {
			const results: Array<{ id: number; exports: unknown }> = []
			let unsub: (() => void) | undefined
			let done = false

			const finish = () => {
				if (done) return
				done = true
				clearTimeout(timer)
				try {
					unsub?.()
				} catch {}
				resolve({ count: results.length, modules: results })
			}

			const timer = setTimeout(finish, timeout)

			unsub = finders.getModules(
				filter,
				(exports: any, moduleId: number) => {
					results.push({
						id: moduleId,
						exports: snapshot(exports, depth),
					})
					if (results.length >= max) finish()
				},
				{ max },
			)

			if (results.length >= max) finish()
		})
	}

	private mcpLookupModules(args: MCPLookupModulesArgs): unknown {
		const finders = this.revengeModulesFinders
		const filterFactory = finders.filters[args.filter]
		if (typeof filterFactory !== 'function')
			throw new Error(
				`Unknown filter "${args.filter}". Available: ${Object.keys(
					finders.filters,
				).join(', ')}`,
			)

		const filterArgs = this.evalInScope(args.args)
		if (!Array.isArray(filterArgs))
			throw new Error('`args` must evaluate to an array of filter arguments')

		const filter = filterFactory(...filterArgs)
		const initialize = args.initialize ?? true
		const depth = args.depth ?? this.settings.log.inspectDepth
		const max = args.max ?? Infinity

		const options = initialize ? undefined : { initialize: false }

		const modules: Array<{ id: number; exports: unknown }> = []
		for (const [exports, id] of finders.lookupModules(filter, options)) {
			modules.push({
				id,
				exports: exports === undefined ? null : snapshot(exports, depth),
			})
			if (modules.length >= max) break
		}

		return { count: modules.length, modules }
	}

	private mcpRequireModule(args: MCPRequireModuleArgs): unknown {
		const depth = args.depth ?? this.settings.log.inspectDepth
		const metroRequire = (globalThis as any).__r

		if (typeof metroRequire !== 'function')
			throw new Error('Metro require function is not available')

		const exports = metroRequire(args.id)

		return {
			id: args.id,
			exports: snapshot(exports, depth),
			source: 'unavailable (Hermes bytecode)',
		}
	}

	private mcpSaveVar(args: MCPSaveVarArgs): unknown {
		const value = this.evalInScope(args.expression)
		this.scope.vars[args.name] = value
		return {
			name: args.name,
			value: snapshot(value, this.settings.log.inspectDepth),
		}
	}

	private mcpPatchMethod(args: MCPPatchMethodArgs): { id: number } {
		const patcher = this.revenge?.patcher
		if (!patcher)
			throw new Error('Revenge patcher is not available in the client scope')

		const patchFn = patcher[args.method]
		if (typeof patchFn !== 'function')
			throw new Error(`Unknown patch method: ${args.method}`)

		const target = this.evalInScope(args.target)
		if (
			target == null ||
			(typeof target !== 'object' && typeof target !== 'function')
		)
			throw new Error('`target` must evaluate to an object or function')

		const hook = this.evalExpression(args.hook)
		if (typeof hook !== 'function')
			throw new Error('`hook` must evaluate to a function')

		const unpatch = patchFn(target, args.key, hook)
		return { id: this.storePatch(unpatch) }
	}

	/** Allocate a patch ID and store its unpatch closure. */
	private storePatch(unpatch: () => void): number {
		const id = ++this.patchIdCounter
		this.patches.set(id, unpatch)
		return id
	}

	/** Remove (and invoke) a stored patch by ID. */
	private removePatch(id: number): { unpatched: boolean } {
		const unpatch = this.patches.get(id)
		if (!unpatch) throw new Error(`Unknown patch ID: ${id}`)

		unpatch()
		this.patches.delete(id)
		return { unpatched: true }
	}

	private mcpUnpatchMethod(args: MCPUnpatchMethodArgs): { unpatched: boolean } {
		return this.removePatch(args.id)
	}

	private mcpEval(args: MCPEvalArgs): unknown {
		const result = this.evalInScope(args.code)
		return snapshot(result, this.settings.log.inspectDepth)
	}

	private mcpDiscordReload(): { reloading: boolean } {
		const manager = this.revengeDiscord.native?.BundleUpdaterManager
		if (typeof manager?.reload !== 'function')
			throw new Error('BundleUpdaterManager.reload is not available')

		// Defer so the success result is flushed before the app restarts
		setTimeout(() => {
			try {
				manager.reload()
			} catch (e) {
				console.error('[DevTools] Reload failed:', e)
			}
		}, 0)

		return { reloading: true }
	}

	private mcpDiscordFluxListen(
		args: MCPDiscordFluxListenArgs,
	): Promise<unknown> {
		const flux = this.revengeDiscord.flux
		if (!flux?.onAnyFluxEventDispatched || !flux.onFluxEventDispatched)
			throw new Error('Revenge Discord Flux API is not available')

		const count = args.count ?? 25
		const timeout = args.timeout ?? 5000
		const depth = args.depth ?? this.settings.log.inspectDepth

		return new Promise(resolve => {
			const events: unknown[] = []
			let unsub: (() => void) | undefined
			let done = false

			const finish = () => {
				if (done) return
				done = true
				clearTimeout(timer)
				try {
					unsub?.()
				} catch {}
				resolve({ count: events.length, events })
			}

			const timer = setTimeout(finish, timeout)

			// The callback MUST return the payload to avoid blocking the event
			const capture = (payload: any) => {
				events.push(snapshot(payload, depth))
				if (events.length >= count) finish()
				return payload
			}

			unsub = args.event
				? flux.onFluxEventDispatched(args.event, capture)
				: flux.onAnyFluxEventDispatched(capture)
		})
	}

	private mcpDiscordFluxPatch(args: MCPDiscordFluxPatchArgs): { id: number } {
		const flux = this.revengeDiscord.flux
		if (!flux?.onAnyFluxEventDispatched || !flux.onFluxEventDispatched)
			throw new Error('Revenge Discord Flux API is not available')

		const hook = this.evalExpression(args.hook)
		if (typeof hook !== 'function')
			throw new Error('`hook` must evaluate to a function')

		const unsub = args.event
			? flux.onFluxEventDispatched(args.event, hook)
			: flux.onAnyFluxEventDispatched(hook)

		return { id: this.storePatch(unsub) }
	}

	private mcpDiscordFluxUnpatch(args: MCPDiscordFluxUnpatchArgs): {
		unpatched: boolean
	} {
		return this.removePatch(args.id)
	}

	private mcpGetLogs(args: MCPGetLogsArgs): unknown {
		const minLevel = args.min_level ?? LogLevel.Debug
		const depth = args.depth ?? this.settings.log.inspectDepth

		let entries = (this.logs.toArray() as LogEntry[]).filter(
			entry => entry.level >= minLevel,
		)
		if (args.limit != null && entries.length > args.limit)
			entries = entries.slice(-args.limit)

		return {
			count: entries.length,
			logs: entries.map(entry => ({
				level: entry.level,
				time: entry.time,
				message: entry.message.map(item => snapshot(item, depth)),
			})),
		}
	}

	private ensureReactCommitHook() {
		if (this.reactCommitHooked) return
		this.reactCommitHooked = true
		try {
			onCommitFiberRoot(root => {
				this.reactRoot = root.current
			})
		} catch {}
	}

	private getReactRootFiber(): Fiber {
		this.ensureReactCommitHook()

		const hook = getRDTHook() as any
		if (typeof hook?.getFiberRoots === 'function')
			for (const id of hook.renderers.keys())
				for (const root of hook.getFiberRoots(id))
					if (root?.current) return root.current

		if (this.reactRoot) return this.reactRoot

		throw new Error(
			'React root fiber is unavailable. No renderer has registered with the DevTools hook and no commit has been observed yet.',
		)
	}

	private resolveReactFiber(from?: string): Fiber {
		if (from != null) {
			const fiber = this.evalInScope(from)
			if (!isValidFiber(fiber))
				throw new Error('`from` must evaluate to a React fiber')
			return fiber
		}

		const stored = this.scope.vars.mcp?.reactFiber
		if (stored != null) {
			if (!isValidFiber(stored))
				throw new Error('`vars.mcp.reactFiber` is not a valid React fiber')
			return stored
		}

		return this.getReactRootFiber()
	}

	private describeFiber(fiber: Fiber) {
		return {
			name:
				getDisplayName(fiber.type) ??
				(typeof fiber.type === 'string' ? fiber.type : `#${fiber.tag}`),
			tag: fiber.tag,
			key: fiber.key,
		}
	}

	private mcpReactTreeGetRoot(): unknown {
		const root = this.getReactRootFiber()
		this.scope.vars.mcp ??= {}
		this.scope.vars.mcp.reactFiber = root
		return { stored: 'vars.mcp.reactFiber', fiber: this.describeFiber(root) }
	}

	private mcpReactTreeMatch(args: MCPReactTreeMatchArgs): unknown {
		const predicate = this.evalExpression(args.predicate)
		if (typeof predicate !== 'function')
			throw new Error('`predicate` must evaluate to a function')

		const start = this.resolveReactFiber(args.from)
		const maxVisits = args.depth ?? 100

		let visited = 0
		let exceeded = false
		const found = traverseFiber(start, fiber => {
			if (++visited > maxVisits) {
				exceeded = true
				return true
			}
			try {
				return Boolean(predicate(fiber))
			} catch {
				return false
			}
		})

		if (!found || exceeded) return { matched: false, visited: visited - 1 }

		this.scope.vars.mcp ??= {}
		this.scope.vars.mcp.reactFiber = found
		return {
			matched: true,
			visited,
			stored: 'vars.mcp.reactFiber',
			fiber: this.describeFiber(found),
		}
	}

	private summarizeProps(props: any): string {
		if (props == null || typeof props !== 'object') return ''

		const parts: string[] = []
		for (const key of Object.keys(props)) {
			if (key === 'children') continue
			if (parts.length >= 8) {
				parts.push('\u2026')
				break
			}

			const value = props[key]
			let rendered: string
			switch (typeof value) {
				case 'string':
					rendered = JSON.stringify(
						value.length > 32 ? `${value.slice(0, 32)}\u2026` : value,
					)
					break
				case 'function':
					rendered = 'fn'
					break
				case 'object':
					rendered =
						value === null
							? 'null'
							: Array.isArray(value)
								? `Array(${value.length})`
								: '{\u2026}'
					break
				default:
					rendered = String(value)
			}
			parts.push(`${key}=${rendered}`)
		}

		return parts.join(' ')
	}

	private mcpReactTreeTraverseStructure(
		args: MCPReactTreeTraverseStructureArgs,
	): unknown {
		const start = this.resolveReactFiber(args.from)
		const maxDepth = args.depth ?? 10
		const showHost = args.showHostComponents ?? false
		const maxLines = 2000

		const lines: string[] = []
		let truncated = false

		const formatLine = (fiber: Fiber, depth: number) => {
			const { name, key } = this.describeFiber(fiber)
			const host = showHost && isHostFiber(fiber) ? ' (host)' : ''
			const keyPart = key != null ? ` key=${JSON.stringify(key)}` : ''
			const props = this.summarizeProps(fiber.memoizedProps)
			const propsPart = props ? ` ${props}` : ''
			return `${'  '.repeat(depth)}<${name}${keyPart}${propsPart}>${host}`
		}

		const walk = (node: Fiber | null, depth: number) => {
			for (let fiber = node; fiber; fiber = fiber.sibling) {
				if (lines.length >= maxLines) {
					truncated = true
					return
				}
				if (!showHost && isHostFiber(fiber)) {
					walk(fiber.child, depth)
					continue
				}
				lines.push(formatLine(fiber, depth))
				if (depth < maxDepth) walk(fiber.child, depth + 1)
				else if (fiber.child) truncated = true
			}
		}

		if (!showHost && isHostFiber(start)) {
			walk(start.child, 0)
		} else {
			lines.push(formatLine(start, 0))
			walk(start.child, 1)
		}

		return {
			depth: maxDepth,
			truncated,
			hostComponentsHidden: !showHost,
			structure: lines.join('\n'),
		}
	}

	private mcpReactTreeHooks(args: MCPReactTreeHooksArgs): unknown {
		const fiber = this.resolveReactFiber(args.from)
		const limit = args.limit ?? 50
		const depth = args.depth ?? this.settings.log.inspectDepth

		const first = fiber.memoizedState
		const isHookNode = (node: any) =>
			node != null &&
			typeof node === 'object' &&
			('memoizedState' in node || 'queue' in node) &&
			'next' in node

		if (!isHookNode(first))
			return {
				count: 0,
				hooks: [],
				truncated: false,
				fiber: this.describeFiber(fiber),
				note: 'fiber has no hook chain (not a function component, or not mounted)',
			}

		const hooks: Array<{ index: number; state: unknown; hasQueue: boolean }> =
			[]
		let truncated = false
		let index = 0
		for (let node: any = first; isHookNode(node); node = node.next) {
			if (hooks.length >= limit) {
				truncated = true
				break
			}
			hooks.push({
				index: index++,
				state: snapshot(node.memoizedState, depth),
				hasQueue: node.queue != null,
			})
		}

		return {
			count: hooks.length,
			hooks,
			truncated,
			fiber: this.describeFiber(fiber),
		}
	}

	//#endregion MCP

	private send(msg: Message) {
		const isOpen = this.ws?.readyState === WebSocket.OPEN
		if (isOpen && this.ws) {
			this.ws.send(serialize(msg))
		}
	}

	/**
	 * Send a log message to the server.
	 *
	 * @param level - Log level (Debug, Default, Warn, Error)
	 * @param message - Array of values to log
	 *
	 * @example
	 * ```ts
	 * import { LogLevel } from '@revenge-mod/devtools-shared/constants'
	 *
	 * client.log(LogLevel.Debug, ["Debug info", { data: 123 }])
	 * client.log(LogLevel.Error, ["Error:", error])
	 * ```
	 */
	log(level: LogLevelType, message: any[]) {
		const snapped = message.map(item =>
			snapshot(item, this.settings.log.inspectDepth),
		)
		this.logs.push({ level, time: Date.now(), message: snapped })

		if (!this.authenticated) return
		if (level < this.settings.log.level) return

		const msg: LogMessage = {
			type: MessageType.Log,
			data: { level, message: snapped },
		}

		this.send(msg)
	}

	/**
	 * Register a handler for a specific message type.
	 *
	 * @param type - Message type to listen for
	 * @param handler - Callback function to handle the message
	 *
	 * @example
	 * ```ts
	 * import { MessageType } from '@revenge-mod/devtools-shared/constants'
	 *
	 * client.on(MessageType.Hi, (msg) => {
	 *   console.log('Server acknowledged connection')
	 * })
	 * ```
	 */
	on(type: MsgType, handler: MessageHandler) {
		if (!this.handlers.has(type)) {
			this.handlers.set(type, new Set())
		}
		this.handlers.get(type)!.add(handler)
	}

	/**
	 * Unregister a message handler.
	 *
	 * @param type - Message type
	 * @param handler - Handler function to remove
	 */
	off(type: MsgType, handler: MessageHandler) {
		const handlers = this.handlers.get(type)
		if (handlers) {
			handlers.delete(handler)
		}
	}

	/**
	 * Check if the client is connected and authenticated with the server.
	 *
	 * @returns `true` if connected and authenticated, `false` otherwise
	 */
	isConnected() {
		return this.connected && this.authenticated
	}
}
