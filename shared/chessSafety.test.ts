import assert from 'node:assert/strict'
import { Chess } from 'chess.js'
import { isCaptureGoodForSide, isPieceHanging } from './chessSafety.ts'

function board(fen: string) {
  return new Chess(fen)
}

assert.equal(
  isPieceHanging(board('4k3/8/8/2p5/3P4/4P3/8/4K3 w - - 0 1'), 'd4', 'w'),
  false,
  'A pawn protected by an equal pawn recapture is not hanging',
)

assert.equal(
  isPieceHanging(board('4k3/8/8/8/6b1/5N2/6P1/4K3 b - - 0 1'), 'f3', 'w'),
  false,
  'A knight protected by a pawn against a bishop capture is not hanging',
)

assert.equal(
  isPieceHanging(board('4k3/8/8/2p5/3Q4/8/8/4K3 b - - 0 1'), 'd4', 'w'),
  true,
  'A queen that can be taken by a pawn is hanging',
)

assert.equal(
  isPieceHanging(board('4k3/6b1/8/8/3N4/8/8/4K3 b - - 0 1'), 'd4', 'w'),
  true,
  'An undefended knight attacked by a bishop is hanging',
)

assert.equal(
  isCaptureGoodForSide(board('4k3/8/8/8/8/7b/6P1/4K3 w - - 0 1'), 'h3', 'w'),
  true,
  'A bishop that can be taken by a pawn without recapture is a good capture',
)

console.log('chessSafety SEE checks passed')
