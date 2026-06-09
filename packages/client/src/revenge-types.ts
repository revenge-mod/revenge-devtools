//! TEMPORARY VENDORED REVENGE TYPES UNTIL CODEBASE MERGE!!!

export type ModuleId = number
export type ModuleExports = any

/** Module filter */
export interface Filter {
	(id: ModuleId, exports?: ModuleExports): boolean
	key: string
	flags: number
	scopes: number
	and(filter: Filter): Filter
	or(filter: Filter): Filter
	keyAs(key: string): Filter
	scope(...scopes: number[]): Filter
}

/** A filter factory (e.g. `withProps`, `withName`). */
export type FilterGenerator = (...args: any[]) => Filter

/** Callback invoked for each matched module. */
export type GetModulesCallback = (exports: ModuleExports, id: ModuleId) => any

/** Unsubscribes from a `getModules`/`waitForModules` subscription. */
export type UnsubscribeFunction = () => void

export interface GetModulesOptions {
	/**
	 * Maximum number of modules to get.
	 * @default 1
	 */
	max?: number
	/** Whether to initialize matching uninitialized modules. */
	initialize?: boolean
	/** Whether to use cached results. */
	cached?: boolean
	[key: string]: unknown
}

export interface LookupModulesOptions {
	/**
	 * Whether to initialize matching uninitialized modules. When `false`,
	 * uninitialized matches yield `[undefined, id]`.
	 */
	initialize?: boolean
	/** Whether to use cached lookup results. */
	cached?: boolean
	/** Whether to return the whole module namespace instead of the default export. */
	returnNamespace?: boolean
	[key: string]: unknown
}

export interface RevengeModuleFinders {
	getModules(
		filter: Filter,
		callback: GetModulesCallback,
		options?: GetModulesOptions,
	): UnsubscribeFunction
	lookupModule(
		filter: Filter,
		options?: Record<string, unknown>,
	): [exports: ModuleExports, id: ModuleId] | []
	lookupModules(
		filter: Filter,
		options?: LookupModulesOptions,
	): Generator<[exports: ModuleExports | undefined, id: ModuleId], undefined>
	waitForModules(
		filter: Filter,
		callback: GetModulesCallback,
		options?: Record<string, unknown>,
	): UnsubscribeFunction
	/** Filter factories keyed by name (`withProps`, `withName`, ...). */
	filters: Record<string, FilterGenerator>
}

export interface RevengeModuleMetroUtils {
	getInitializedModuleExports(id: ModuleId): ModuleExports | undefined
	isModuleInitialized(id: ModuleId): number | undefined
}

export interface RevengeModules {
	finders: RevengeModuleFinders
	metro: {
		utils: RevengeModuleMetroUtils
		[key: string]: unknown
	}
	[key: string]: unknown
}

export type UnpatchFunction = () => void

export interface HookOptions {
	priority?: number
}

/** The 3 patch kinds exposed by `@revenge-mod/patcher`. */
export type PatchMethod = 'before' | 'instead' | 'after'

export interface RevengePatcher {
	before(
		parent: Record<PropertyKey, any>,
		key: PropertyKey,
		hook: (args: any[]) => any[] | void,
		options?: HookOptions,
	): UnpatchFunction
	instead(
		parent: Record<PropertyKey, any>,
		key: PropertyKey,
		hook: (args: any[], original: (...args: any[]) => any) => any,
		options?: HookOptions,
	): UnpatchFunction
	after(
		parent: Record<PropertyKey, any>,
		key: PropertyKey,
		hook: (result: any, args: any[]) => any,
		options?: HookOptions,
	): UnpatchFunction
}

/**
 * The Revenge "unscoped" API object exposed to the DevTools client scope as `revenge`.
 */
export interface RevengeScope {
	modules: RevengeModules
	patcher: RevengePatcher
	discord?: RevengeDiscord
	[key: string]: unknown
}

/** A Discord Flux dispatch payload. (`{ type: string; ... }`) */
export interface FluxPayload {
	type: string
	[key: PropertyKey]: any
}

/**
 * A Discord Flux event dispatch patch.
 *
 * Returning a falsy value blocks the event, returning the (modified) payload passes it through.
 */
export type FluxEventDispatchPatch = (
	payload: FluxPayload,
) => FluxPayload | undefined | void

/** The `revenge.discord.flux` API namespace. */
export interface RevengeDiscordFlux {
	/** Registers a patch for all Flux events. Returns an unsubscribe function. */
	onAnyFluxEventDispatched(patch: FluxEventDispatchPatch): UnsubscribeFunction
	/** Registers a patch for a specific Flux event type. Returns an unsubscribe function. */
	onFluxEventDispatched(
		type: string,
		patch: FluxEventDispatchPatch,
	): UnsubscribeFunction
	[key: string]: unknown
}

export interface BundleUpdaterManager {
	/** Reloads the app. */
	reload(): void
}

export interface RevengeDiscordNative {
	BundleUpdaterManager: BundleUpdaterManager
	[key: string]: unknown
}

/** The `revenge.discord.*` API namespace. */
export interface RevengeDiscord {
	flux: RevengeDiscordFlux
	native: RevengeDiscordNative
	[key: string]: unknown
}
