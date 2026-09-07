'use strict'

// npm keeps its package-specific dependency tree under renamed `deps` folders
// because electron-builder prunes directories named `node_modules`.
const Module = require('module')
const path = require('path')
const { pathToFileURL } = require('url')
const builtin = new Set(Module.builtinModules)
const dependencyRoot = process.env.DSH_NPM_DEPS
const originalResolveFilename = Module._resolveFilename

function registerEsmDependencyResolver(root) {
  if (typeof Module.register !== 'function') return
  const source = `
    import { createRequire } from 'node:module'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'

    let resolveFromDeps

    export function initialize(data) {
      resolveFromDeps = createRequire(pathToFileURL(join(data.dependencyRoot, '__npm-esm-loader__.cjs')))
    }

    export async function resolve(specifier, context, nextResolve) {
      const isBareSpecifier = !specifier.startsWith('node:')
        && !specifier.startsWith('.')
        && !specifier.startsWith('/')
        && !/^[A-Za-z]:[\\\\/]/.test(specifier)
      if (isBareSpecifier) {
        try {
          return {
            url: pathToFileURL(resolveFromDeps.resolve(specifier)).href,
            shortCircuit: true,
          }
        } catch {
          // Let Node resolve package-local imports and unavailable packages normally.
        }
      }
      return nextResolve(specifier, context)
    }
  `
  Module.register(`data:text/javascript,${encodeURIComponent(source)}`, {
    data: { dependencyRoot: root },
  })
}

if (dependencyRoot) {
  const resolveFrom = (request, parent, depsDir) => {
    const probe = new Module(path.join(depsDir, '__npm-loader__.cjs'))
    probe.filename = path.join(depsDir, '__npm-loader__.cjs')
    probe.paths = [depsDir]
    return originalResolveFilename.call(Module, request, probe)
  }
  const findPackage = (request, parent) => {
    let cursor = parent && parent.filename ? path.dirname(parent.filename) : dependencyRoot
    while (cursor && cursor.length >= dependencyRoot.length) {
      try {
        return resolveFrom(request, parent, path.join(cursor, 'deps'))
      } catch {
        const next = path.dirname(cursor)
        if (next === cursor) break
        cursor = next
      }
    }
    try {
      return resolveFrom(request, parent, path.join(dependencyRoot, 'deps'))
    } catch {
      return null
    }
  }
  Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
    if (!builtin.has(request) && !request.startsWith('node:') && !request.startsWith('.') && !path.isAbsolute(request)) {
      const bundled = findPackage(request, parent)
      if (bundled !== null) return bundled
    }
    return originalResolveFilename.call(Module, request, parent, isMain, options)
  }
  registerEsmDependencyResolver(dependencyRoot)
}
