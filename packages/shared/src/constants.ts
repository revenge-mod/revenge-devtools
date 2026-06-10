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
	GetModules: 'revenge_get_modules',
	LookupModules: 'revenge_lookup_modules',
	RequireModule: 'revenge_require_module',
	SaveVar: 'revenge_save_var',
	PatchMethod: 'revenge_patch_method',
	UnpatchMethod: 'revenge_unpatch_method',
	Eval: 'revenge_eval',
	DiscordReload: 'revenge_discord_reload',
	DiscordFluxListen: 'revenge_discord_flux_listen',
	DiscordFluxPatch: 'revenge_discord_flux_patch',
	DiscordFluxUnpatch: 'revenge_discord_flux_unpatch',
	GetLogs: 'revenge_get_logs',
	ReactTreeGetRoot: 'revenge_react_tree_get_root',
	ReactTreeMatch: 'revenge_react_tree_match',
	ReactTreeTraverseStructure: 'revenge_react_tree_traverse_structure',
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
