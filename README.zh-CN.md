# magpie-strip-harness

[English](README.md) | 简体中文

一个 [magpie](https://usemagpie.ai) **网关中间件**：在请求路由到任何供应商之前，把 agent 请求体 `system` role 里由 harness 注入的身份提示剔除——比如 DeepSeek Harness 的开场白 **"You are an AI agent powered by DeepSeek Harness."**。只改请求，不碰回复与事件，对所有供应商生效。

> 提示：DSH 自身有 `includeHarnessIdentity: false` 的 profile 选项可以只关开场白。想在不改客户端配置的前提下统一处理（多客户端共用网关、还要顺带清掉 Web GUI 提示等其他 harness 段落）时，用这个中间件。

## 安装

```sh
git clone https://github.com/aqiu817/magpie-strip-harness.git
magpie plugin add ./magpie-strip-harness
```

也可以在应用里：插件 → 添加插件，填入克隆下来的文件夹路径。包里没有 `main`/`exports`，magpie 会把它当纯中间件加载。

## 剔除逻辑

粒度保守，尽量少动原文：

1. **段落级**：system 文本按空行分段，命中模式的整段丢弃（处理跨行的 harness 段落，如 Web GUI 提示）。
2. **行级兜底**：全文没有空行结构、或段落级会清空全文时，改为丢弃命中的**行**，无关内容总是保留。

清空后的消息/字段整个移除（删掉 `body.system`、丢掉空的 chat system 消息）。Anthropic 块上的 `cache_control` 等字段在幸存块上原样保留。

按 agent 自己的 API 格式读取请求体，四种协议都支持：`chat`（messages 里 system/developer）、`anthropic`（`system` 字符串或 blocks）、`responses`（`instructions` + input 里的 system 条目）、`gemini`（`systemInstruction`）；协议未知时逐个形状防御性尝试。

## 选项

在应用里（插件 → 已安装 → 选项）编辑，或：

```sh
magpie plugin options magpie-strip-harness '{"debug": true}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `patterns` | `["/deepseek[\\s_-]*harness/i"]` | 按段落/行匹配的模式。`"/regex/i"` 形式编译为正则，其余字符串按大小写不敏感子串匹配。设置后**替换**默认值；全部无效时回退默认，清洗不会静默失效。 |
| `stripAll` | `false` | 命中即移除整个 system 内容，而不是逐段剔除。 |
| `debug` | `false` | 每次改写请求时向 magpie 日志输出一行（应用「设置 → 插件」可见调用计数）。 |

## 验证

开着 debug，通过网关发一条带 harness 开场白的请求（或直接正常使用 DSH），上游收到的请求里就没有那句开场白了。magpie 的用量记录里能看到特征：中间件首次生效时，该会话的下一条请求前缀缓存会失效（`cache_read=0`）并随即在新前缀上重建。

## 局限

- 剔除粒度是空行段落/行。如果 harness 文字和无关内容挤在同一段无空行里，只删命中行、可能留下续行——把 pattern 收紧即可。
- 修改 system 会让该请求的供应商侧提示词缓存失效，属预期代价。
- magpie 自己的内部请求（会话标题、路由分类）不经过中间件。

## 测试

```sh
node test.mjs
```

## 许可

MIT
