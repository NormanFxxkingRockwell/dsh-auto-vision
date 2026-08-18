// dsh-auto-vision: DeepSeek Harness 多模态视觉桥
//
// 给不支持图片输入的主模型（如 deepseek v4 flash）提供 vision 工具，并且：
//   A. 条件隐藏 read_image —— 纯文本主模型会话里藏掉必失败的 read_image，
//      让模型只能走 vision（动态跟随：切到多模态模型自动恢复原生读图）；
//   B. 粘图自动转述 —— 用户直接粘贴进对话的图片，在进入模型前被自动转述
//      成文本，主模型只看到文字（图片永不进入主会话上下文）。
//
// 模型路由（三级）：
//   1. config.provider + config.model 同时给出 -> 直接使用，挂载期校验 image 模态；
//   2. 未显式配置 -> 自动发现：扫描已注册 provider，选第一个声明 image 模态的模型；
//   3. 都找不到 -> 挂载期抛错并给出修复指引。
//
// 零外部 import：纯用宿主服务（tools/fs/systemPrompt/llm/attachments）。

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

const DEFAULT_INSTRUCTION = '请详细描述这张图片的内容，包括主体、构图、风格、色调和氛围。'

const TRANSCRIBE_FAILED_TEXT = '[图片自动转述失败：视觉模型调用出错。请稍后重试，或把图片保存为文件后让我用 vision 工具读取。]'

function baseName(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

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
  const autoHideReadImage = config.autoHideReadImage !== false
  const transcribeImages = config.transcribeImages !== false
  return { provider, model, prefer, discovery, autoHideReadImage, transcribeImages }
}

/** 在已注册 provider 中找一个声明了 image 输入模态的模型。单个 provider 查询失败时跳过继续。 */
async function discoverVisualModel(llm, prefer, providers) {
  const ordered = []
  const seen = new Set()
  for (const id of [...prefer, ...providers]) {
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  for (const provider of ordered) {
    let models
    try {
      models = await llm.listModels(provider)
    } catch {
      continue
    }
    for (const entry of models || []) {
      if (entry.inputModalities && entry.inputModalities.includes('image')) {
        return { provider, model: entry.id }
      }
    }
  }
  return null
}

/**
 * 等待 provider 适配器注册完成并稳定。插件 loader 行与 llm adapter 行并发
 * 启动：内置 provider 先注册，settings 声明的 provider 随后异步注册。等到
 * 快照连续 stableMs 毫秒不变（或超时）才返回最终 id 列表。
 */
async function waitForProviders(llm, timeoutMs, stableMs) {
  const deadline = Date.now() + timeoutMs
  let lastKey = null
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    const ids = llm.listProviders().map((p) => p.id)
    const key = ids.join('\u0000')
    if (key !== lastKey) {
      lastKey = key
      lastChange = Date.now()
    }
    if (lastKey !== null && Date.now() - lastChange >= stableMs) return ids
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return lastKey === null ? [] : lastKey.split('\u0000')
}

/**
 * 把一条 user message 里的 image 块逐个转述为文本块。
 * @returns 替换后的 content 块数组；不包含 image 时返回原 content。
 */
async function transcribeBlocks(ctx, llm, visual, blocks, signal, cache) {
  let sawImage = false
  const out = []
  for (const block of blocks || []) {
    if (!block || block.type !== 'image') {
      out.push(block)
      continue
    }
    sawImage = true
    const att = block.attachment
    const key = att && att.attachmentId ? att.attachmentId : null
    let text = null
    if (key && cache.has(key)) {
      text = cache.get(key)
    } else if (att && att.attachmentId) {
      try {
        const parts = []
        let finished = null
        for await (const chunk of llm.stream({
          provider: visual.provider,
          model: visual.model,
          system: VISION_SYSTEM,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: DEFAULT_INSTRUCTION },
              {
                type: 'image',
                attachment: {
                  attachmentId: att.attachmentId,
                  mediaType: att.mediaType,
                  bytes: att.bytes,
                  width: att.width,
                  height: att.height,
                },
              },
            ],
          }],
          signal,
        })) {
          if (chunk.type === 'text-delta') parts.push(chunk.text)
          if (chunk.type === 'finish') finished = chunk.reason
        }
        if (finished !== 'error' && finished !== 'aborted') {
          text = parts.join('').trim()
        }
      } catch {
        text = null
      }
      if (text && key) {
        cache.set(key, text)
        if (cache.size > 256) {
          const first = cache.keys().next().value
          if (first !== undefined) cache.delete(first)
        }
      }
    }
    out.push({ type: 'text', text: text ? '【图片转述】' + text : TRANSCRIBE_FAILED_TEXT })
  }
  return { sawImage, blocks: out }
}

/** async apply：挂载阶段完成路由解析与校验，并注册工具与两个扩展钩子。 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  const llm = ctx.get('llm')
  if (!llm) throw new Error('dsh-auto-vision: no llm service mounted')

  // ── 路由解析：显式配置 > 自动发现 > 明确失败 ──────────────────────────
  const providers = await waitForProviders(llm, 20000, 1000)
  let visual
  if (cfg.provider) {
    if (!providers.includes(cfg.provider)) {
      throw new Error(
        'dsh-auto-vision: configured provider ' + cfg.provider + ' is not registered (registered: [' + providers.join(', ') + ']). ' +
        'Add the provider to settings and restart the profile.'
      )
    }
    const info = await llm.resolveModelInfo(cfg.provider, cfg.model)
    if (!(info.inputModalities && info.inputModalities.includes('image'))) {
      throw new Error(
        'dsh-auto-vision: configured model ' + cfg.provider + '/' + cfg.model +
        ' does not declare image input (inputModalities=' + JSON.stringify(info.inputModalities) + '). ' +
        'Declare it as image-capable (e.g. add "input: [text, image]" to the model entry in settings.yaml) or set config.provider/config.model to an image-capable model.'
      )
    }
    visual = { provider: cfg.provider, model: cfg.model }
  } else if (cfg.discovery) {
    visual = await discoverVisualModel(llm, cfg.prefer, providers)
    if (!visual) {
      const ids = providers.join(', ') || '(none)'
      throw new Error(
        'dsh-auto-vision: no image-capable model found among configured providers [' + ids + ']. ' +
        'Register a multimodal provider and declare "input: [text, image]" on its model entry, or set config.provider/config.model explicitly.'
      )
    }
  } else {
    throw new Error('dsh-auto-vision: disabled in config: no provider/model and discovery is turned off')
  }

  // ── 方案 A：动态隐藏 read_image（仅对纯文本主模型会话） ──────────────
  // tools.restrict 要求 agent 级 scoped context（profile 层 ctx 会被拒绝），
  // 且必须早于工具列表快照：agent/created 时执行首轮判定（读 agent.options
  // 的默认模型），agent/request 时跟踪运行中的模型切换。挂在 agent ctx 上
  // 的 restrict 随 agent 销毁自动 unwind；deniedAgents 记录已 deny 的 agent。
  const deniedAgents = new Map()
  async function syncHide(agent, provider, model) {
    if (!cfg.autoHideReadImage || !agent || !provider || !model) return
    const actx = agent.ctx
    if (!actx) return
    let imageCapable = false
    try {
      const info = await llm.resolveModelInfo(provider, model)
      imageCapable = Boolean(info.inputModalities && info.inputModalities.includes('image'))
    } catch {
      imageCapable = false // fail-open：判定失败时不藏
    }
    const wantHide = !imageCapable
    if (wantHide && !deniedAgents.has(agent)) {
      try {
        deniedAgents.set(agent, actx.tools.restrict({ deny: ['read_image'] }))
      } catch {
        /* 保持未设状态 */
      }
    } else if (!wantHide && deniedAgents.has(agent)) {
      try { deniedAgents.get(agent)() } catch { /* noop */ }
      deniedAgents.delete(agent)
    }
  }
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    const ro = agent.options || {}
    syncHide(agent, ro.provider, ro.model).catch(() => {})
  })
  ctx.on('agent/request', async (payload, next) => {
    const cfgResolved = await next()
    await syncHide(payload && payload.agent, cfgResolved && cfgResolved.provider, cfgResolved && cfgResolved.model).catch(() => {})
    return cfgResolved
  })

  // ── 方案 B：粘贴图片自动转述（agent/pre-step 替换消息） ──────────────
  const transcriptCache = new Map()
  if (cfg.transcribeImages) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const p = payload || {}
      const msgs = Array.isArray(p.messages) ? p.messages : []
      let anyImage = false
      for (const m of msgs) {
        const c = m && m.content
        if (Array.isArray(c) && c.some((b) => b && b.type === 'image')) {
          anyImage = true
          break
        }
      }
      if (!anyImage) return next()
      if (p.signal && p.signal.aborted) return next()
      const out = []
      try {
        for (const m of msgs) {
          const c = m && m.content
          if (!Array.isArray(c) || !c.some((b) => b && b.type === 'image')) {
            out.push(m)
            continue
          }
          const { blocks } = await transcribeBlocks(ctx, llm, visual, c, p.signal, transcriptCache)
          out.push({ ...m, content: blocks })
        }
      } catch {
        return next()
      }
      return { messages: out }
    })
  }

  ctx.systemPrompt.section({
    name: 'tool:vision',
    order: 96,
    text:
      '本会话由 dsh-auto-vision 提供图片能力，使用 ' + visual.provider + '/' + visual.model + ' 识别。' +
      '遇到图片文件路径时，一律先用 vision 工具（file_path 指向图片，instruction 说明要看什么）取得识别文本后再继续；' +
      '不要尝试用 read_image 或直接猜测图片内容。用户直接粘贴进对话的图片会被自动转述成文字，' +
      '模型看到以【图片转述】开头的文本即为转述结果。',
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
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
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
          : DEFAULT_INSTRUCTION
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