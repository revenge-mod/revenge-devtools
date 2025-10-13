# 👷 Revenge Developer Tools

Debugging tools for modifying React Native apps in runtime.

Comes with serializer, logger, and a simple WebSocket server + client.

## Setup

```bash
bun install
```

## Server

```bash
cd packages/server
bun start
```

Server runs on `ws://localhost:7864` by default. Set `PORT` environment variable to change.

## Client (React Native)

```ts
import { DevToolsClient } from "@revenge-mod/devtools-client"
import { LogLevel } from '@revenge-mod/devtools-shared/constants'

const client = new DevToolsClient()
client.connect("ws://localhost:7864", "Some additional info")

// Expose local variables to server
client.expose('test', { a: 1, b: 2 })
client.expose('user', { name: 'John', age: 30 })

client.log(LogLevel.Default, ["Hello from client"])
client.log(LogLevel.Default, [globalThis])
```

## 📜 License

This project was made by mostly using AI tools, so it is licensed under CC0 1.0.  
See [LICENSE](./LICENSE) for more details.
