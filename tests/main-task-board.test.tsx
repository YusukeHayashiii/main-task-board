import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fitTables } from '../hooks/tables'

const PLUGIN = 'main-task-board'
const TOOL = 'mcp__main-task-board__board'
const ROOT = '/work'
const T0 = Date.UTC(2026, 0, 15, 1, 3) // 日本時間で 2026-01-15 10:03

type World = {
  writes: Map<string, string>
  fills: string[]
  opened: string[]
  /** パネルを開くときに求めた高さ。求めなかったときは undefined。 */
  rows: (number | undefined)[]
  toasts: string[]
  /** 質問でモデルに渡した文。 */
  prompts: string[]
  /** 登録されたコマンドとツールの名前。 */
  registered: string[]
  /** 裏で起動したコマンド。 */
  ran: (readonly string[])[]
  advance: (ms: number) => Promise<void>
}

// taken: 別の mod が先に登録していて、登録が断られるコマンドの名前。
function world(
  on: On,
  answer = '結論: 文字列を数値に変える関数です。',
  checked = '',
  taken: readonly string[] = [],
): World {
  const clock = mock.clock(on, { now: T0 })
  const seen: World = {
    writes: new Map(),
    fills: [],
    opened: [],
    rows: [],
    toasts: [],
    prompts: [],
    registered: [],
    ran: [],
    advance: ms => clock.advance(ms),
  }
  mock.store(on)
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    if (taken.includes(e.name)) throw new Error(`"/${e.name}" refused: another plugin registered it already`)
    seen.registered.push(`/${e.name}`)

    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    seen.registered.push(e.name)

    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    seen.rows.push(e.rows)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)

    return { isFilled: true }
  })
  on('fs.read', ($, e) => {
    const found = seen.writes.get(e.path)

    return found === undefined ? { deny: `ENOENT: ${e.path}` } : { value: found }
  })
  on('fs.exists', ($, e) => ({ value: seen.writes.has(e.path) }))
  on('fs.write', ($, e) => {
    seen.writes.set(e.path, e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    seen.ran.push(e.argv)

    return {
      value: { exitCode: 0, stdout: checked, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('model.fork', ($, e) => {
    seen.prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: answer,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }
  })

  return seen
}

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: ROOT }
const VIEWPORT = { columns: 180, rows: 48, isFullscreen: true }
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  surface: 'terminal',
  requestId: PLUGIN,
  viewport: VIEWPORT,
  props: {
    title: PLUGIN,
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 44 },
    view: {},
  },
} as const
const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: VIEWPORT,
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const
const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

// /ask は回答を待たずに戻るので、裏の処理が進むまで待つ。
async function until(done: () => boolean | Promise<boolean>) {
  // テストの型には setTimeout が無いが、実行時にはある。
  const { setTimeout: later } = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }
  for (let i = 0; i < 200 && !(await done()); i += 1) await new Promise<void>(resolve => later(resolve, 1))
}

type Found = { find: (query: { type: 'Text'; text?: RegExp }) => Promise<{ text?: string } | undefined> }

// 見つからなかったときに、何を探していたかと、代わりに何が描かれていたかを返す。
async function shown(ui: Found, pattern: RegExp): Promise<string> {
  if ((await ui.find({ type: 'Text', text: pattern })) !== undefined) return ''

  return `${pattern.source} が無い。先頭の Text: ${(await ui.find({ type: 'Text' }))?.text ?? '(なし)'}`
}

async function hidden(ui: Found, pattern: RegExp): Promise<boolean> {
  return (await ui.find({ type: 'Text', text: pattern })) === undefined
}

test('セッションの始まり: 画面のある起動でだけ、コマンドとツールを足す', async ($, on) => {
  const seen = world(on)
  await $.session.start({ ...SESSION, isInteractive: false })
  expect(seen.registered).toEqual([])

  await $.session.start(SESSION)
  expect([...seen.registered].sort()).toEqual(['/ask', '/now', 'board'])
})

test('セッションの始まり: コマンドの名前が取られていても、ボードのツールは足す', async ($, on) => {
  // 別の mod が /now を先に登録しているとき、登録は断られる。
  const seen = world(on, undefined, '', ['now'])
  await $.session.start(SESSION)
  expect([...seen.registered].sort()).toEqual(['/ask', 'board'])

  await $.tool.call({ tool: TOOL, goal: '名前が取られていても動く' } as never)
  const ui = await $.ui.mount(PANE)
  expect(await shown(ui, /^名前が取られていても動く$/)).toBe('')
  await ui.unmount()
})

test('メインタスク: ツールで入れた内容が、入力欄の上とパネルに出る', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({
    tool: TOOL,
    goal: '#123 ログイン画面にパスワードの再設定を足す',
    now: 'レビュアーの承認を待っている',
    steps: ['調査', '実装', 'レビュー', 'マージ'],
    current: 2,
    decisions: [
      { id: '1', title: 'リンクの送り方', status: 'decided', answer: 'A: メールでリンクを送る' },
      { id: '2', title: 'リンクの期限', status: 'open' },
    ],
  } as never)
  // 2 回目は、渡した項目だけが変わる。
  await $.tool.call({ tool: TOOL, decisions: [{ id: '2', status: 'tentative', answer: '30 分' }] } as never)

  const band = await $.ui.mount(BAND)
  expect(await shown(band, /流れ 2\/4 実装/)).toBe('')
  expect(await shown(band, /決める 1\/2/)).toBe('')
  await band.unmount()

  const ui = await $.ui.mount(PANE)
  // タブは無く、メインタスクと質問が同じ画面に並ぶ。
  expect(await shown(ui, /^ メインタスク $/)).toBe('')
  expect(await shown(ui, /^ 質問 $/)).toBe('')
  expect((await ui.find({ key: 'tab-note' })) === undefined).toBe(true)
  expect(await shown(ui, /#123 ログイン画面/)).toBe('')
  expect(await shown(ui, /A: メールでリンクを送る/)).toBe('')
  expect(await shown(ui, /リンクの期限\(仮決め\)/)).toBe('')
  // 全体の流れ: 済んだ手順は消さずにチェックを付け、いまの手順の下に補足を出す。
  expect(await shown(ui, /1\/4 済み/)).toBe('')
  expect(await shown(ui, /✓ 1\. 調査/)).toBe('')
  expect(await shown(ui, /▶ 2\. 実装.*← いまここ/)).toBe('')
  expect(await shown(ui, /□ 3\. レビュー/)).toBe('')
  expect(await shown(ui, /^\s+レビュアーの承認を待っている$/)).toBe('')

  // 手順が進んだら、番号だけを渡す。前の手順が済みになる。
  await $.tool.call({ tool: TOOL, current: 4, now: '' } as never)
  expect(await shown(ui, /3\/4 済み/)).toBe('')
  expect(await shown(ui, /▶ 4\. マージ/)).toBe('')
  // 全部終わったら、手順の数 + 1 を渡す。
  await $.tool.call({ tool: TOOL, current: 5 } as never)
  expect(await shown(ui, /4\/4 済み/)).toBe('')
  expect(await hidden(ui, /▶/)).toBe(true)

  // reset で、別の作業に入れ直す。
  await $.tool.call({ tool: TOOL, reset: true, goal: '別の作業' } as never)
  expect(await shown(ui, /^別の作業$/)).toBe('')
  expect(await hidden(ui, /全体の流れ/)).toBe(true)
  await ui.unmount()
})

test('パネル: ターミナルの通常の表示でだけ、横に出す方法を案内する', async ($, on) => {
  world(on)
  await $.session.start(SESSION)

  const docked = await $.ui.mount(PANE)
  expect(await hidden(docked, /"tui": "fullscreen"/)).toBe(true)
  await docked.unmount()

  const inline = await $.ui.mount({
    ...PANE,
    viewport: { ...VIEWPORT, isFullscreen: false },
    props: { ...PANE.props, placement: 'inline' },
  })
  expect(await shown(inline, /横に出すには.*"tui": "fullscreen"/)).toBe('')
  await inline.unmount()
})

test('パネル: 通常の表示では勝手に開かず、開くときは中身が収まる高さを求める', async ($, on) => {
  const seen = world(on)
  await $.session.start(SESSION)
  const band = await $.ui.mount({ ...BAND, viewport: { ...VIEWPORT, isFullscreen: false } })

  await $.tool.call({ tool: TOOL, goal: '検索を足す', steps: ['調査', '実装'], current: 1 } as never)
  expect(seen.opened).toEqual([])

  await $.command.run({ ...command('now'), presentation: { isFullscreen: false, columns: 180 } })
  expect(seen.opened).toEqual([PLUGIN])
  expect((seen.rows[0] ?? 0) > 10).toBe(true)
  await band.unmount()
})

test('パネル: 全画面の表示では、初めて中身が入ったら開き、高さは求めない', async ($, on) => {
  const seen = world(on)
  await $.session.start(SESSION)
  const band = await $.ui.mount(BAND)

  await $.tool.call({ tool: TOOL, goal: '検索を足す', steps: ['調査', '実装'], current: 1 } as never)
  await until(() => seen.opened.length > 0)
  expect(seen.opened).toEqual([PLUGIN])
  expect(seen.rows).toEqual([undefined])
  await band.unmount()
})

test('質問: 回答がパネルに出る。既定では、ファイルを作らず、別のセッションも起動しない', async ($, on) => {
  const seen = world(on, '結論: 文字列を数値に変える関数です。\n\n原文で確かめること: parseInt の基数')
  await $.session.start(SESSION)
  const ran = await $.command.run(command('ask', 'parseInt とは何ですか'))
  expect(ran.text).toBe(undefined)
  expect(seen.opened).toEqual([PLUGIN])
  await until(() => seen.toasts.length === 1)

  const ui = await $.ui.mount(PANE)
  expect(await shown(ui, /^parseInt とは何ですか$/)).toBe('')
  expect((await ui.find({ type: 'Markdown' })) !== undefined).toBe(true)
  expect(await shown(ui, /これまでの質問/)).toBe('')

  // 既定の指示には、読む人の説明も、原文の確認を求める行も入らない。
  expect(seen.prompts[0]?.includes('質問: parseInt とは何ですか')).toBe(true)
  expect(seen.prompts[0]?.includes('読む人について')).toBe(false)
  expect(seen.prompts[0]?.includes('原文で確かめること')).toBe(false)
  // 回答が確認を求める行を書いても、既定では別のセッションを起動しない。
  expect(seen.ran.length).toBe(0)
  expect(await hidden(ui, /Web で原文を確かめています/)).toBe(true)
  // 既定では、質問ログのファイルを作らない。
  expect(seen.writes.size).toBe(0)

  await ui.press({ key: `to-main:${T0}` })
  expect(seen.fills[0]?.includes('質問: parseInt とは何ですか')).toBe(true)
  await ui.unmount()
})

test('質問: 続けて聞くと、前のやり取りがモデルに渡り、最初の質問の下に並ぶ', async ($, on) => {
  const seen = world(on)
  await $.session.start(SESSION)
  await $.command.run(command('ask', 'parseInt とは何ですか'))

  const ui = await $.ui.mount(PANE)
  await until(() => seen.toasts.length === 1)
  await seen.advance(60_000)
  await ui.input({ key: `reply:${T0}`, text: 'それは小数も扱えますか' })
  await until(() => seen.toasts.length === 2)

  expect(seen.prompts[0]?.includes('これまでのやり取り')).toBe(false)
  expect(seen.prompts[1]?.includes('質問: parseInt とは何ですか\n回答: 結論: 文字列を数値に変える関数です。')).toBe(true)

  expect(await shown(ui, /^続けて聞いた質問\(1\)$/)).toBe('')
  expect(await shown(ui, /^それは小数も扱えますか$/)).toBe('')
  expect((await ui.find({ key: `a:${T0}` })) !== undefined).toBe(true)
  expect((await ui.find({ key: `a:${T0 + 60_000}` })) === undefined).toBe(true)
  await ui.unmount()
})

test(
  '設定: 読む人の説明と質問ログのフォルダを入れると、指示に入り、ファイルに追記される',
  { options: { reader: 'SQL は書ける。フロントエンドには慣れていない', askLogDir: 'notes/questions' } },
  async ($, on) => {
    const seen = world(on)
    await $.session.start(SESSION)
    await $.command.run(command('ask', 'parseInt とは何ですか'))
    const path = `${ROOT}/notes/questions/260115_質問ログ.md`
    await until(() => seen.writes.has(path))

    expect(seen.prompts[0]?.includes('読む人について: SQL は書ける。フロントエンドには慣れていない')).toBe(true)
    const log = seen.writes.get(path) ?? ''
    expect(log.startsWith('# 質問ログ(2026-01-15)')).toBe(true)
    expect(log.includes('## 10:03 parseInt とは何ですか\n\n<!-- session: session-1 -->')).toBe(true)
    expect(log.includes('結論: 文字列を数値に変える関数です。')).toBe(true)
  },
)

test(
  '設定: 原文の確認をオンにすると、別のセッションで調べた回答に置き換わる',
  { options: { webCheck: true, askLogDir: '/logs' } },
  async ($, on) => {
    const seen = world(
      on,
      '結論: 基数を省くと 10 進数として読む。\n\n原文で確かめること: parseInt の基数',
      '**確かめた回答**\n\n基数を省くと、先頭の文字で決まる。\n\n> If radix is undefined\n\n**出典**: parseInt\n',
    )
    await $.session.start(SESSION)
    await $.command.run(command('ask', 'parseInt の基数を省くとどうなりますか'))
    const path = '/logs/260115_質問ログ.md'
    await until(() => (seen.writes.get(path) ?? '').includes('### 原文の確認'))

    expect(seen.prompts[0]?.includes('原文で確かめること')).toBe(true)
    // Web の検索と取得だけを許した claude -p を起動する。
    expect(seen.ran.length).toBe(1)
    expect(seen.ran[0]?.slice(0, 2).join(' ')).toBe('claude -p')
    expect(seen.ran[0]?.[2]?.includes('確かめること: parseInt の基数')).toBe(true)
    expect(seen.ran[0]?.join(' ').includes('--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch')).toBe(true)

    const ui = await $.ui.mount(PANE)
    expect(await shown(ui, /原文で確かめた回答\(確かめたこと: parseInt の基数\)/)).toBe('')
    const texts = async () => (await ui.findAll({ type: 'Markdown' })).map(one => one.text ?? '')
    expect((await texts()).join('|').includes('If radix is undefined')).toBe(true)
    expect((await texts()).join('|').includes('10 進数として読む')).toBe(false)
    await ui.press({ key: `first-answer:${T0}` })
    expect((await texts()).join('|').includes('10 進数として読む')).toBe(true)
    await ui.unmount()
    expect(seen.toasts.length).toBe(2)
  },
)

test('表: 幅に収まらない表だけを、行ごとの箇条書きに直す', async () => {
  const small = '| a | b |\n|---|---|\n| 1 | 2 |'
  expect(fitTables(small, 70)).toBe(small)

  const wide = `| 案 | 帰結 |\n|---|---|\n| A | ${'長い説明'.repeat(12)} |`
  const fitted = fitTables(wide, 40)
  expect(fitted.includes('|')).toBe(false)
  expect(fitted.includes('- **案: A**')).toBe(true)
  expect(fitted.includes('  - 帰結: 長い説明')).toBe(true)

  // コードの中の表はそのままにする。
  const fenced = `\`\`\`\n${wide}\n\`\`\``
  expect(fitTables(fenced, 40)).toBe(fenced)
})
