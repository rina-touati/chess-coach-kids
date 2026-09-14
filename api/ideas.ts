import { Chess, type Square } from 'chess.js'
import { isPieceHanging, pieceValues } from '../shared/chessSafety.js'
import type { StockfishLine } from './stockfish.js'

export type PositionTheme =
  | 'defend_hanging'
  | 'escape_threat'
  | 'develop_piece'
  | 'control_center'
  | 'king_safety'
  | 'find_check'
  | 'convert_material'

export type PositionFacts = {
  phase: 'opening' | 'middlegame' | 'endgame'
  myHangingPieces: Square[]
  opponentThreats: Square[]
  theme: PositionTheme
  sharedIntent: string | null
}

function getPhase(chess: Chess): PositionFacts['phase'] {
  const board = chess.board().flat()
  const pieces = board.filter(Boolean)
  const nonPawnMaterial = pieces.reduce((total, piece) => {
    if (!piece || piece.type === 'p' || piece.type === 'k') return total
    return total + pieceValues[piece.type]
  }, 0)

  if (chess.moveNumber() <= 8) return 'opening'
  if (pieces.length <= 10 || nonPawnMaterial <= 1800) return 'endgame'
  return 'middlegame'
}

function getMyHangingPieces(chess: Chess, myColor: 'w' | 'b') {
  const hanging: Square[] = []

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== myColor || piece.type === 'k') continue

      const square = piece.square as Square
      if (isPieceHanging(chess, square, myColor)) hanging.push(square)
    }
  }

  return hanging
}

function getOpponentThreats(chess: Chess, myColor: 'w' | 'b') {
  const enemy = myColor === 'w' ? 'b' : 'w'
  const currentTurn = chess.turn()
  if (currentTurn !== enemy) {
    const legalThreats = new Set<Square>()

    for (const row of chess.board()) {
      for (const piece of row) {
        if (!piece || piece.color !== myColor || piece.type === 'k') continue
        if (isPieceHanging(chess, piece.square as Square, myColor)) legalThreats.add(piece.square as Square)
      }
    }

    return [...legalThreats]
  }

  const threats = new Set<Square>()
  for (const move of chess.moves({ verbose: true })) {
    if (move.captured && move.color === enemy && isPieceHanging(chess, move.to as Square, myColor)) threats.add(move.to as Square)
  }

  return [...threats]
}

function classifyEngineMove(chess: Chess, uci: string) {
  try {
    const move = new Chess(chess.fen()).move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] as 'q' | 'r' | 'b' | 'n' | undefined) ?? 'q',
    })

    if (move.san.includes('#') || move.san.includes('+')) return 'find_check'
    if (move.captured) return 'convert_material'
    if (['d4', 'e4', 'd5', 'e5', 'c4', 'f4', 'c5', 'f5'].includes(move.to)) return 'control_center'
    if (move.piece === 'n' || move.piece === 'b') return 'develop_piece'
    return null
  } catch {
    return null
  }
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

function chooseTheme(
  chess: Chess,
  phase: PositionFacts['phase'],
  engineLines: StockfishLine[],
  myHangingPieces: Square[],
  opponentThreats: Square[],
): PositionTheme {
  if (myHangingPieces.length > 0) return 'defend_hanging'
  if (opponentThreats.length > 0) return 'escape_threat'
  if (chess.isCheck()) return 'king_safety'

  const sharedIntent = getSharedIntent(chess, engineLines)
  if (sharedIntent === 'find_check' || sharedIntent === 'convert_material' || sharedIntent === 'control_center' || sharedIntent === 'develop_piece') {
    return sharedIntent
  }

  if (phase === 'opening') return 'develop_piece'
  if (phase === 'endgame') return 'convert_material'
  return 'find_check'
}

export function describePosition(fen: string, engineLines: StockfishLine[], opponentBestReply?: string | null): PositionFacts {
  const chess = new Chess(fen)
  const myColor = chess.turn()
  const phase = getPhase(chess)
  const myHangingPieces = getMyHangingPieces(chess, myColor)
  const opponentThreats = getOpponentThreats(chess, myColor)
  const theme =
    opponentBestReply && myHangingPieces.length > 0 ? 'escape_threat' : chooseTheme(chess, phase, engineLines, myHangingPieces, opponentThreats)

  return {
    phase,
    myHangingPieces,
    opponentThreats,
    theme,
    sharedIntent: getSharedIntent(chess, engineLines),
  }
}
