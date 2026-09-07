import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type JsonRecord = Record<string, unknown>

export interface ClientStoreCompatibilityOptions {
  dshHome: string
  profilePath: string
  packagePath?: string
  /** Official runtimes >= 0.1.2 ship dsh-client-store as a static module. */
  runtimeVersion?: string
}

export interface ClientStoreCompatibilityResult {
  changed: boolean
  packagePath: string
  compatibilityPath: string
}

export interface VisionRouterCompatibilityOptions {
  profilePath: string
}

const PACKAGE_NAME = '@deepseek-ai/dsh-client-store'
const PACKAGE_SPECIFIER = 'file:../../.desktop-compat/dsh-client-store'
const PACKAGE_VERSION = '0.0.0-desktop-compat'

const compatibilityPackageBase = {
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  private: true,
  type: 'module',
  main: 'index.js',
  // Legacy community bundles synchronously require this package. It must be
  // a real browser client entry so dsh-client-modules includes its factory in
  // the boot graph before those consumers materialize.
  files: ['index.js', 'client.js', 'cordis.patch.yml'],
  exports: {
    '.': './index.js',
    './client': './client.js',
    './package.json': './package.json',
  },
}

export function runtimeProvidesBuiltInClientStore(version: string | undefined): boolean {
  if (version === undefined) return false
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 0 || minor > 1 || (minor === 1 && patch >= 2)
}

function createCompatibilityPackage(includeClientBundle: boolean): Record<string, unknown> {
  if (!includeClientBundle) return { ...compatibilityPackageBase }
  return {
    ...compatibilityPackageBase,
    dsh: {
      client: {
        platform: 'web',
        immediately: true,
      },
      bundle: {
        patch: './cordis.patch.yml',
      },
    },
  }
}

const compatibilityIndex = `export function apply() {\n  // The browser face is provided by client.js; the host face is intentionally inert.\n}\n`
const compatibilityPatch = `# The desktop bridge has no host-side behavior, but it must be an active
# Loader entry so dsh-client-modules can discover and serve its browser bundle.
- insert:
    - id: dsh-client-store-compat
      name: '${PACKAGE_NAME}'
`

const compatibilityClient = `window.__ModuleLoader__.load({
  id: "${PACKAGE_NAME}",
  factory: () => {
    const shallowEqual = (left, right) => {
      if (Object.is(left, right)) return true;
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.is(left[key], right[key]));
    };
    const createSnapshotStore = (initial) => {
      let state = initial;
      const listeners = new Set();
      const notify = () => { for (const listener of [...listeners]) listener(); };
      return {
        getSnapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        update: (mutator) => { const draft = structuredClone(state); mutator(draft); state = draft; notify(); },
        set: (next) => { state = next; notify(); },
      };
    };
    const defineStore = (decl) => ({
      spec: decl,
      create: (scopeKey) => {
        const persistKey = decl.persist === undefined ? undefined : scopeKey === undefined ? decl.persist : decl.persist + '.' + scopeKey;
        const store = createSnapshotStore(decl.init());
        const actions = {};
        for (const key of Object.keys(decl.actions)) actions[key] = (...args) => store.update(draft => decl.actions[key](draft, ...args));
        return {
          actions,
          getSnapshot: store.getSnapshot,
          subscribe: store.subscribe,
          store,
          clearPersisted: () => { if (persistKey !== undefined) localStorage.removeItem(persistKey); },
        };
      },
    });
    // Return a callable facade. Cordis accepts callable plugins without
    // unwrapping a namespace-like object, while legacy consumers can still
    // access the named helpers and apply method as properties.
    const plugin = () => {};
    plugin.apply = () => {};
    plugin.createSnapshotStore = createSnapshotStore;
    plugin.defineStore = defineStore;
    plugin.shallowEqual = shallowEqual;
    return plugin;
  },
});
`

const VISION_ROUTER_PRELUDE_RELATIVE_PATH = join('node_modules', 'dsh-vision-router', 'lib', 'client-host-compat-prelude.js')
const VISION_ROUTER_VULNERABLE_CATALOG_PROBE = /function hasHostCatalog\(remote\)\s*\{\s*return !!\(\s*remote && remote\.session &&\s*typeof remote\.session\.modelCatalog === 'function'\s*\);\s*\}/
const VISION_ROUTER_VULNERABLE_CATALOG_CALL = /function catalogModels\(remote\)\s*\{\s*return function models\(\)\s*\{\s*return Promise\.resolve\(remote\.session\.modelCatalog\(\)\)\.then\(wrapCatalogResult\);\s*\};\s*\}/
const VISION_ROUTER_VULNERABLE_REMOTE_PROXY = /function compatibleRemote\(remote\)\s*\{[\s\S]*?return new Proxy\(remote,\s*\{\s*get:\s*function\(target, property\)\s*\{[\s\S]*?\}\s*\}\);\s*\}/
const VISION_ROUTER_SAFE_CATALOG_PROBE = `function readRemoteSession(remote) {
    try {
      return remote && remote.session;
    } catch (_) {
      // Cordis throws while the asynchronously mounted namespace is absent.
      return undefined;
    }
  }

  function hasHostCatalog(remote) {
    var session = readRemoteSession(remote);
    return !!(session && typeof session.modelCatalog === 'function');
  }`
const VISION_ROUTER_SAFE_CATALOG_CALL = `function catalogModels(remote) {
    return function models() {
      var session = readRemoteSession(remote);
      if (!session || typeof session.modelCatalog !== 'function') {
        return Promise.resolve({
          result: {
            ok: false,
            error: { message: 'Vision Router model catalog is not available yet' }
          }
        });
      }
      return Promise.resolve(session.modelCatalog()).then(wrapCatalogResult);
    };
  }`
const VISION_ROUTER_SAFE_REMOTE_PROXY = `function compatibleRemote(remote) {
    if (!remote || (typeof remote !== 'object' && typeof remote !== 'function')) return remote;
    var hostCatalog = hasHostCatalog(remote);
    return new Proxy(remote, {
      get: function(target, property) {
        if (property === 'session') return readRemoteSession(target);
        if (property === '$on') {
          var subscribe = Reflect.get(target, property, target);
          if (typeof subscribe !== 'function') return subscribe;
          return function(event, listener) {
            var args = Array.prototype.slice.call(arguments);
            if (hostCatalog && event === LEGACY_CREDENTIAL_EVENT) args[0] = HOST_CREDENTIAL_EVENT;
            return subscribe.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function patchVisionRouterPreludeContent(content: string): { content: string; changed: boolean } {
  let next = content
  let changed = false
  if (!next.includes('function readRemoteSession(remote)') && VISION_ROUTER_VULNERABLE_CATALOG_PROBE.test(next)) {
    next = next.replace(VISION_ROUTER_VULNERABLE_CATALOG_PROBE, VISION_ROUTER_SAFE_CATALOG_PROBE)
    changed = true
  }
  if (!next.includes("Vision Router model catalog is not available yet") && VISION_ROUTER_VULNERABLE_CATALOG_CALL.test(next)) {
    next = next.replace(VISION_ROUTER_VULNERABLE_CATALOG_CALL, VISION_ROUTER_SAFE_CATALOG_CALL)
    changed = true
  }
  if (!next.includes('var hostCatalog = hasHostCatalog(remote)') && VISION_ROUTER_VULNERABLE_REMOTE_PROXY.test(next)) {
    next = next.replace(VISION_ROUTER_VULNERABLE_REMOTE_PROXY, VISION_ROUTER_SAFE_REMOTE_PROXY)
    changed = true
  }
  return { content: next, changed }
}

export async function ensureVisionRouterCompatibility(options: VisionRouterCompatibilityOptions): Promise<boolean> {
  const preludePath = join(options.profilePath, VISION_ROUTER_PRELUDE_RELATIVE_PATH)
  let content: string
  try {
    content = await readFile(preludePath, 'utf8')
  } catch {
    return false
  }
  const patched = patchVisionRouterPreludeContent(content)
  if (!patched.changed) return false
  await writeFile(preludePath, patched.content, 'utf8')
  return true
}

function mergeProfileManifest(input: JsonRecord, includeClientBundle: boolean): JsonRecord {
  const dependencies = isRecord(input.dependencies) ? { ...input.dependencies } : {}
  dependencies[PACKAGE_NAME] = PACKAGE_SPECIFIER

  const dsh = isRecord(input.dsh) ? input.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  if (includeClientBundle) {
    // Legacy runtimes discover the bridge through an active Loader entry.
    if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
  } else {
    // Newer runtimes expose this module in the immutable static module table.
    // Leaving a host entry with the same name would import that object and
    // Cordis would reject it because static modules are not host plugins.
    while (bundles.includes(PACKAGE_NAME)) bundles.splice(bundles.indexOf(PACKAGE_NAME), 1)
  }

  return {
    ...input,
    dependencies,
    dsh: { ...dsh, profile: { ...profile, bundles } },
  }
}

async function readJson(path: string): Promise<JsonRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    if (await readFile(path, 'utf8') === content) return false
  } catch {
    // The file will be created below.
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return true
}

export async function ensureClientStoreCompatibility(options: ClientStoreCompatibilityOptions): Promise<ClientStoreCompatibilityResult> {
  const packagePath = options.packagePath ?? join(options.profilePath, 'package.json')
  const compatibilityPath = join(options.dshHome, '.desktop-compat', 'dsh-client-store')
  const currentProfile = await readJson(packagePath)
  const includeClientBundle = !runtimeProvidesBuiltInClientStore(options.runtimeVersion)
  const nextProfile = mergeProfileManifest(currentProfile, includeClientBundle)
  const profileContent = `${JSON.stringify(nextProfile, null, 2)}\n`
  const packageContent = `${JSON.stringify(createCompatibilityPackage(includeClientBundle), null, 2)}\n`
  const changedProfile = await writeIfChanged(packagePath, profileContent)
  const changedPackage = await writeIfChanged(join(compatibilityPath, 'package.json'), packageContent)
  const changedIndex = await writeIfChanged(join(compatibilityPath, 'index.js'), compatibilityIndex)
  const changedPatch = await writeIfChanged(join(compatibilityPath, 'cordis.patch.yml'), compatibilityPatch)
  // Synchronize the browser factory into the local file dependency. The
  // package declaration above makes it an actual graph row for old plugins.
  const changedClient = await writeIfChanged(join(compatibilityPath, 'client.js'), compatibilityClient)
  return {
    changed: changedProfile || changedPackage || changedIndex || changedPatch || changedClient,
    packagePath,
    compatibilityPath,
  }
}

/**
 * Refreshes the files of a local `file:` dependency after pnpm has already
 * materialized it. pnpm can retain an older copy when only package metadata or
 * non-JavaScript assets changed; the DSH loader reads the profile copy, so the
 * bridge files must be synchronized explicitly.
 */
export async function synchronizeInstalledClientStoreCompatibility(options: Pick<ClientStoreCompatibilityOptions, 'dshHome' | 'profilePath'>): Promise<boolean> {
  const sourcePath = join(options.dshHome, '.desktop-compat', 'dsh-client-store')
  const targetPath = join(options.profilePath, 'node_modules', '@deepseek-ai', 'dsh-client-store')
  try {
    await readFile(join(targetPath, 'package.json'), 'utf8')
  } catch {
    return false
  }

  for (const file of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
    await copyFile(join(sourcePath, file), join(targetPath, file))
  }
  return true
}
