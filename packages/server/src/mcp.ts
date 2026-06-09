import * as util from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCPCommand } from '@revenge-mod/devtools-shared/constants'
import { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MCPCommand as MCPCommandType } from '@revenge-mod/devtools-shared/types'

export type RunMcpCommandFn = (
	command: MCPCommandType,
	args: Record<string, unknown>,
	clientId?: string,
) => Promise<unknown>

/**
 * Lists currently connected clients from server state.
 */
export type ListClientsFn = () => Array<{
	id: string
	info?: string
	version: number
	authenticated: boolean
}>

function text(value: unknown) {
	return {
		content: [
			{
				type: 'text' as const,
				text:
					typeof value === 'string'
						? value
						: util.inspect(value, { depth: 8, colors: false }),
			},
		],
	}
}

function errorText(message: string) {
	return { ...text(message), isError: true }
}

/**
 * Build an MCP server exposing the Revenge DevTools client commands as tools.
 *
 * @param run Forwards a command to the targeted client and awaits its result.
 * @param listClients Returns the list of connected clients.
 */
export function createMcpServer(
	run: RunMcpCommandFn,
	listClients: ListClientsFn,
): McpServer {
	const server = new McpServer({
		name: 'revenge-devtools',
		version: pkg.version,
	})

	const clientId = z
		.string()
		.optional()
		.describe(
			'ID of the client to target. Defaults to the only connected client.',
		)

	server.registerTool(
		MCPCommand.GetModules,
		{
			description:
				'Find Revenge/Metro modules by filter. Returns matching module IDs and a depth-limited shape of their exports. Can wait until `max` matches arrive or `timeout` elapses.',
			inputSchema: {
				filter: z
					.string()
					.describe(
						'Filter factory name, e.g. "withProps", "withName", "withSingleProp".',
					),
				args: z
					.string()
					.default('[]')
					.describe(
						'Stringified JS array of arguments passed to the filter factory, evaluated in client scope. e.g. "[\'createElement\']".',
					),
				max: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Maximum number of modules to collect (default 1).'),
				timeout: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Milliseconds to wait for matches (default 5000).'),
				depth: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Depth to traverse when describing exports.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.GetModules, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.LookupModules,
		{
			description:
				'Lookup all Revenge/Metro modules matching a filter (synchronous). Returns every matching module ID with a depth-limited shape of its exports. Set `initialize: false` to return matching IDs with `null` exports WITHOUT initializing the modules (no side effects).',
			inputSchema: {
				filter: z
					.string()
					.describe(
						'Filter factory name, e.g. "withProps", "withName", "withSingleProp".',
					),
				args: z
					.string()
					.default('[]')
					.describe(
						'Stringified JS array of arguments passed to the filter factory, evaluated in client scope.',
					),
				initialize: z
					.boolean()
					.optional()
					.describe(
						'Whether to initialize matching uninitialized modules (default true). When false, uninitialized matches return `null` exports.',
					),
				max: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Maximum number of modules to collect (default: all).'),
				depth: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Depth to traverse when describing exports.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.LookupModules, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.RequireModule,
		{
			description:
				'Require (initialize if needed) a Metro module by its ID and return a depth-limited shape of its exports.',
			inputSchema: {
				id: z.number().int().describe('The Metro module ID to require.'),
				depth: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Depth to traverse when describing exports.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.RequireModule, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.SaveVar,
		{
			description:
				'Evaluate an expression in the client scope and store it under `vars[name]` (same shortcut as `vars.x = value`) for reuse in later calls.',
			inputSchema: {
				name: z.string().describe('Variable name to store under `vars`.'),
				expression: z
					.string()
					.describe('Expression to evaluate; its result is stored.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.SaveVar, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.PatchMethod,
		{
			description:
				'Patch a method on a target object using the Revenge patcher. Returns a patch ID usable with unpatch_method.',
			inputSchema: {
				method: z
					.enum(['before', 'instead', 'after'])
					.describe('The patch kind.'),
				target: z
					.string()
					.describe(
						'Expression resolving to the object/parent to patch (in client scope).',
					),
				key: z.string().describe('The method key to patch on the target.'),
				hook: z
					.string()
					.describe('Function expression to evaluate and use as the hook.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.PatchMethod, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.UnpatchMethod,
		{
			description: 'Remove a patch previously created with patch_method.',
			inputSchema: {
				id: z.number().int().describe('The patch ID returned by patch_method.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.UnpatchMethod, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.Eval,
		{
			description:
				'Evaluate arbitrary code in the client scope and return the depth-limited result. Use for anything not covered by the other tools.',
			inputSchema: {
				code: z.string().describe('Code to evaluate in the client scope.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.Eval, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	/* ---- Discord tools ---- */

	server.registerTool(
		MCPCommand.DiscordReload,
		{
			description:
				'Reload the Discord app via BundleUpdaterManager. The targeted client connection will drop as the app restarts.',
			inputSchema: { clientId },
		},
		async ({ clientId: cid }) => {
			try {
				return text(await run(MCPCommand.DiscordReload, {}, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.DiscordFluxListen,
		{
			description:
				'Observe dispatched Flux events (without blocking them). Resolves with captured event payloads once `count` events are seen or `timeout` elapses.',
			inputSchema: {
				event: z
					.string()
					.optional()
					.describe(
						'Specific Flux action type to listen for. Omit to capture all events.',
					),
				count: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Maximum number of events to capture (default 25).'),
				timeout: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Milliseconds to listen for (default 5000).'),
				depth: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe('Depth to traverse when describing each payload.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.DiscordFluxListen, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.DiscordFluxPatch,
		{
			description:
				'Patch a Flux event with a hook function. The hook receives the payload; returning a falsy value BLOCKS the event, returning the (modified) payload passes it through. Returns a patch ID usable with revenge_discord_flux_unpatch (shares the same ID store as revenge_patch_method).',
			inputSchema: {
				event: z
					.string()
					.optional()
					.describe(
						'Specific Flux action type to patch. Omit to patch all events.',
					),
				hook: z
					.string()
					.describe(
						'Function expression `(payload) => payload | undefined` evaluated in client scope.',
					),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.DiscordFluxPatch, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	server.registerTool(
		MCPCommand.DiscordFluxUnpatch,
		{
			description:
				'Remove a Flux patch previously created with revenge_discord_flux_patch.',
			inputSchema: {
				id: z
					.number()
					.int()
					.describe('The patch ID returned by revenge_discord_flux_patch.'),
				clientId,
			},
		},
		async ({ clientId: cid, ...args }) => {
			try {
				return text(await run(MCPCommand.DiscordFluxUnpatch, args, cid))
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	/// SERVER-LOCAL TOOLS

	server.registerTool(
		'revenge_devtools_clients',
		{
			description:
				'List the DevTools clients currently connected to the server. Reads server state directly (does not require any client to be connected).',
			inputSchema: {},
		},
		async () => {
			try {
				const list = listClients()
				return text({ count: list.length, clients: list })
			} catch (e: any) {
				return errorText(e?.message ?? String(e))
			}
		},
	)

	return server
}

/**
 * Handle a single MCP HTTP request in stateless mode.
 *
 * A fresh server and transport are created per request, avoiding any conflict with the REPL's ownership of stdin.
 */
export async function handleMcpHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	body: unknown,
	run: RunMcpCommandFn,
	listClients: ListClientsFn,
): Promise<void> {
	const server = createMcpServer(run, listClients)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	res.on('close', () => {
		transport.close()
		server.close()
	})

	await server.connect(transport)
	await transport.handleRequest(req, res, body)
}
