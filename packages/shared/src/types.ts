import type { LogLevel, MessageType } from './constants'

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]
export type MessageType<
	K extends keyof typeof MessageType = keyof typeof MessageType,
> = (typeof MessageType)[K]

export interface Settings {
	logLevel: LogLevel
	inspectDepth: number
	interceptConsole: boolean
}

export interface LogMessageData {
	level: LogLevel
	message: any[]
}

export interface Message {
	type: MessageType
	data?: any
}

export interface LogMessage extends Message {
	type: MessageType<'Log'>
	data: LogMessageData
}

export interface RunMessage extends Message {
	type: MessageType<'Run'>
	data: {
		code: string
		/**
		 * Map variables in `code` to values in the client environment.
		 */
		mappings: Record<string, string>
	}
}

export interface HelloMessage extends Message {
	type: MessageType<'Hello'>
	data: {
		version: number
		info?: string
	}
}

export interface HiMessage extends Message {
	type: MessageType<'Hi'>
	data: {
		version: number
		supported: boolean
		settings: Settings
	}
}
