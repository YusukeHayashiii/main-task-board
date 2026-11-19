import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register } from 'claude-code'

import type { Ask, AskView, Board, Decision, DecisionStatus, Step } from '../types'
import { fitTables } from './tables'

const PLUGIN = 'main-task-board'
const TOOL = `mcp__${PLUGIN}__board`
const PANE = 'main-task-board'
const PANE_TITLE = 'メインタスク・質問'
const JST_MS = 9 * 60 * 60 * 1000
// 質問の回答を Web の原文で確かめる、別セッション(claude -p)の設定。設定でオンにしたときだけ使う。
const CHECK_TOOLS = 'WebSearch,WebFetch'
const CHECK_TIMEOUT_MS = 5 * 60 * 1000
const CHECK_MARK = /^[\s\-*]*原文で確かめること[::]\s*(.+)$/m
const READER = '読む人は、この分野に詳しくないかもしれない。専門家向けの説明にしない'

function checkerPrompt(reader: string): string {
  return `あなたは、質問への回答を公式ドキュメントなどの原文で確かめ、確かめた内容で回答を書き直す係です。使えるのは Web の検索と取得だけです。

読む人は、あなたの返答だけを読みます。最初の回答は読み返しません。返答だけで質問の答えが分かるように書いてください。

調べ方:

- 「確かめること」に書かれた点を調べる。話を広げない
- 公式ドキュメントなどの一次情報を優先する。検索結果の要約ではなく、ページを取得して原文を読む
- 原文を取得できなかった点は、推測で埋めない

返答は日本語で、次の 3 つをこの順に書く。1 文字目から「**確かめた回答**」で始め、前置き(「調べ終えたので」など)やまとめは書かない。

1. **確かめた回答**
   - 質問への答えを、最初から書き直す。最初に結論を 1〜2 文で書き、そのあとに要る説明だけを 3 行以内で足す。聞かれていないこと(関連する仕組み、注意点、使い分け)には広げない
   - 原文で確かめられた内容は、原文に合わせて書く。最初の回答が原文と違っていた点は、正しい内容を書いたうえで、行の終わりに「(最初の回答から訂正)」と付ける
   - 最初の回答のうち、今回確かめていない内容で質問の答えに要るものは残し、行の終わりに「(未確認)」と付ける
   - 原文を取得できなかった点は「原文を取得できなかった」と書き、試した検索語か URL を添える
2. **原文**: 根拠にした文を、原文のまま引用(> で始める)。英語なら、下に日本語の訳を添える。どの内容の根拠かが分かるように並べる
3. **出典**: ページの題名と URL

書き方:

- 見出し(# で始まる行)は使わない。区切りは太字と箇条書きで書く
- ${READER}。専門用語は、使う前にふつうの言葉で言い換える${reader === '' ? '' : `\n- 読む人について: ${reader}`}
- 最初の回答が長くても、長さを引き継がない`
}

const EMPTY_BOARD: Board = { goal: '', now: '', steps: [], decisions: [], updatedAt: 0 }
const EMPTY_ASKS: AskView = { list: [], openId: '', isAllShown: false }

// 形を変えたら shape を変える。リロードをまたいで残る古い値を読まないため。
const board = atom({ plugin: 'main-task-board', key: 'board' } as const, EMPTY_BOARD, {
  shape: 'board-1',
})
const asks = atom({ plugin: 'main-task-board', key: 'asks' } as const, EMPTY_ASKS, {
  shape: 'asks-1',
})

const STATUS_MARK: Record<DecisionStatus, string> = {
  decided: '✓',
  tentative: '△',
  waiting: '…',
  open: '□',
}
const STATUS_WORD: Record<DecisionStatus, string> = {
  decided: '決定',
  tentative: '仮決め',
  waiting: '返事待ち',
  open: '未決',
}
const STEP_MARK: Record<Step['status'], string> = { done: '✓', now: '▶', todo: '□' }

const BOARD_SECTION = `# メインタスクのボード(main-task-board mod)

質問のやり取りが続くと、決めることや作業の現在地が画面の上に流れてしまう。そこで mod が「メインタスクのボード」を入力欄の上とチャットの横に固定表示している。ユーザーはボードを見て現在地を確かめるので、実態とずれたままにしない。ボードは ${TOOL} ツールで更新する。

- 作業の目的が分かったら goal を入れる(例: 「#123 ログイン画面にパスワードの再設定を足す」)。別の作業に切り替わったら reset: true で入れ直す
- 作業の進め方が見えたら、steps に全体の流れを最初から最後まで順番どおりに入れる(済んだ手順も含める。レビュー、マージ、デプロイなど、何がきっかけで進むかが分かる形で書く)。ユーザーはこの一覧で、全体のどこにいるかを見る。済んだ手順は消さない(画面ではチェックが付き、字が薄くなる)
- 手順が進んだら、その返答の中で current にいまの手順の番号を渡す(前の手順が済みになる)。全部終わったら、手順の数 + 1 を渡す。流れそのものが変わったら steps を入れ直し、current も渡す
- now は、いまの手順に補足があるときだけ 1 行で書く(いまの手順の下に出る)。ユーザーや他の人の作業待ちなら、誰の何を待っているかを書く(例: 「レビュアーの承認を待っている」)。補足が無くなったら空文字を渡して消す
- 決めることの一覧をユーザーに示したら、同じ返答の中で decisions に全件を入れる。id は一覧の番号と同じにする
- 決まった、仮決めした、誰かの返事待ちになったときは、その返答の中で status と answer を更新する。answer は「A: メールでリンクを送る」のように、選んだ案の中身まで書く
- 理解のための質問に答えるだけの返答では、メインタスクが動いていなければ更新しなくてよい
- ボードの更新を返答の本文で報告する必要はない(画面に出ている)

ユーザーが /ask やパネルの入力欄で聞いた質問と回答は、横のパネルにだけ出て、この会話には残らない。ユーザーがその内容に触れたら、覚えているふりをせず、質問を言い直してもらう。`

type Options = { reader: string; askLogDir: string; webCheck: boolean }

let config: Options = { reader: '', askLogDir: '', webCheck: false }
let logChain: Promise<void> = Promise.resolve()
// 動いている確認の質問の id。読み込み直すと消える。
const checking = new Set<string>()

function clean(value: unknown, limit = 300): string {
  if (typeof value !== 'string') return ''
  const one = value.replace(/\s+/g, ' ').trim()

  return one.length > limit ? `${one.slice(0, limit)}…` : one
}

function isStatus(value: unknown): value is DecisionStatus {
  return value === 'open' || value === 'tentative' || value === 'decided' || value === 'waiting'
}

function progress(current: Board): { done: number; total: number; focus: Decision | undefined } {
  const total = current.decisions.length
  const done = current.decisions.filter(one => one.status === 'decided').length
  const focus =
    current.decisions.find(one => one.status === 'open') ??
    current.decisions.find(one => one.status === 'tentative') ??
    current.decisions.find(one => one.status === 'waiting')

  return { done, total, focus }
}

/** 全体の流れのうち、いまの手順(無ければ、まだ終わっていない最初の手順。全部済みなら -1)と、済んだ数。 */
function flow(current: Board): { done: number; total: number; at: number } {
  const total = current.steps.length
  const done = current.steps.filter(one => one.status === 'done').length
  const now = current.steps.findIndex(one => one.status === 'now')

  return { done, total, at: now >= 0 ? now : current.steps.findIndex(one => one.status === 'todo') }
}

function toSteps(list: readonly unknown[]): Step[] {
  return list
    .map((raw): Step => {
      const item = (typeof raw === 'object' && raw !== null ? raw : { title: raw }) as Record<string, unknown>
      const status = item.status

      return { title: clean(item.title, 120), status: status === 'done' || status === 'now' ? status : 'todo' }
    })
    .filter(one => one.title !== '')
    .slice(0, 20)
}

function isEmpty(current: Board): boolean {
  return (
    current.goal === '' && current.now === '' && current.steps.length === 0 && current.decisions.length === 0
  )
}

function boardAsText(current: Board): string {
  const lines: string[] = []
  if (current.goal) lines.push(`メインタスク: ${current.goal}`)
  if (current.steps.length > 0) {
    const { at } = flow(current)
    lines.push('全体の流れ:')
    current.steps.forEach((one, i) =>
      lines.push(
        `${STEP_MARK[i === at ? 'now' : one.status]} ${i + 1}. ${one.title}${i === at ? ' ← いまここ' : ''}${i === at && current.now ? `(${current.now})` : ''}`,
      ),
    )
  } else if (current.now) lines.push(`いま: ${current.now}`)
  if (current.decisions.length > 0) {
    lines.push('決めること:')
    for (const one of current.decisions) {
      const answer = one.answer ? ` → ${one.answer}` : ''
      const extra = one.note ? `(${one.note})` : ''
      lines.push(`- ${one.id}. ${one.title} [${STATUS_WORD[one.status]}]${answer}${extra}`)
    }
  }

  return lines.join('\n')
}

function applyBoard(current: Board, input: Record<string, unknown>, now: number): Board {
  const base = input.reset === true ? EMPTY_BOARD : current
  const next: Board = { ...base, steps: [...base.steps], decisions: [...base.decisions], updatedAt: now }

  if (typeof input.goal === 'string') next.goal = clean(input.goal)
  if (typeof input.now === 'string') next.now = clean(input.now)
  if (Array.isArray(input.steps)) next.steps = toSteps(input.steps)
  // current: いまの手順の番号(1 始まり)。前の手順を済みに、後ろの手順をこれからにする。全部終わったら、手順の数 + 1 を渡す。
  if (typeof input.current === 'number' && Number.isFinite(input.current)) {
    const at = Math.round(input.current) - 1
    next.steps = next.steps.map((one, i) => ({ ...one, status: i < at ? 'done' : i === at ? 'now' : 'todo' }))
  }
  if (Array.isArray(input.remove)) {
    const gone = new Set(input.remove.map(id => String(id)))
    next.decisions = next.decisions.filter(one => !gone.has(one.id))
  }
  if (Array.isArray(input.decisions)) {
    for (const raw of input.decisions) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const id = clean(String(item.id ?? ''), 20)
      if (id === '') continue
      const at = next.decisions.findIndex(one => one.id === id)
      const before = at >= 0 ? next.decisions[at] : undefined
      const merged: Decision = {
        id,
        title: typeof item.title === 'string' ? clean(item.title) : (before?.title ?? ''),
        status: isStatus(item.status) ? item.status : (before?.status ?? 'open'),
        answer: typeof item.answer === 'string' ? clean(item.answer) : (before?.answer ?? ''),
        note: typeof item.note === 'string' ? clean(item.note) : (before?.note ?? ''),
      }
      if (at >= 0) next.decisions[at] = merged
      else next.decisions.push(merged)
    }
    next.decisions = next.decisions.slice(0, 30)
  }

  return next
}

/** 保存してあったボードを、いまの形に合わせて読む。形が合わなければ undefined。 */
function restore(saved: unknown): Board | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined
  const one = saved as Partial<Board>
  if (typeof one.goal !== 'string' || !Array.isArray(one.decisions)) return undefined

  return {
    goal: one.goal,
    now: typeof one.now === 'string' ? one.now : '',
    steps: Array.isArray(one.steps) ? one.steps : [],
    decisions: one.decisions,
    updatedAt: typeof one.updatedAt === 'number' ? one.updatedAt : 0,
  }
}

function stampJst(now: number): { ymd: string; yymmdd: string; hm: string } {
  const iso = new Date(now + JST_MS).toISOString()

  return { ymd: iso.slice(0, 10), yymmdd: iso.slice(2, 10).replace(/-/g, ''), hm: iso.slice(11, 16) }
}

// 同じ名前のコマンドを別の mod が先に登録していると、登録は断られる。
// そのコマンドだけを諦めて、ボードとパネルは動かす(パネルは入力欄の上のボタンから開ける)。
async function addCommand($: EngineInterface, command: Parameters<EngineInterface['command']['register']>[0]) {
  try {
    await $.command.register(command)
  } catch {
    // 名前が取られている。
  }
}

// ターミナルの表示のしかた。描くたびに画面から受け取る。分かるまでは undefined。
// 通常の表示(全画面でない)では、パネルは入力欄の上に出て、中をスクロールできない。
let isFullscreen: boolean | undefined

function noteLayout(surface: string, viewport: { isFullscreen?: boolean } | undefined) {
  if (surface === 'terminal' && viewport?.isFullscreen !== undefined) isFullscreen = viewport.isFullscreen
}

// 通常の表示で、パネルの中身が収まる高さの見積もり。折り返しの分を足して多めに取る。
// 画面に入りきらない分は Claude Code が削るので、多すぎても困らない。
function paneRows(current: Board, view: AskView): number {
  const hint = 3
  const main = isEmpty(current)
    ? 1 + 3
    : 1 +
      1 +
      (current.steps.length > 0 ? 2 + current.steps.length + (current.now !== '' ? 1 : 0) : current.now !== '' ? 2 : 0) +
      (current.decisions.length > 0
        ? 2 +
          current.decisions.reduce((sum, one) => sum + 1 + (one.answer !== '' ? 1 : 0) + (one.note !== '' ? 1 : 0), 0)
        : 0) +
      2
  const roots = view.list.filter(one => one.parentId === undefined).length
  const questions = 3 + 5 + (roots === 0 ? 6 : Math.min(roots, 3) + 2 + 16)
  return Math.ceil((hint + main + questions) * 1.2)
}

async function showPane($: EngineInterface, isFocused = false) {
  const pane: PaneOpenArgs = isFocused ? { id: PANE, title: PANE_TITLE, focus: true } : { id: PANE, title: PANE_TITLE }
  if (isFullscreen !== false) return $.ui.open(pane)

  return $.ui.open({ ...pane, rows: paneRows(await read($, board), await read($, asks)) })
}

// ---------- 質問 ----------

// 質問ログは、設定でフォルダを指定したときだけ書く。入れただけではファイルを作らない。
function appendLog($: EngineInterface, entry: Ask, part: 'answer' | 'check' = 'answer') {
  if (config.askLogDir === '') return
  // 続けて聞いたときに、読み書きが重ならないように 1 件ずつ書く。
  logChain = logChain
    .then(async () => {
      const dir = config.askLogDir.startsWith('/')
        ? config.askLogDir
        : `${(await $.session.root()).replace(/\/+$/, '')}/${config.askLogDir}`
      const { ymd, yymmdd, hm } = stampJst(entry.at)
      const path = `${dir}/${yymmdd}_質問ログ.md`
      const before = (await $.fs.exists(path))
        ? await $.fs.read(path)
        : [
            `# 質問ログ(${ymd})`,
            '',
            'main-task-board mod の `/ask` で聞いた質問と回答。回答はツールを使わずに、その時点の会話だけから書かれている。「原文の確認」という見出しの節は、回答のあとに別の問い合わせが Web で原文を調べ、回答を書き直したもの。最初の回答と食い違う点は、「原文の確認」の節が正しい。',
            '',
          ].join('\n')
      const title = `${entry.parentId !== undefined ? '(続き) ' : ''}${entry.q.replace(/\s+/g, ' ').slice(0, 80)}`
      // どのセッションの質問かを見分けるための印。Markdown の表示には出ない。
      const mark = `<!-- session: ${await $.session.id()} -->`
      const block =
        part === 'answer'
          ? `\n## ${hm} ${title}\n\n${mark}\n\n質問: ${entry.q}\n\n${entry.a}\n`
          : `\n### 原文の確認(${hm} の質問: ${title})\n\n${mark}\n\n上の最初の回答を、原文で確かめて書き直したもの。食い違う点は、こちらが正しい。\n\n確かめたこと: ${entry.check?.what ?? ''}\n\n${entry.check?.text ?? ''}\n`
      await $.fs.write(path, `${before.replace(/\n+$/, '\n')}${block}`)
    })
    .catch(() => undefined)
}

/** 最初の質問とその続きを、聞いた順に並べる。 */
function threadOf(list: Ask[], rootId: string): Ask[] {
  return list.filter(one => one.id === rootId || one.parentId === rootId).sort((x, y) => x.at - y.at)
}

/** 回答として読む本文。原文で確かめた回答があれば、そちらを使う。 */
function finalAnswer(one: Ask): string {
  return one.check?.state === 'done' ? one.check.text : one.a
}

// 続けて聞くときに、モデルへ渡すこれまでのやり取り。質問はメインの会話に残らないので、ここで渡さないと前の質問を知らない。
async function historyOf($: EngineInterface, rootId: string, beforeAt: number): Promise<string> {
  const view = await read($, asks)

  return threadOf(view.list, rootId)
    .filter(one => one.at < beforeAt && one.status === 'done')
    .map(one => `質問: ${one.q}\n回答: ${finalAnswer(one)}`)
    .join('\n\n')
}

async function setCheck($: EngineInterface, id: string, check: NonNullable<Ask['check']>) {
  let changed: Ask | undefined
  await update($, asks, view => ({
    ...view,
    list: view.list.map(one => {
      if (one.id !== id) return one
      changed = { ...one, check }

      return changed
    }),
  }))

  return changed
}

// 回答が「原文で確かめること」を挙げたときに、Web の検索と取得だけを許した別セッション(claude -p)を裏で動かす。
// サブエージェントにすると、報告がメインの会話に入り込むので使わない。
async function startCheck($: EngineInterface, entry: Ask, what: string, history: string) {
  const prompt = [
    '次の質問への「最初の回答」は、ツールを使わずに書かれたものです。「確かめること」を Web の原文で確かめてください。',
    '',
    history === '' ? '' : `この質問は、次のやり取りに続けて聞かれたものです。\n\n${history}\n`,
    `質問: ${entry.q}`,
    '',
    `確かめること: ${what}`,
    '',
    '最初の回答:',
    entry.a,
  ].join('\n')
  let text = ''
  let reason = ''
  checking.add(entry.id)
  try {
    const ran = await $.process.run(
      [
        'claude',
        '-p',
        prompt,
        '--append-system-prompt',
        checkerPrompt(config.reader),
        '--tools',
        CHECK_TOOLS,
        '--allowedTools',
        CHECK_TOOLS,
        '--no-session-persistence',
      ],
      { cwd: await $.session.root(), timeoutMs: CHECK_TIMEOUT_MS },
    )
    text = ran.stdout.trim()
    if (ran.exitCode !== 0) reason = `終了コード ${ran.exitCode}: ${(ran.stderr.trim() || text).slice(0, 200)}`
    else if (text === '') reason = '回答が空だった'
  } catch (error) {
    reason = error instanceof Error ? error.message.slice(0, 200) : 'エラー'
  }
  checking.delete(entry.id)
  const changed = await setCheck(
    $,
    entry.id,
    reason === ''
      ? { state: 'done', what, text }
      : { state: 'error', what, text: `原文の確認が終わらなかった(${reason})。` },
  )
  if (reason === '' && changed !== undefined) {
    appendLog($, changed, 'check')
    $.ui.toast('質問に、原文の確認が届いた')
  }
}

async function ask($: EngineInterface, question: string, parentId?: string) {
  const q = question.trim()
  if (q === '') return
  const at = await $.clock.now()
  const id = String(at)
  const history = parentId === undefined ? '' : await historyOf($, parentId, at)

  const entry: Ask = { id, q, a: '', status: 'pending', at, ...(parentId !== undefined && { parentId }) }
  // 続きも 1 件と数えるので、最初の質問だけで 30 件ほど残るよう、上限を広めにとる。
  await update($, asks, view => ({ ...view, list: [entry, ...view.list].slice(0, 80), openId: parentId ?? id }))

  const prompt = [
    '[脇道の質問] メインタスクの作業を止めずに聞く、理解のための質問です。この回答は横のパネルにだけ表示され、メインの会話には残りません。',
    '',
    '- ツールは使えません。考え込まず、これまでの会話だけを根拠に、すぐ答えてください',
    `- ${READER}`,
    ...(config.reader === '' ? [] : [`- 読む人について: ${config.reader}`]),
    '- 聞かれたことだけに答える。最初に結論を 1〜2 文で書き、そのあとに要る説明を 3 行以内で足す。全体で 5 行ほどに収める',
    '- 聞かれていないこと(関連する仕組み、注意点、使い分け、コード例)には広げない。もっと知りたければ、続けて聞いてもらえる',
    '- 専門用語は、使う前にふつうの言葉で言い換える',
    '- 確かめていない内容は「未確認」と明記し、言い切らない',
    ...(config.webCheck
      ? [
          '- 公式ドキュメントなど Web の原文で確かめる必要があれば、最後に「原文で確かめること: 〜」と 1 行で書く。この行があると、mod が裏で Web を調べて、確かめた内容で回答を書き直す。製品の仕様や挙動を言い切るときは書く。この mod の使い方や、会話の内容を聞かれただけなら書かない',
        ]
      : []),
    '- リポジトリのファイルやデータを読まないと確かめられないことは、最後に「メインの会話で確かめること: 〜」と 1 行で書く',
    '- メインタスクの決めることが変わるときだけ、最後に「メインタスクへの影響: 〜」と 1 行で書く',
    '',
    history === ''
      ? ''
      : `これは、下の脇道のやり取りに続けて聞いた質問です。「それ」「さっきの」などは、このやり取りを指します。\n\nこれまでのやり取り:\n\n${history}\n`,
    `質問: ${q}`,
  ].join('\n')

  let answer = ''
  let status: Ask['status'] = 'done'
  try {
    let result = await $.model.fork({ prompt })
    if (!result.isAnswered && result.reason === 'nothing-to-fork') {
      // まだ会話が無いときは、会話の文脈なしで答える。
      result = await $.model.complete({ model: await $.session.model(), prompt })
    }
    if (result.isAnswered) {
      answer = result.text.trim()
    } else {
      status = 'error'
      answer = `回答を取れなかった(${result.reason})。もう一度聞くか、メインの会話で聞いてください。`
    }
  } catch (error) {
    status = 'error'
    answer = `回答を取れなかった(${error instanceof Error ? error.message.slice(0, 200) : 'エラー'})。`
  }

  const what = status === 'done' && config.webCheck ? (CHECK_MARK.exec(answer)?.[1]?.trim() ?? '') : ''
  const done: Ask = {
    ...entry,
    a: answer,
    status,
    ...(what !== '' && { check: { state: 'running' as const, what, text: '' } }),
  }
  await update($, asks, view => ({ ...view, list: view.list.map(one => (one.id === id ? done : one)) }))
  if (status === 'done') {
    appendLog($, done)
    $.ui.toast(what === '' ? '質問に回答が届いた' : '質問に回答が届いた。原文を Web で確かめている')
  }
  if (what !== '') await startCheck($, done, what, history)
}

export const register: Register = (on, options) => {
  config = {
    reader: clean(options.reader, 300),
    askLogDir: clean(options.askLogDir, 400).replace(/\/+$/, ''),
    webCheck: options.webCheck === true,
  }

  // ---------- セッションの始まりと終わり ----------

  on('session.start', async ($, e, next) => {
    // 画面の無い起動(claude -p)には、コマンドもツールも足さない。ボードを見る人がいないため。
    if (!e.isInteractive) return next(e)

    await addCommand($, {
      name: 'now',
      description: 'メインタスクの現在地(目的、全体の流れ、決めること)をパネルに出す',
      immediate: true,
    })
    await addCommand($, {
      name: 'ask',
      description: 'メインタスクを止めずに質問する。回答は横のパネルに出て、会話には残らない',
      argumentHint: '[質問]',
      immediate: true,
    })
    // 読み込み直すと、動いていた確認は結果を返せない。途中だったものは途切れたと表示する。
    await update($, asks, view => ({
      ...view,
      list: view.list.map(one =>
        one.check?.state === 'running' && !checking.has(one.id)
          ? { ...one, check: { ...one.check, state: 'error' as const, text: '原文の確認が途中で途切れた。' } }
          : one,
      ),
    }))
    await $.tool.register({
      name: 'board',
      description:
        'メインタスクのボード(ユーザーの画面に固定表示される、作業の現在地)を更新する。渡した項目だけが変わる。decisions は id で上書きまたは追加される。',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'メインタスクの目的を 1 行で。Issue 番号があれば先頭に書く' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description:
              '全体の流れ。最初から最後までの手順を順番どおりに(済んだ手順も含める)。渡すと全部を置き換えるので、current も一緒に渡す',
          },
          current: {
            type: 'number',
            description:
              'いまの手順の番号(1 始まり)。渡すと、前の手順が済み、後ろの手順がこれからになる。全部終わったら、手順の数 + 1',
          },
          now: {
            type: 'string',
            description:
              'いまの手順への補足(いまの手順の下に出る)。誰かの作業待ちなら、誰の何を待っているか。無ければ空文字',
          },
          decisions: {
            type: 'array',
            description: '決めること。id が同じものは上書き、無いものは追加',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'ユーザーに示した一覧の番号' },
                title: { type: 'string', description: '何を決めるのか' },
                status: {
                  type: 'string',
                  enum: ['open', 'tentative', 'decided', 'waiting'],
                  description: 'open: 未決、tentative: 仮決め、decided: 決定、waiting: 誰かの返事待ち',
                },
                answer: { type: 'string', description: '選んだ案とその中身。例「A: メールでリンクを送る」' },
                note: { type: 'string', description: '誰に確認中か、前提など。無ければ空' },
              },
              required: ['id'],
            },
          },
          remove: { type: 'array', items: { type: 'string' }, description: '消す decisions の id' },
          reset: { type: 'boolean', description: '別の作業に切り替えるとき true。全部消してから入れる' },
        },
      },
    })

    // 再開したセッションでは、前に保存したボードを戻す。
    try {
      if (isEmpty(await read($, board))) {
        const saved = (await $.store.get('boards')) as Record<string, unknown> | undefined
        const mine = restore(saved?.[await $.session.id()])
        if (mine !== undefined) await update($, board, () => mine)
      }
    } catch {
      // 保存が読めなければ空のまま始める。
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, board, () => EMPTY_BOARD)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // ボードのツールを持たない相手(サブエージェントなど)には書かない。
    if (e.traits.includes('bare') || !e.tools.includes(TOOL)) return composed

    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:board`, text: BOARD_SECTION, scope: 'session' as const },
      ],
    }
  })

  // 会話が要約されても、メインタスクの現在地が要約から落ちないようにする。
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const current = await read($, board)
    if (isEmpty(current)) return next(e)
    const keep = `次の「メインタスクのボード」は、ユーザーの画面に固定表示している作業の現在地。要約にそのまま含めること。\n\n${boardAsText(current)}`

    return next({ ...e, instructions: [e.instructions, keep].filter(Boolean).join('\n\n') })
  })

  // ---------- メインタスクのボードのツール ----------

  on('tool.call', { tool: /^mcp__main-task-board__board$/ }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    const before = await read($, board)
    await update($, board, current => applyBoard(current, input, now))
    const after = await read($, board)

    try {
      const saved = ((await $.store.get('boards')) as Record<string, Board> | undefined) ?? {}
      const kept = Object.entries({ ...saved, [await $.session.id()]: after })
        .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
        .slice(0, 20)
      await $.store.set('boards', Object.fromEntries(kept))
    } catch {
      // 保存できなくても、このセッションの表示は続く。
    }

    // 初めて中身が入ったら、横のパネルを出す(幅が足りなければ出ない)。
    // 通常の表示ではパネルが入力欄の上に出て会話を隠すので、勝手には開かない。
    if (isFullscreen === true && isEmpty(before) && !isEmpty(after)) {
      const isOpen = (await $.ui.panes().catch(() => [])).some(one => one.id === PANE)
      if (!isOpen) void showPane($).catch(() => undefined)
    }

    const { done, total } = progress(after)
    const path = flow(after)
    const text = `メインタスクのボードを更新した(全体の流れ ${path.done}/${path.total} 済み、決めること ${done}/${total} 決定)。ユーザーの画面に表示済み。`

    // mod のツールの result は、文字列で返す。
    return { result: text }
  })

  // ---------- コマンド(パネルのボタンと同じことができる) ----------

  on('command.run', { command: 'now' }, async ($, e) => {
    isFullscreen = e.presentation.isFullscreen
    // 通常の表示ではクリックが mod に届かず、パネルの × を押せない。開いているときの /now は閉じる。
    if (!isFullscreen) {
      const panes = await $.ui.panes().catch(() => [])
      if (panes.some(one => one.id === PANE && one.isPlaced)) {
        await $.ui.close({ id: PANE })
        return {}
      }
    }
    const opened = await showPane($)
    if (opened.isPlaced) return {}
    const current = await read($, board)

    return {
      text: isEmpty(current)
        ? 'メインタスクのボードはまだ空。Claude が作業の目的と全体の流れを登録すると表示される。'
        : boardAsText(current),
      isTextDisplayOnly: true as const,
    }
  })

  on('command.run', { command: 'ask' }, async ($, e) => {
    isFullscreen = e.presentation.isFullscreen
    const question = e.args.trim()
    const opened = await showPane($, question === '')
    if (question === '') {
      return opened.isPlaced
        ? {}
        : { text: '/ask のあとに質問を書いてください。例: /ask この関数は何をしていますか', isTextDisplayOnly: true as const }
    }
    void ask($, question).catch(() => undefined)

    return opened.isPlaced
      ? {}
      : {
          text: '質問を受け付けた。いまはパネルを表示できる幅が無い。画面を広げて /now で開くと、回答を読めます。',
          isTextDisplayOnly: true as const,
        }
  })

  // ---------- 入力欄の上: パネルを開くボタンと、メインタスクの 1 行 ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteLayout(e.surface, e.viewport)
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const current = await read($, board)
    const view = await read($, asks)
    const pending = view.list.filter(one => one.status === 'pending').length

    const { Box, Text, Button } = $.ui.resolve(e)
    const { done, total, focus } = progress(current)
    const path = flow(current)
    const here = current.steps[path.at]

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Box flexShrink={0}>
            <Button
              key="open"
              label={pending > 0 ? 'メインタスク・質問(回答中)' : 'メインタスク・質問'}
              onPress={() => void showPane($).catch(() => undefined)}
            />
          </Box>
          {!isEmpty(current) && (
            <Text wrap="truncate-end">
              {current.goal || '(目的は未登録)'}
              {path.total > 0 && (
                <Text color={path.done === path.total ? 'success' : undefined}>
                  {'  '}流れ {Math.min(path.total, path.done + 1)}/{path.total}
                  {here !== undefined && ` ${here.title}`}
                </Text>
              )}
              {total > 0 && (
                <Text color={done === total ? 'success' : 'warning'}>
                  {'  '}決める {done}/{total}
                </Text>
              )}
              {focus !== undefined && (
                <Text>
                  {'  '}▸ {focus.id}. {focus.title}
                  <Text dimColor>({STATUS_WORD[focus.status]})</Text>
                </Text>
              )}
              {current.now !== '' && <Text dimColor>{'  '}{current.now}</Text>}
            </Text>
          )}
        </Box>
        {below}
      </Box>
    )
  })

  // ---------- パネル: メインタスクと質問を、同じ画面に上下に並べる ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteLayout(e.surface, e.viewport)
    const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e)
    // 幅に収まらない表は罫線が折り返して崩れるので、行ごとの箇条書きに直してから描く。
    const fit = (text: string) => fitTables(text, e.props.bodyColumns)

    // 大きな区切り(メインタスク・質問)。中の小見出しの太字と見分けられるよう、帯にする。
    // 色は指定せず、端末の文字色と背景色を入れ替える(inverse)。色コードは端末によって丸められるため。
    const heading = (key: string, title: string, sub = '') => (
      <Box key={`h:${key}`} marginTop={key === 'main' ? 0 : 2}>
        <Text bold inverse>
          {` ${title} `}
        </Text>
        {sub !== '' && <Text dimColor> {sub}</Text>}
      </Box>
    )

    const current = await read($, board)
    const { done, total, focus } = progress(current)
    const path = flow(current)
    const view = await read($, asks)
    // 一覧には最初の質問だけを出し、続けて聞いた質問は、開いた質問の下にやり取りとして並べる。
    const roots = view.list.filter(one => one.parentId === undefined)
    const opened = roots.find(one => one.id === view.openId) ?? roots[0]
    const thread = opened === undefined ? [] : threadOf(view.list, opened.id)
    const listed = view.isAllShown ? roots : roots.slice(0, 3)

    const turn = (one: Ask, index: number) => (
      <Box key={`t:${one.id}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
        {/* 質問は引用や複数行を含むことがあり、太字だけでは回答と見分けられない。枠で囲んで境目を示す。 */}
        <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text bold color="suggestion">
            {index === 0 ? '質問' : `続けて聞いた質問(${index})`}
          </Text>
          <Text>{one.q}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold color="claude">
            回答
          </Text>
        </Box>
        {one.status === 'pending' && <Text dimColor>回答中…</Text>}
        {/* 原文の確認が終わったら、確かめた回答だけを読めば足りるように、最初の回答と置き換える。 */}
        {one.status !== 'pending' && one.check?.state === 'done' ? (
          <Box flexDirection="column">
            <Text color="success">原文で確かめた回答(確かめたこと: {one.check.what})</Text>
            <Markdown text={fit(one.check.text)} />
            <Box marginTop={1}>
              <Button
                key={`first-answer:${one.id}`}
                label={view.firstShownId === one.id ? '最初の回答を隠す' : '最初の回答も出す(確かめる前のもの)'}
                onPress={() =>
                  update($, asks, now => ({ ...now, firstShownId: now.firstShownId === one.id ? '' : one.id }))
                }
              />
            </Box>
            {view.firstShownId === one.id && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>最初の回答(確かめる前のもの。上の回答と違う点は、上が正しい)</Text>
                <Markdown text={fit(one.a)} />
              </Box>
            )}
          </Box>
        ) : (
          one.status !== 'pending' && <Markdown text={fit(one.a)} />
        )}
        {one.check?.state === 'running' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="warning">Web で原文を確かめています(確かめること: {one.check.what})</Text>
            <Text dimColor>終わると、上の回答が、確かめた内容で書き直した回答に置き換わります。</Text>
          </Box>
        )}
        {one.check?.state === 'error' && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="warning">{one.check.text}</Text>
            <Text dimColor>上の回答は、原文で確かめていません(確かめること: {one.check.what})。</Text>
          </Box>
        )}
        {one.status !== 'pending' && (
          <Box marginTop={1}>
            <Button
              key={`to-main:${one.id}`}
              label="メインの会話で確かめる"
              onPress={() =>
                void $.prompt.fill({
                  text: [
                    '脇道で聞いた次の質問を、ファイルや公式ドキュメントで確かめて答えてください。',
                    '',
                    ...(index === 0
                      ? []
                      : [`この質問の前に聞いたこと: ${thread.slice(0, index).map(x => x.q.replace(/\s+/g, ' ')).join(' / ')}`, '']),
                    `質問: ${one.q}`,
                  ].join('\n'),
                  mode: 'replace',
                })
              }
            />
          </Box>
        )}
      </Box>
    )

    const boardPart = isEmpty(current) ? (
      <Box flexDirection="column">
        <Text dimColor>メインタスクのボードはまだ空です。</Text>
        <Text dimColor>作業を始めると、Claude が目的、全体の流れ、決めることをここに登録します。</Text>
        <Box>
          <Button
            key="fill"
            label="いまの状況を登録してもらう"
            onPress={() =>
              void $.prompt.fill({
                text: 'いまの作業の目的、全体の流れ、決めることをメインタスクのボードに登録してください。',
                mode: 'replace',
              })
            }
          />
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text bold>{current.goal || '(未登録)'}</Text>
        {/* 済んだ手順も消さずに残す。チェックを付けて字を薄くし、いまの手順だけを目立たせる。 */}
        {path.total > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              全体の流れ{' '}
              <Text color={path.done === path.total ? 'success' : 'warning'}>
                {path.done}/{path.total} 済み
              </Text>
            </Text>
            {current.steps.map((one, at) => (
              <Box flexDirection="column">
                <Text
                  bold={at === path.at}
                  dimColor={one.status === 'done'}
                  color={at === path.at ? 'warning' : undefined}
                >
                  {STEP_MARK[at === path.at ? 'now' : one.status]} {at + 1}. {one.title}
                  {at === path.at && '  ← いまここ'}
                </Text>
                {at === path.at && current.now !== '' && <Text>{'     '}{current.now}</Text>}
              </Box>
            ))}
          </Box>
        )}
        {/* 流れが無いとき、または全部済んだあとに補足だけがあるとき。 */}
        {current.now !== '' && path.at < 0 && (
          <Box marginTop={1}>
            <Text>{current.now}</Text>
          </Box>
        )}
        {total > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              決めること <Text color={done === total ? 'success' : 'warning'}>{done}/{total} 決定</Text>
            </Text>
            {current.decisions.map(one => (
              <Box flexDirection="column">
                <Text
                  bold={focus?.id === one.id}
                  dimColor={one.status === 'decided'}
                  color={
                    focus?.id === one.id
                      ? 'warning'
                      : one.status === 'decided'
                        ? 'success'
                        : one.status === 'open'
                          ? undefined
                          : 'warning'
                  }
                >
                  {STATUS_MARK[one.status]} {one.id}. {one.title}
                  {one.status !== 'decided' && one.status !== 'open' && `(${STATUS_WORD[one.status]})`}
                  {focus?.id === one.id && '  ← いまここ'}
                </Text>
                {one.answer !== '' && <Text>{'    '}→ {one.answer}</Text>}
                {one.note !== '' && <Text dimColor>{'    '}{one.note}</Text>}
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Button
            key="refresh"
            plain
            dimColor
            label="↻ ボードを最新にしてもらう"
            onPress={() =>
              void $.prompt.fill({
                text: 'メインタスクのボードを、いまの状況に合わせて更新してください。',
                mode: 'replace',
              })
            }
          />
        </Box>
      </Box>
    )

    // ターミナルの通常の表示では、パネルは横ではなく入力欄の上に出る。横に出す方法を 1 行で案内する。
    // 表示を勝手に変えると Claude Code の画面全体が変わるので、mod からは変えない。
    // isFullscreen が無い画面(表示のしかたを言わない画面)では出さない。
    const isInlineTerminal = e.surface === 'terminal' && e.viewport?.isFullscreen === false

    return (
      <Box flexDirection="column">
        {isInlineTerminal && (
          <Box key="side-hint" flexDirection="column" marginBottom={1}>
            <Text dimColor>この表示ではクリックが効かない。/ask で質問欄へ(↓ でスクロール、Tab で欄に戻る)。閉じるには /now をもう一度打つ</Text>
            <Text dimColor>
              横に出すには、~/.claude/settings.json に "tui": "fullscreen" を足して、Claude Code を起動し直す
            </Text>
          </Box>
        )}
        {heading('main', 'メインタスク')}
        {boardPart}
        {heading('ask', '質問', 'メインタスクを止めずに聞く')}
        {roots.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>これまでの質問</Text>
            {listed.map(one => {
              const mine = threadOf(view.list, one.id)
              const more = mine.length - 1

              return (
                <Button
                  key={`a:${one.id}`}
                  plain
                  dimColor={one.id !== opened?.id}
                  label={`${one.id === opened?.id ? '▸' : ' '} ${mine.some(x => x.status === 'pending') ? '(回答中) ' : ''}${one.q.replace(/\s+/g, ' ').slice(0, 60)}${more > 0 ? `(続き ${more})` : ''}`}
                  onPress={() => update($, asks, now => ({ ...now, openId: one.id }))}
                />
              )
            })}
            {roots.length > 3 && (
              <Button
                key="all"
                plain
                dimColor
                label={view.isAllShown ? '  新しい 3 件だけにする' : `  ほか ${roots.length - 3} 件も出す`}
                onPress={() => update($, asks, now => ({ ...now, isAllShown: !now.isAllShown }))}
              />
            )}
          </Box>
        )}
        {/* 欄の場所が分かるように枠で囲む。プレースホルダーは置かない(マウスで範囲を選ぶと、その文字までコピーされるため)。
            ターミナルでは入力欄をクリックしても入力できる状態にならないことがあるので、クリックで押せるボタンから欄へ移す。 */}
        <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          <Button
            key="focus-q"
            plain
            dimColor
            label="✎ 新しく聞く(クリックで入力。Enter で送る)"
            onPress={() => void $.ui.focus({ requestId: PANE, key: 'q' }).catch(() => undefined)}
          />
          {/* 1 行の欄だと、長い文や複数行を貼ったときに末尾が切れる。3 行にして、超えた分は欄の中でスクロールさせる。 */}
          <Input key="q" autoFocus rows={3} onSubmit={value => void ask($, value).catch(() => undefined)} />
        </Box>
        {roots.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>ここで聞いた質問と回答は、メインの会話に残りません。</Text>
            <Text dimColor>回答は、いまの会話の内容から書かれます(ツールは使いません)。</Text>
            <Text dimColor>ファイルを読む確認は、回答の下のボタンでメインの会話に回せます。</Text>
            <Text dimColor>回答の下の入力欄から、同じ質問に続けて聞けます。</Text>
            {config.webCheck && (
              <Text dimColor>公式ドキュメントの確認が要る内容は、裏で Web を調べて、確かめた内容で回答を書き直します。</Text>
            )}
          </Box>
        )}
        {opened !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            {thread.map(turn)}
            {/* 続けて聞く欄。前のやり取りをモデルに渡すので、「それ」「さっきの」で聞ける。 */}
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="inactive" paddingX={1}>
              <Button
                key={`focus-reply:${opened.id}`}
                plain
                dimColor
                label="✎ この質問に続けて聞く(クリックで入力。Enter で送る)"
                onPress={() =>
                  void $.ui.focus({ requestId: PANE, key: `reply:${opened.id}` }).catch(() => undefined)
                }
              />
              <Input
                key={`reply:${opened.id}`}
                rows={3}
                onSubmit={value => void ask($, value, opened.id).catch(() => undefined)}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
