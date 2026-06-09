import type { LogLevel, MessageType } from './constants'

/**
 * MCP command name type. Derived from {@link MCPCommandArgsMap} so it stays in
 * sync with the supported commands.
 */
export type MCPCommand = keyof MCPCommandArgsMap

/**
 * Log level type extracted from the LogLevel constant.
 */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

/**
 * Message type extracted from the MessageType constant.
 */
export type MessageType<
	K extends keyof typeof MessageType = keyof typeof MessageType,
> = (typeof MessageType)[K]

/**
 * Client-side settings configuration.
 */
export interface ClientSettings {
	log: {
		/** Minimum log level to send (0-3: Debug, Default, Warn, Error) */
		level: LogLevel
		/** Whether to intercept console methods */
		interceptConsole: boolean
		/** Maximum depth for object inspection */
		inspectDepth: number
	}
}

/**
 * Server-side settings configuration.
 */
export interface ServerSettings {
	watch: {
		/** Command to execute when watched files change, or false to disable */
		command: string | false
	}
	mcp: {
		/** Time in milliseconds to wait for a client to respond to an MCP command. */
		commandTimeout: number
	}
}

/**
 * Combined settings for client and server.
 */
export interface Settings {
	client: ClientSettings
	server: ServerSettings
}

/**
 * Log message data payload.
 */
export interface LogMessageData {
	level: LogLevel
	message: any[]
}

/**
 * Base message interface for WebSocket communication.
 */
export interface Message {
	type: MessageType
	data?: any
}

/**
 * Log message sent from client to server.
 */
export interface LogMessage extends Message {
	type: MessageType<'Log'>
	data: LogMessageData
}

/**
 * Run message sent from server to client to execute code.
 */
export interface RunMessage extends Message {
	type: MessageType<'Run'>
	data: {
		/** JavaScript code to execute */
		code: string
		/**
		 * Map variables in `code` to values in the client environment.
		 * Key is the variable name, value is the path in client scope.
		 */
		mappings: Record<string, string>
	}
}

/**
 * Hello message sent from client to server on initial connection.
 */
export interface HelloMessage extends Message {
	type: MessageType<'Hello'>
	data: {
		/** Protocol version of the client */
		version: number
		/** Optional information to identify the client */
		info?: string
	}
}

/**
 * Hi message sent from server to client in response to Hello.
 */
export interface HiMessage extends Message {
	type: MessageType<'Hi'>
	data: {
		/** Protocol version of the server */
		version: number
		/** Whether the client version is supported */
		supported: boolean
		/** Settings to apply to the client */
		settings: ClientSettings
	}
}

//#region MCP

export interface MCPGetModulesArgs {
	/** Name of the filter factory to use (e.g. "withProps", "withName"). */
	filter: string
	/**
	 * Stringified JS array expression of arguments to pass to the filter factory.
	 * Evaluated in the client scope so dynamic values are passable.
	 *
	 * @example "['createElement']"
	 */
	args: string
	/**
	 * Maximum number of matching modules to collect.
	 * @default 1
	 */
	max?: number
	/**
	 * Time in milliseconds to wait for matches before resolving.
	 * @default 5000
	 */
	timeout?: number
	/** Depth to traverse when describing each module's exports shape. */
	depth?: number
}

export interface MCPSaveVarArgs {
	/** Variable name to store under `vars`. */
	name: string
	/** Stringified expression to evaluate in scope. Result is stored at `vars[name]`. */
	expression: string
}

export interface MCPPatchMethodArgs {
	/** The patch kind. */
	method: 'before' | 'instead' | 'after'
	/** Stringified expression resolving to the object/parent to patch (in scope). */
	target: string
	/** The key of the method to patch on the target object. */
	key: string
	/** Stringified function expression to evaluate and use as the hook. */
	hook: string
}

export interface MCPUnpatchMethodArgs {
	/** The patch ID returned by a previous `patch_method` call. */
	id: number
}

export interface MCPEvalArgs {
	/** Stringified code to evaluate in the client scope. */
	code: string
}

export interface MCPLookupModulesArgs {
	/** Name of the filter factory to use (e.g. "withProps", "withName"). */
	filter: string
	/**
	 * Stringified JS array expression of arguments to pass to the filter factory.
	 * Evaluated in the client scope so dynamic values are passable.
	 */
	args: string
	/**
	 * Whether to initialize matching uninitialized modules.
	 * When `false`, uninitialized matches are returned as `{ id, exports: null }`
	 * without triggering side effects.
	 *
	 * @default true
	 */
	initialize?: boolean
	/**
	 * Maximum number of matching modules to collect.
	 * @default Number.POSITIVE_INFINITY
	 */
	max?: number
	/** Depth to traverse when describing each module's exports shape. */
	depth?: number
}

export interface MCPRequireModuleArgs {
	/** The Metro module ID to require/initialize. */
	id: number
	/** Depth to traverse when describing the module's exports shape. */
	depth?: number
}

export type MCPDiscordReloadArgs = Record<string, never>

export interface MCPDiscordFluxListenArgs {
	/** Specific Flux action type to listen for. Omit to capture all events. */
	event?: string
	/**
	 * Maximum number of events to capture before resolving.
	 * @default 25
	 */
	count?: number
	/**
	 * Time in milliseconds to listen before resolving.
	 * @default 5000
	 */
	timeout?: number
	/** Depth to traverse when describing each captured payload. */
	depth?: number
}

export interface MCPDiscordFluxPatchArgs {
	/** Specific Flux action type to patch. Omit to patch all events. */
	event?: string
	/**
	 * Stringified function expression `(payload) => payload | undefined`.
	 * Returning a falsy value blocks the event from being dispatched.
	 */
	hook: string
}

export interface MCPDiscordFluxUnpatchArgs {
	/** The patch ID returned by a previous `revenge_discord_flux_patch` call. */
	id: number
}

export interface MCPCommandArgsMap {
	revenge_get_modules: MCPGetModulesArgs
	revenge_lookup_modules: MCPLookupModulesArgs
	revenge_require_module: MCPRequireModuleArgs
	revenge_save_var: MCPSaveVarArgs
	revenge_patch_method: MCPPatchMethodArgs
	revenge_unpatch_method: MCPUnpatchMethodArgs
	revenge_eval: MCPEvalArgs
	revenge_discord_reload: MCPDiscordReloadArgs
	revenge_discord_flux_listen: MCPDiscordFluxListenArgs
	revenge_discord_flux_patch: MCPDiscordFluxPatchArgs
	revenge_discord_flux_unpatch: MCPDiscordFluxUnpatchArgs
}

/**
 * MCPRun message sent from server to client to run an MCP command.
 */
export interface MCPRunMessage extends Message {
	type: MessageType<'MCPRun'>
	data: {
		/** Unique request ID used to correlate the result. */
		id: string
		command: MCPCommand
		args: MCPCommandArgsMap[MCPCommand]
	}
}

/**
 * MCPResult message sent from client to server with the result of an MCP command.
 */
export interface MCPResultMessage extends Message {
	type: MessageType<'MCPResult'>
	data: {
		id: string
		ok: boolean
		result?: any
		error?: string
	}
}

//#endregion MCP
