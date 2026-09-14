import { type Chess, type Move, type PieceSymbol, type Square } from 'chess.js'

export const pieceValues: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
}

export function getPieceValueOnSquare(chess: Chess, square: string) {
  const piece = chess.get(square as Square)
  return piece ? pieceValues[piece.type] : 0
}

export function getLeastAttackerValue(chess: Chess, square: string, color: 'w' | 'b') {
  const attackers = chess.attackers(square as Square, color)
  if (attackers.length === 0) return null
  return Math.min(...attackers.map((attackerSquare) => getPieceValueOnSquare(chess, attackerSquare)))
}

export function isPieceHanging(chess: Chess, square: Square, color: 'w' | 'b') {
  const piece = chess.get(square)
  if (!piece || piece.color !== color || piece.type === 'k') return false

  const enemyColor = color === 'w' ? 'b' : 'w'
  const enemyAttackerValue = getLeastAttackerValue(chess, square, enemyColor)
  if (enemyAttackerValue === null) return false

  const ownDefenderValue = getLeastAttackerValue(chess, square, color)
  const pieceValue = pieceValues[piece.type]

  if (ownDefenderValue === null) return true
  if (enemyAttackerValue <= pieceValue && ownDefenderValue > enemyAttackerValue) return true
  if (enemyAttackerValue > pieceValue && ownDefenderValue > pieceValue) return true
  return false
}

export function getMoveSafetyPenalty(chessAfterMove: Chess, move: Move) {
  if (move.san.includes('#')) return 0

  const movedPiece = chessAfterMove.get(move.to as Square)
  if (!movedPiece) return 0

  const enemyColor = movedPiece.color === 'w' ? 'b' : 'w'
  const ownColor = movedPiece.color
  const enemyAttackerValue = getLeastAttackerValue(chessAfterMove, move.to, enemyColor)
  if (enemyAttackerValue === null) return 0

  const ownDefenderValue = getLeastAttackerValue(chessAfterMove, move.to, ownColor)
  const movedPieceValue = move.promotion ? pieceValues[move.promotion] : pieceValues[movedPiece.type]

  if (ownDefenderValue === null) return movedPieceValue + 120
  if (enemyAttackerValue <= movedPieceValue && ownDefenderValue > enemyAttackerValue) return Math.round(movedPieceValue * 0.65)
  if (enemyAttackerValue > movedPieceValue && ownDefenderValue > movedPieceValue) return Math.round(movedPieceValue * 0.45)
  return 0
}
