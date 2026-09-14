import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js'
import { pieceValues } from '../shared/chessSafety.js'
import type { StockfishLine } from './stockfish.js'

const DECISIVE = 200
const CLOSE_LINES = 90

export type PositionTheme =
  | 'defend_hanging'
  | 'escape_threat'
  | 'capture_free'
  | 'develop_piece'
  | 'control_center'
  | 'king_safety'
  | 'find_check'
  | 'convert_material'

export type PositionFacts = {
  phase: 'opening' | 'middlegame' | 'endgame'
  myHangingPieces: Square[]
  opponentThreats: Square[]
  freeCaptures: Square[]
  theme: PositionTheme
  sharedIntent: string | null
  bestMove: string | null
  scoreCp: number | null
  mateIn: number | null
  targetPieceName: string | null
  targetPieceSquare: Square | null
  engineSpreadCp: number | null
  isEngineDerived: true
}

const pieceNames: Record<PieceSymbol, string> = {
  p: 'רגלי',
  n: 'סוס',
  b: 'רץ',
  r: 'צריח',
  q: 'מלכה',
  k: 'מלך',
}

function getPhase(chess: Chess): PositionFacts['phase'] {
  const board = chess.board().flat()
  const pieces = board.filter(Boolean)
  const nonPawnMaterial = pieces.reduce((total, piece) => {
    if (!piece || piece.type === 'p' || piece.type === 'k') return total
    return total + pieceValues[piece.type]
  }, 0)

  if (pieces.length <= 10 || nonPawnMaterial <= 1800) return 'endgame'
  if (chess.moveNumber() <= 8) return 'opening'
  return 'middlegame'
}

function moveFromUci(chess: Chess, uci: string | null | undefined) {
  if (!uci || uci.length < 4) return null

  try {
    return new Chess(chess.fen()).move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] as 'q' | 'r' | 'b' | 'n' | undefined) ?? 'q',
    })
  } catch {
    return null
  }
}

function classifyEngineMove(chess: Chess, uci: string) {
  const move = moveFromUci(chess, uci)
  if (!move) return null

  if (move.san.includes('#') || move.san.includes('+')) return 'find_check'
  if (move.captured) return 'convert_material'
  if (['d4', 'e4', 'd5', 'e5', 'c4', 'f4', 'c5', 'f5'].includes(move.to)) return 'control_center'
  if (move.piece === 'n' || move.piece === 'b') return 'develop_piece'
  return null
}

function getSharedIntent(chess: Chess, engineLines: StockfishLine[]) {
  const intents = engineLines
    .slice(0, 3)
    .map((line) => classifyEngineMove(chess, line.move))
    .filter(Boolean)

  if (intents.length < 2) return null
  const [first] = intents
  return intents.every((intent) => intent === first) ? first : null
}

function scoreFromChildView(chess: Chess, line: StockfishLine | undefined) {
  if (!line || typeof line.scoreCp !== 'number') return null

  // Stockfish reports score from the side-to-move view. The child plays white.
  return chess.turn() === 'w' ? line.scoreCp : -line.scoreCp
}

function getEngineSpread(chess: Chess, engineLines: StockfishLine[]) {
  const scores = engineLines
    .slice(0, 3)
    .map((line) => scoreFromChildView(chess, line))
    .filter((score): score is number => typeof score === 'number')

  if (scores.length < 2) return null
  return Math.max(...scores) - Math.min(...scores)
}

function getTargetPiece(chess: Chess, move: Move | null, theme: PositionTheme) {
  if (!move) return { targetPieceName: null, targetPieceSquare: null }

  if (theme === 'capture_free' && move.captured) {
    return {
      targetPieceName: pieceNames[move.captured],
      targetPieceSquare: move.to as Square,
    }
  }

  const sourcePiece = chess.get(move.from as Square)
  if (theme === 'develop_piece' && sourcePiece?.type === 'p') {
    return {
      targetPieceName: null,
      targetPieceSquare: null,
    }
  }

  return {
    targetPieceName: sourcePiece ? pieceNames[sourcePiece.type] : null,
    targetPieceSquare: move.from as Square,
  }
}

function deriveQuietTheme(phase: PositionFacts['phase'], sharedIntent: string | null): PositionTheme {
  if (sharedIntent === 'find_check') return 'find_check'
  if (sharedIntent === 'control_center') return 'control_center'
  if (sharedIntent === 'develop_piece') return 'develop_piece'
  if (sharedIntent === 'convert_material' && phase === 'endgame') return 'convert_material'

  if (phase === 'opening') return 'develop_piece'
  if (phase === 'endgame') return 'convert_material'
  return 'control_center'
}

function topLinesMoveSamePiece(engineLines: StockfishLine[]) {
  const topMoves = engineLines.slice(0, 3).map((line) => line.move).filter((move) => move.length >= 4)
  if (topMoves.length < 2) return false
  const [from] = topMoves[0] ? [topMoves[0].slice(0, 2)] : [null]
  return Boolean(from) && topMoves.every((move) => move.slice(0, 2) === from)
}

function deriveTheme(chess: Chess, phase: PositionFacts['phase'], engineLines: StockfishLine[]) {
  const bestLine = engineLines[0]
  const bestScore = scoreFromChildView(chess, bestLine)
  const bestMove = moveFromUci(chess, bestLine?.move)
  const sharedIntent = getSharedIntent(chess, engineLines)
  const engineSpreadCp = getEngineSpread(chess, engineLines)
  const secondScore = scoreFromChildView(chess, engineLines[1])

  if (bestLine?.mateIn && bestLine.mateIn > 0 && bestLine.mateIn <= 3) {
    return { theme: 'find_check' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  const onlyGoodMove =
    typeof bestScore === 'number' &&
    typeof secondScore === 'number' &&
    bestScore > -DECISIVE &&
    bestScore - secondScore >= DECISIVE

  const bestCapturesValuablePiece =
    bestMove?.captured &&
    bestMove.captured !== 'p' &&
    typeof bestScore === 'number' &&
    bestScore > -DECISIVE * 2

  if (bestMove?.captured && (bestCapturesValuablePiece || (typeof bestScore === 'number' && bestScore >= DECISIVE))) {
    return { theme: 'capture_free' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  if (typeof bestScore === 'number' && bestScore <= -DECISIVE) {
    return { theme: 'escape_threat' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  if (topLinesMoveSamePiece(engineLines) && typeof bestScore === 'number' && bestScore < DECISIVE) {
    return { theme: 'defend_hanging' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  if (onlyGoodMove && !bestMove?.captured) {
    return { theme: 'defend_hanging' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  if (phase === 'endgame' && typeof bestScore === 'number' && bestScore >= DECISIVE) {
    return { theme: 'convert_material' as const, sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  if (
    typeof bestScore === 'number' &&
    Math.abs(bestScore) < DECISIVE &&
    (engineSpreadCp === null || engineSpreadCp <= CLOSE_LINES)
  ) {
    return { theme: deriveQuietTheme(phase, sharedIntent), sharedIntent, bestMove, bestScore, engineSpreadCp }
  }

  return { theme: deriveQuietTheme(phase, sharedIntent), sharedIntent, bestMove, bestScore, engineSpreadCp }
}

export function describePosition(fen: string, engineLines: StockfishLine[]): PositionFacts {
  const chess = new Chess(fen)
  const phase = getPhase(chess)
  const derived = deriveTheme(chess, phase, engineLines)
  const targetPiece = getTargetPiece(chess, derived.bestMove, derived.theme)
  const threatSquares =
    derived.theme === 'defend_hanging' || derived.theme === 'escape_threat'
      ? targetPiece.targetPieceSquare
        ? [targetPiece.targetPieceSquare]
        : []
      : []
  const captureSquares = derived.theme === 'capture_free' && targetPiece.targetPieceSquare ? [targetPiece.targetPieceSquare] : []

  return {
    phase,
    myHangingPieces: threatSquares,
    opponentThreats: [],
    freeCaptures: captureSquares,
    theme: derived.theme,
    sharedIntent: derived.sharedIntent,
    bestMove: engineLines[0]?.move ?? null,
    scoreCp: derived.bestScore,
    mateIn: engineLines[0]?.mateIn ?? null,
    targetPieceName: targetPiece.targetPieceName,
    targetPieceSquare: targetPiece.targetPieceSquare,
    engineSpreadCp: derived.engineSpreadCp,
    isEngineDerived: true,
  }
}
