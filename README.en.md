# GitHub plugin (`@local/dsh-github`)

English | [中文](README.md)

Adds GitHub capabilities to DeepSeek Harness: **create repositories, upload code, open issues and pull requests**, and inspect the account, repositories, and issues. Every operation calls the GitHub REST API directly — no `git` or `gh` CLI required.

## Install

This directory is an installable DSH bundle. In DeepSeek Harness run:

```
plugin_manager  action: install_bundle  target: "<absolute path to this directory>"
```

After installation the bundle appears in plugin management, and its `github-tools` row applies to every Agent.

## Configure the token

The plugin resolves the token in this order:

1. the row's `config.token`;
2. the `GITHUB_TOKEN` environment variable;
3. the `GH_TOKEN` environment variable.

Using an environment variable is recommended (it applies to the Harness process and is not stored in configuration). You can also override the row in the profile patch layer (`<profile dir>/cordis.patch.yml`):

```yaml
- id: github-tools
  name: '@local/dsh-github'
  config:
    token: 'ghp_your_token'
```

Required permissions:

- **Classic token**: `repo` (includes private repositories); `public_repo` is enough for public repositories only.
- **Fine-grained token**: `Contents: Read and write`, `Issues: Read and write`, `Pull requests: Read and write`; creating repositories also needs `Administration: Read and write`, plus repository access for the target repository or organization.

Verify the setup with `github_get_user`: it returns the signed-in account and the token scopes (fine-grained tokens usually report none, so rely on the call results).

## Tools

| Tool | Purpose | Main parameters |
| --- | --- | --- |
| `github_get_user` | Verify the token and return the signed-in account and scopes | none |
| `github_create_repository` | Create a repository in your account or an organization | `name`, `owner`, `description`, `private`, `autoInit`, `homepage` |
| `github_push_files` | Upload code; one commit per call | `owner`, `repo`, `message`, `branch`, `files`, `directory` |
| `github_create_issue` | Open an issue | `owner`, `repo`, `title`, `body`, `labels`, `assignees` |
| `github_create_pull_request` | Open a pull request | `owner`, `repo`, `title`, `head`, `base`, `body`, `draft` |
| `github_list_repositories` | List repositories | `owner`, `limit` |
| `github_list_issues` | List issues (pull requests excluded) | `owner`, `repo`, `state`, `limit` |

`github_push_files` accepts inline text or local files:

```json
{
  "owner": "me",
  "repo": "my-project",
  "message": "feat: initial project layout",
  "files": [
    { "path": "README.md", "content": "# my-project" },
    { "path": "src/main.js", "source": "D:/work/my-project/src/main.js" }
  ]
}
```

You can also pass `directory` to upload a whole local directory (`source` and `directory` relative paths resolve against the current session working directory).

## Behavior

- Uploads use the Git Data API (`blob → tree → commit → ref update`), so one call produces one commit and never force-pushes; pushing onto an existing branch adds a commit on top of its current head.
- For a **brand-new empty repository**, GitHub refuses to create blobs or trees before the first commit (HTTP 409), so the plugin commits the first file through the Contents API and then layers the requested commit on top; the result reports this as `bootstrapCommit`.
- If a local GitHub accelerator, proxy, or security product intercepts TLS for `api.github.com`, Node's bundled certificate authorities fail validation; the plugin then adds the **operating system root certificates** to the process trust store once and retries (TLS verification is never disabled).
- Directory uploads skip `.git` and `node_modules` and ignore symbolic links; limits are 10 MB per file, 25 MB per call, and 500 files. Files beyond a limit are listed with a reason.
- Repositories are **public** by default; `autoInit` defaults to `false`, leaving the repository empty so the first code upload can create the first commit. Pass `autoInit: true` when you want an initial README commit.
- A repository is created in an organization only when `owner` is passed and that name is an organization; otherwise it is created in the authenticated account.
- GitHub Enterprise Server is supported by changing `apiBaseUrl` to `https://ghe.example.com/api/v3`.

## Security notes

- The token is read only from plugin configuration or the environment and is **never** written into the session log; do not paste a token into chat (it becomes part of the session log).
- Creating repositories, opening issues or pull requests, and pushing code are real write operations, public depending on repository visibility.
- The plugin registers its tools under `github_*` names; confirm registration in the tool list.

## Layout

```
github-plugin/
├─ package.json          # bundle manifest (dsh.bundle.patch, exports, files)
├─ cordis.patch.yml      # Loader insert row and default config
├─ lib/index.js          # Host implementation of the 7 GitHub tools
├─ locale/en.json        # Plugin manager title/description (English)
├─ locale/zh.json        # Plugin manager title/description (Chinese)
├─ icon.svg              # Original icon
├─ .github/workflows/ci.yml  # Validation workflow
├─ LICENSE               # MIT
├─ .gitignore
├─ README.en.md
└─ README.md
```

## License

MIT, see [LICENSE](LICENSE).
