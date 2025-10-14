import chalk from 'chalk'

let currentPrompt = ''
let currentLine = ''

/**
 * Set the current prompt for preservation during logging.
 * This ensures the prompt is restored after log output.
 *
 * @param prompt - The prompt string (e.g., "> ")
 * @param line - The current input line
 */
export function setPrompt(prompt: string, line: string = '') {
	currentPrompt = prompt
	currentLine = line
}

/**
 * Clear the current input line while preserving the prompt.
 */
export function clearPromptLine() {
	currentLine = ''
}

function clearLine() {
	if (currentPrompt || currentLine) {
		process.stdout.write('\r\x1b[K')
	}
}

function restorePrompt() {
	if (currentPrompt || currentLine) {
		process.stdout.write(currentPrompt + currentLine)
	}
}

function logWithPrompt(...args: any[]) {
	clearLine()
	console.log(...args)
	restorePrompt()
}

export const logger = {
	debug(...args: any[]) {
		logWithPrompt(...args)
	},

	log(...args: any[]) {
		logWithPrompt(...args)
	},

	info(...args: any[]) {
		logWithPrompt('ℹ️', ...args)
	},

	warn(...args: any[]) {
		logWithPrompt('⚠️', ...args)
	},

	error(...args: any[]) {
		logWithPrompt('🛑', ...args)
	},

	success(...args: any[]) {
		logWithPrompt('✅', ...args)
	},

	server(...args: any[]) {
		logWithPrompt(chalk.magenta('[SERVER]'), ...args)
	},

	client(id: string, ...args: any[]) {
		logWithPrompt(chalk.cyan(`[${id}]`), ...args)
	},
}

/**
 * Create a logger instance for a specific client.
 * Each method prefixes output with the client ID in a colored format.
 *
 * @param id - Client identifier
 * @returns Logger instance with client-specific formatting
 */
export function createClientLogger(id: string) {
	return {
		debug(...args: any[]) {
			logWithPrompt(chalk.gray(`[${id}]`), ...args)
		},
		log(...args: any[]) {
			logWithPrompt(chalk.cyan(`[${id}]`), ...args)
		},
		warn(...args: any[]) {
			logWithPrompt(chalk.yellow(`⚠️ [${id}]`), ...args)
		},
		error(...args: any[]) {
			logWithPrompt(chalk.red(`🛑 [${id}]`), ...args)
		},
	}
}
