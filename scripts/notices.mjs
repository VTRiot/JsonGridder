// Generates THIRD_PARTY_NOTICES.md: every third-party component that ends up in the Windows EXE.
//
//   npm run notices            write THIRD_PARTY_NOTICES.md and print the tally
//   npm run notices -- --check regenerate in memory and fail if the file on disk differs
//
// Sources:
// - npm: the modules that Vite puts into the build output (both pages), mapped to their package
//   folders under node_modules. The license text is read from each package's own LICENSE file.
// - Rust: `cargo metadata` filtered to the Windows target, walked from this crate through normal
//   and build dependencies. The license text is read from the crate folder in the cargo registry.
// - The editor copied into vendor/, and the components that cannot be found automatically
//   (scripts/notices-manual.json).
// The script stops with an error when a license is GPL-family or unknown, or when a text is empty.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const output = path.join(root, 'THIRD_PARTY_NOTICES.md')
const manualFile = path.join(scriptDir, 'notices-manual.json')
const vendorDir = path.join(root, 'vendor', 'svelte-jsoneditor')
const WINDOWS_TARGET = 'x86_64-pc-windows-msvc'
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i
const COPYRIGHT_LINE = /^\s*(copyright\b|\(c\)\s|©)/i
const GPL_FAMILY = /\b(A|L)?GPL\b|GPL-|AGPL|LGPL/i
const checkOnly = process.argv.includes('--check')

const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
const hashOf = (text) =>
  crypto.createHash('sha256').update(normalize(text).replace(/\s+/g, ' ')).digest('hex').slice(0, 12)

function licenseFilesIn(folder) {
  if (!fs.existsSync(folder)) return []
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: normalize(fs.readFileSync(path.join(folder, name), 'utf8')) }))
    .filter(({ text }) => text !== '')
}

function copyrightLines(files) {
  const lines = new Set()
  for (const { text } of files) {
    for (const line of text.split('\n')) {
      // Template lines such as "Copyright [yyyy] [name of copyright owner]" are not notices.
      if (COPYRIGHT_LINE.test(line) && !/\[yyyy\]|\{yyyy\}|<year>/i.test(line)) lines.add(line.trim())
    }
  }
  return [...lines]
}

const personName = (person) =>
  typeof person === 'string' ? person.replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim() : person?.name

// ---------- npm ----------

/** The module ids that Vite writes into the output, for both pages. */
async function bundledModuleIds() {
  const result = await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false, emptyOutDir: false }
  })
  const outputs = Array.isArray(result) ? result : [result]
  const ids = new Set()
  for (const { output: items } of outputs) {
    for (const item of items) {
      if (item.type !== 'chunk') continue
      for (const id of item.moduleIds ?? Object.keys(item.modules ?? {})) ids.add(id)
    }
  }
  return [...ids].map((id) => id.replace(/^\0/, '').replace(/\?.*$/, '').replaceAll('\\', '/'))
}

function packageRootOf(id) {
  const marker = '/node_modules/'
  const at = id.lastIndexOf(marker)
  if (at < 0) return null
  const rest = id.slice(at + marker.length).split('/')
  const depth = rest[0].startsWith('@') ? 2 : 1
  return id.slice(0, at + marker.length) + rest.slice(0, depth).join('/')
}

async function npmComponents() {
  const ids = await bundledModuleIds()
  const roots = new Set()
  let vendorModules = 0
  for (const id of ids) {
    const packageRoot = packageRootOf(id)
    if (packageRoot) roots.add(path.normalize(packageRoot))
    else if (id.includes('/vendor/svelte-jsoneditor/')) vendorModules += 1
  }
  const components = [...roots].map((folder) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
    const files = licenseFilesIn(folder)
    const authors = [personName(pkg.author)].filter(Boolean)
    return {
      kind: 'npm',
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '',
      source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      files,
      authors
    }
  })
  return { components, moduleCount: ids.length, vendorModules }
}

// ---------- Rust ----------

function cargoMetadata() {
  const json = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', WINDOWS_TARGET],
    { cwd: path.join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  return JSON.parse(json)
}

function rustComponents() {
  const metadata = cargoMetadata()
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const rootId = metadata.resolve.root
  const reached = new Set()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const dep of nodes.get(id)?.deps ?? []) {
      // Dev dependencies are only for tests and never reach the EXE.
      const shipped = dep.dep_kinds.some(({ kind }) => kind === null || kind === 'build')
      if (shipped && !reached.has(dep.pkg)) {
        reached.add(dep.pkg)
        queue.push(dep.pkg)
      }
    }
  }
  reached.delete(rootId)
  const components = [...reached].map((id) => {
    const pkg = packages.get(id)
    return {
      kind: 'crate',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? '',
      source: `https://crates.io/crates/${pkg.name}/${pkg.version}`,
      repository: pkg.repository ?? '',
      files: licenseFilesIn(path.dirname(pkg.manifest_path)),
      authors: (pkg.authors ?? []).map(personName).filter(Boolean)
    }
  })
  const lock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8')
  const lockCount = (lock.match(/^\[\[package\]\]$/gm) ?? []).length - 1
  return { components, resolveCount: metadata.resolve.nodes.length - 1, lockCount }
}

// ---------- vendor and manual ----------

/** The editor copied into vendor/ has no package.json of its own; its origin is in the manual list. */
function vendorComponent(entry) {
  return {
    kind: 'vendor',
    ...entry,
    files: licenseFilesIn(vendorDir),
    authors: entry.authors ?? []
  }
}

/**
 * Fills in the text for a component that ships without a license file, from the list in
 * notices-manual.json: either the files of a sibling package from the same project
 * (`sameAs`), or a text kept in scripts/license-texts (`file`).
 */
function supplement(component, components, supplements, supplied) {
  if (component.files.length > 0) return
  const rule = supplements[component.name]
  if (!rule) return
  if (rule.sameAs) {
    const sibling = components.find(
      (other) => other.name === rule.sameAs && other.files.length > 0 && !other.supplemented
    )
    if (sibling) component.files = sibling.files.map(({ name, text }) => ({ name: `${name} of ${sibling.name} ${sibling.version}`, text }))
  } else if (rule.file) {
    component.files = [{ name: path.basename(rule.file), text: normalize(fs.readFileSync(path.join(root, rule.file), 'utf8')) }]
  }
  if (component.files.length > 0) {
    component.supplemented = rule.why
    supplied.push(`${component.name} ${component.version} (${component.license}): ${rule.why}`)
  }
}

function manualComponents() {
  const manual = JSON.parse(fs.readFileSync(manualFile, 'utf8'))
  return manual.components.map((entry) => {
    const files = []
    if (entry.licenseFile) {
      const file = path.join(root, entry.licenseFile)
      files.push({ name: path.basename(file), text: normalize(fs.readFileSync(file, 'utf8')) })
    }
    return { kind: 'manual', ...entry, files, authors: entry.authors ?? [] }
  })
}

// ---------- checks and output ----------

function classify(license) {
  if (!license || /^(UNLICENSED|SEE LICENSE IN)/i.test(license)) return 'unknown'
  // An OR expression is acceptable when at least one choice is not GPL-family.
  const choices = license.replace(/[()]/g, '').split(/\s+OR\s+|\s*\/\s*/)
  return choices.some((choice) => !GPL_FAMILY.test(choice)) ? 'ok' : 'gpl'
}

function render(components, extras) {
  const texts = new Map()
  const textId = (text) => {
    const key = hashOf(text)
    if (!texts.has(key)) texts.set(key, { id: `T${String(texts.size + 1).padStart(3, '0')}`, text })
    return texts.get(key).id
  }
  const lines = [
    '# Third-party notices',
    '',
    'JsonGridder is distributed under the MIT License (see LICENSE). The Windows executable also contains the third-party components listed below. Each component is distributed under its own license, reproduced in full in the "License texts" section at the end.',
    '',
    'This file is generated by `npm run notices` (scripts/notices.mjs). Do not edit it by hand.',
    '',
    `- npm packages in the build output: ${extras.npm}`,
    `- Rust crates for the Windows target: ${extras.rust}`,
    `- Other components: ${extras.other}`,
    ''
  ]
  const sections = [
    ['Editor', components.filter(({ kind }) => kind === 'vendor')],
    ['Other components', components.filter(({ kind }) => kind === 'manual')],
    ['npm packages', components.filter(({ kind }) => kind === 'npm')],
    ['Rust crates', components.filter(({ kind }) => kind === 'crate')]
  ]
  for (const [title, items] of sections) {
    lines.push(`## ${title}`, '')
    for (const item of items) {
      const copyright = copyrightLines(item.files)
      const holders = copyright.length > 0 ? copyright : item.authors.map((name) => `Copyright (c) ${name}`)
      lines.push(`### ${item.name} ${item.version}`, '')
      lines.push(`- License: ${item.license}`)
      lines.push(`- Source: ${item.source}`)
      if (item.repository && item.repository !== item.source) lines.push(`- Repository: ${item.repository}`)
      for (const holder of holders) lines.push(`- ${holder}`)
      if (item.note) lines.push(`- Note: ${item.note}`)
      if (item.supplemented) lines.push(`- Note: the package does not include a license file. ${item.supplemented}`)
      lines.push(`- License text: ${item.files.map((file) => `${textId(file.text)} (${file.name})`).join(', ')}`)
      lines.push('')
    }
  }
  lines.push('## License texts', '')
  for (const { id, text } of texts.values()) {
    lines.push(`### ${id}`, '', '```text', text.replaceAll('```', "'''"), '```', '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

const supplied = []
const manualList = JSON.parse(fs.readFileSync(manualFile, 'utf8'))
const npm = await npmComponents()
const rust = rustComponents()
const vendor = vendorComponent(manualList.editor)
const manual = manualComponents()
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
const components = [vendor, ...manual, ...npm.components.sort(byName), ...rust.components.sort(byName)]
for (const component of components) supplement(component, components, manualList.supplements ?? {}, supplied)
for (const name of Object.keys(manualList.supplements ?? {})) {
  if (!components.some((component) => component.name === name)) {
    console.log(`note: the supplement for ${name} is not used (the component is no longer shipped)`)
  }
}

const problems = []
const tally = new Map()
for (const component of components) {
  const verdict = classify(component.license)
  if (verdict !== 'ok') problems.push(`${verdict}: ${component.name} ${component.version} (${component.license || 'no license field'})`)
  if (component.files.length === 0 || component.files.some(({ text }) => !text)) {
    problems.push(`empty text: ${component.name} ${component.version} (${component.license})`)
  }
  tally.set(component.license, (tally.get(component.license) ?? 0) + 1)
}

const document = render(components, { npm: npm.components.length, rust: rust.components.length, other: manual.length + 1 })
console.log(`npm: ${npm.components.length} packages from ${npm.moduleCount} bundled modules (${npm.vendorModules} editor modules from vendor/)`)
console.log(
  `rust: ${rust.components.length} crates for ${WINDOWS_TARGET} (${rust.resolveCount} in the resolve filtered to the target, ${rust.lockCount} in Cargo.lock for all targets, this crate excluded)`
)
const missingCrates = rust.resolveCount - rust.components.length
if (missingCrates !== 0) console.log(`  ${missingCrates} crates of the filtered resolve are dev-only and not listed`)
console.log(`other: ${manual.length + 1} (editor + ${manual.length} manual)`)
console.log(`supplemented texts: ${supplied.length}`)
for (const line of supplied) console.log(`  ${line}`)
console.log('licenses:')
for (const [license, count] of [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${String(count).padStart(4)}  ${license}`)
}
console.log(`problems: ${problems.length}`)
for (const line of problems) console.log(`  ${line}`)
if (problems.length > 0) process.exit(1)

if (checkOnly) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : ''
  const same = current === document
  console.log(same ? 'notices: up to date' : 'notices: out of date, run npm run notices')
  process.exit(same ? 0 : 1)
}
fs.writeFileSync(output, document)
console.log(`notices: wrote ${path.relative(root, output)} (${Buffer.byteLength(document)} bytes)`)
