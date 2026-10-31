// magpie-strip-harness — magpie 网关中间件
// 在请求路由前，把 agent 请求体 system role 里由 harness 注入的身份提示
// （如 DeepSeek Harness 的开场白 "You are an AI agent powered by DeepSeek Harness."）
// 所在的段落剔除，其余内容原样保留。只改请求，不碰回复与事件。
//
// 运行环境是 moejs（网关内置 JS 引擎）：只有标准 JS，可用的语法刻意保持保守
// （无可选链 / 空值合并 / 展开运算符 / 后行断言）。

const DEFAULT_PATTERNS = ["/deepseek[\\s_-]*harness/i"]

// "/body/flags" 形式编译为 RegExp，其余按大小写不敏感的子串匹配。
function compilePattern(p) {
  if (typeof p !== "string") return null
  const s = p.trim()
  if (!s) return null
  const m = /^\/(.+)\/([a-z]*)$/.exec(s)
  if (m) {
    try {
      return new RegExp(m[1], m[2] || "i")
    } catch (e) {
      return null // 非法正则：跳过该条，等效于不存在
    }
  }
  const needle = s.toLowerCase()
  return { test: (t) => t.toLowerCase().indexOf(needle) !== -1 }
}

function getMatchers(options) {
  const src =
    options && Array.isArray(options.patterns) && options.patterns.length > 0
      ? options.patterns
      : DEFAULT_PATTERNS
  const out = []
  for (let i = 0; i < src.length; i++) {
    const m = compilePattern(src[i])
    if (m) out.push(m)
  }
  if (out.length === 0 && src !== DEFAULT_PATTERNS) {
    // patterns 全部无效（如正则笔误）时退回默认，避免清洗整个静默失效
    for (let j = 0; j < DEFAULT_PATTERNS.length; j++) {
      const m = compilePattern(DEFAULT_PATTERNS[j])
      if (m) out.push(m)
    }
  }
  return out
}

function hit(text, matchers) {
  for (let i = 0; i < matchers.length; i++) {
    try {
      if (matchers[i].test(text)) return true
    } catch (e) {
      /* 单条模式对当前输入抛错时视为不命中 */
    }
  }
  return false
}

// 两级剔除，尽量少动原文：
// 1) 段落级：按空行分段，丢弃命中的整段（处理跨行的 harness 段落）；
// 2) 行级兜底：没有空行结构、或段落级会清空全文时，改为丢弃命中的行。
function stripText(text, matchers) {
  const str = String(text)
  if (!str || !hit(str, matchers)) {
    return { text: str, changed: false }
  }
  const paras = str.split(/\n[ \t]*\n/)
  if (paras.length > 1) {
    const kept = []
    let removed = 0
    for (let i = 0; i < paras.length; i++) {
      if (hit(paras[i], matchers)) removed++
      else kept.push(paras[i])
    }
    if (removed > 0 && kept.length > 0) {
      return { text: kept.join("\n\n"), changed: true }
    }
    // 段落级会清空全文：退到行级，避免误杀无匹配的行
  }
  const lines = str.split(/\n/)
  const keptLines = []
  let removedLines = 0
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].length > 0 && hit(lines[j], matchers)) removedLines++
    else keptLines.push(lines[j])
  }
  return { text: keptLines.join("\n"), changed: removedLines > 0 }
}

// stripAll: 命中即移除整个 system 内容（该消息/字段整体删除）
function processText(text, matchers, stripAll) {
  const str = String(text)
  if (stripAll) {
    if (!str || !hit(str, matchers)) return { text: str, changed: false }
    return { text: "", changed: true }
  }
  return stripText(text, matchers)
}

// 对一段 content（字符串或 parts 数组）做剔除。
// 返回 null 表示结构不适用；changed=false 表示原样保留。
function stripContent(content, matchers, stripAll) {
  if (typeof content === "string") {
    const r = processText(content, matchers, stripAll)
    if (!r.changed) return { changed: false }
    if (!String(r.text).trim()) return { changed: true, removedAll: true }
    return { changed: true, content: r.text }
  }
  if (Array.isArray(content)) {
    let changed = false
    const out = []
    for (let i = 0; i < content.length; i++) {
      const part = content[i]
      if (part && typeof part.text === "string") {
        const r = processText(part.text, matchers, stripAll)
        if (r.changed) {
          changed = true
          if (String(r.text).trim()) out.push(Object.assign({}, part, { text: r.text }))
          // 变空的 part 直接丢弃
        } else {
          out.push(part)
        }
      } else {
        out.push(part)
      }
    }
    if (!changed) return { changed: false }
    if (out.length === 0) return { changed: true, removedAll: true }
    return { changed: true, content: out }
  }
  return null
}

// chat completions：messages 里 role 为 system / developer 的条目
function stripChatSystem(body, matchers, stripAll) {
  if (!Array.isArray(body.messages)) return false
  let changed = false
  const out = []
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i]
    if (!msg || (msg.role !== "system" && msg.role !== "developer")) {
      out.push(msg)
      continue
    }
    const res = stripContent(msg.content, matchers, stripAll)
    if (res && res.changed) {
      changed = true
      if (!res.removedAll) out.push(Object.assign({}, msg, { content: res.content }))
      // 清空后整条消息移除
      continue
    }
    out.push(msg)
  }
  if (changed) body.messages = out
  return changed
}

// anthropic messages：body.system（字符串或 blocks 数组，保留 cache_control 等字段）
function stripAnthropicSystem(body, matchers, stripAll) {
  const sys = body.system
  if (typeof sys !== "string" && !Array.isArray(sys)) return false
  const res = stripContent(sys, matchers, stripAll)
  if (!res || !res.changed) return false
  if (res.removedAll) delete body.system
  else body.system = res.content
  return true
}

// responses：body.instructions + input 里 role 为 system / developer 的条目
function stripResponsesSystem(body, matchers, stripAll) {
  let changed = false
  if (typeof body.instructions === "string") {
    const r = processText(body.instructions, matchers, stripAll)
    if (r.changed) {
      changed = true
      if (!String(r.text).trim()) delete body.instructions
      else body.instructions = r.text
    }
  }
  if (Array.isArray(body.input)) {
    const out = []
    let touched = false
    for (let i = 0; i < body.input.length; i++) {
      const item = body.input[i]
      const role = item && item.role
      if (role === "system" || role === "developer") {
        const res = stripContent(item.content, matchers, stripAll)
        if (res && res.changed) {
          touched = true
          changed = true
          if (!res.removedAll) out.push(Object.assign({}, item, { content: res.content }))
          continue
        }
      }
      out.push(item)
    }
    if (touched) body.input = out
  }
  return changed
}

// gemini：systemInstruction / system_instruction（字符串或 {parts:[...]}）
function stripGeminiSystem(body, matchers, stripAll) {
  let key = null
  let si = null
  if (body.systemInstruction !== undefined) {
    key = "systemInstruction"
    si = body.systemInstruction
  } else if (body.system_instruction !== undefined) {
    key = "system_instruction"
    si = body.system_instruction
  }
  if (!key) return false
  let changed = false
  let next = si
  if (typeof si === "string") {
    const r = processText(si, matchers, stripAll)
    if (r.changed) {
      changed = true
      next = String(r.text).trim() ? r.text : ""
    }
  } else if (si && typeof si === "object" && Array.isArray(si.parts)) {
    const out = []
    let touched = false
    for (let i = 0; i < si.parts.length; i++) {
      const p = si.parts[i]
      const t = p && typeof p === "object" ? p.text : p
      if (typeof t === "string") {
        const r = processText(t, matchers, stripAll)
        if (r.changed) {
          touched = true
          changed = true
          if (String(r.text).trim()) {
            out.push(typeof p === "object" ? Object.assign({}, p, { text: r.text }) : r.text)
          }
          continue
        }
      }
      out.push(p)
    }
    if (touched) next = Object.assign({}, si, { parts: out })
  }
  if (!changed) return false
  if (typeof next === "string" && !next.trim()) delete body[key]
  else body[key] = next
  return true
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const options = ctx && typeof ctx === "object" ? ctx.options : null
  const matchers = getMatchers(options)
  if (matchers.length === 0) return body
  const stripAll = !!(options && options.stripAll === true)
  const protocol = ctx && ctx.protocol

  let changed = false
  if (protocol === "chat") changed = stripChatSystem(body, matchers, stripAll)
  else if (protocol === "anthropic") changed = stripAnthropicSystem(body, matchers, stripAll)
  else if (protocol === "responses") changed = stripResponsesSystem(body, matchers, stripAll)
  else if (protocol === "gemini") changed = stripGeminiSystem(body, matchers, stripAll)
  else {
    // 协议未知时按已知形状逐个尝试（各函数只读自己的字段，互不干扰）
    changed = stripChatSystem(body, matchers, stripAll)
    if (!changed) changed = stripAnthropicSystem(body, matchers, stripAll)
    if (!changed) changed = stripResponsesSystem(body, matchers, stripAll)
    if (!changed) changed = stripGeminiSystem(body, matchers, stripAll)
  }

  if (changed && options && options.debug === true) {
    const tag = protocol || "unknown"
    const model = ctx && ctx.model ? ctx.model : "?"
    console.log("[strip-harness] " + tag + " " + model + ": removed harness prompt from system role")
  }
  return body
}
