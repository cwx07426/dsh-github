/**
 * GitHub tools for DeepSeek Harness.
 *
 * The plugin registers seven model-facing tools on every Agent. They call the
 * GitHub REST API directly with a personal access token and cover the common
 * repository workflow: verify the account, create a repository, upload code as
 * one commit, open a pull request, and work with issues.
 *
 * Token resolution order: the plugin row's `token`, then `GITHUB_TOKEN`, then
 * `GH_TOKEN`. No token is read from the session log.
 * @module @local/dsh-github
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import tls from 'node:tls'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Loader identity. */
export const name = 'github-tools'

/** Services this plugin needs. */
export const inject = ['tools']

/** Defaults for the plugin row's config. */
const DEFAULTS = {
  /** Personal access token; empty means read it from the environment. */
  token: '',
  /** REST API origin; override only for GitHub Enterprise Server. */
  apiBaseUrl: 'https://api.github.com',
  /** Deadline for one GitHub API request. */
  timeoutMs: 30000,
}

/** Maximum files uploaded by one github_push_files call. */
const MAX_FILES = 500
/** Maximum size of one uploaded file. */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Maximum combined size of one upload. */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
/** Directories a directory upload never descends into. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
/** Parallel blob uploads. */
const BLOB_CONCURRENCY = 8
/** Pinned REST API version. */
const GH_API_VERSION = '2022-11-28'

/** Actionable message shown whenever no token can be resolved. */
const TOKEN_HELP =
  'No GitHub token is configured. Set the github-tools row token in the profile patch, for example ' +
  "config: { token: 'ghp_...' }, or start the Harness with GITHUB_TOKEN (or GH_TOKEN) set. " +
  'A classic token needs the repo scope; a fine-grained token needs administration and issues write access.'

/**
 * Resolve the HTTP implementation for one Host.
 *
 * The Harness Host runs inside Electron, so its main process can use the
 * Chromium network stack through `net.fetch`. That stack verifies certificates
 * against the operating system trust store, which keeps working on machines
 * where a local Git proxy, VPN, or security product terminates TLS for GitHub
 * hosts. A plain Node `fetch` only knows its bundled certificate authorities,
 * so it fails there with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Fall back to the
 * global fetch outside Electron.
 * @returns a fetch-compatible function.
 */
let fetchImplPromise
function fetchImpl() {
  if (!fetchImplPromise) {
    fetchImplPromise = (async () => {
      if (process.versions && process.versions.electron) {
        try {
          const electron = await import('electron')
          const net = electron.net || (electron.default && electron.default.net)
          if (net && typeof net.fetch === 'function') {
            return (url, init) => net.fetch(url, init)
          }
        } catch {
          // Not an Electron main process after all; use the global fetch.
        }
      }
      return (url, init) => globalThis.fetch(url, init)
    })()
  }
  return fetchImplPromise
}

/**
 * Certificate-validation failures that mean the local trust store, not the
 * server, is the problem. A local Git proxy, VPN, or security product that
 * terminates TLS for GitHub hosts signs with a private CA that the operating
 * system trusts but Node's bundled root list does not.
 */
const CERTIFICATE_FAILURES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
])

/** Whether the operating system's root certificates were already added. */
let systemCAsInstalled = false

/**
 * Add the operating system root certificates to this process's default trust
 * store, once. Used only after a request failed certificate validation, so a
 * normal deployment keeps Node's default trust behavior.
 * @returns true when the store changed and the request is worth retrying.
 */
function installSystemCAs() {
  if (systemCAsInstalled) return false
  systemCAsInstalled = true
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return false
    const current = tls.getCACertificates('default')
    const system = tls.getCACertificates('system')
    if (!Array.isArray(system) || !system.length) return false
    tls.setDefaultCACertificates(Array.from(new Set([...current, ...system])))
    return true
  } catch {
    return false
  }
}

/** Build the error message for a failed network attempt. */
function networkError(error, method, apiPath, signal, settings) {
  if (error && error.name === 'AbortError' && !(signal && signal.aborted)) {
    return new Error(`GitHub ${method} ${apiPath} timed out after ${settings.timeoutMs}ms`)
  }
  const cause = error && error.cause ? error.cause.code || error.cause.message : ''
  return new Error(
    `GitHub ${method} ${apiPath} could not be reached${cause ? ` (${cause})` : ''}. ` +
      'Check the network, VPN, or local Git proxy and the apiBaseUrl setting.',
  )
}

/** Merge the row config over the defaults. */
function settingsOf(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  const apiBaseUrl = typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim() ? raw.apiBaseUrl.trim() : DEFAULTS.apiBaseUrl
  const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULTS.timeoutMs
  return { token, apiBaseUrl, timeoutMs }
}

/** Resolve the token from config, then the process environment. */
function tokenOf(settings) {
  for (const candidate of [settings.token, process.env.GITHUB_TOKEN, process.env.GH_TOKEN]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

/** Require one non-empty string argument. */
function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

/** Percent-encode one REST path segment. */
function enc(value) {
  return encodeURIComponent(value)
}

/** Compose the `/repos/{owner}/{repo}` prefix. */
function repoPathOf(owner, repo) {
  return `/repos/${enc(owner)}/${enc(repo)}`
}

/** Build the error for a rejected REST response. */
function githubError(status, method, apiPath, payload) {
  const message = payload && typeof payload.message === 'string' ? payload.message : ''
  const details = payload && Array.isArray(payload.errors)
    ? payload.errors
        .map((entry) => (typeof entry === 'string' ? entry : entry && typeof entry.message === 'string' ? entry.message : ''))
        .filter(Boolean)
        .join('; ')
    : ''
  if (status === 401) {
    return new Error(
      `GitHub rejected the token (HTTP 401): ${message || 'bad credentials'}. Check the github-tools token or GITHUB_TOKEN value.`,
    )
  }
  if (status === 403) {
    const hint = /rate limit/i.test(message)
      ? 'The token reached a GitHub rate limit; wait for the reset window or use another token.'
      : 'The token likely lacks a required scope or the account lacks access to this repository.'
    return new Error(`GitHub ${method} ${apiPath} was refused (HTTP 403): ${message || 'forbidden'}. ${hint}`)
  }
  return new Error(
    `GitHub ${method} ${apiPath} failed (HTTP ${status})${message ? `: ${message}` : ''}${details ? ` [${details}]` : ''}`,
  )
}

/**
 * Call one GitHub REST endpoint.
 * @param settings - resolved plugin settings.
 * @param method - HTTP method.
 * @param apiPath - path below the API origin, including any query string.
 * @param options - request body, caller signal, tolerated status codes, and Accept header.
 * @returns the parsed body plus status and headers; `data` is undefined for a tolerated failure status.
 */
async function githubRequest(settings, method, apiPath, options = {}) {
  const { body, signal, tolerate = [], accept = 'application/vnd.github+json' } = options
  const token = tokenOf(settings)
  if (!token) throw new Error(TOKEN_HELP)
  const url = settings.apiBaseUrl.replace(/\/+$/, '') + apiPath
  const signals = []
  if (signal) signals.push(signal)
  if (settings.timeoutMs > 0) signals.push(AbortSignal.timeout(settings.timeoutMs))
  const perform = async () => {
    const request = await fetchImpl()
    return request(url, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        'x-github-api-version': GH_API_VERSION,
        'user-agent': 'dsh-github-tools',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  }
  let response
  try {
    response = await perform()
  } catch (error) {
    const causeCode = error && error.cause ? error.cause.code : undefined
    if (CERTIFICATE_FAILURES.has(causeCode) && installSystemCAs()) {
      try {
        response = await perform()
      } catch (retryError) {
        throw networkError(retryError, method, apiPath, signal, settings)
      }
    } else {
      throw networkError(error, method, apiPath, signal, settings)
    }
  }
  const text = await response.text()
  let payload
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
  }
  if (!response.ok) {
    if (tolerate.includes(response.status)) return { status: response.status, data: undefined, headers: response.headers }
    throw githubError(response.status, method, apiPath, payload)
  }
  return { status: response.status, data: payload, headers: response.headers }
}

/** Read the commit a branch points at, or undefined when the branch does not exist yet. */
async function readBranchHead(settings, repoPath, branch, signal) {
  const result = await githubRequest(settings, 'GET', `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`, {
    signal,
    tolerate: [404, 409],
  })
  if (result.status !== 200) return undefined
  const object = result.data && result.data.object
  if (!object || typeof object.sha !== 'string') return undefined
  return { sha: object.sha }
}

/** Read the tree hash of one commit. */
async function readCommitTree(settings, repoPath, sha, signal) {
  const result = await githubRequest(settings, 'GET', `${repoPath}/git/commits/${enc(sha)}`, { signal })
  const tree = result.data && result.data.tree
  return tree && typeof tree.sha === 'string' ? tree.sha : undefined
}

/** Normalize a model-supplied path into a clean repository-relative path. */
function normalizeRepoPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Each uploaded file needs a non-empty path')
  const unified = input.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (!segments.length) throw new Error(`Invalid uploaded file path: ${input}`)
  if (segments.some((segment) => segment === '..')) throw new Error(`Uploaded file path must stay inside the repository: ${input}`)
  return segments.join('/')
}

/** Walk a local directory and collect repository-relative candidates. */
async function walkDirectory(root, prefix, collected, signal) {
  const stack = [{ absolute: root, prefix }]
  while (stack.length) {
    const current = stack.pop()
    const entries = await fsp.readdir(current.absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (signal.aborted) throw new Error('github_push_files was cancelled')
      const absolute = path.join(current.absolute, entry.name)
      const relative = current.prefix ? `${current.prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        stack.push({ absolute, prefix: relative })
      } else if (entry.isFile()) {
        collected.set(normalizeRepoPath(relative), { source: absolute })
      }
      if (collected.size > MAX_FILES) return
    }
  }
}

/** Resolve a relative local path against the calling Session's working directory. */
async function resolveLocalSource(shared, agent, source, signal) {
  if (path.isAbsolute(source)) return source
  let base = process.cwd()
  if (shared.workingDirectory && agent) {
    try {
      base = await shared.workingDirectory.ensure(agent, signal)
    } catch {
      base = process.cwd()
    }
  }
  return path.resolve(base, source)
}

/** Collect upload candidates from explicit files and/or one local directory. */
async function collectCandidates(shared, args, agent, signal) {
  const collected = new Map()
  if (Array.isArray(args.files)) {
    for (const entry of args.files) {
      if (!entry || typeof entry !== 'object') throw new Error('Each files entry must be an object with path and content or source')
      const target = normalizeRepoPath(entry.path)
      if (typeof entry.content === 'string') {
        collected.set(target, { content: entry.content })
      } else if (typeof entry.source === 'string' && entry.source.trim()) {
        collected.set(target, { source: await resolveLocalSource(shared, agent, entry.source.trim(), signal) })
      } else {
        throw new Error(`files entry "${target}" needs content (inline text) or source (local file path)`)
      }
    }
  }
  if (typeof args.directory === 'string' && args.directory.trim()) {
    const root = await resolveLocalSource(shared, agent, args.directory.trim(), signal)
    const stat = await fsp.stat(root).catch(() => undefined)
    if (!stat || !stat.isDirectory()) throw new Error(`directory is not a readable local directory: ${args.directory}`)
    const nested = new Map()
    await walkDirectory(root, '', nested, signal)
    for (const [target, descriptor] of nested) collected.set(target, descriptor)
  }
  if (!collected.size) throw new Error('Nothing to upload: provide files, directory, or both')
  return collected
}

/** Read candidate bytes and apply the size and count limits. */
async function loadUploads(collected, signal) {
  const pending = []
  const skipped = []
  let totalBytes = 0
  for (const [repoPath, descriptor] of collected) {
    if (signal.aborted) throw new Error('github_push_files was cancelled')
    if (pending.length >= MAX_FILES) {
      skipped.push({ path: repoPath, reason: `upload is limited to ${MAX_FILES} files` })
      continue
    }
    let bytes
    if (typeof descriptor.content === 'string') {
      bytes = Buffer.from(descriptor.content, 'utf8')
    } else {
      try {
        bytes = await fsp.readFile(descriptor.source)
      } catch (error) {
        skipped.push({ path: repoPath, reason: `unreadable: ${error && error.code ? error.code : 'read failed'}` })
        continue
      }
    }
    if (bytes.length > MAX_FILE_BYTES) {
      skipped.push({ path: repoPath, reason: `larger than ${MAX_FILE_BYTES} bytes` })
      continue
    }
    if (totalBytes + bytes.length > MAX_TOTAL_BYTES) {
      skipped.push({ path: repoPath, reason: 'upload size limit reached' })
      continue
    }
    totalBytes += bytes.length
    pending.push({ path: repoPath, bytes })
  }
  return { pending, skipped, totalBytes }
}

/** Run tasks with bounded concurrency while keeping result order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** Create one repository in the authenticated account or an organization. */
async function createRepository(settings, args, signal) {
  const repositoryName = requireText(args.name, 'name')
  const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined
  const body = { name: repositoryName, private: args.private === true }
  if (typeof args.description === 'string' && args.description.trim()) body.description = args.description.trim()
  if (typeof args.homepage === 'string' && args.homepage.trim()) body.homepage = args.homepage.trim()
  if (args.autoInit === true) body.auto_init = true
  let apiPath = '/user/repos'
  if (owner) {
    const identity = await githubRequest(settings, 'GET', '/user', { signal })
    const login = identity.data && typeof identity.data.login === 'string' ? identity.data.login : ''
    if (!login || owner.toLowerCase() !== login.toLowerCase()) {
      const account = await githubRequest(settings, 'GET', `/users/${enc(owner)}`, { signal })
      const type = account.data && account.data.type
      if (type !== 'Organization') {
        throw new Error(
          `Cannot create a repository in "${owner}": it is not an organization. Only the authenticated account (@${login || 'unknown'}) or an organization that account belongs to can own a new repository.`,
        )
      }
      apiPath = `/orgs/${enc(owner)}/repos`
    }
  }
  const created = await githubRequest(settings, 'POST', apiPath, { signal, body })
  const data = created.data || {}
  return {
    repository: typeof data.full_name === 'string' ? data.full_name : `${owner || 'unknown'}/${repositoryName}`,
    url: typeof data.html_url === 'string' ? data.html_url : '',
    defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : 'main',
    private: data.private === true,
    autoInit: args.autoInit === true,
  }
}

/** Upload files and directories as exactly one commit on one branch. */
async function pushFiles(settings, shared, args, agent, signal) {
  const owner = requireText(args.owner, 'owner')
  const repo = requireText(args.repo, 'repo')
  const message = requireText(args.message, 'message')
  const repoPath = repoPathOf(owner, repo)
  const repository = await githubRequest(settings, 'GET', repoPath, { signal })
  const info = repository.data || {}
  const defaultBranch = typeof info.default_branch === 'string' && info.default_branch ? info.default_branch : 'main'
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : defaultBranch

  const head = await readBranchHead(settings, repoPath, branch, signal)
  let baseTree
  let parent
  if (head) {
    baseTree = await readCommitTree(settings, repoPath, head.sha, signal)
    parent = head.sha
  } else if (branch !== defaultBranch) {
    const fallback = await readBranchHead(settings, repoPath, defaultBranch, signal)
    if (fallback) {
      baseTree = await readCommitTree(settings, repoPath, fallback.sha, signal)
      parent = fallback.sha
    }
  }
  let branchExists = Boolean(head)
  let bootstrapCommit

  const collected = await collectCandidates(shared, args, agent, signal)
  const { pending, skipped, totalBytes } = await loadUploads(collected, signal)
  if (!pending.length) {
    throw new Error(
      `No file could be uploaded${skipped.length ? `: ${skipped.map((entry) => `${entry.path} (${entry.reason})`).join(', ')}` : ''}`,
    )
  }

  if (!head && !parent) {
    // A brand-new repository has no commit, and GitHub refuses to create blobs
    // or trees there (HTTP 409 "Git Repository is empty"). The Contents API is
    // the one write path that works before the first commit, so seed the default
    // branch with the first uploaded file and base this upload on that commit.
    const seed = pending[0]
    const seedPath = seed.path
      .split('/')
      .map((segment) => enc(segment))
      .join('/')
    const seeded = await githubRequest(settings, 'PUT', `${repoPath}/contents/${seedPath}`, {
      signal,
      body: { message, content: seed.bytes.toString('base64'), branch: defaultBranch },
    })
    bootstrapCommit = seeded.data && seeded.data.commit && seeded.data.commit.sha ? seeded.data.commit.sha : undefined
    const seededHead = await readBranchHead(settings, repoPath, defaultBranch, signal)
    if (!seededHead) throw new Error('GitHub did not create the initial commit for the empty repository')
    baseTree = await readCommitTree(settings, repoPath, seededHead.sha, signal)
    parent = seededHead.sha
    bootstrapCommit = bootstrapCommit || seededHead.sha
    if (branch === defaultBranch) branchExists = true
  }

  const blobs = await mapLimit(pending, BLOB_CONCURRENCY, async (file) => {
    const created = await githubRequest(settings, 'POST', `${repoPath}/git/blobs`, {
      signal,
      body: { content: file.bytes.toString('base64'), encoding: 'base64' },
    })
    const sha = created.data && created.data.sha
    if (typeof sha !== 'string') throw new Error(`GitHub did not return a blob for ${file.path}`)
    return { path: file.path, sha }
  })

  const treeBody = { tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })) }
  if (baseTree) treeBody.base_tree = baseTree
  const tree = await githubRequest(settings, 'POST', `${repoPath}/git/trees`, { signal, body: treeBody })
  const treeSha = tree.data && tree.data.sha
  if (typeof treeSha !== 'string') throw new Error('GitHub did not return a tree for the upload')

  const commitBody = { message, tree: treeSha, parents: parent ? [parent] : [] }
  const commit = await githubRequest(settings, 'POST', `${repoPath}/git/commits`, { signal, body: commitBody })
  const commitSha = commit.data && commit.data.sha
  if (typeof commitSha !== 'string') throw new Error('GitHub did not return a commit for the upload')

  if (branchExists) {
    await githubRequest(settings, 'PATCH', `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, {
      signal,
      body: { sha: commitSha, force: false },
    })
  } else {
    await githubRequest(settings, 'POST', `${repoPath}/git/refs`, {
      signal,
      body: { ref: `refs/heads/${branch}`, sha: commitSha },
    })
  }

  const htmlUrl = typeof info.html_url === 'string' ? info.html_url : `https://github.com/${owner}/${repo}`
  const files = pending.map((file) => file.path)
  return {
    repository: typeof info.full_name === 'string' ? info.full_name : `${owner}/${repo}`,
    branch,
    branchCreated: !head,
    bootstrapCommit: bootstrapCommit || null,
    commit: commitSha,
    commitUrl: `${htmlUrl}/commit/${commitSha}`,
    fileCount: files.length,
    totalBytes,
    files: files.slice(0, 50),
    truncatedFiles: files.length > 50,
    skipped,
  }
}

/** Create one issue. */
async function createIssue(settings, args, signal) {
  const owner = requireText(args.owner, 'owner')
  const repo = requireText(args.repo, 'repo')
  const title = requireText(args.title, 'title')
  const body = { title }
  if (typeof args.body === 'string' && args.body.trim()) body.body = args.body
  if (Array.isArray(args.labels) && args.labels.length) body.labels = args.labels.filter((label) => typeof label === 'string' && label.trim())
  if (Array.isArray(args.assignees) && args.assignees.length) {
    body.assignees = args.assignees.filter((assignee) => typeof assignee === 'string' && assignee.trim())
  }
  const created = await githubRequest(settings, 'POST', `${repoPathOf(owner, repo)}/issues`, { signal, body })
  const data = created.data || {}
  return {
    repository: `${owner}/${repo}`,
    number: typeof data.number === 'number' ? data.number : null,
    title: typeof data.title === 'string' ? data.title : title,
    state: typeof data.state === 'string' ? data.state : 'open',
    url: typeof data.html_url === 'string' ? data.html_url : '',
  }
}

/** Open one pull request. */
async function createPullRequest(settings, args, signal) {
  const owner = requireText(args.owner, 'owner')
  const repo = requireText(args.repo, 'repo')
  const title = requireText(args.title, 'title')
  const head = requireText(args.head, 'head')
  const base = requireText(args.base, 'base')
  const body = { title, head, base }
  if (typeof args.body === 'string' && args.body.trim()) body.body = args.body
  if (args.draft === true) body.draft = true
  const created = await githubRequest(settings, 'POST', `${repoPathOf(owner, repo)}/pulls`, { signal, body })
  const data = created.data || {}
  return {
    repository: `${owner}/${repo}`,
    number: typeof data.number === 'number' ? data.number : null,
    title: typeof data.title === 'string' ? data.title : title,
    state: typeof data.state === 'string' ? data.state : 'open',
    head,
    base,
    draft: data.draft === true,
    url: typeof data.html_url === 'string' ? data.html_url : '',
  }
}

/** List repositories reachable to the account, or the repositories of one owner. */
async function listRepositories(settings, args, signal) {
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
  const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined
  const apiPath = owner
    ? `/users/${enc(owner)}/repos?per_page=${limit}&sort=updated`
    : `/user/repos?per_page=${limit}&sort=updated&affiliation=owner,collaborator,organization_member`
  const response = await githubRequest(settings, 'GET', apiPath, { signal })
  const items = Array.isArray(response.data) ? response.data : []
  return {
    owner: owner || null,
    count: items.length,
    repositories: items.slice(0, limit).map((item) => ({
      name: typeof item.full_name === 'string' ? item.full_name : '',
      private: item.private === true,
      description: typeof item.description === 'string' ? item.description : '',
      defaultBranch: typeof item.default_branch === 'string' ? item.default_branch : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
      url: typeof item.html_url === 'string' ? item.html_url : '',
    })),
    truncated: items.length >= limit,
  }
}

/** List issues; pull requests are omitted. */
async function listIssues(settings, args, signal) {
  const owner = requireText(args.owner, 'owner')
  const repo = requireText(args.repo, 'repo')
  const state = ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open'
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20
  const response = await githubRequest(
    settings,
    'GET',
    `${repoPathOf(owner, repo)}/issues?state=${state}&per_page=${limit}`,
    { signal },
  )
  const all = Array.isArray(response.data) ? response.data : []
  const issues = all.filter((item) => !item.pull_request)
  return {
    repository: `${owner}/${repo}`,
    state,
    count: issues.length,
    issues: issues.slice(0, limit).map((item) => ({
      number: typeof item.number === 'number' ? item.number : null,
      title: typeof item.title === 'string' ? item.title : '',
      state: typeof item.state === 'string' ? item.state : '',
      labels: Array.isArray(item.labels)
        ? item.labels.map((label) => (typeof label === 'string' ? label : label && typeof label.name === 'string' ? label.name : '')).filter(Boolean)
        : [],
      author: item.user && typeof item.user.login === 'string' ? item.user.login : null,
      url: typeof item.html_url === 'string' ? item.html_url : '',
    })),
    truncated: issues.length >= limit,
  }
}

/** Compact text for one repository list. */
function repositoryLines(repositories) {
  return repositories
    .map((item) => {
      const visibility = item.private ? 'private' : 'public'
      const description = item.description ? ` — ${item.description.slice(0, 90)}` : ''
      const updated = item.updatedAt ? ` [updated ${item.updatedAt.slice(0, 10)}]` : ''
      return `- ${item.name} (${visibility})${description}${updated}`
    })
    .join('\n')
}

/** Terminal tool renderers shared by the plugin. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * Register the GitHub tools.
 * @param ctx - the plugin's Cordis context.
 * @param config - the row's config, already defaulted by the patch.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config)
  const shared = { workingDirectory: ctx.get('workingDirectory') }

  ctx.tools.register(
    defineTool({
      name: 'github_get_user',
      description:
        'Verify the configured GitHub token and show the account it authenticates as, with the token scopes GitHub reports. Call it before the first write, or after an authentication error from another GitHub tool, to confirm which account and permissions are in effect.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const scopes = Array.isArray(value.scopes) ? value.scopes : []
          const name = value.name ? ` (${value.name})` : ''
          const scopeText = scopes.length
            ? `Token scopes: ${scopes.join(', ')}.`
            : 'No OAuth scopes are reported; fine-grained tokens usually hide them, so rely on the call results instead.'
          return textBlock(`Authenticated as @${value.login}${name}. ${scopeText}`)
        },
      },
      async execute(args, exec) {
        const response = await githubRequest(settings, 'GET', '/user', { signal: exec.signal })
        const data = response.data || {}
        const scopesHeader = response.headers.get('x-oauth-scopes') || ''
        return {
          login: typeof data.login === 'string' ? data.login : '',
          name: typeof data.name === 'string' ? data.name : '',
          id: typeof data.id === 'number' ? data.id : null,
          type: typeof data.type === 'string' ? data.type : '',
          scopes: scopesHeader.split(',').map((scope) => scope.trim()).filter(Boolean),
          url: typeof data.html_url === 'string' ? data.html_url : '',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_repository',
      description:
        'Create a new GitHub repository in the authenticated account or in an organization that account belongs to. It is public unless private is true, and empty unless autoInit is true, so a following github_push_files call can create the first commit. Creating a repository is a public, persistent action.',
      parameters: {
        name: { type: 'string', required: true, description: 'Repository name, for example "my-project".' },
        owner: {
          type: 'string',
          description: 'Organization that receives the repository, or the authenticated login. Omit to create it in the authenticated account.',
        },
        description: { type: 'string', description: 'Short repository description shown on GitHub.' },
        private: { type: 'boolean', description: 'Create a private repository. Defaults to false (public).' },
        autoInit: {
          type: 'boolean',
          description: 'Create an initial README commit. Defaults to false, leaving the repository empty for the first code upload.',
        },
        homepage: { type: 'string', description: 'Homepage URL shown in the repository sidebar.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const visibility = value.private ? 'private' : 'public'
          const next = value.autoInit
            ? `Push code to it with github_push_files on branch ${value.defaultBranch}.`
            : `It is empty; github_push_files creates its first commit.`
          return textBlock(`Created ${visibility} repository ${value.repository} at ${value.url}. Default branch: ${value.defaultBranch}. ${next}`)
        },
      },
      async execute(args, exec) {
        return createRepository(settings, args, exec.signal)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_push_files',
      description:
        'Upload code to a GitHub repository as one commit on a branch, creating the branch when it does not exist. Provide inline file contents with files, a local directory to mirror with directory, or both; .git and node_modules directories are skipped, symbolic links are ignored, and files beyond the size limit are reported in the result. A push onto an existing branch adds a commit on top of its current head and never force-pushes. An empty repository first receives a small initialization commit for one file, because GitHub refuses git objects before the first commit; the requested commit follows immediately. Use github_create_repository first when the repository does not exist.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner: a user login or an organization.' },
        repo: { type: 'string', required: true, description: 'Repository name without the owner prefix.' },
        message: { type: 'string', required: true, description: 'Commit message for the single commit this call creates.' },
        branch: {
          type: 'string',
          description: "Branch that receives the commit. Defaults to the repository's default branch, or main for an empty repository.",
        },
        files: {
          type: 'array',
          description: 'Files to write; each entry provides inline content or a local source path.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: 'Repository-relative path, for example "src/index.js".' },
              content: { type: 'string', description: 'Inline UTF-8 text of the file.' },
              source: {
                type: 'string',
                description: 'Local file to upload; absolute, or relative to the Session working directory.',
              },
            },
          },
        },
        directory: {
          type: 'string',
          description:
            'Local directory whose files are uploaded at their relative paths; absolute, or relative to the Session working directory. Skips .git and node_modules.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const action = value.branchCreated ? 'Created branch' : 'Pushed to branch'
          const shown = Array.isArray(value.files) ? value.files.join(', ') : ''
          const more = value.truncatedFiles ? ' and more' : ''
          const bootstrap = value.bootstrapCommit
            ? ` Initialized the empty repository first with commit ${String(value.bootstrapCommit).slice(0, 7)}.`
            : ''
          const skipped = Array.isArray(value.skipped) && value.skipped.length
            ? ` Skipped ${value.skipped.length} file(s): ${value.skipped
                .slice(0, 8)
                .map((entry) => `${entry.path} (${entry.reason})`)
                .join(', ')}${value.skipped.length > 8 ? ', ...' : ''}.`
            : ''
          return textBlock(
            `${action} ${value.branch} in ${value.repository} with commit ${String(value.commit).slice(0, 7)}: ${value.commitUrl}.` +
              bootstrap +
              ` Uploaded ${value.fileCount} file(s), ${value.totalBytes} bytes: ${shown}${more}.${skipped}`,
          )
        },
      },
      async execute(args, exec) {
        return pushFiles(settings, shared, args, exec.agent, exec.signal)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_issue',
      description:
        'Open an issue in a GitHub repository with a required title and optional body, labels, and assignees. Returns the issue number and web URL. Opening an issue is visible to everyone with repository access.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner: a user login or an organization.' },
        repo: { type: 'string', required: true, description: 'Repository name without the owner prefix.' },
        title: { type: 'string', required: true, description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body in GitHub-flavored Markdown.' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Label names to attach. Labels must already exist in the repository: an unknown label name makes GitHub reject the request.',
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub logins to assign; they must have access to the repository.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(`Created issue #${value.number} "${value.title}" in ${value.repository} (${value.state}): ${value.url}`),
      },
      async execute(args, exec) {
        return createIssue(settings, args, exec.signal)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_create_pull_request',
      description:
        'Open a pull request from head into base in a GitHub repository. Use it after github_push_files created the branch: head is the branch with the new commits and base is the branch to merge into. draft opens it as a draft that cannot merge until marked ready.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner: a user login or an organization.' },
        repo: { type: 'string', required: true, description: 'Repository name without the owner prefix.' },
        title: { type: 'string', required: true, description: 'Pull request title.' },
        head: { type: 'string', required: true, description: 'Source branch with the changes, for example the branch github_push_files created.' },
        base: { type: 'string', required: true, description: 'Target branch to merge into, usually the default branch.' },
        body: { type: 'string', description: 'Pull request description in GitHub-flavored Markdown.' },
        draft: { type: 'boolean', description: 'Open as a draft pull request. Defaults to false.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const draft = value.draft ? 'draft ' : ''
          return textBlock(
            `Created ${draft}pull request #${value.number} "${value.title}" in ${value.repository} (${value.head} → ${value.base}): ${value.url}`,
          )
        },
      },
      async execute(args, exec) {
        return createPullRequest(settings, args, exec.signal)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_repositories',
      description:
        'List GitHub repositories, most recently updated first: the repositories the authenticated account can access when owner is omitted, or the public repositories of one user or organization when owner is set. Returns names, visibility, description, default branch, and last update time.',
      parameters: {
        owner: {
          type: 'string',
          description: 'User login or organization whose repositories to list. Omit to list repositories the authenticated account owns or can collaborate on.',
        },
        limit: { type: 'integer', description: 'Maximum repositories to return, from 1 to 100. Defaults to 20.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          if (!value.count) {
            return textBlock(`No repositories found${value.owner ? ` for ${value.owner}` : ''}. Check the token scopes and the owner name.`)
          }
          const scope = value.owner ? `for ${value.owner}` : 'the authenticated account'
          const more = value.truncated ? ' Listing limit reached; raise limit for more.' : ''
          return textBlock(`${value.count} repository(ies) ${scope}:\n${repositoryLines(value.repositories)}${more}`)
        },
      },
      async execute(args, exec) {
        return listRepositories(settings, args, exec.signal)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'github_list_issues',
      description:
        'List issues in a GitHub repository, newest first and filtered by state. Pull requests are omitted, so the result contains only issues. Use it to find an existing issue before creating a duplicate, or to report open work.',
      parameters: {
        owner: { type: 'string', required: true, description: 'Repository owner: a user login or an organization.' },
        repo: { type: 'string', required: true, description: 'Repository name without the owner prefix.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter. Defaults to open.' },
        limit: { type: 'integer', description: 'Maximum issues to return, from 1 to 100. Defaults to 20.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          if (!value.count) return textBlock(`No ${value.state} issues in ${value.repository}.`)
          const lines = value.issues
            .map((issue) => {
              const labels = issue.labels.length ? ` [${issue.labels.join(', ')}]` : ''
              const author = issue.author ? ` — @${issue.author}` : ''
              return `- #${issue.number} (${issue.state}) ${issue.title}${labels}${author}`
            })
            .join('\n')
          const more = value.truncated ? ' Listing limit reached; raise limit for more.' : ''
          return textBlock(`${value.count} ${value.state} issue(s) in ${value.repository}:\n${lines}${more}`)
        },
      },
      async execute(args, exec) {
        return listIssues(settings, args, exec.signal)
      },
    }),
  )
}
