import type { LogLevel, MessageType } from './constants'

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
