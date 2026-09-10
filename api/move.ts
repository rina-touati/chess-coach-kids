import { Chess, type Move, type Square } from 'chess.js'
import { type ApiRequest, type ApiResponse, handleCorsPreflight, parseJsonBody, setJsonHeaders } from './_shared.js'
import { analyzePosition } from './stockfish.js'

type MoveRequest = {
  fen?: string
  childName?: string
  moveCount?: number
  skillLevel?: number
  lessonSkill?: 'opening' | 'tactics' | 'safety' | 'endgame' | 'focus' | null
  move?: {
    from?: string
    to?: string
    promotion?: 'q' | 'r' | 'b' | 'n'
  }
}

const pieceValues = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
} as const

const pieceNames = {
  p: 'רגלי',
  n: 'סוס',
  b: 'רץ',
  r: 'צריח',
  q: 'מלכה',
  k: 'מלך',
} as const

function cleanName(name: unknown) {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'אלוף'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function moveFromUci(chess: Chess, uci: string | null) {
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

function formatMove(move: Move | null | undefined) {
  if (!move) return null
  return pieceNames[move.piece]
}

function movedFromHome(move: Move) {
  if (move.color !== 'w') return false
  if (move.piece === 'n') return move.from === 'b1' || move.from === 'g1'
  if (move.piece === 'b') return move.from === 'c1' || move.from === 'f1'
  if (move.piece === 'q') return move.from === 'd1'
  if (move.piece === 'r') return move.from === 'a1' || move.from === 'h1'
  return false
}

function isCenterMove(move: Move) {
  return ['d4', 'e4', 'd5', 'e5', 'c4', 'f4', 'c5', 'f5'].includes(move.to)
}

function openingExplanation(move: Move) {
  if (move.piece === 'n' && movedFromHome(move)) {
    return 'יופי, הוצאת סוס מהבית. עכשיו הוא קרוב לאמצע הלוח ועוזר לחברים שלו.'
  }

  if (move.piece === 'b' && movedFromHome(move)) {
    return 'יופי, הוצאת רץ מהבית. רץ אוהב קו פתוח כדי לראות רחוק על הלוח.'
  }

  if (move.piece === 'p' && isCenterMove(move)) {
    return 'יופי, הזזת רגלי לאמצע. מי ששולט באמצע מקבל יותר מקום לכלים.'
  }

  if (move.piece === 'q' && movedFromHome(move)) {
    return 'המלכה חזקה, אבל בתחילת המשחק לא כדאי להוציא אותה מהר מדי. קודם עדיף להוציא סוסים ורצים.'
  }

  return 'זה מסע חוקי. בתחילת המשחק אנחנו רוצים להוציא סוסים ורצים, לתפוס את האמצע, ולשמור על המלך.'
}

function getPieceValueOnSquare(chess: Chess, square: string) {
  const piece = chess.get(square as Square)
  return piece ? pieceValues[piece.type] : 0
}

function getLeastAttackerValue(chess: Chess, square: string, color: 'w' | 'b') {
  const attackers = chess.attackers(square as Square, color)
  if (attackers.length === 0) return null
  return Math.min(...attackers.map((attackerSquare) => getPieceValueOnSquare(chess, attackerSquare)))
}

function getMoveSafetyPenalty(chessAfterMove: Chess, move: Move) {
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

function buildMoveCoachText(args: {
  childName: string
  playerMove: Move
  blackMove: Move | null
  bestMove: Move | null
  finalGame: Chess
  safetyPenalty: number
  moveCount: number
  lessonSkill: MoveRequest['lessonSkill']
}) {
  const played = formatMove(args.playerMove) ?? 'המסע שלך'
  const black = formatMove(args.blackMove)
  const best = formatMove(args.bestMove)

  if (args.finalGame.isCheckmate()) {
    return args.finalGame.turn() === 'w'
      ? {
          mood: 'careful' as const,
          text: `${args.childName}, זה מט לשחור. המלך הלבן בלי בריחה, אז נבדוק במסע הבא איפה ההגנה נשברה.`,
        }
      : {
          mood: 'good' as const,
          text: `${args.childName}, זה מט ללבן. מצאת דרך לסגור למלך את כל הבריחות.`,
        }
  }

  if (args.finalGame.isDraw()) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, זה תיקו. מכאן אף צד לא יכול לנצח, אז כדאי להתחיל משחק חדש ולחפש תכנית מוקדם יותר.`,
    }
  }

  if (args.finalGame.isCheck()) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, השחור נתן שח${black ? ` עם ${black}` : ''}. כשהמלך בסכנה, קודם מצילים אותו. התקפה באה אחר כך.`,
    }
  }

  if (args.safetyPenalty > 250) {
    return {
      mood: 'careful' as const,
      text: `${args.childName}, ה${played} נשאר במקום מסוכן. לפני שמזיזים כלי, שואלים: מי יכול לאכול אותו, ומי שומר עליו?`,
    }
  }

  if (args.playerMove.san.includes('x')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, יפה, ה${played} לקח כלי. עכשיו בודקים אם הוא נשאר מוגן או שהשחור יכול לאכול אותו בחזרה.`,
    }
  }

  if (args.playerMove.san.includes('+')) {
    return {
      mood: 'good' as const,
      text: `${args.childName}, נתת שח. זה אומר שהמלך השחור חייב לענות מיד. עכשיו נבדוק מה השחור יכול לעשות בחזרה.`,
    }
  }

  if (args.lessonSkill === 'opening' || args.moveCount <= 8) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, ${openingExplanation(args.playerMove)} במסע הבא ננסה להוציא עוד כלי או להכין מקום בטוח למלך.`,
    }
  }

  if (best) {
    return {
      mood: 'idea' as const,
      text: `${args.childName}, המסע חוקי. עכשיו כדאי לחפש רעיון פעיל: שח, לקיחה, או איום על כלי של השחור.`,
    }
  }

  return {
    mood: 'idea' as const,
    text: `${args.childName}, המסע חוקי. לפני המסע הבא נעצור רגע ונשאל: מה השחור מאיים, ואיזה כלי שלי צריך שמירה?`,
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = parseJsonBody<MoveRequest>(req)
    const gameBefore = new Chess(typeof body.fen === 'string' ? body.fen : undefined)
    const childName = cleanName(body.childName)
    const moveCount = clampNumber(body.moveCount, 1, 1, 500)
    const skillLevel = clampNumber(body.skillLevel, 8, 0, 20)

    if (gameBefore.turn() !== 'w' || gameBefore.isGameOver()) {
      res.status(400).json({ error: 'It is not white to move' })
      return
    }

    const requestedMove = body.move
    const playerMove = gameBefore.move({
      from: requestedMove?.from as Square,
      to: requestedMove?.to as Square,
      promotion: requestedMove?.promotion ?? 'q',
    })
    const afterPlayer = new Chess(gameBefore.fen())
    const safetyPenalty = getMoveSafetyPenalty(afterPlayer, playerMove)

    const [beforeAnalysis, blackAnalysis] = await Promise.all([
      analyzePosition(typeof body.fen === 'string' ? body.fen : gameBefore.fen(), 520, 20).catch(() => null),
      afterPlayer.isGameOver() ? Promise.resolve(null) : analyzePosition(afterPlayer.fen(), 420, skillLevel).catch(() => null),
    ])

    const bestMove = moveFromUci(new Chess(typeof body.fen === 'string' ? body.fen : undefined), beforeAnalysis?.bestMove ?? null)
    const stockfishBlackMove = moveFromUci(afterPlayer, blackAnalysis?.bestMove ?? null)
    const fallbackBlackMove = !afterPlayer.isGameOver() ? afterPlayer.moves({ verbose: true })[0] ?? null : null
    const blackMove = stockfishBlackMove ?? fallbackBlackMove

    if (blackMove && !afterPlayer.isGameOver()) {
      afterPlayer.move({ from: blackMove.from, to: blackMove.to, promotion: blackMove.promotion ?? 'q' })
    }

    const afterBlackAnalysis = afterPlayer.isGameOver() ? null : await analyzePosition(afterPlayer.fen(), 220, 20).catch(() => null)
    const coach = buildMoveCoachText({
      childName,
      playerMove,
      blackMove,
      bestMove,
      finalGame: afterPlayer,
      safetyPenalty,
      moveCount,
      lessonSkill: body.lessonSkill ?? null,
    })

    res.status(200).json({
      fen: afterPlayer.fen(),
      pgn: afterPlayer.pgn(),
      text: coach.text,
      mood: coach.mood,
      playerMove: {
        from: playerMove.from,
        to: playerMove.to,
        san: playerMove.san,
        piece: playerMove.piece,
        captured: playerMove.captured ?? null,
      },
      blackMove: blackMove
        ? {
            from: blackMove.from,
            to: blackMove.to,
            san: blackMove.san,
            piece: blackMove.piece,
            captured: blackMove.captured ?? null,
          }
        : null,
      status: {
        isCheck: afterPlayer.isCheck(),
        isCheckmate: afterPlayer.isCheckmate(),
        isDraw: afterPlayer.isDraw(),
        turn: afterPlayer.turn(),
      },
      facts: {
        bestMove: beforeAnalysis?.bestMove ?? null,
        safetyPenalty,
        beforeAnalysis,
        afterPlayerAnalysis: blackAnalysis,
        afterBlackAnalysis,
      },
    })
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Move analysis failed',
    })
  }
}
