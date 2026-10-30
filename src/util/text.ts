/**
 * text.ts —— 纯文本工具（无状态、无依赖）。
 * 场景：清洗、截断、给工具输出做预览、从原文里确定性抽取参与者/地点。
 */

/** 统一空白、去掉控制字符。保留换行（多行内容在工具输出里可读性更好）。 */
export function cleanText(text: string): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\r\n?/g, '\n')
    // eslint 风格的控制字符清理（不引入外部依赖）
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 单行化 + 截断，用于 node label / 摘要行。 */
export function preview(text: string, maxChars = 120): string {
  const budget = Math.max(1, Math.floor(maxChars))
  const single = cleanText(text).replace(/\n+/g, ' ')
  if (single.length <= budget) return single
  // maxChars 是硬上限：省略号也算在预算里，调用方可以据此约束响应体大小。
  if (budget === 1) return '…'
  return `${single.slice(0, budget - 1)}…`
}

export function splitSentences(text: string): string[] {
  return cleanText(text)
    .split(/(?<=[。！？!?；;\n])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** 按字符数截断但保留结尾省略号；不做语义截断。 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

const PARTICIPANT_PATTERNS: readonly RegExp[] = [
  /(?:和|跟|与|同|找|约|陪)([\u4e00-\u9fa5]{1,3}?)(?:聊|说|讲|谈|讨论|商量|吃|见|开会|碰头|确认)/gu,
  /([\u4e00-\u9fa5]{2,3})(?:说|表示|认为|提到|建议|反馈|问)/gu,
  /([\u4e00-\u9fa5]{2,3})(?:同学|老师|医生|老板|同事)/gu,
]

const LOCATION_NOUNS: readonly string[] = [
  '公司',
  '办公室',
  '会议室',
  '家',
  '家里',
  '学校',
  '医院',
  '咖啡厅',
  '咖啡馆',
  '机场',
  '车站',
  '地铁',
  '图书馆',
  '公园',
  '餐厅',
  '酒店',
  '实验室',
  '教室',
]

/** 参与者抽取（启发式，确定性）：只认「和王哥聊」这类明确句式，宁可少抽不误抽。 */
export function extractParticipants(text: string, max = 4): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const pattern of PARTICIPANT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = (match[1] ?? '').trim()
      if (name.length < 2 || name.length > 3) continue
      if (seen.has(name)) continue
      seen.add(name)
      found.push(name)
      if (found.length >= max) return found
    }
  }
  return found
}

/** 地点抽取：命中已知地点名词即算一个地点。 */
export function extractLocations(text: string, max = 4): string[] {
  const found: string[] = []
  for (const noun of LOCATION_NOUNS) {
    if (text.includes(noun)) {
      found.push(noun)
      if (found.length >= max) break
    }
  }
  return found
}

/** 去重并保持原顺序。 */
export function uniqueStrings(values: readonly string[], max = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

/** 去掉重复的前缀空白/引号，给标题用。 */
export function trimTitle(text: string, maxChars = 28): string {
  const cleaned = cleanText(text)
    .replace(/^[#>*\-\s]+/u, '')
    .replace(/^["'「『（(]+/u, '')
    .replace(/["'」』）)]+$/u, '')
  const single = cleaned.replace(/\n+/g, ' ')
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single
}

/**
 * 宿主会在用户消息里注入运行上下文（时间戳、工作目录、压缩提示等）。
 * 这些行是真实证据的一部分（Experience 原样保存），但不适合当 Episode 标题。
 */
const RUNTIME_LINE_PREFIXES: readonly string[] = [
  'time sampled',
  'elapsed since',
  'browser time zone',
  'current runtime context',
  'current working directory',
  'current dsh file policy',
  'current deepseek implementation checkout',
  'current deepseek web gui url',
  'you are the team lead',
  'you are an ai agent',
  'you are a coding agent',
  'agent teams is available',
  'use list_agents',
  'to message another teammate',
  'the runtime context names',
  'the client-plugin hmr receiver',
  'approval prompts are disabled',
  'a skill is a reusable set',
  'if the user names a skill',
  '[compressed conversation section]',
  '[acp]',
  '[bili]',
  'reasoning effort',
  '[per-summary length budget]',
]

const NEWLINE = String.fromCharCode(10)

function isRuntimeLine(line: string): boolean {
  const lowered = line.toLowerCase()
  return RUNTIME_LINE_PREFIXES.some((prefix) => lowered.startsWith(prefix))
}

/** 去掉宿主注入的运行上下文行，用于标题/预览这类「给人看」的派生字段。 */
export function stripRuntimeLines(text: string): string {
  const kept = cleanText(text)
    .split(NEWLINE)
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return true
      return !isRuntimeLine(trimmed)
    })
  return kept.join(NEWLINE).trim()
}

/**
 * 判断一段文本是不是「结构化回执」而不是自然语言（JSON / 数组 / HTML 片段）。
 * 用途：工具结果经常是 {"stage":"enable",...} 这类回执，可以记录成 Experience，
 * 但不该被当作 Episode 标题，也不该给高重要性。
 */
export function looksLikeStructuredText(text: string): boolean {
  const trimmed = cleanText(text).trim()
  if (trimmed.length === 0) return false
  const first = trimmed[0]
  if (first === '{' || first === '[' || first === '<') return true
  // 被截断的 JSON 可能不以括号结尾，用「引号+冒号」出现的次数兜底。
  const quoteColon = trimmed.split('":').length - 1
  return quoteColon >= 2 && trimmed.length < 2000
}

/**
 * 判断一段文本更像「工具输出 / 代码 / 日志」而不是人写的经历。
 *
 * 用途：工具结果必须被捕获、可检索、可追溯，但**不该进 Episode 摘要与参与者抽取**——
 * 否则一段 grep 结果会让摘要变成 `53|export type ...`，还会把「的视听」这类片段当成参与者。
 * 这里只做保守判定：命中编译错误、行号前缀、堆栈帧，或同时具备两类代码特征才否决。
 */
export function looksLikeToolOutput(text: string): boolean {
  const trimmed = cleanText(text)
  if (trimmed.length === 0) return false
  if (/error TS\d+/.test(trimmed)) return true
  if (/^\s*\d+\|/m.test(trimmed)) return true
  if (/^\s*at\s+\S+\(/m.test(trimmed)) return true
  let hits = 0
  if (/\b(?:export|import|interface|function|const|let|await|async)\s/.test(trimmed)) hits += 1
  if (trimmed.includes(':/') || trimmed.includes(':' + String.fromCharCode(92))) hits += 1
  if (/^\s*[{[]"/m.test(trimmed)) hits += 1
  if (/\b(?:npm|node|pnpm|tsc)\s+[-a-z]/.test(trimmed)) hits += 1
  // 管道符密度高通常是表格 / diff / grep 结果。
  if ((trimmed.match(/\|/g)?.length ?? 0) >= 6) hits += 1
  return hits >= 2
}


/**
 * 判断一行是不是「机器产出」：路径:行号、代码、编译/运行日志、JSON 行、命令行。
 *
 * 与 looksLikeToolOutput 的区别：后者判断「整段文本」；这里判断**单行**，
 * 用于把 file/tool 类型的长输出按行过滤后再切句（否则整段代码会被当成一句话）。
 */
export function looksLikeMachineLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  // 路径:行号:内容（grep / 源码清单最常见的形态）
  if (/^[A-Za-z]:?[\\/][^\s]*:\d+:|^\.{0,2}[\\/][^\s]*:\d+:/u.test(trimmed)) return true
  // 缩进 + JS/TS 语句或括号结构
  if (/^\s{2,}(?:export|import|const|let|var|function|class|interface|type|return|if|for|while|await|async)\s/u.test(line)) return true
  if (/^\s{2,}[})\]]+[;,]?$/u.test(line)) return true
  // 独立成行的代码符号行
  if (/^(?:export|import|const|let|var|function|class|interface|type|declare|return)\s/u.test(trimmed)) return true
  if (/^[})\]]+[;,]+$/u.test(trimmed)) return true
  // 行号前缀（`  21 | import ...` 这类源码清单）
  if (/^\s*\d+\s*\|\s?/u.test(trimmed)) return true
  // 整行就是路径（盘符路径 / POSIX 路径 / 相对路径），没有说明文字
  if (/^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^\s]*$/u.test(trimmed) && trimmed.length >= 6) return true
  // 编译 / 测试 / 运行日志
  if (/\berror TS\d+/u.test(trimmed)) return true
  if (/^\s*at\s+[\w.$]+\s*\(/u.test(trimmed)) return true
  if (/^(?:ok|PASS|FAIL|SKIP)\b/u.test(trimmed) && /\d/u.test(trimmed)) return true
  if (/^(?:\$|>)\s+\S/u.test(trimmed)) return true
  if (/\b(?:npm|pnpm|yarn|npx|node|tsc|git|curl|cd)\s+[-\w./]/u.test(trimmed)) return true
  // 构建/测试耗时与收尾日志（+28ms Done in 1.2s 这类）
  if (/^\+\d+(?:\.\d+)?m?s\b/u.test(trimmed)) return true
  if (/\b(?:Done in|built in|took|compiled in)\s+\d/u.test(trimmed)) return true
  // 文件:行[:列] 片段（哪怕后面没有内容）
  if (/[A-Za-z0-9_./\\-]+\.\w{1,6}:\d+(?::\d+)?/u.test(trimmed)) return true
  // JSON / 数组行
  if (/^[{[]\s*["']?/u.test(trimmed) && /[}\]]\s*$/u.test(trimmed)) return true
  // 符号占比过高的一行（代码/表格/序列化片段）
  const symbols = (trimmed.match(/[{}()\[\];=<>|\\/]/g) ?? []).length
  if (trimmed.length >= 24 && symbols / trimmed.length > 0.18) return true
  return false
}

/**
 * 去掉机器产出行，只留下像人写的部分（标题/摘要候选的第一道过滤）。
 * 这是**逐行**判断：一段 file 输出里既有代码也有说明文字时，只保留说明文字。
 */
export function stripMachineLines(text: string): string {
  const kept = cleanText(text)
    .split(NEWLINE)
    .filter((line) => !looksLikeMachineLine(line))
  return kept.join(NEWLINE).trim()
}

/**
 * 判断一段文本是否以机器产出为主（字符占比），用于摘要质量评估。
 */
export function machineShareOf(text: string): number {
  const cleaned = cleanText(text)
  if (cleaned.length === 0) return 0
  const lines = cleaned.split(NEWLINE)
  let machine = 0
  for (const line of lines) {
    if (looksLikeMachineLine(line) || isRuntimeLine(line.trim())) machine += line.length
  }
  return machine / cleaned.length
}
/**
 * 判断一段文本是不是「路径堆」——例如一次 read_file 结果里的文件清单。
 * 摘要里出现这种句子对读者毫无意义（看不出发生了什么），因此在抽取阶段丢掉。
 */
export function looksLikePathHeavy(text: string): boolean {
  const winPath = ':' + String.fromCharCode(92)
  let hits = (text.split(':/').length - 1) + (text.split(winPath).length - 1)
  hits += text.split('/node_modules/').length - 1
  return hits >= 2
}
