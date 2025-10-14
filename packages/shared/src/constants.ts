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
	},
}

/**
 * Current protocol version for client-server compatibility.
 * Clients and servers with different versions may be incompatible.
 */
export const PROTOCOL_VERSION = 2
