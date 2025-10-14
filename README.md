# 👷 Revenge Developer Tools

Debugging tools for modifying React Native apps in runtime.  
Comes with serializer, logger, and a simple WebSocket server + client.

## ⬇️ Install

### 💻 Server

```sh
bun install --global @revenge-mod/devtools-server
```

You can start the server with:

```sh
revenge-devtools
# or see options
revenge-devtools --help
```

The server runs on `ws://localhost:7864` by default. Pass in `--port <port>` to change the port.

### ⚛️ Client (React Native)

> The client package is only published on [JSR](https://jsr.io). To install it, run the following command:
>
> ```sh
> bunx jsr add @revenge-mod/devtools-client
> ```

While the server is running, you can connect to it from your React Native app.

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
