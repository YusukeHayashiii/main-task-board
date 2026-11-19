export type DecisionStatus = 'open' | 'tentative' | 'decided' | 'waiting'

export type Decision = {
  id: string
  title: string
  status: DecisionStatus
  answer: string
  note: string
}

export type StepStatus = 'done' | 'now' | 'todo'

/** 全体の流れの 1 段。 */
export type Step = { title: string; status: StepStatus }

export type Board = {
  goal: string
  /** いまの手順についての補足(誰の何を待っているか、など)。いまの手順の下に 1 行で出す。無ければ空。 */
  now: string
  /** 全体の流れ。最初から最後までの手順を順に持ち、済んだ手順も消さずに status で持つ。 */
  steps: Step[]
  decisions: Decision[]
  updatedAt: number
}

export type Ask = {
  id: string
  q: string
  a: string
  status: 'pending' | 'done' | 'error'
  at: number
  /** 回答のあとに、裏で Web の原文を確かめた結果。確かめなかった質問には無い。 */
  check?: { state: 'running' | 'done' | 'error'; what: string; text: string }
  /** 続けて聞いた質問のとき、最初の質問の id。一覧には最初の質問だけを出し、続きはその下に並べる。 */
  parentId?: string
}

/** firstShownId: 原文で確かめた回答に置き換わったあと、最初の回答も出している質問の id。 */
export type AskView = { list: Ask[]; openId: string; isAllShown: boolean; firstShownId?: string }

declare module 'claude-code' {
  interface PluginState {
    'main-task-board': {
      board: Shaped<Board>
      asks: Shaped<AskView>
    }
  }
}
