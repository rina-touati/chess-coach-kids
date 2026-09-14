import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js'

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

function chessWithTurn(chess: Chess, color: 'w' | 'b') {
  const fenParts = chess.fen().split(' ')
  fenParts[1] = color
  return fenParts.join(' ')
}

function findLeastValuableLegalCapture(chess: Chess, targetSquare: Square, capturingColor: 'w' | 'b') {
  const target = chess.get(targetSquare)
  if (!target || target.color === capturingColor || target.type === 'k') return null

  const candidateGame = new (chess.constructor as typeof Chess)(chessWithTurn(chess, capturingColor))
  const legalCaptures = candidateGame
    .moves({ verbose: true })
    .filter((move) => move.to === targetSquare && Boolean(move.captured))
    .sort((a, b) => pieceValues[a.piece] - pieceValues[b.piece])

  return legalCaptures[0] ?? null
}

export function getCaptureGainForSide(chess: Chess, targetSquare: Square, capturingColor: 'w' | 'b', depth = 0): number {
  if (depth > 24) return 0

  const target = chess.get(targetSquare)
  if (!target || target.color === capturingColor || target.type === 'k') return 0

  const capture = findLeastValuableLegalCapture(chess, targetSquare, capturingColor)
  if (!capture) return 0

  const capturedValue = pieceValues[target.type]
  const afterCapture = new (chess.constructor as typeof Chess)(chessWithTurn(chess, capturingColor))
  afterCapture.move({
    from: capture.from,
    to: capture.to,
    promotion: capture.promotion ?? 'q',
  })

  const replyColor = capturingColor === 'w' ? 'b' : 'w'
  const replyGain = getCaptureGainForSide(afterCapture, targetSquare, replyColor, depth + 1)
  return capturedValue - Math.max(0, replyGain)
}

export function isCaptureGoodForSide(chess: Chess, targetSquare: Square, capturingColor: 'w' | 'b') {
  return getCaptureGainForSide(chess, targetSquare, capturingColor) > 0
}

export function isPieceHanging(chess: Chess, square: Square, color: 'w' | 'b') {
  const piece = chess.get(square)
  if (!piece || piece.color !== color || piece.type === 'k') return false

  const enemyColor = color === 'w' ? 'b' : 'w'
  return isCaptureGoodForSide(chess, square, enemyColor)
}

export function getMoveSafetyPenalty(chessAfterMove: Chess, move: Move) {
  if (move.san.includes('#')) return 0

  const movedPiece = chessAfterMove.get(move.to as Square)
  if (!movedPiece) return 0

  const enemyColor = movedPiece.color === 'w' ? 'b' : 'w'
  const captureGain = getCaptureGainForSide(chessAfterMove, move.to as Square, enemyColor)
  return captureGain > 0 ? captureGain + 80 : 0
}
