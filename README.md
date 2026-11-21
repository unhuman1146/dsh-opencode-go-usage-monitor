# dsh-opencode-go-usage-monitor

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) 插件：把 **OpenCode Go 套餐余量**做成一个可以单独打开的全局面板，并把三档摘要放进侧栏气泡。

An independent usage panel for the OpenCode Go plan in DeepSeek Harness: 5h / weekly / monthly remaining percentages, reset countdowns, and the same summary in the sidebar entry. Read-only; the API key never reaches the browser.

```
dsh plugin --profile web add github:unhuman1146/dsh-opencode-go-usage-monitor
```

> 需要 `dsh >= 0.2.0-rc.2`（Web / Desktop profile 均可），并且已经配置好 `opencode-go` 这个 provider 的 key。

## 显示什么

三张卡片，对应上游 `GET https://opencode.ai/zen/go/v1/usage` 的三个窗口：

| 窗口 | 说明 |
|---|---|
| `5h` rolling | 5 小时滚动窗口 |
| `本周` weekly | 每周重置 |
| `本月` monthly | 每月重置 |

每张卡片：**剩余百分比**（大字）+ 已用百分比 + 用量进度条 + 重置时间 + 重置倒计时。
上游 `percent` 的含义是「已用」，所以剩余 = 100 − used；剩余 ≥50% 绿色、≥20% 黄色、其余红色，窗口 `status` 不是 `ok` 时为黄色。

面板打开期间每 30 秒自动刷新，页面隐藏时暂停；右上角「刷新」会绕过宿主的 8 秒缓存直接读上游。

## 侧栏气泡

侧栏的图标本身就是显示位：**悬停气泡**（侧栏收起态）和**行文字**（侧栏展开态）显示当前三档剩余，例如

```
5h 96% · 本周 99% · 本月 100%
```

- 数据还没读到（插件刚装载、或第一次读取失败）时，气泡回退成面板名「套餐余量」。
- 气泡不依赖面板打开：插件在后台每 60 秒读一次（页面隐藏时暂停），不用先点开面板。
- 百分比变化时侧栏条目会重新登记一次（id、排序、选中态不变），因为 Harness 侧栏只在 slot 注册表或语言变化时重新读取 label。
- 气泡与面板卡片共用同一份最新快照，不会出现两处不一致。

## key 怎么用（安全边界）

**浏览器半永远不接触 key。** 页面只请求本包自己的回环路由：

```
GET /plugins/dsh-opencode-go-usage-monitor/usage[?fresh=1]
```

宿主读取模型设置中 `opencode-go` 的 `apiKeyEnv`。默认引用名为 `OPENCODE_GO_API_KEY`。若模型设置位于独立的 Agent 配置，且宿主无法读取它，可在本插件的 Host 行配置 `config.apiKeyEnv`，填入同一凭据引用名。宿主先查该名称的进程环境变量，再查 Harness 凭据服务。

路由要求本机连接和有效的 Harness 会话。宿主只向官方 HTTPS 用量接口发送凭据，拒绝重定向。页面收到用量摘要或固定错误提示。无效百分比与未知重置时间显示为「—」。插件只读查询，无遥测，用量快照仅保留在内存中。

## 安装 / 卸载

- 安装：`dsh plugin --profile web add github:unhuman1146/dsh-opencode-go-usage-monitor`，或在本机通过 `plugin_manager` → `install_bundle` 指向本地包目录。
- 停用/启用：Plugins 页面里开关 `dsh-opencode-go-usage-monitor`。
- 卸载：Plugins 页面里移除该 bundle。
- 改过 `client.js` 后需要让宿主重新发布该包的浏览器半：停用再启用一次 bundle（有 HMR 构建环境时会自动热更）。

## 开发

运行 `npm test` 执行离线回归测试。若已安装 Harness，可运行 `node scripts/check-harness.mjs "<Harness 的 node_modules 路径>"` 测试真实会话和 HTTP 路由。该测试使用独立的内存凭据和模拟用量数据。

```
package.json          dsh.bundle / dsh.client / dsh.catalog 清单
cordis.patch.yml      插入一条 Host 行
index.js              Host 半：解析 key、请求上游、注册回环路由、8s 缓存
client.js             浏览器半：全局面板 + 侧栏条目（纯 JS，无需构建）
icon.svg              插件图标
```

浏览器半用 `window.__ModuleLoader__.load({ id, factory })` 注册，纯 JavaScript、无 JSX、无构建步骤；样式只用 `--dsw-alias-*` 主题 token，文案走 `ctx.locale`。

## 已知限制

- 上游只给百分比，没有金额、没有套餐名；`/zen/go/v1/balance`、`/v1/plan` 之类的路径都是 404。
- 没有历史曲线（只保留最近一次成功读取）。

## 排障：改了插件 id 或路由后必须**重启宿主**

DSH Desktop 里，宿主（dsh 核心）是 Electron 拉起的一个独立子进程，ESM 模块在进程内缓存：

- **刷新页面**只重载浏览器半；
- 停用/启用 bundle 会重建 Loader 行，但同一路径的 Host 模块仍来自缓存。

所以改动 `index.js`、包名或回环路由之后，要**完全退出 DSH Desktop 再打开**（不是 Ctrl+R），否则页面会请求一个宿主里尚未注册的新路由，表现为 `HTTP 404`。只改 `client.js` 时，刷新页面即可。

## License

MIT
