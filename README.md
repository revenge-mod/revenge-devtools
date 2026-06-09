# 👷 Revenge Developer Tools

Powerful debugging tools for modified React Native applications, consisting of three main packages:

- **[@revenge-mod/devtools-client](./packages/client)** - Client library for React Native apps
- **[@revenge-mod/devtools-server](./packages/server)** - WebSocket server for receiving logs and executing commands
- **[@revenge-mod/devtools-shared](./packages/shared)** - Shared utilities, types, and constants

The tools enable real-time communication between your React Native app and a debugging server, allowing you to:

- Execute code remotely on the client from the server terminal
- Expose and inspect variables from your app environment
- Watch files and trigger automatic code execution on changes
- Send logs from your app to the server console *(must be manually implemented in client)*

## 📦 Packages

You'll typically only need to install the server. The client is intended for use in modified React Native applications, which may already have the client package integrated.

### 💻 Server

The server package provides a WebSocket server with an interactive terminal for debugging connected clients.

[Read more →](./packages/server/README.md)

### ⚛️ Client

The client package is designed for React Native applications and provides the `DevToolsClient` class for connecting to the server.

[Read more →](./packages/client/README.md)

### 🗄️ Shared

The shared package contains common utilities, types, and constants used by both client and server.

[Read more →](./packages/shared/README.md)

## 📜 License

This project was made by mostly using AI tools, so it is licensed under CC0 1.0.  
See [LICENSE](./LICENSE) for more details.
