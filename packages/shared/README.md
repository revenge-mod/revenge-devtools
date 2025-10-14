# @revenge-mod/devtools-shared

Shared utilities, types, and constants for Revenge Developer Tools.

## 📖 Overview

The shared package provides common functionality used by both the client and server packages:

- **Constants** - Protocol version, message types, log levels, and default settings
- **Types** - TypeScript type definitions for messages and settings
- **Serializer** - Advanced object serialization with depth limiting
- **Logger** - Terminal logging utilities with prompt preservation (server-side)

## 📦 Exports

The package exports four main modules:

```ts
import { LogLevel, MessageType, PROTOCOL_VERSION, DEFAULT_SETTINGS } from '@revenge-mod/devtools-shared/constants'
import type { Message, LogMessage, RunMessage, HelloMessage, HiMessage, Settings } from '@revenge-mod/devtools-shared/types'
import { serialize, deserialize, createDepthLimitedProxy } from '@revenge-mod/devtools-shared/serializer'
import { logger, createClientLogger, setPrompt, clearPromptLine } from '@revenge-mod/devtools-shared/logger'
```

## 🔧 Constants

### `LogLevel`

Defines the available log levels:

```ts
export const LogLevel = {
  Debug: 0,    // Verbose debug information
  Default: 1,  // Normal logs
  Warn: 2,     // Warning messages
  Error: 3,    // Error messages
} as const
```

### `MessageType`

Defines the WebSocket message types:

```ts
export const MessageType = {
  Hello: 1,  // Client introduces itself
  Hi: 2,     // Server acknowledges connection
  Log: 3,    // Client sends logs
  Run: 4,    // Server executes code
} as const
```

### `PROTOCOL_VERSION`

Current protocol version (2). Used for client-server compatibility checks.

### `DEFAULT_SETTINGS`

Default configuration for client and server:

```ts
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
```

## 📝 Types

### Message Types

#### `Message`

Base message interface:

```ts
interface Message {
  type: MessageType
  data?: any
}
```

#### `LogMessage`

Message for sending logs to the server:

```ts
interface LogMessage extends Message {
  type: MessageType<'Log'>
  data: {
    level: LogLevel
    message: any[]
  }
}
```

#### `RunMessage`

Message for executing code on the client:

```ts
interface RunMessage extends Message {
  type: MessageType<'Run'>
  data: {
    code: string
    mappings: Record<string, string>  // Variable name -> path in client scope
  }
}
```

#### `HelloMessage`

Initial client handshake:

```ts
interface HelloMessage extends Message {
  type: MessageType<'Hello'>
  data: {
    version: number
    info?: string  // Optional client description
  }
}
```

#### `HiMessage`

Server response to handshake:

```ts
interface HiMessage extends Message {
  type: MessageType<'Hi'>
  data: {
    version: number
    supported: boolean    // Whether client version is compatible
    settings: ClientSettings
  }
}
```

### Settings Types

#### `ClientSettings`

Configuration for the client:

```ts
interface ClientSettings {
  log: {
    level: LogLevel           // Minimum log level
    interceptConsole: boolean // Whether to intercept console
    inspectDepth: number      // Max depth for object inspection
  }
}
```

#### `ServerSettings`

Configuration for the server:

```ts
interface ServerSettings {
  watch: {
    command: string | false  // Command to run on file changes
  }
}
```

#### `Settings`

Combined settings:

```ts
interface Settings {
  client: ClientSettings
  server: ServerSettings
}
```

## 🔄 Serializer

The serializer uses `superjson` with custom transformers for React Native compatibility.

### `serialize(value: any): string`

Serialize a value to a JSON string with support for:

- Functions (serialized by name)
- Symbols
- Objects with `Symbol.toStringTag`
- Circular references
- Special types (Date, RegExp, etc.)

```ts
import { serialize } from '@revenge-mod/devtools-shared/serializer'

const data = { fn: () => {}, sym: Symbol('test') }
const json = serialize(data)
```

### `deserialize<T>(json: string): T`

Deserialize a JSON string back to its original value:

```ts
import { deserialize } from '@revenge-mod/devtools-shared/serializer'

const data = deserialize<MyType>(json)
```

### `createDepthLimitedProxy<T>(obj: T, maxDepth?: number, currentDepth?: number): T`

Create a proxy that limits object traversal depth to prevent excessive serialization:

```ts
import { createDepthLimitedProxy } from '@revenge-mod/devtools-shared/serializer'

const obj = { deep: { nested: { structure: { here: 'value' } } } }
const limited = createDepthLimitedProxy(obj, 2)

// Accessing beyond depth 2 returns special markers:
// limited.deep.nested.structure  // Returns [Object]
```

The proxy handles:

- **Objects** - Replaced with `[Object]` at max depth
- **Functions** - Replaced with `[Function: name]` at max depth
- **Getters** - Replaced with `[Getter]` at max depth
- **Setters** - Replaced with `[Setter]` at max depth
- **Getter/Setter pairs** - Replaced with `[Getter/Setter]` at max depth
- **Arrays** - Each element is proxied recursively

These markers are rendered with colors in Node.js environments.

## 📊 Logger

Server-side logging utilities that preserve the terminal prompt.

### `logger`

Main logger instance with colored output:

```ts
import { logger } from '@revenge-mod/devtools-shared/logger'

logger.debug('Debug message')       // Plain output
logger.log('Normal message')        // Plain output
logger.info('Info message')         // ℹ️ prefix
logger.warn('Warning')              // ⚠️ prefix
logger.error('Error')               // 🛑 prefix
logger.success('Success')           // ✅ prefix
logger.server('Server message')     // [SERVER] prefix in magenta
logger.client('a1b2c3d4', 'Client') // [a1b2c3d4] prefix in cyan
```

### `createClientLogger(id: string)`

Create a logger instance for a specific client:

```ts
import { createClientLogger } from '@revenge-mod/devtools-shared/logger'

const clientLog = createClientLogger('a1b2c3d4')
clientLog.log('Message')    // [a1b2c3d4] Message
clientLog.warn('Warning')   // ⚠️ [a1b2c3d4] Warning
clientLog.error('Error')    // 🛑 [a1b2c3d4] Error
```

### `setPrompt(prompt: string, line?: string)`

Set the current prompt for preservation during logging:

```ts
import { setPrompt } from '@revenge-mod/devtools-shared/logger'

setPrompt('> ', 'user input')
```

### `clearPromptLine()`

Clear the current input line:

```ts
import { clearPromptLine } from '@revenge-mod/devtools-shared/logger'

clearPromptLine()
```

## 🎨 Features

### Advanced Serialization

The serializer handles complex JavaScript objects:

```ts
// Functions are preserved by name
const fn = function namedFunction() {}
serialize({ fn })  // Preserves function name

// Symbols are preserved
const sym = Symbol('description')
serialize({ sym })  // Preserves symbol description

// Special objects maintain their string representation
const map = new Map()
serialize({ map })  // Preserves [object Map] representation
```

### Depth Limiting

Prevents excessive serialization and circular references:

```ts
const circular = { a: {} }
circular.a.b = circular

const proxy = createDepthLimitedProxy(circular, 2)
// Access beyond depth returns markers instead of recursing infinitely
```

### Prompt Preservation

The logger clears and restores the terminal prompt when logging:

```ts
// User is typing: "> hello world"
logger.log('New message')
// Output:
// New message
// > hello world  (prompt restored)
```

## 📜 License

This project is licensed under CC0 1.0. See [LICENSE](../../LICENSE) for more details.
