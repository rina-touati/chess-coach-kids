import { Chess } from 'chess.js'
import { createRequire } from 'node:module'
import path from 'node:path'
import { type ApiRequest, type ApiResponse, handleCorsPreflight, parseJsonBody, setJsonHeaders } from './_shared.js'

type StockfishEngine = {
  listener?: (line: string) => void
  sendCommand(command: string): void
}

type StockfishRequest = {
  fen?: string
  movetime?: number
  skillLevel?: number
  multiPv?: number
}

export type StockfishLine = {
  rank: number
  move: string
  scoreCp: number | null
  mateIn: number | null
}

export type StockfishResult = {
  bestMove: string | null
  ponder: string | null
  scoreCp: number | null
  mateIn: number | null
  depth: number | null
  lines: StockfishLine[]
  source: 'stockfish'
}

const require = createRequire(import.meta.url)
const initStockfish = require('stockfish') as (enginePath: string) => Promise<StockfishEngine>
const enginePath = path.join(process.cwd(), 'vendor', 'stockfish', 'stockfish-18-lite-single.cjs')

let enginePromise: Promise<StockfishEngine> | null = null
let engineQueue = Promise.resolve()

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

async function getEngine() {
  if (!enginePromise) enginePromise = initStockfish(enginePath)
  return enginePromise
}

function parseInfo(
  line: string,
  current: Omit<StockfishResult, 'bestMove' | 'ponder' | 'lines' | 'source'>,
  linesByRank: Map<number, StockfishLine>,
) {
  const depthMatch = line.match(/\bdepth\s+(-?\d+)/)
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/)
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/)
  const multiPvMatch = line.match(/\bmultipv\s+(\d+)/)
  const pvMatch = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)/)

  if (multiPvMatch && pvMatch) {
    linesByRank.set(Number(multiPvMatch[1]), {
      rank: Number(multiPvMatch[1]),
      move: pvMatch[1],
      scoreCp: cpMatch ? Number(cpMatch[1]) : null,
      mateIn: mateMatch ? Number(mateMatch[1]) : null,
    })
  }

  return {
    depth: depthMatch ? Number(depthMatch[1]) : current.depth,
    scoreCp: cpMatch ? Number(cpMatch[1]) : current.scoreCp,
    mateIn: mateMatch ? Number(mateMatch[1]) : current.mateIn,
  }
}

async function runQueued<T>(task: () => Promise<T>) {
  const run = engineQueue.then(task, task)
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function sortedLines(linesByRank: Map<number, StockfishLine>) {
  return [...linesByRank.values()].sort((a, b) => a.rank - b.rank)
}

export async function analyzePosition(fen: string, movetime: number, skillLevel: number, multiPv = 1): Promise<StockfishResult> {
  return runQueued(async () => {
    const engine = await getEngine()

    return new Promise<StockfishResult>((resolve, reject) => {
      let settled = false
      const requestedMultiPv = clampNumber(multiPv, 1, 1, 3)
      const linesByRank = new Map<number, StockfishLine>()
      let latest = {
        depth: null as number | null,
        scoreCp: null as number | null,
        mateIn: null as number | null,
      }

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        engine.listener = undefined
        reject(new Error('Stockfish timed out'))
      }, Math.max(1500, movetime + 2500))

      engine.listener = (line: string) => {
        if (line.startsWith('info ')) {
          latest = parseInfo(line, latest, linesByRank)
          return
        }

        if (!line.startsWith('bestmove ')) return

        const parts = line.split(/\s+/)
        settled = true
        clearTimeout(timeout)
        engine.listener = undefined
        resolve({
          bestMove: parts[1] && parts[1] !== '(none)' ? parts[1] : null,
          ponder: parts[3] && parts[3] !== '(none)' ? parts[3] : null,
          scoreCp: latest.scoreCp,
          mateIn: latest.mateIn,
          depth: latest.depth,
          lines: sortedLines(linesByRank),
          source: 'stockfish',
        })
      }

      engine.sendCommand('ucinewgame')
      engine.sendCommand(`setoption name Skill Level value ${skillLevel}`)
      engine.sendCommand('setoption name UCI_LimitStrength value false')
      engine.sendCommand(`setoption name MultiPV value ${requestedMultiPv}`)
      engine.sendCommand(`position fen ${fen}`)
      engine.sendCommand(`go movetime ${movetime}`)
    })
  })
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = parseJsonBody<StockfishRequest>(req)
    const fen = typeof body.fen === 'string' ? body.fen : ''
    const chess = new Chess(fen)

    if (chess.isGameOver()) {
      res.status(200).json({
        bestMove: null,
        ponder: null,
        scoreCp: null,
        mateIn: null,
        depth: null,
        lines: [],
        source: 'stockfish',
      } satisfies StockfishResult)
      return
    }

    const movetime = clampNumber(body.movetime, 350, 80, 1200)
    const skillLevel = clampNumber(body.skillLevel, 8, 0, 20)
    const multiPv = clampNumber(body.multiPv, 1, 1, 3)
    const result = await analyzePosition(chess.fen(), movetime, skillLevel, multiPv)
    res.status(200).json(result)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Stockfish analysis failed',
    })
  }
}
