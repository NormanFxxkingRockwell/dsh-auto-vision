// dsh-auto-vision: DeepSeek Harness 多模态视觉桥
//
// 给不支持图片输入的主模型（如 deepseek v4 flash）提供一个 vision 工具。
// 工具内部直调一个"已声明接受图片输入"的模型读取本地图片，把识别结果
// 以纯文本返回；图片块只存在于插件内部的视觉请求中，绝不注入当前会话
// 上下文，因此主模型会话不会被任何 image 块污染。
//
// 模型路由（三级）：
//   1. config.provider + config.model 同时给出 -> 直接使用，挂载期用
//      resolveModelInfo 校验该模型确实声明了 image 模态，不满足即报错。
//   2. 未显式配置 -> 自动发现：按 config.prefer 指定的 provider 顺序优先
//      （缺省用注册顺序），遍历 listProviders()/listModels() 找出第一个
//      inputModalities 包含 'image' 的模型并使用。
//   3. 都找不到 -> 挂载期抛错，错误信息给出修复指引（声明 input）。
//
// 零外部 import：不依赖任何 npm 依赖，纯用宿主服务。

export const name = 'dsh-auto-vision'

export const inject = ['tools', 'fs', 'systemPrompt', 'llm']

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const VISION_SYSTEM =
  '你是一个多模态视觉识别代理。用户会给你一张图片和一个指令，你需要直接基于图片内容给出准确、完整的回答。只输出识别结论本身，不要自我介绍、不要解释你的机制。'

/** 归一化并校验插件配置。 */
function normalizeConfig(raw) {
  const config = raw || {}
  const provider = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : undefined
  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : undefined
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('dsh-auto-vision: config.provider and config.model must be provided together (or both omitted to auto-discover an image-capable model)')
  }
  const prefer = Array.isArray(config.prefer)
    ? config.prefer.map((x) => String(x)).filter((x) => x.length > 0)
    : []
  if (prefer.some((x) => /[^a-zA-Z0-9._-]/.test(x))) {
    throw new Error('dsh-auto-vision: config.prefer must be a list of provider route ids')
  }
  const discovery = config.discovery !== false
  return { provider, model, prefer, discovery }
}

/** 在已注册 provider 中找一个声明了 image 输入模态的模型。 */
async function discoverVisualModel(llm, prefer) {
  const ordered = []
  const seen = new Set()
  for (const id of [...prefer, ...llm.listProviders().map((p) => p.id)]) {
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  const warnings = []
  for (const provider of ordered) {
    let models
    try {
      models = await llm.listModels(provider)
    } catch (error) {
      warnings.push(provider + ': ' + (error && error.message ? error.message : String(error)))
      continue
    }
    for (const entry of models || []) {
      if (entry.inputModalities && entry.inputModalities.includes('image')) {
        return { provider, model: entry.id, label: entry.name, warnings }
      }
    }
  }
  return null
}

/** async apply：挂载阶段完成路由解析与校验，失败即挂载失败并给出修复指引。 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  const llm = ctx.get('llm')
  if (!llm) throw new Error('dsh-auto-vision: no llm service mounted')

  // ── 路由解析：显式配置 > 自动发现 > 明确失败 ──────────────────────────
  let visual
  let warnings = []
  if (cfg.provider) {
    const info = await llm.resolveModelInfo(cfg.provider, cfg.model)
    if (!(info.inputModalities && info.inputModalities.includes('image'))) {
      throw new Error(
        'dsh-auto-vision: configured model ' + cfg.provider + '/' + cfg.model +
        ' does not declare image input (inputModalities=' + JSON.stringify(info.inputModalities) + '). ' +
        'Declare it as image-capable (e.g. add "input: [text, image]" to the model entry in settings.yaml) or set config.provider/config.model to an image-capable model.'
      )
    }
    visual = { provider: cfg.provider, model: cfg.model, label: info.name, source: 'config' }
  } else if (cfg.discovery) {
    visual = await discoverVisualModel(llm, cfg.prefer)
    if (visual) warnings = visual.warnings || []
    else {
      const ids = llm.listProviders().map((p) => p.id).join(', ') || '(none)'
      throw new Error(
        'dsh-auto-vision: no image-capable model found among configured providers [' + ids + ']. ' +
        'Register a multimodal provider and declare "input: [text, image]" on its model entry, or set config.provider/config.model explicitly.'
      )
    }
  } else {
    throw new Error('dsh-auto-vision: disabled in config: no provider/model and discovery is turned off')
  }

  function baseName(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i >= 0 ? p.slice(i + 1) : p
  }

  ctx.systemPrompt.section({
    name: 'tool:vision',
    order: 96,
    text:
      '当前主模型不支持图片输入（read_image 会失败）：遇到图片文件时，一律先用 vision 工具（参数 file_path 指向图片路径，instruction 说明要看什么）取得识别文本，再基于该文本继续工作；不要尝试用 read_image 或直接猜测图片内容。本会话的 vision 工具使用 ' + visual.provider + '/' + visual.model + ' 识别图片。',
  })

  return ctx.tools.register({
    name: 'vision',
    description:
      '使用内置多模态模型读取并识别一张本地图片，把识别结果作为纯文本返回。当当前主模型不支持图片输入（无法使用 read_image）时，用本工具代替：主模型只需要给图片路径和你想从图片里获取的信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: '图片文件路径，支持 PNG/JPEG/WebP/GIF' },
        instruction: { type: 'string', description: '识别要求，例如"描述图里的内容""提取图中文字""图中有什么动物/人/物体"。缺省为详细描述图片。' },
      },
      required: ['file_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '<vision-result>\n' + String(value.text) + '\n</vision-result>',
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const p = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      if (!p) throw new Error('vision: file_path must be a non-empty string')
      const dot = p.lastIndexOf('.')
      const ext = dot >= 0 ? p.slice(dot).toLowerCase() : ''
      const mediaType = IMAGE_EXTENSIONS[ext]
      if (!mediaType) throw new Error('vision: only PNG/JPEG/WebP/GIF image paths are supported')

      const attachments = ctx.get('attachments')
      if (!attachments) throw new Error('vision: no attachment service is mounted')
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error('vision: ' + mediaType + ' images are not accepted by this deployment')
      }

      const target = await ctx.fs.resolve(p)
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const ref = await attachments.saveImage({ data: data, mediaType: mediaType, name: baseName(p) })

      const instruction =
        typeof args.instruction === 'string' && args.instruction.trim()
          ? args.instruction.trim()
          : '请详细描述这张图片的内容，包括主体、构图、风格、色调和氛围。'
      const parts = []
      let finished = null
      for await (const chunk of llm.stream({
        provider: visual.provider,
        model: visual.model,
        system: VISION_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            {
              type: 'image',
              attachment: {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
              },
            },
          ],
        }],
        signal: exec.signal,
      })) {
        if (chunk.type === 'text-delta') parts.push(chunk.text)
        if (chunk.type === 'finish') finished = chunk.reason
      }
      if (finished === 'error' || finished === 'aborted') throw new Error('vision: model call finished with ' + finished)
      const text = parts.join('').trim()
      if (!text) throw new Error('vision: model returned no text')
      return { text: text }
    },
  })
}