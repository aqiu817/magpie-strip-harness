// node test.mjs — 本地逻辑测试（纯标准 JS，node 直接跑）
import assert from "node:assert/strict"
import { onRequest } from "./strip.middleware.js"

const OPENING = "You are an AI agent powered by DeepSeek Harness."
const WEBGUI =
  "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.\nWhen the user refers to \"this page\", \"this GUI\", or \"this app\" without naming one, they mean it."
const PERSONA = "You are a careful coding agent. Keep answers tight and verifiable."
const ENV = "# Environment\n- Working directory: D:\\DS Harness\n- Platform: win32"

let passed = 0
function t(name, fn) {
  fn()
  passed++
  console.log("ok - " + name)
}

const chatCtx = (options) => ({ protocol: "chat", model: "test/model", options })

// 1. chat：开场白独立段落 → 只删该段，persona/env 保留
t("chat: drops the opener paragraph, keeps the rest", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: OPENING + "\n\n" + PERSONA + "\n\n" + ENV },
      { role: "user", content: "hi" },
    ],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content, PERSONA + "\n\n" + ENV)
  assert.equal(out.messages[1].role, "user")
})

// 2. chat：Web GUI 多行段落（无空行）整段删除
t("chat: drops a multi-line harness paragraph as a whole", () => {
  const body = {
    model: "m",
    messages: [{ role: "system", content: WEBGUI + "\n\n" + PERSONA }],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content, PERSONA)
})

// 3. chat：单换行拼接（无空行结构）→ 行级兜底
t("chat: line fallback when there are no blank lines", () => {
  const body = {
    model: "m",
    messages: [{ role: "system", content: OPENING + "\n" + PERSONA + "\n" + ENV }],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content, PERSONA + "\n" + ENV)
})

// 4. chat：无命中 → 原样返回
t("chat: leaves non-matching system text untouched", () => {
  const body = { model: "m", messages: [{ role: "system", content: PERSONA }, { role: "user", content: "hi" }] }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content, PERSONA)
  assert.equal(out.messages.length, 2)
})

// 5. chat：content parts 数组 → 命中的 part 文本被剔，其余 part 保留
t("chat: handles parts-array system content", () => {
  const body = {
    model: "m",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: OPENING },
          { type: "text", text: PERSONA },
        ],
      },
    ],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content.length, 1)
  assert.equal(out.messages[0].content[0].text, PERSONA)
})

// 6. chat：整条 system 全命中 → 消息整个移除
t("chat: removes a fully matched system message", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: OPENING + "\n\nSee DeepSeek Harness docs." },
      { role: "user", content: "hi" },
    ],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, "user")
})

// 7. chat：developer role 同样处理
t("chat: also processes developer role", () => {
  const body = {
    model: "m",
    messages: [{ role: "developer", content: OPENING + "\n\n" + PERSONA }],
  }
  const out = onRequest(body, chatCtx({}))
  assert.equal(out.messages[0].content, PERSONA)
})

// 8. anthropic：blocks 数组 → 命中块移除，其余块连同 cache_control 保留
t("anthropic: strips blocks, preserves cache_control on survivors", () => {
  const body = {
    model: "m",
    system: [
      { type: "text", text: OPENING },
      { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hi" }],
  }
  const out = onRequest(body, { protocol: "anthropic", model: "m", options: {} })
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].text, PERSONA)
  assert.deepEqual(out.system[0].cache_control, { type: "ephemeral" })
})

// 9. anthropic：字符串 system + 全命中 → 字段删除
t("anthropic: deletes system when fully matched (string form)", () => {
  const body = { model: "m", system: OPENING, messages: [{ role: "user", content: "hi" }] }
  const out = onRequest(body, { protocol: "anthropic", model: "m", options: {} })
  assert.equal("system" in out, false)
})

// 10. responses：instructions + input 里的 system 条目
t("responses: strips instructions and input system items", () => {
  const body = {
    model: "m",
    instructions: OPENING + "\n\n" + PERSONA,
    input: [
      { role: "system", content: [{ type: "input_text", text: OPENING }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  }
  const out = onRequest(body, { protocol: "responses", model: "m", options: {} })
  assert.equal(out.instructions, PERSONA)
  assert.equal(out.input.length, 1)
  assert.equal(out.input[0].role, "user")
})

// 11. gemini：systemInstruction.parts
t("gemini: strips matching parts of systemInstruction", () => {
  const body = {
    systemInstruction: { parts: [{ text: OPENING }, { text: PERSONA }] },
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  }
  const out = onRequest(body, { protocol: "gemini", model: "m", options: {} })
  assert.deepEqual(out.systemInstruction, { parts: [{ text: PERSONA }] })
})

// 12. 未知协议 → 防御性尝试 chat 形状
t("unknown protocol: falls back to chat shape", () => {
  const body = { model: "m", messages: [{ role: "system", content: OPENING + "\n\n" + PERSONA }] }
  const out = onRequest(body, { model: "m", options: {} })
  assert.equal(out.messages[0].content, PERSONA)
})

// 13. patterns 覆盖默认：普通子串（大小写不敏感）
t("options.patterns replaces defaults (plain substring)", () => {
  const body = {
    model: "m",
    messages: [{ role: "system", content: "恶魔白泽 is active.\n\n" + PERSONA }],
  }
  const out = onRequest(body, chatCtx({ patterns: ["恶魔白泽"] }))
  assert.equal(out.messages[0].content, PERSONA)
  // 默认模式不再生效
  const body2 = { model: "m", messages: [{ role: "system", content: OPENING }] }
  const out2 = onRequest(body2, chatCtx({ patterns: ["nomatch"] }))
  assert.equal(out2.messages[0].content, OPENING)
})

// 14. stripAll：命中即清空整个 system
t("options.stripAll removes the whole system on any match", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: PERSONA + "\n\n" + OPENING },
      { role: "user", content: "hi" },
    ],
  }
  const out = onRequest(body, chatCtx({ stripAll: true }))
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, "user")
})

// 15. 非对象 body / 空选项 → 原样返回
t("non-object body passes through", () => {
  assert.equal(onRequest(null, chatCtx({})), null)
  const arr = [{ role: "system", content: OPENING }]
  assert.equal(onRequest(arr, chatCtx({})), arr)
})

// 16. 变体写法：DeepSeek-Harness / deepseek_harness 也命中
t("default pattern catches separator variants", () => {
  for (const v of ["You are an AI agent powered by DeepSeek-Harness.", "deepseek_harness rocks"]) {
    const body = { model: "m", messages: [{ role: "system", content: v + "\n\n" + PERSONA }] }
    const out = onRequest(body, chatCtx({}))
    assert.equal(out.messages[0].content, PERSONA, v)
  }
})

// 17. 非法 pattern 被跳过并回退默认，清洗不失效
t("all-invalid patterns fall back to defaults", () => {
  const body = { model: "m", messages: [{ role: "system", content: OPENING + "\n\n" + PERSONA }] }
  const out = onRequest(body, chatCtx({ patterns: ["/[/"] }))
  assert.equal(out.messages[0].content, PERSONA)
})

// 18. 记录刻意行为：孤立多行段落（全文无空行）走行级兜底，
//     只删命中行、保留同段落其余行 —— 宁可留残余也不误杀无关内容。
t("lone multi-line paragraph: line-level fallback keeps unmatched lines", () => {
  const body = { model: "m", messages: [{ role: "system", content: WEBGUI }] }
  const out = onRequest(body, chatCtx({}))
  assert.equal(
    out.messages[0].content,
    'When the user refers to "this page", "this GUI", or "this app" without naming one, they mean it.'
  )
})

console.log("\n" + passed + "/" + passed + " passed")
