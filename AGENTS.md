# AGENTS.md

## 项目定位

`d-connect` 是一个本地守护进程，用于把本机 Agent CLI（`claudecode`、`codex`、`qoder`、`opencode`、`iflow`）桥接到 IM 平台（当前支持 `DingTalk`、`Feishu`），并通过本地 IPC 和 cron 能力管理会话与定时任务。

## 技术栈与运行约束

- 语言：TypeScript
- 运行时：Node.js `>=22`
- 模块系统：ESM（`tsconfig.json` 使用 `NodeNext`）
- 测试：Vitest
- 包管理：仓库当前使用 `npm`（存在 `package-lock.json`）

重要约束：

- 源码只改 `src/**` 和 `tests/**`，不要手改 `dist/**`。
- 本项目导入路径遵循 ESM 约定，TypeScript 源文件内部也使用 `./foo.js` 这样的后缀。
- 配置文件格式是严格 `JSON`，不是 JSONC。

## 常用命令

```bash
npm install
npm run build
npm test
npm run dev -- start -c ./config.json
node dist/index.js start -c ./config.json
```

常见本地联调：

```bash
npm run dev -- send -p <project> -s local:debug "hello"
npm run dev -- cron add -p <project> -s local:debug -e "*/30 * * * * *" "status"
npm run dev -- cron list -p <project>
```

## 目录结构

- `src/index.ts`：CLI 入口，定义 `start`、`send`、`cron` 命令。
- `src/app.ts`：应用启动编排，负责加载配置、初始化日志、runtime、IPC、cron。
- `src/config/**`：配置路径解析、模板生成、Zod schema 校验。
- `src/runtime/**`：核心运行时，负责项目实例、会话缓存、消息收发、事件格式化。
- `src/adapters/agent/**`：各类 Agent CLI 适配器与输出解析。
- `src/adapters/platform/**`：IM 平台适配器，目前为 DingTalk / Feishu。
- `src/ipc/**`：本地 Unix Socket IPC server/client。
- `src/scheduler/cron.ts`：定时任务调度与持久化编排。
- `src/infra/store-json/**`：JSON 文件原子写入等基础设施。
- `tests/**`：Vitest 测试，整体以模块级单测为主。
- `dist/**`：构建产物，不作为人工修改入口。

## 代码约定

- 保持现有风格：双引号、分号、显式类型、`type` import 与值 import 分离。
- 优先做小而集中的修改，不要顺手重构无关模块。
- 新逻辑若会影响 CLI 输出、事件拼装、配置解析或平台消息格式，必须补测试。
- 错误处理保持当前模式：抛出清晰错误，由 CLI 入口或上层统一打印。
- 日志统一走 `Logger`，不要直接在业务代码里散落 `console.log`。

## 修改建议

### 新增 Agent CLI 支持

通常需要同时修改：

1. `src/config/schema.ts`
2. `src/adapters/agent/index.ts`
3. `src/adapters/agent/<name>.ts`
4. `src/adapters/agent/parsers.ts`（如果输出格式有差异）
5. 相关测试

优先复用 `src/adapters/agent/base-cli.ts` 的 one-shot CLI 执行模型，除非新的 Agent 明确需要不同生命周期。

### 新增 IM 平台支持

通常需要同时修改：

1. `src/config/schema.ts`
2. `src/adapters/platform/index.ts`
3. `src/adapters/platform/<name>.ts`
4. `src/runtime/engine.ts`（仅在平台语义确实不同的时候）
5. 相关测试

### 修改配置结构

- 先改 `src/config/schema.ts`
- 再改 `src/config/loader.ts` / `src/config/validator.ts` / 配置模板
- 最后补充配置加载测试

## 测试期望

提交前至少运行与改动相关的测试；如果改动了公共运行路径，优先跑全量：

```bash
npm test
npm run build
```

涉及以下改动时，测试不要省：

- `src/runtime/**`
- `src/config/**`
- `src/adapters/agent/parsers.ts`
- `src/adapters/platform/**`
- `src/ipc/**`
- `src/scheduler/**`

## 调试提示

- 若配置文件不存在，`start` 会自动生成模板并退出，这是预期行为。
- 本地调试优先使用 `local:<name>` 这样的 `sessionKey`，先验证 runtime/IPC/cron，再接入真实 IM。
- 守护进程依赖 `dataDir/ipc.sock`；排查 IPC 问题时先确认 `start` 是否已成功启动。
- 若看到 `session is busy`，说明同一会话仍在处理上一条请求，不要把它误判为进程卡死。

## 对后续 Agent 的要求

- 先阅读相关模块再改，不要凭文件名猜行为。
- 不要编辑 `dist/**` 来“修复”运行结果；应修改 `src/**` 后重新构建。
- 不要引入新的框架级依赖，除非确有必要且与当前架构一致。
- 若用户要求只是补文档或配置说明，避免顺带修改业务逻辑。
- 若改动影响用户可见命令、配置字段或平台行为，同时更新 `README.md`。
