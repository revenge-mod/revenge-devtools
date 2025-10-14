# @revenge-mod/devtools-client

Client library for connecting React Native apps to the Revenge Developer Tools server.

## 📖 Overview

The client package provides a WebSocket-based connection to the developer tools server, enabling real-time debugging and code execution in a modified React Native application.

## ⬇️ Install

The client package is only published on [JSR](https://jsr.io). To install it, run the following command:

```sh
bunx jsr add @revenge-mod/devtools-client
```

## 🚀 Usage

```ts
import { DevToolsClient } from "@revenge-mod/devtools-client"
import { LogLevel } from '@revenge-mod/devtools-shared/constants'

const client = new DevToolsClient()
client.connect("ws://localhost:7864", "My React Native App")
```

### Sending logs

The client can send logs to the server console with different log levels:

```ts
import { LogLevel } from '@revenge-mod/devtools-shared/constants'

// Debug logs (level 0)
client.log(LogLevel.Debug, ["Debug message", { data: 123 }])

// Default logs (level 1)
client.log(LogLevel.Default, ["Hello from client"])

// Warning logs (level 2)
client.log(LogLevel.Warn, ["Warning message"])

// Error logs (level 3)
client.log(LogLevel.Error, ["Error message", error])
```

### Exposing local variables

You can expose local variables to make them accessible from the server:

```ts
// Expose individual variables
client.expose('user', { name: 'John', age: 30 })
client.expose('config', appConfig)

// Access from server with:
// > user.name
// "John"
```

The exposed variables are available in the server's execution scope and can be referenced in code sent from the server.

### 🔎 Inspecting objects

The client automatically handles complex object serialization with configurable depth limiting:

```ts
// Log complex objects - automatically serialized
client.log(LogLevel.Default, [globalThis]) // { ... }
client.log(LogLevel.Default, [__r]) // [Function: __r]

// Depth is controlled by server settings (default: 2)
```

### 🔌 Connection

```ts
// Check connection status
if (client.isConnected()) {
  console.log("I'm connected!")
}

// Disconnect when done
client.disconnect()

// Clear all saved variables (this is not exposed scope variables!)
client.clearVars()
```

### 🖐️ Event handlers

You can listen to messages from the server:

```ts
import { MessageType } from '@revenge-mod/devtools-shared/constants'

// Listen for specific message types
client.on(MessageType.Hi, (msg) => {
  console.log('Server acknowledged connection', msg)
})

client.on(MessageType.Run, (msg) => {
  console.log('Server sent code to execute')
})

// Remove event handler
const handler = (msg) => console.log(msg)
client.on(MessageType.Hi, handler)
client.off(MessageType.Hi, handler)
```

## 📚 API reference

### `DevToolsClient`

#### Properties

- `static version: number` - Protocol version
- `ws: WebSocket | null` - WebSocket connection instance
- `settings: ClientSettings` - Current client settings received from server

#### Methods

##### `connect(url: string, info?: string): void`

Connect to the developer tools server.

- `url` - WebSocket server URL (e.g., `ws://localhost:7864`)
- `info` - Optional information string to identify the client

##### `disconnect(): void`

Disconnect from the server and clean up the connection.

##### `expose(key: string, value: any): void`

Expose a variable to the server execution scope.

- `key` - Variable name to use in server scope
- `value` - Value to expose (will be serialized)

##### `clearVars(): void`

Clear all saved variables. Not the scope itself!

##### `log(level: LogLevel, message: any[]): void`

Send a log message to the server.

- `level` - Log level (Debug, Default, Warn, Error)
- `message` - Array of values to log

##### `isConnected(): boolean`

Check if the client is connected and authenticated with the server.

Returns `true` if connected and authenticated, `false` otherwise.

##### `on(type: MessageType, handler: MessageHandler): void`

Register a handler for a specific message type.

- `type` - Message type to listen for
- `handler` - Callback function `(msg: Message) => void`

##### `off(type: MessageType, handler: MessageHandler): void`

Unregister a message handler.

- `type` - Message type
- `handler` - Handler function to remove

## 📝 Notes

- No sandboxing is applied to executed code
- Object depth limiting prevents circular references and excessive serialization
- The client must manually implement console method interception if desired (see `client.log.interceptConsole` setting)

## 📜 License

This project is licensed under CC0 1.0. See [LICENSE](../../LICENSE) for more details.
