# @revenge-mod/devtools-server

WebSocket server with interactive terminal for debugging React Native apps connected via the Revenge Developer Tools client.

## 📖 Overview

The server package provides a WebSocket server that:

- Provides an interactive terminal for executing code on clients
- Supports file watching with automatic code execution on changes
- Manages client connections and settings
- Includes variable mapping for easier code execution
- Receives and displays logs from connected clients *(must be manually implemented in client)*

## ⬇️ Install

Install globally using Bun:

```sh
bun install --global @revenge-mod/devtools-server
```

Or using npm:

```sh
npm install --global @revenge-mod/devtools-server
```

## 🚀 Usage

Start the server with default settings:

```sh
revenge-devtools
```

The server runs on `ws://localhost:7864` by default.

### ⚙️ Options

```sh
revenge-devtools [options]
```

- `--port, -p <port>` - Port to listen on (default: 7864)
- `--watch, -w [path]` - Enable file watching (default: current directory if no path provided)
- `--mcp` - Enable the MCP server on the main port at the MCP path (default path: `/mcp`)
- `--mcp-port <port>` - Enable the MCP server on a separate port
- `--mcp-path <path>` - Path for the MCP endpoint (default: `/mcp`)
- `--help, -h` - Show help information

#### Examples

```sh
# Run on a custom port
revenge-devtools --port 8080

# Enable file watching on a specific directory
revenge-devtools --watch ./src

# Enable file watching on current directory
revenge-devtools --watch

# Combine options
revenge-devtools --port 8080 --watch ./src

# Enable the MCP server (Streamable HTTP) at http://localhost:7864/mcp
revenge-devtools --mcp

# Run the MCP server on a separate port
revenge-devtools --mcp-port 7865
```

## 🤖 MCP server

When started with `--mcp`, the server exposes a [Model Context Protocol](https://modelcontextprotocol.io) endpoint over Streamable HTTP so an LLM/agent can drive a connected client. Each tool call is forwarded to the target client over the existing WebSocket connection and the result is returned to the caller.

Point your MCP client at `http://localhost:<port><mcp-path>` (default `http://localhost:7864/mcp`).

### 🛠️ Tools

#### Modules

- `revenge_get_modules` - Find Metro/Revenge modules by a named filter (e.g. `withProps`) and a stringified array of arguments (evaluated in the client scope, so dynamic values are passable). Returns matching module IDs and a depth-limited shape of their exports. Supports `max` and `timeout` to wait for matches.
- `revenge_lookup_modules` - Synchronously look up all modules matching a filter. Set `initialize: false` to return matching IDs with `null` exports **without** initializing the modules (no side effects).
- `revenge_require_module` - Require (initialize if needed) a Metro module by its ID and return a depth-limited shape of its exports.

#### Scope & patching

- `revenge_save_var` - Evaluate an expression in the client scope and store it under `vars[name]` (same shortcut as `vars.x = value`) for reuse in later calls.
- `revenge_patch_method` - Patch a method (`before` / `instead` / `after`) on a target object using the Revenge patcher. Returns a patch ID.
- `revenge_unpatch_method` - Remove a patch by its ID.
- `revenge_eval` - Evaluate arbitrary code in the client scope and return the depth-limited result.

#### Discord

- `revenge_discord_reload` - Reload the Discord app via `BundleUpdaterManager` (the client connection will drop).
- `revenge_discord_flux_listen` - Observe dispatched Flux events without blocking them, resolving once `count` events are captured or `timeout` elapses. Omit `event` to capture all events.
- `revenge_discord_flux_patch` - Patch a Flux event with a hook; returning a falsy value blocks the event. Returns a patch ID (shares the same ID store as `revenge_patch_method`/`revenge_unpatch_method`).
- `revenge_discord_flux_unpatch` - Remove a Flux patch by its ID.

#### Server

- `revenge_devtools_clients` - List the clients currently connected to the server. Reads server state directly, so it works even with no client connected.

Most tools accept an optional `clientId` to target a specific client when more than one is connected (`revenge_devtools_clients` does not, as it is server-local).

The MCP request timeout (how long the server waits for a client to respond) is configurable at runtime via the `server.mcp.commandTimeout` setting (milliseconds, default `30000`): `.setting server.mcp.commandTimeout 60000`. Long-running `revenge_discord_flux_listen` / `revenge_get_modules` waits should stay below this value.

> [!WARNING]
> MCP tools evaluate arbitrary code in the connected client (same trust model as the REPL). It is opt-in via `--mcp` and intended for trusted local connections only.

## ⌨️ REPL

Once the server is running, you can use these commands in the terminal:

### ⚛️ Client management

#### `.clients` or `.ls`

List all connected clients with their IDs and protocol versions.

```text
> .clients
Connected clients (2):
  a1b2c3d4 - v2
  e5f6g7h8 - v2
```

### 🗺️ Mappings

Mappings allow you to create shortcuts for accessing client-side values when executing code.

#### `.map`

Show all current mappings.

```text
> .map
Current mappings (2):
  nmp -> nativeModuleProxy
```

#### `.map+ <var> <path>`

Add a new mapping.

```text
> .map+ HI HermesInternal
Mapped: HI -> HermesInternal
```

Now you can use `HI` in your code:

```javascript
> HI === HermesInternal
true
```

#### `.map- <var>`

Remove a mapping.

```text
> .map- HI
Removed mapping: HI
```

### ⚙️ Settings

#### `.setting <key> [value]`

Get or set a configuration setting. If no value is provided, displays the current value.

```text
> .setting client.log.level
client.log.level: 1 (default: 1)

> .setting client.log.level 0
Set client.log.level = 0

> .setting
Current settings:
  client:
    log:
      level: 0
      interceptConsole: true
      inspectDepth: 2
  server:
    watch:
      command: false
```

#### Client settings

- `client.log.level` - Minimum log level (0=Debug, 1=Default, 2=Warn, 3=Error)
- `client.log.inspectDepth` - Maximum depth for object inspection
- `client.log.interceptConsole` - Whether to **suggest** intercepting console methods *(must be manually implemented in client)*

#### Server settings

- `server.watch.command` - Command to execute when watched files change

### 🧑‍💻 Code execution

Any input that doesn't start with a dot (`.`) is treated as JavaScript code and executed on all connected clients. Note that Hermes does not persist variables between executions. You can use the `vars` object to store persistent variables:

```javascript
> x = 1 + 1
2

> x
undefined

> vars.x = 1 + 1
2

> vars.x
2
```

The code is executed in the client's environment with access to:

- All exposed variables (via `client.expose()`)
- Mapped variables (via `.map+`)
- The `devTools` object containing the client instance

### 🗃️ File watching

When the server is started with `--watch`, you can configure automatic code execution on file changes:

```text
> .setting server.watch.command "console.log('Reloaded!')"
Set server.watch.command = console.log('Reloaded!')
```

Now whenever files change in the watched directory, the command will be executed on all clients.

### ⌨️ Other commands

#### `.help` or `?`

Show all available commands.

#### `.exit`, `.quit`, or `.q`

Shut down the server.

## 📨 Protocol

The server uses a simple WebSocket protocol with message types:

- `Hello` (1) - Client introduces itself with version
- `Hi` (2) - Server responds with version compatibility and settings
- `Log` (3) - Client sends log messages
- `Run` (4) - Server sends code to execute
- `MCPRun` (5) - Server asks the client to run an MCP command
- `MCPResult` (6) - Client returns the result of an MCP command

The protocol version is currently `3`. Clients with incompatible versions are rejected.

## 📝 Advanced usage

### Programmatic usage

You can also use the server programmatically in your own Node.js applications:

```ts
import { broadcast, sendToClient } from '@revenge-mod/devtools-server'
import { MessageType } from '@revenge-mod/devtools-shared/constants'

// Broadcast a message to all clients
broadcast({
  type: MessageType.Run,
  data: {
    code: 'console.log("Hello from custom script")',
    mappings: {}
  }
})

// Send to a specific client
sendToClient('a1b2c3d4', {
  type: MessageType.Run,
  data: {
    code: 'return user.name',
    mappings: { user: 'devTools.scope.user' }
  }
})
```

### File watching options

The server uses `@parcel/watcher` for efficient file watching. When changes are detected:

1. The configured watch command is executed on all clients
2. Variable mappings are included in the execution scope
3. Results are displayed in the server console

This enables workflows like:

```sh
# Watch for changes and reload a module
revenge-devtools --watch ./src

# In the server terminal:
> .setting server.watch.command "import('./myModule.js')"
```

## 📜 License

This project is licensed under CC0 1.0. See [LICENSE](../../LICENSE) for more details.
