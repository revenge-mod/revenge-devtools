import type { Settings } from './types'

export const LogLevel = {
	Debug: 0,
	Default: 1,
	Warn: 2,
	Error: 3,
} as const

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

export const PROTOCOL_VERSION = 2

export const MAX_DEPTH_MESSAGE = '[MAX DEPTH REACHED]'
