import {
	DEFAULT_SETTINGS,
	LogLevel,
	MCPCommand,
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
	MCPDiscordFluxListenArgs,
	MCPDiscordFluxPatchArgs,
	MCPDiscordFluxUnpatchArgs,
	MCPEvalArgs,
	MCPGetModulesArgs,
	MCPLookupModulesArgs,
	MCPPatchMethodArgs,
	MCPRequireModuleArgs,
	MCPResultMessage,
	MCPRunMessage,
	MCPSaveVarArgs,
	MCPUnpatchMethodArgs,
	Message,
	MessageType as MsgType,
	RunMessage,
} from '@revenge-mod/devtools-shared/types'
import type { RevengeScope } from './revenge-types'

type MessageHandler = (msg: Message) => void

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

	private scope: Record<string, any> = { devTools: this, vars: {} }
	private connected: boolean = false
	private authenticated: boolean = false
	private handlers = new Map<number, Set<MessageHandler>>()

	/** Store of active patches created via the `patch_method` MCP command. */
	private patches = new Map<number, () => void>()
	/** Monotonic counter for allocating patch IDs. */
	private patchIdCounter = 0

	/**
	 * Connect to the developer tools server.
	 *
	 * @param url - WebSocket server URL (e.g., "ws://localhost:7864")
	 * @param info - Optional information string to identify this client
	 *
	 * @example
	 * ```ts
	 * client.connect("ws://localhost:7864", "My React Native App")
	 * ```
	 */
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
		this.scope.vars = {}
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

	//#region MCP

	/**
	 * Evaluate a code string against the client scope, auto-returning the last expression (same as the `Run` handler).
	 */
	private evalInScope(code: string): any {
		const wrapped = this.wrapCodeWithAutoReturn(code)
		return this.withScope(this.scope, wrapped)(...Object.values(this.scope))
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
				default:
					throw new Error(`Unknown MCP command: ${command}`)
			}

			this.sendMCPResult(id, true, result)
		} catch (e: any) {
			this.sendMCPResult(
				id,
				false,
				undefined,
				e?.stack ?? e?.message ?? String(e),
			)
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
						exports: createDepthLimitedProxy(exports, depth),
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
				exports:
					exports === undefined
						? null
						: createDepthLimitedProxy(exports, depth),
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
			exports: createDepthLimitedProxy(exports, depth),
		}
	}

	private mcpSaveVar(args: MCPSaveVarArgs): unknown {
		const value = this.evalInScope(args.expression)
		this.scope.vars[args.name] = value
		return {
			name: args.name,
			value: createDepthLimitedProxy(value, this.settings.log.inspectDepth),
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
		return createDepthLimitedProxy(result, this.settings.log.inspectDepth)
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
				events.push(createDepthLimitedProxy(payload, depth))
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
		if (!this.authenticated) return
		if (level < this.settings.log.level) return

		const msg: LogMessage = {
			type: MessageType.Log,
			data: { level, message },
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
