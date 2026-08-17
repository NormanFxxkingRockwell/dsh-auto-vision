# dsh-auto-vision

**给纯文本主模型装上眼睛——自动发现你已配置的多模态模型，`dsh plugin add` 即装即用。**

![license](https://img.shields.io/badge/license-MIT-green)
![dsh](https://img.shields.io/badge/dsh-plugin-4B32C3)
[![repo](https://img.shields.io/badge/repo-github-181717?logo=github)](https://github.com/NormanFxxkingRockwell/dsh-auto-vision)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives a
text-only conversation model (e.g. `deepseek-v4-flash`) a `vision` tool: the plugin finds an
image-capable model among your already-configured providers and delegates image reading to it,
returning the description as plain text. The image block never enters the text-only model's
context — zero session pollution.

## 为什么需要它

dsh 内置的 `read_image` 会把图片块注入当前模型上下文，因此强制要求当前模型声明了 image
模态——纯文本模型（deepseek v4 flash）调用即被拒绝。dsh-auto-vision 换成一条**插件内部的
视觉通道**：

```
主模型(纯文本) --vision 工具--> [插件内部 ctx.llm.stream] --> 多模态模型(qwen3.7-plus 等)
                          <-- 纯文本识别结果 <---------------
```

- 图片块只存在于插件内部的视觉请求里，**永不进入主会话上下文**；
- 识别走宿主自己的 LLM 运行时（`ctx.llm`）：用你已配置的 provider/key/重试策略，无需任何新 API key。

## 核心卖点：自动发现

默认**零配置**：插件挂载时遍历 `llm.listProviders()` / `llm.listModels()`，找出第一个声明了
`inputModalities` 包含 `image` 的模型并自动使用。也可以在 config 里显式指定。

## 安装

要求：`dsh` CLI 可用，且已配置一个多模态模型（见下方"模态声明"）。

```sh
# 从 GitHub 源码安装（本插件纯 JS、零构建步骤，无需 prepare/构建授权）
dsh plugin --profile <name> add github:NormanFxxkingRockwell/dsh-auto-vision

# 若已发布到 npm
dsh plugin --profile <name> add dsh-auto-vision

# 验证层已生效
dsh --profile <name> --dump-config
```

装好后在会话里直接说"读这张图 <path> 描述一下"，主模型会自动调用 `vision` 工具。

### 模态声明

自动发现依赖模型声明了 image 输入。在 `settings.yaml` 里给支持图片的模型声明：

```yaml
providers:
  bailian:
    models:
      - id: qwen3.7-plus
        name: Qwen3.7-Plus
        contextWindow: 100000
        input: [text, image]
```

没声明任何多模态模型时，插件会在**挂载期**报错并给出这条指引（而不是第一次调用才崩）。

## 配置

插件行配置（全部可选；默认走自动发现）：

| config | 说明 |
|---|---|
| `provider` + `model` | 显式指定视觉模型（必须成对给出）；挂载期会校验其 image 模态 |
| `prefer: [bailian]` | 自动发现时优先尝试的 provider 顺序 |
| `discovery: false` | 关闭自动发现（未显式配置时插件报错） |

用户可在自己 profile 的 `cordis.patch.yml` 覆盖（按官方层顺序，后应用层整行替换 config）：

```yaml
- update:
    - id: dsh-auto-vision
      config:
        provider: bailian
        model: qwen3.7-plus
```

## 兼容性与行为

- 工具名 `vision`，参数 `file_path`（必填，PNG/JPEG/WebP/GIF）+ `instruction`（可选）；
- 与 `read_image` 共用同一 attachment 管线（尺寸/字节限制、持久化）；
- 挂载期预检：显式模型不支持图片、或自动发现落空，都会给出可操作的错误；
- 零运行时依赖：不 import 任何 npm 包，只使用宿主服务（`tools` / `fs` / `systemPrompt` / `llm` / `attachments`）。

## License

MIT