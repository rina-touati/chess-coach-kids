import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js'
import { pieceValues } from '../shared/chessSafety.js'
import type { StockfishLine } from './stockfish.js'

const DECISIVE = 220
const BIG_EDGE = 450
const ONLY_MOVE_GAP = 180

export type PositionTheme =
  | 'king_safety'
  | 'find_check'
  | 'engine_tactic'
  | 'engine_defense'
  | 'improve_position'
  | 'convert_material'

export type EngineLineFact = {
  rank: number
  move: string
  san: string | null
  scoreCp: number | null
  mateIn: number | null
  pieceName: string | null
  capturedPieceName: string | null
  isCapture: boolean
  givesCheck: boolean
  isDevelopment: boolean
  isCenterMove: boolean
}

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
  isCheck: boolean
  isCheckmate: boolean
  isDraw: boolean
  legalMovesCount: number
  topEngineLines: EngineLineFact[]
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

function scoreFromChildView(chess: Chess, line: StockfishLine | undefined) {
  if (!line || typeof line.scoreCp !== 'number') return null
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

function getKingSquare(chess: Chess, color = chess.turn()) {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece?.type === 'k' && piece.color === color) return piece.square as Square
    }
  }

  return null
}

function isCenterMove(move: Move) {
  return ['d4', 'e4', 'd5', 'e5', 'c4', 'f4', 'c5', 'f5'].includes(move.to)
}

function isDevelopmentMove(move: Move) {
  return (
    (move.piece === 'n' || move.piece === 'b') &&
    ['b1', 'g1', 'c1', 'f1', 'b8', 'g8', 'c8', 'f8'].includes(move.from)
  )
}

function toEngineLineFact(chess: Chess, line: StockfishLine): EngineLineFact {
  const move = moveFromUci(chess, line.move)

  return {
    rank: line.rank,
    move: line.move,
    san: move?.san ?? null,
    scoreCp: scoreFromChildView(chess, line),
    mateIn: line.mateIn,
    pieceName: move ? pieceNames[move.piece] : null,
    capturedPieceName: move?.captured ? pieceNames[move.captured] : null,
    isCapture: Boolean(move?.captured),
    givesCheck: Boolean(move?.san.includes('+') || move?.san.includes('#')),
    isDevelopment: move ? isDevelopmentMove(move) : false,
    isCenterMove: move ? isCenterMove(move) : false,
  }
}

function getSharedIntent(topLines: EngineLineFact[]) {
  if (topLines.length < 2) return null

  const intents = topLines.map((line) => {
    if (line.mateIn && line.mateIn > 0) return 'mate'
    if (line.givesCheck) return 'check'
    if (line.isCapture && line.capturedPieceName) return `capture_${line.capturedPieceName}`
    if (line.isDevelopment) return 'development'
    if (line.isCenterMove) return 'center'
    return null
  })

  const [first] = intents
  return first && intents.every((intent) => intent === first) ? first : null
}

function deriveTheme(chess: Chess, phase: PositionFacts['phase'], topLines: EngineLineFact[]): PositionTheme {
  const [bestLine, secondLine] = topLines

  if (chess.isCheck()) return 'king_safety'
  if (bestLine?.mateIn && bestLine.mateIn > 0 && bestLine.mateIn <= 3) return 'find_check'
  if (bestLine?.givesCheck) return 'find_check'

  const bestScore = bestLine?.scoreCp
  const secondScore = secondLine?.scoreCp
  const onlyMove =
    typeof bestScore === 'number' &&
    typeof secondScore === 'number' &&
    bestScore - secondScore >= ONLY_MOVE_GAP

  if (typeof bestScore === 'number' && bestScore <= -DECISIVE) return 'engine_defense'
  if (onlyMove && !bestLine?.isCapture) return 'engine_defense'
  if (bestLine?.isCapture && (typeof bestScore !== 'number' || bestScore > -DECISIVE)) return 'engine_tactic'
  if (phase === 'endgame' || (typeof bestScore === 'number' && bestScore >= BIG_EDGE)) return 'convert_material'

  return 'improve_position'
}

function getTargetPiece(chess: Chess, bestLine: EngineLineFact | undefined, theme: PositionTheme) {
  if (theme === 'king_safety') {
    return { targetPieceName: 'מלך', targetPieceSquare: getKingSquare(chess) }
  }

  const move = moveFromUci(chess, bestLine?.move)
  if (!move) return { targetPieceName: null, targetPieceSquare: null }

  if (theme === 'engine_tactic' && move.captured) {
    return { targetPieceName: pieceNames[move.captured], targetPieceSquare: move.to as Square }
  }

  const sourcePiece = chess.get(move.from as Square)
  return {
    targetPieceName: sourcePiece ? pieceNames[sourcePiece.type] : null,
    targetPieceSquare: move.from as Square,
  }
}

export function describePosition(fen: string, engineLines: StockfishLine[]): PositionFacts {
  const chess = new Chess(fen)
  const phase = getPhase(chess)
  const topEngineLines = engineLines.slice(0, 3).map((line) => toEngineLineFact(chess, line))
  const theme = deriveTheme(chess, phase, topEngineLines)
  const targetPiece = getTargetPiece(chess, topEngineLines[0], theme)
  const engineSpreadCp = getEngineSpread(chess, engineLines)
  const sharedIntent = getSharedIntent(topEngineLines)
  const tacticalSquare = theme === 'engine_tactic' && targetPiece.targetPieceSquare ? [targetPiece.targetPieceSquare] : []
  const threatSquare = theme === 'king_safety' && targetPiece.targetPieceSquare ? [targetPiece.targetPieceSquare] : []

  return {
    phase,
    myHangingPieces: threatSquare,
    opponentThreats: [],
    freeCaptures: tacticalSquare,
    theme,
    sharedIntent,
    bestMove: engineLines[0]?.move ?? null,
    scoreCp: topEngineLines[0]?.scoreCp ?? null,
    mateIn: engineLines[0]?.mateIn ?? null,
    targetPieceName: targetPiece.targetPieceName,
    targetPieceSquare: targetPiece.targetPieceSquare,
    engineSpreadCp,
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isDraw: chess.isDraw(),
    legalMovesCount: chess.moves().length,
    topEngineLines,
    isEngineDerived: true,
  }
}
