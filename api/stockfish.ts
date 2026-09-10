import { Chess } from 'chess.js'
import { createRequire } from 'node:module'
import path from 'node:path'
import { type ApiRequest, type ApiResponse, parseJsonBody, setJsonHeaders } from './_shared.js'

type StockfishEngine = {
  listener?: (line: string) => void
  sendCommand(command: string): void
}

type StockfishRequest = {
  fen?: string
  movetime?: number
  skillLevel?: number
}

type StockfishResult = {
  bestMove: string | null
  ponder: string | null
  scoreCp: number | null
  mateIn: number | null
  depth: number | null
  source: 'stockfish'
}

const require = createRequire(import.meta.url)
const initStockfish = require('stockfish') as (enginePath: string) => Promise<StockfishEngine>
const enginePath = path.join(process.cwd(), 'vendor', 'stockfish', 'stockfish-18-lite-single.js')

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

function parseInfo(line: string, current: Omit<StockfishResult, 'bestMove' | 'ponder' | 'source'>) {
  const depthMatch = line.match(/\bdepth\s+(-?\d+)/)
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/)
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/)

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

async function analyzePosition(fen: string, movetime: number, skillLevel: number): Promise<StockfishResult> {
  return runQueued(async () => {
    const engine = await getEngine()

    return new Promise<StockfishResult>((resolve, reject) => {
      let settled = false
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
          latest = parseInfo(line, latest)
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
          source: 'stockfish',
        })
      }

      engine.sendCommand('ucinewgame')
      engine.sendCommand(`setoption name Skill Level value ${skillLevel}`)
      engine.sendCommand('setoption name UCI_LimitStrength value false')
      engine.sendCommand(`position fen ${fen}`)
      engine.sendCommand(`go movetime ${movetime}`)
    })
  })
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)

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
        source: 'stockfish',
      } satisfies StockfishResult)
      return
    }

    const movetime = clampNumber(body.movetime, 350, 80, 1200)
    const skillLevel = clampNumber(body.skillLevel, 8, 0, 20)
    const result = await analyzePosition(chess.fen(), movetime, skillLevel)
    res.status(200).json(result)
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Stockfish analysis failed',
    })
  }
}
