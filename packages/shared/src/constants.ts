import type { Settings } from './types'

/**
 * Log levels for filtering and categorizing messages.
 * Lower values indicate more verbose logging.
 */
export const LogLevel = {
	Debug: 0,
	Default: 1,
	Warn: 2,
	Error: 3,
} as const

/**
 * WebSocket message types for client-server communication.
 */
export const MessageType = {
	/**
	 * "Hello, I'm client, version (x)."
	 */
	Hello: 1,
	/**
	 * "Hi client. I'm server, version (x)."
	 * - "I accept your connection. Here are the settings."
	 * - "I don't support that version, closing connection."
	 */
	Hi: 2,
	/**
	 * "Server, log this for me."
	 */
	Log: 3,
	/**
	 * "Client, run this for me."
	 */
	Run: 4,
	/**
	 * "Client, run this MCP command for me and send me the result."
	 */
	MCPRun: 5,
	/**
	 * "Server, here is the result of the MCP command you asked me to run."
	 */
	MCPResult: 6,
} as const

/**
 * MCP command names (and tool names) supported by the client runtime.
 */
export const MCPCommand = {
	GetModules: 'get_modules',
	LookupModules: 'lookup_modules',
	RequireModule: 'require_module',
	SaveVar: 'save_var',
	PatchMethod: 'patch_method',
	UnpatchMethod: 'unpatch_method',
	Eval: 'eval',
	DiscordReload: 'discord_reload',
	DiscordFluxListen: 'discord_flux_listen',
	DiscordFluxPatch: 'discord_flux_patch',
	DiscordFluxUnpatch: 'discord_flux_unpatch',
	GetLogs: 'get_logs',
	ReactTreeGetRoot: 'react_tree_get_root',
	ReactTreeMatch: 'react_tree_match',
	ReactTreeTraverseStructure: 'react_tree_traverse_structure',
	ReactTreeHooks: 'react_tree_hooks',
} as const

/**
 * Default settings for client and server.
 */
export const DEFAULT_SETTINGS: Settings = {
	client: {
		log: {
			level: LogLevel.Default,
			inspectDepth: 2,
			interceptConsole: true,
		},
	},
	server: {
		watch: {
			command: false,
		},
		mcp: {
			commandTimeout: 30000,
		},
	},
}

/**
 * Current protocol version for client-server compatibility.
 * Clients and servers with different versions may be incompatible.
 */
export const PROTOCOL_VERSION = 5
