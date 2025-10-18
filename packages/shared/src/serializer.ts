/** biome-ignore-all lint/complexity/noBannedTypes: don't care */

import chalk from 'chalk'
import SuperJSON from 'superjson'

const superjson = new SuperJSON()

superjson.registerCustom<Function, string>(
	{
		isApplicable: (v): v is Function => typeof v === 'function',
		serialize: v => v.name || '<anonymous>',
		deserialize: v =>
			// biome-ignore lint/complexity/useArrowFunction: THOU SHALL BE NAMED!!!
			Object.defineProperty(function () {}, 'name', { value: v }),
	},
	'function',
)

superjson.registerCustom<symbol, string>(
	{
		isApplicable: (v): v is symbol => typeof v === 'symbol',
		serialize: v => v.description ?? '',
		deserialize: v => Symbol(v),
	},
	'symbol',
)

superjson.registerCustom<object, string>(
	{
		isApplicable: (v): v is object => {
			// Check if it's an object (not null, not array, not a basic type)
			if (
				v == null ||
				typeof v !== 'object' ||
				Array.isArray(v) ||
				v.constructor === Object
			) {
				return false
			}
			// Check if it has Symbol.toStringTag
			return Symbol.toStringTag in v
		},
		serialize: v => {
			// Use Object.prototype.toString to get the tag
			return Object.prototype.toString.call(v)
		},
		deserialize: v => {
			// Ensure v is treated as a string
			const tagString = String(v)
			// Create a simple object with the toString representation
			return {
				[Symbol.for('nodejs.util.inspect.custom')]() {
					return chalk.cyan(tagString)
				},
				toString() {
					return tagString
				},
			}
		},
	},
	'toStringTag',
)

class MaxDepthObject {
	// Custom inspect for Node.js environments
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return chalk.cyan('[Object]')
	}

	// Fallback toString for browsers/non-Node environments
	toString() {
		return '[Object]'
	}
}

class MaxDepthFunction {
	constructor(public name: string = 'anonymous') {}

	// Custom inspect for Node.js environments
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return chalk.cyan(`[Function: ${this.name}]`)
	}

	// Fallback toString for browsers/non-Node environments
	toString() {
		return `[Function: ${this.name}]`
	}
}

class MaxDepthGetter {
	constructor(public name: string) {}

	// Custom inspect for Node.js environments
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return chalk.cyan(`[Getter]`)
	}

	// Fallback toString for browsers/non-Node environments
	toString() {
		return '[Getter]'
	}
}

class MaxDepthSetter {
	constructor(public name: string) {}

	// Custom inspect for Node.js environments
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return chalk.cyan(`[Setter]`)
	}

	// Fallback toString for browsers/non-Node environments
	toString() {
		return '[Setter]'
	}
}

class MaxDepthGetterSetter {
	constructor(public name: string) {}

	// Custom inspect for Node.js environments
	[Symbol.for('nodejs.util.inspect.custom')]() {
		return chalk.cyan(`[Getter/Setter]`)
	}

	// Fallback toString for browsers/non-Node environments
	toString() {
		return '[Getter/Setter]'
	}
}

superjson.registerClass(MaxDepthObject, {
	identifier: 'MaxDepthObject',
	allowProps: [],
})

superjson.registerClass(MaxDepthFunction, {
	identifier: 'MaxDepthFunction',
	allowProps: ['name'],
})

superjson.registerClass(MaxDepthGetter, {
	identifier: 'MaxDepthGetter',
	allowProps: ['name'],
})

superjson.registerClass(MaxDepthSetter, {
	identifier: 'MaxDepthSetter',
	allowProps: ['name'],
})

superjson.registerClass(MaxDepthGetterSetter, {
	identifier: 'MaxDepthGetterSetter',
	allowProps: ['name'],
})

/**
 * Creates a Proxy that limits object depth traversal.
 * @param obj - The object to wrap
 * @param maxDepth - Maximum depth to traverse (default: 2)
 * @param currentDepth - Current depth level (used internally)
 */
export function createDepthLimitedProxy<T extends object>(
	obj: T,
	maxDepth = 2,
	currentDepth = 0,
): T {
	// Handle null/undefined
	if (obj == null) return obj

	// Handle primitive types
	if (typeof obj !== 'object' && typeof obj !== 'function') return obj

	// Check if we've exceeded max depth
	if (currentDepth >= maxDepth) {
		if (typeof obj === 'function') {
			return new MaxDepthFunction((obj as Function).name || 'anonymous') as any
		}
		return new MaxDepthObject() as any
	}

	// Handle arrays
	if (Array.isArray(obj)) {
		return obj.map(item => {
			if (item != null && typeof item === 'object') {
				return createDepthLimitedProxy(item, maxDepth, currentDepth + 1)
			}
			return item
		}) as any
	}

	return new Proxy(obj, {
		get(target, prop, receiver) {
			// Check if this property is a getter/setter at max depth
			const descriptor = Object.getOwnPropertyDescriptor(target, prop)

			// If we're at max depth and this is an accessor property, show the getter/setter
			if (currentDepth + 1 >= maxDepth && descriptor) {
				const hasGetter = typeof descriptor.get === 'function'
				const hasSetter = typeof descriptor.set === 'function'

				if (hasGetter && hasSetter) {
					return new MaxDepthGetterSetter(String(prop))
				}
				if (hasGetter) {
					return new MaxDepthGetter(String(prop))
				}
				if (hasSetter) {
					return new MaxDepthSetter(String(prop))
				}
			}

			const value = Reflect.get(target, prop, receiver)

			// If the value is an object/function and the next level would exceed max depth, return the message
			if (
				value != null &&
				(typeof value === 'object' || typeof value === 'function') &&
				currentDepth + 1 >= maxDepth
			) {
				if (typeof value === 'function') {
					return new MaxDepthFunction((value as Function).name || 'anonymous')
				}
				return new MaxDepthObject()
			}

			// If the value is an object or function, wrap it in a proxy
			if (
				value != null &&
				(typeof value === 'object' || typeof value === 'function')
			) {
				return createDepthLimitedProxy(value, maxDepth, currentDepth + 1)
			}

			return value
		},
		ownKeys(target) {
			return Reflect.ownKeys(target)
		},
		getOwnPropertyDescriptor(target, prop) {
			return Reflect.getOwnPropertyDescriptor(target, prop)
		},
	})
}

/**
 * Serialize a value to JSON string using superjson with custom transformers.
 * Handles functions, symbols, and special objects gracefully.
 *
 * @param value - Value to serialize
 * @returns JSON string representation
 */
export const serialize = superjson.stringify

/**
 * Deserialize a JSON string back to its original value using superjson.
 *
 * @param json - JSON string to deserialize
 * @returns Deserialized value
 */
export const deserialize = superjson.parse
