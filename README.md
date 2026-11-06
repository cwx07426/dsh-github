# GitHub 插件（`@local/dsh-github`）

> English summary: a GitHub plugin for DeepSeek Harness — create repositories, upload code as one commit per call, open issues and pull requests, and list repositories and issues, all through the GitHub REST API without `git` or `gh`. It also handles empty-repository first pushes and local TLS-interception setups (GitHub accelerators, VPNs, security products) automatically.

为 DeepSeek Harness 增加 GitHub 能力：**创建仓库、上传代码、提交 issue 与 pull request**，以及查看账号权限和仓库、issue 列表。所有操作直接调用 GitHub REST API，不依赖 `git` 或 `gh` CLI。

## 安装

本目录就是一个可安装的 DSH bundle。在 Harness 中执行：

```
plugin_manager  action: install_bundle  target: "<本目录的绝对路径>"
```

安装后 bundle 会出现在插件管理中，`github-tools` 行对所有 Agent 生效。

## 配置 Token

插件按顺序解析 Token：

1. 插件行的 `config.token`；
2. 环境变量 `GITHUB_TOKEN`；
3. 环境变量 `GH_TOKEN`。

推荐用环境变量（对 Harness 进程生效，不落盘到配置）。也可以在用户 profile 的 patch 层覆盖本行配置（`C:\Users\<用户>\.dsh\profiles\<profile>\cordis.patch.yml`）：

```yaml
- id: github-tools
  name: '@local/dsh-github'
  config:
    token: 'ghp_你的token'
```

所需权限：

- **Classic token**：勾选 `repo`（含私有仓库）；只操作公开仓库时 `public_repo` 即可。
- **Fine-grained token**：`Contents: Read and write`、`Issues: Read and write`、`Pull requests: Read and write`；创建仓库还需要 `Administration: Read and write`，并授权给目标仓库/组织。

配置后用 `github_get_user` 验证：它会返回当前账号和 Token 的 scope（fine-grained token 可能不显示 scope，以实际调用结果为准）。

## 工具

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `github_get_user` | 验证 Token，返回登录账号与 scope | 无 |
| `github_create_repository` | 创建仓库（个人账号或组织） | `name`、`owner`、`description`、`private`、`autoInit`、`homepage` |
| `github_push_files` | 上传代码，一次调用一个 commit | `owner`、`repo`、`message`、`branch`、`files`、`directory` |
| `github_create_issue` | 提交 issue | `owner`、`repo`、`title`、`body`、`labels`、`assignees` |
| `github_create_pull_request` | 提交 PR | `owner`、`repo`、`title`、`head`、`base`、`body`、`draft` |
| `github_list_repositories` | 列出仓库 | `owner`、`limit` |
| `github_list_issues` | 列出 issue（不含 PR） | `owner`、`repo`、`state`、`limit` |

`github_push_files` 的 `files` 支持内联文本或本地文件：

```json
{
  "owner": "me",
  "repo": "my-project",
  "message": "feat: 初始化项目",
  "files": [
    { "path": "README.md", "content": "# my-project" },
    { "path": "src/main.js", "source": "D:/work/my-project/src/main.js" }
  ]
}
```

也可以直接传 `directory` 上传整个本地目录（`source`、`directory` 的相对路径按当前会话的工作目录解析）。

## 行为说明

- 上传走 Git Data API：`blob → tree → commit → 更新 ref`，一次调用产生一个 commit，不会 force push；对已存在的分支是在其当前 head 之上追加提交。
- 对**全新的空仓库**，GitHub 拒绝在首个提交之前创建 blob/tree（HTTP 409），所以插件会先用 Contents API 把第一个文件提交成初始提交，再把本次上传作为第二个提交叠加；返回结果里会带 `bootstrapCommit` 说明这一点。
- 如果本机有 GitHub 加速器 / 代理 / 安全软件对 `api.github.com` 做 TLS 拦截，Node 自带的根证书会校验失败；插件会在**首次证书失败时**把操作系统根证书补进本进程信任库并重试一次（不关闭 TLS 校验）。
- 目录上传跳过 `.git` 和 `node_modules`，忽略符号链接；单文件上限 10 MB，单次总量上限 25 MB，最多 500 个文件，超限的文件会在结果中列出并说明原因。
- 仓库默认 **public**；`autoInit` 默认 `false`，仓库保持空仓库，便于第一次上传代码创建首个提交。若需要 README 初始提交则传 `autoInit: true`。
- 只有显式写入 `owner` 且该名称属于组织时才会在组织下建库；否则建在 Token 所属账号下。
- 企业版 GitHub 可把 `apiBaseUrl` 改成 `https://ghe.example.com/api/v3`。

## 安全提示

- Token 只从插件配置或环境变量读取，**不会**写入会话记录；不要把 Token 直接粘贴到聊天里（会进入会话日志）。
- 创建仓库、提交 issue/PR、推送代码都是真实、公开（取决于仓库可见性）的写操作。
- 插件注册的工具会按照 `github_*` 的名称出现在模型工具列表中，可在工具列表里确认注册状态。

## 目录结构

```
github-plugin/
├─ package.json          # bundle 清单（dsh.bundle.patch、exports、files）
├─ cordis.patch.yml      # Loader 插入行与默认 config
├─ lib/index.js          # 7 个 GitHub 工具的 Host 实现
├─ locale/en.json        # 插件管理器的标题/描述（英文）
├─ locale/zh.json        # 插件管理器的标题/描述（中文）
├─ icon.svg              # 原创图标
├─ LICENSE               # MIT
├─ .gitignore
└─ README.md
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
