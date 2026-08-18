# dsh-auto-vision

![license](https://img.shields.io/badge/license-MIT-green)
![dsh](https://img.shields.io/badge/dsh-plugin-4B32C3)
[![repo](https://img.shields.io/badge/repo-github-181717?logo=github)](https://github.com/NormanFxxkingRockwell/dsh-auto-vision)

**给 DeepSeek Harness 里的纯文本主模型装上眼睛：自动发现你已配置的多模态模型，一条命令装上 vision 工具，图片识别结果以纯文本返回。**

## 快速开始

本插件**已发布到 npm**（`dsh-auto-vision@0.1.0`），两种安装方式任选：

**方式一：npm 安装（推荐）**

```sh
dsh plugin --profile <你的profile名> add dsh-auto-vision
```

**方式二：GitHub 源码安装**（纯 JS、零构建步骤，无需构建授权）

```sh
dsh plugin --profile <你的profile名> add github:NormanFxxkingRockwell/dsh-auto-vision
```

装好后，直接在主对话里说：

> 读这张图 `C:\path\to\image.jpg` 描述一下

主模型会自动调用 `vision` 工具，把识别结果以文本形式返回给你。

> 要求：你的 dsh 里已经配置了至少一个**声明了图片输入**的多模态模型（如何声明见下文「配置」）。没有的话，插件会在启动时报错并告诉你怎么办。

## 它解决什么问题

dsh 内置的 `read_image` 会把图片块直接塞进当前模型的上下文，所以只有当**当前主模型本身支持图片**时才能用。像 `deepseek v4 flash` 这样的纯文本模型，调用 `read_image` 会被直接拒绝。

本插件换了一条路：**由插件内部转发给一个多模态模型**，主模型全程只看到文本。除此之外，它把两个"本来会卡住"的场景也自动打通了：

- **粘贴图片自动转述**：你把图片直接拖进/粘进对话框发送，插件会在图片进入模型前自动转述成文字——不需要文件路径，也不用指定工具；
- **自动隐藏 read_image**：纯文本主模型的会话里会藏掉必然失败的 `read_image`，让模型只能走 `vision`，不会先撞一次失败再换路。

```
你（纯文本主模型）
   │  调用 vision 工具 / 收到自动转述的图片文字
   ▼
vision 工具（本插件）
   │  把图片转给多模态模型（比如 qwen3.7-plus）
   ▼
识别结果 → 纯文本返回给你
```

## 工作原理

- **自动发现模型**：默认零配置。插件启动时扫描你已配置的全部模型，自动选中第一个「声明支持图片输入」的模型来读图；你也可以手动指定（见下）。
- **图片不进主会话**：图片块只存在于插件内部的视觉请求中，你的主模型上下文里不会有任何图片，不会被污染、不会报错。
- **走你自己的通道**：识别请求走宿主自己的模型运行时（`ctx.llm`）——用你已配置的 key、重试策略，不需要任何额外的 API key 或服务。

## 配置

以下配置都是**可选的**，不配置也能用（自动发现）。

### 在 plugins 层配置（改 cordis.patch.yml 或 preset 行）

| 配置项 | 说明 |
|---|---|
| `provider` + `model` | 手动指定视觉模型（两个必须成对给出）。启动时会校验它确实支持图片，否则报错 |
| `prefer` | 自动发现时优先尝试的 provider 顺序，例如 `prefer: [bailian]` |
| `discovery: false` | 关闭自动发现（此时必须手动指定 provider/model，否则插件报错） |
| `autoHideReadImage: false` | 关闭"自动隐藏 read_image"（默认开启：纯文本主模型会话藏 read_image，切多模态模型自动恢复） |
| `transcribeImages: false` | 关闭"粘贴图片自动转述" |

示例：

```yaml
# 在你的 profile 的 cordis.patch.yml 里覆盖插件配置
- id: dsh-auto-vision
  config:
    provider: bailian
    model: qwen3.7-plus
```

### 给模型声明图片输入

自动发现靠的是「模型声明了 `image` 模态」。在 `settings.yaml` 里给支持图片的模型声明：

```yaml
providers:
  bailian:
    models:
      - id: qwen3.7-plus
        name: Qwen3.7-Plus
        contextWindow: 100000
        input: [text, image]
```

## 功能与兼容性

- 工具名 `vision`，参数：`file_path`（必填，支持 PNG / JPEG / WebP / GIF）、`instruction`（可选，识别要求）
- 与 `read_image` 共用同一套附件管线和大小限制
- **粘贴图片**：发送时被自动转述为文字（以【图片转述】开头），主模型一致性看到文本
- **read_image 隐藏**：自动跟随当前主模型——纯文本时藏掉 read_image 强制走 vision；切到多模态模型自动恢复原生 read_image，互不干扰
- 启动时会预检：手动指定的模型不支持图片、或自动发现落空，都会在启动时就报出可操作的错误，而不是等你调用时才崩
- 零运行时依赖：不依赖任何 npm 包，只用宿主服务

## License

MIT