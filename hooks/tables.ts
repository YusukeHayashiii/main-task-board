// Markdown の表を、パネルの幅に合わせて描き直す。

const FENCE = /^\s*(```|~~~)/

// ---------- 表をパネルの幅に合わせる ----------

// 画面での幅。全角の文字は 2 と数える。
export function displayWidth(text: string): number {
  let width = 0

  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at)
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)

    width += isWide ? 2 : 1
  }

  return width
}

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')

  return inner.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

// 罫線つきで描いたときの幅。列ごとの最大の幅に、余白と罫線を足す。
function tableWidth(rows: readonly string[][]): number {
  const count = Math.max(...rows.map(row => row.length))
  let total = 1

  for (let column = 0; column < count; column += 1) {
    const widest = Math.max(
      ...rows.map(row => displayWidth((row[column] ?? '').replace(/\*\*|`/g, ''))),
    )
    total += widest + 3
  }

  return total
}

function tableAsList(head: readonly string[], body: readonly string[][]): string[] {
  const lines: string[] = []

  for (const row of body) {
    const first = row[0] ?? ''
    const label = (head[0] ?? '') === '' ? first : `${head[0]}: ${first}`
    lines.push(`- **${label}**`)

    for (let column = 1; column < Math.max(head.length, row.length); column += 1) {
      const cell = row[column] ?? ''
      if (cell === '') continue
      const name = head[column] ?? ''
      lines.push(name === '' ? `  - ${cell}` : `  - ${name}: ${cell}`)
    }
  }

  return lines
}

// Markdown の表のうち、罫線つきで描くと columns に収まらないものを、行ごとの箇条書きに直す。
// パネルの Markdown は表を中身の幅のまま描くので、収まらない表は罫線が折り返して崩れる。
// 収まる表と、コードの中の表はそのまま返す。
export function fitTables(text: string, columns: number): string {
  if (columns <= 0) return text

  const lines = text.split('\n')
  const out: string[] = []
  let isFenced = false
  let at = 0

  while (at < lines.length) {
    const line = lines[at] ?? ''

    if (FENCE.test(line)) {
      isFenced = !isFenced
      out.push(line)
      at += 1
      continue
    }

    const rule = lines[at + 1] ?? ''
    const isTable =
      !isFenced && line.includes('|') && rule.includes('-') && rule.includes('|') && TABLE_RULE.test(rule)

    if (!isTable) {
      out.push(line)
      at += 1
      continue
    }

    let end = at + 2
    while (end < lines.length && (lines[end] ?? '').trim() !== '' && (lines[end] ?? '').includes('|')) {
      end += 1
    }

    const head = splitRow(line)
    const body = lines.slice(at + 2, end).map(splitRow)

    if (tableWidth([head, ...body]) <= columns) {
      out.push(...lines.slice(at, end))
    } else {
      if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') out.push('')
      out.push(...tableAsList(head, body))
      if ((lines[end] ?? '').trim() !== '') out.push('')
    }

    at = end
  }

  return out.join('\n')
}
