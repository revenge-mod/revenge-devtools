/** biome-ignore-all lint/complexity/noBannedTypes: don't care */

import chalk from 'chalk'
import { parse, stringify } from 'devalue'

const inspect = Symbol.for('nodejs.util.inspect.custom')

class MaxDepthObject {
	[inspect]() {
		return chalk.cyan('[Object]')
	}

	toString() {
		return '[Object]'
	}
}

class MaxDepthFunction {
	constructor(public name: string = 'anonymous') {}

	[inspect]() {
		return chalk.cyan(`[Function: ${this.name}]`)
	}

	toString() {
		return `[Function: ${this.name}]`
	}
}

class MaxDepthGetter {
	constructor(public name: string) {}

	[inspect]() {
		return chalk.cyan('[Getter]')
	}

	toString() {
		return '[Getter]'
	}
}

class MaxDepthSetter {
	constructor(public name: string) {}

	[inspect]() {
		return chalk.cyan('[Setter]')
	}

	toString() {
		return '[Setter]'
	}
}

class MaxDepthGetterSetter {
	constructor(public name: string) {}

	[inspect]() {
		return chalk.cyan('[Getter/Setter]')
	}

	toString() {
		return '[Getter/Setter]'
	}
}

class TaggedObject {
	constructor(public tag: string) {}

	[inspect]() {
		return chalk.cyan(this.tag)
	}

	toString() {
		return this.tag
	}
}

function isPlaceholder(value: object): boolean {
	return (
		value instanceof MaxDepthObject ||
		value instanceof MaxDepthFunction ||
		value instanceof MaxDepthGetter ||
		value instanceof MaxDepthSetter ||
		value instanceof MaxDepthGetterSetter ||
		value instanceof TaggedObject
	)
}

function isTagged(value: object): boolean {
	try {
		return (
			value.constructor !== Object &&
			Symbol.toStringTag in value &&
			!(value instanceof Map) &&
			!(value instanceof Set)
		)
	} catch {
		return false
	}
}

function symbolKeyName(key: symbol, copy: object): string {
	const base = `[Symbol(${key.description ?? ''})]`
	let name = base
	let index = 1
	while (name in copy) name = `${base}#${index++}`
	return name
}

/**
 * Creates an eager, depth-bounded snapshot of a value as plain objects,
 * arrays, and placeholder instances. Repeated references and cycles within
 * the depth window are preserved as real shared references.
 *
 * @param value - The value to snapshot
 * @param maxDepth - Maximum depth to traverse (default: 2)
 */
export function snapshot<T>(value: T, maxDepth = 2): T {
	return snap(value, maxDepth, 0, new WeakMap()) as T
}

function snap(
	value: unknown,
	maxDepth: number,
	depth: number,
	seen: WeakMap<object, unknown>,
): unknown {
	if (value == null) return value

	if (typeof value === 'function')
		return new MaxDepthFunction((value as Function).name || 'anonymous')

	if (typeof value !== 'object') return value

	if (isPlaceholder(value)) return value

	if (value instanceof Date || value instanceof RegExp || value instanceof URL)
		return value

	if (seen.has(value)) return seen.get(value)

	if (depth >= maxDepth) return new MaxDepthObject()

	if (value instanceof Map) {
		const copy = new Map()
		seen.set(value, copy)
		for (const [k, v] of value)
			copy.set(
				snap(k, maxDepth, depth + 1, seen),
				snap(v, maxDepth, depth + 1, seen),
			)
		return copy
	}

	if (value instanceof Set) {
		const copy = new Set()
		seen.set(value, copy)
		for (const v of value) copy.add(snap(v, maxDepth, depth + 1, seen))
		return copy
	}

	if (Array.isArray(value)) {
		const copy: unknown[] = []
		seen.set(value, copy)
		for (let i = 0; i < value.length; i++) {
			try {
				copy[i] = snap(value[i], maxDepth, depth + 1, seen)
			} catch {
				copy[i] = new MaxDepthObject()
			}
		}
		return copy
	}

	if (isTagged(value))
		return new TaggedObject(Object.prototype.toString.call(value))

	const copy: Record<string, unknown> = {}
	seen.set(value, copy)

	for (const key of Reflect.ownKeys(value)) {
		let descriptor: PropertyDescriptor | undefined
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key)
		} catch {
			continue
		}
		if (!descriptor) continue

		let child: unknown
		if ('value' in descriptor) {
			try {
				child = snap(descriptor.value, maxDepth, depth + 1, seen)
			} catch {
				child = new MaxDepthObject()
			}
		} else {
			const hasGetter = typeof descriptor.get === 'function'
			const hasSetter = typeof descriptor.set === 'function'

			if (depth + 1 >= maxDepth) {
				child =
					hasGetter && hasSetter
						? new MaxDepthGetterSetter(String(key))
						: hasGetter
							? new MaxDepthGetter(String(key))
							: new MaxDepthSetter(String(key))
			} else if (hasGetter) {
				try {
					child = snap(descriptor.get!.call(value), maxDepth, depth + 1, seen)
				} catch {
					child = new MaxDepthGetter(String(key))
				}
			} else {
				child = new MaxDepthSetter(String(key))
			}
		}

		const name = typeof key === 'symbol' ? symbolKeyName(key, copy) : key
		copy[name] = child
	}

	return copy
}

const reducers: Record<string, (value: unknown) => unknown> = {
	MaxDepthObject: v => v instanceof MaxDepthObject && [],
	MaxDepthFunction: v => v instanceof MaxDepthFunction && [v.name],
	MaxDepthGetter: v => v instanceof MaxDepthGetter && [v.name],
	MaxDepthSetter: v => v instanceof MaxDepthSetter && [v.name],
	MaxDepthGetterSetter: v => v instanceof MaxDepthGetterSetter && [v.name],
	TaggedObject: v => v instanceof TaggedObject && [v.tag],
	URL: v => typeof URL !== 'undefined' && v instanceof URL && [v.href],
	symbol: v => typeof v === 'symbol' && [v.description ?? ''],
	function: v =>
		typeof v === 'function' && [(v as Function).name || '<anonymous>'],
	instance: v => {
		if (v === null || typeof v !== 'object') return false
		let proto: object | null
		try {
			proto = Object.getPrototypeOf(v)
		} catch {
			return [{}]
		}
		if (
			proto === Object.prototype ||
			proto === Array.prototype ||
			proto === null
		)
			return false
		if (
			v instanceof Date ||
			v instanceof RegExp ||
			v instanceof Map ||
			v instanceof Set
		)
			return false
		return [{ ...v }]
	},
}

const revivers: Record<string, (value: any) => unknown> = {
	MaxDepthObject: () => new MaxDepthObject(),
	MaxDepthFunction: ([name]: [string]) => new MaxDepthFunction(name),
	MaxDepthGetter: ([name]: [string]) => new MaxDepthGetter(name),
	MaxDepthSetter: ([name]: [string]) => new MaxDepthSetter(name),
	MaxDepthGetterSetter: ([name]: [string]) => new MaxDepthGetterSetter(name),
	TaggedObject: ([tag]: [string]) => new TaggedObject(tag),
	URL: ([href]: [string]) => new URL(href),
	symbol: ([description]: [string]) => Symbol(description),
	function: ([name]: [string]) =>
		// biome-ignore lint/complexity/useArrowFunction: THOU SHALL BE NAMED!!!
		Object.defineProperty(function () {}, 'name', { value: name }),
	instance: ([props]: [Record<string, unknown>]) => props,
}

/**
 * Serialize a value to a JSON string using devalue with custom reducers.
 * Handles functions, symbols, depth placeholders, and special objects.
 *
 * @param value - Value to serialize
 * @returns JSON string representation
 */
export function serialize(value: unknown): string {
	return stringify(value, reducers)
}

/**
 * Deserialize a JSON string back to its original value using devalue.
 *
 * @param json - JSON string to deserialize
 * @returns Deserialized value
 */
export function deserialize<T = unknown>(json: string): T {
	return parse(json, revivers) as T
}
