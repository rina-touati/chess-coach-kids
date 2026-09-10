import { useEffect, useMemo, useState } from 'react'
import { Chess, type Move, type Square } from 'chess.js'
import { Chessboard, type PieceDropHandlerArgs } from 'react-chessboard'
import { Lightbulb, Mic, RefreshCcw, RotateCcw, Volume2 } from 'lucide-react'
import './App.css'

type CoachMood = 'good' | 'careful' | 'idea'

type CoachMessage = {
  text: string
  mood: CoachMood
}

type ChildProfile = {
  childProfileId?: string
  displayName?: string
  level?: number
  skillScores?: Record<string, number>
  summary?: {
    weakest_skill_label?: string
    last_training_focus?: {
      topicLabel?: string
      nextQuestion?: string
    }
    [key: string]: unknown
  }
  gamesPlayed?: number
  movesRecorded?: number
}

const fallbackKidName = 'אלוף'
const centerSquares = new Set(['c3', 'd3', 'e3', 'f3', 'c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5', 'c6', 'd6', 'e6', 'f6'])
const startingBackRank = new Set(['b1', 'c1', 'f1', 'g1'])
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

const whitePieceSquareTables = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 5, 5, 0, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    20, 30, 10, 0, 0, 10, 30, 20,
    20, 20, 0, 0, 0, 0, 20, 20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
  ],
} as const

type MoveAnalysis = {
  move: Move
  score: number
  safetyPenalty: number
}

type SpeechRecognitionResultEvent = Event & {
  results: {
    [index: number]: {
      [index: number]: {
        transcript: string
      }
    }
  }
}

type SpeechRecognitionConstructor = new () => {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  start(): void
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

function speak(text: string) {
  void speakWithServerVoice(text)
}

function speakWithBrowserVoice(text: string) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'he-IL'
  utterance.rate = 0.9
  utterance.pitch = 1.08
  window.speechSynthesis.speak(utterance)
}

async function speakWithServerVoice(text: string) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1200)

  try {
    const response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })

    if (!response.ok) throw new Error('Speech API failed')

    window.speechSynthesis.cancel()
    const blob = await response.blob()
    const audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    audio.playbackRate = 1.18
    audio.addEventListener('ended', () => URL.revokeObjectURL(audioUrl), { once: true })
    await audio.play()
  } catch {
    speakWithBrowserVoice(text)
  } finally {
    window.clearTimeout(timeout)
  }
}

function squareIndex(square: string) {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1])
  return (8 - rank) * 8 + file
}

function pieceSquareBonus(piece: keyof typeof pieceValues, square: string, color: 'w' | 'b') {
  const index = squareIndex(square)
  const tableIndex = color === 'w' ? index : 63 - index
  return whitePieceSquareTables[piece][tableIndex]
}

function fenForTurn(chess: Chess, turn: 'w' | 'b') {
  const parts = chess.fen().split(' ')
  parts[1] = turn
  parts[3] = '-'
  return parts.join(' ')
}

function getMobility(chess: Chess, turn: 'w' | 'b') {
  try {
    return new Chess(fenForTurn(chess, turn)).moves().length
  } catch {
    return 0
  }
}

function evaluateBoard(chess: Chess) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -100_000 : 100_000
  if (chess.isDraw()) return 0

  let score = 0
  const board = chess.board()

  for (let rank = 0; rank < board.length; rank += 1) {
    for (let file = 0; file < board[rank].length; file += 1) {
      const piece = board[rank][file]
      if (!piece) continue

      const square = `${String.fromCharCode(97 + file)}${8 - rank}`
      const pieceScore = pieceValues[piece.type] + pieceSquareBonus(piece.type, square, piece.color)
      score += piece.color === 'w' ? pieceScore : -pieceScore
    }
  }

  const whiteMobility = getMobility(chess, 'w')
  const blackMobility = getMobility(chess, 'b')
  score += (whiteMobility - blackMobility) * 4

  return score
}

function scoreMoveForOrdering(move: Move) {
  const captured = move.captured ? pieceValues[move.captured] : 0
  const attacker = pieceValues[move.piece]
  const checkBonus = move.san.includes('+') ? 60 : 0
  const promotionBonus = move.promotion ? pieceValues[move.promotion] : 0

  return captured * 10 - attacker + checkBonus + promotionBonus
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

function adjustScoreForSafety(score: number, movingColor: 'w' | 'b', safetyPenalty: number) {
  return movingColor === 'w' ? score - safetyPenalty : score + safetyPenalty
}

function minimax(chess: Chess, depth: number, alpha: number, beta: number): number {
  if (depth === 0 || chess.isGameOver()) return evaluateBoard(chess)

  const moves = chess.moves({ verbose: true }).sort((a, b) => scoreMoveForOrdering(b) - scoreMoveForOrdering(a))

  if (chess.turn() === 'w') {
    let best = -Infinity
    for (const move of moves) {
      chess.move(move)
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta))
      chess.undo()
      alpha = Math.max(alpha, best)
      if (beta <= alpha) break
    }
    return best
  }

  let best = Infinity
  for (const move of moves) {
    chess.move(move)
    best = Math.min(best, minimax(chess, depth - 1, alpha, beta))
    chess.undo()
    beta = Math.min(beta, best)
    if (beta <= alpha) break
  }
  return best
}

function analyzeLegalMoves(chess: Chess, depth = 2): MoveAnalysis[] {
  const moves = chess.moves({ verbose: true })

  return moves
    .map((move) => {
      const next = new Chess(chess.fen())
      next.move(move)
      const safetyPenalty = getMoveSafetyPenalty(next, move)
      const rawScore = minimax(next, depth - 1, -Infinity, Infinity)
      return {
        move,
        score: adjustScoreForSafety(rawScore, move.color, safetyPenalty),
        safetyPenalty,
      }
    })
    .sort((a, b) => (chess.turn() === 'w' ? b.score - a.score : a.score - b.score))
}

function findMoveAnalysis(analyses: MoveAnalysis[], playedMove: Move) {
  return analyses.find(
    (analysis) => analysis.move.from === playedMove.from && analysis.move.to === playedMove.to && analysis.move.promotion === playedMove.promotion,
  )
}

function formatScore(score: number) {
  if (Math.abs(score) > 90_000) return score > 0 ? 'כמעט ניצחון ללבן' : 'כמעט ניצחון לשחור'
  const pawns = Math.abs(score / 100).toFixed(1)
  return score >= 0 ? `יתרון לבן בערך ${pawns} רגלים` : `יתרון שחור בערך ${pawns} רגלים`
}

function explainMoveReason(move: Move) {
  if (move.san.includes('#')) return 'כי זה נותן מט'
  if (move.san.includes('+')) return 'כי זה נותן שח ומכריח את היריב להגיב'
  if (move.captured) return `כי זה לוקח ${pieceNames[move.captured]}`
  if ((move.piece === 'n' || move.piece === 'b') && startingBackRank.has(move.from)) return 'כי זה מוציא כלי חדש למשחק'
  if (centerSquares.has(move.to)) return 'כי זה מקרב כלי למרכז'
  return 'כי זה משפר את המקום של הכלי'
}

function getCoachMessage(
  move: Move,
  chess: Chess,
  bestBeforeMove: MoveAnalysis | undefined,
  playedAnalysis: MoveAnalysis | undefined,
  childName: string,
): CoachMessage {
  if (chess.isCheckmate()) {
    return {
      mood: 'good',
      text: `וואו ${childName}! זה מט. ניצחת במשחק.`,
    }
  }

  if (bestBeforeMove && playedAnalysis) {
    const loss = bestBeforeMove.score - playedAnalysis.score

    if (loss > 250) {
      return {
        mood: 'careful',
        text: `עצור רגע. זה מסע חוקי, אבל היה מסע חזק יותר: ${bestBeforeMove.move.from} אל ${bestBeforeMove.move.to}, ${explainMoveReason(bestBeforeMove.move)}.`,
      }
    }

    if (loss > 120) {
      return {
        mood: 'idea',
        text: `לא רע, אבל אפשר היה לדייק. המסע ${bestBeforeMove.move.from} אל ${bestBeforeMove.move.to} נראה קצת יותר חזק, ${explainMoveReason(bestBeforeMove.move)}.`,
      }
    }
  }

  if (move.san.includes('+')) {
    return {
      mood: 'good',
      text: `יפה מאוד. עשית שח למלך. עכשיו תחפש איך להביא עוד כלי לעזור.`,
    }
  }

  if (move.captured) {
    return {
      mood: 'good',
      text: `יופי! לקחת כלי של היריב. עכשיו תבדוק שהכלי שלך לא נשאר לבד.`,
    }
  }

  if (move.piece === 'n' && startingBackRank.has(move.from)) {
    return {
      mood: 'good',
      text: `מעולה. הוצאת סוס למשחק. בתחילת משחק אוהבים להביא סוסים ורצים למרכז.`,
    }
  }

  if (move.piece === 'b' && startingBackRank.has(move.from)) {
    return {
      mood: 'good',
      text: `יפה. הרץ יצא מהבית. ככל שיותר כלים משחקים, הצבא שלך חזק יותר.`,
    }
  }

  if (centerSquares.has(move.to)) {
    return {
      mood: 'idea',
      text: `רעיון טוב. המרכז הוא מקום חשוב. מי ששולט במרכז רואה יותר משבצות.`,
    }
  }

  if (move.piece === 'q') {
    return {
      mood: 'careful',
      text: `המלכה חזקה מאוד, אבל לא כדאי להוציא אותה לבד מוקדם מדי. תנסה להביא גם סוס או רץ.`,
    }
  }

  return {
    mood: 'idea',
    text: `מסע בסדר. המצב עכשיו: ${formatScore(evaluateBoard(chess))}. לפני המסע הבא נשאל: מה היריב מאיים לקחת?`,
  }
}

function getGameOverMessage(chess: Chess, childName: string): CoachMessage | null {
  if (chess.isCheckmate()) {
    return chess.turn() === 'w'
      ? {
          mood: 'careful',
          text: `${childName}, זה מט. השחור ניצח הפעם. בוא נבדוק איך המלך נשאר בלי בריחה.`,
        }
      : {
          mood: 'good',
          text: `וואו ${childName}! זה מט. ניצחת במשחק.`,
        }
  }

  if (chess.isDraw()) {
    return {
      mood: 'idea',
      text: 'זה תיקו. אף צד לא יכול לנצח מכאן, אז אפשר להתחיל משחק חדש ולנסות רעיון אחר.',
    }
  }

  return null
}

function getCheckMessage(): CoachMessage {
  return {
    mood: 'careful',
    text: 'זה שח. עכשיו הדבר הראשון הוא לשמור על המלך ולמצוא בריחה טובה.',
  }
}

function pickBlackMove(chess: Chess) {
  const analyses = analyzeLegalMoves(chess, 3)
  return analyses[0]?.move ?? null
}

function getHint(chess: Chess) {
  const best = analyzeLegalMoves(chess, 2)[0]?.move

  if (!best) {
    return {
      text: 'המשחק נגמר. אפשר להתחיל מחדש.',
      squares: {},
    }
  }

  return {
    text: `רמז חכם: נסה ${best.from} אל ${best.to}. ${explainMoveReason(best)}.`,
    squares: {
      [best.from]: { background: '#facc15' },
      [best.to]: { background: '#22c55e' },
    },
  }
}

function App() {
  const [profile, setProfile] = useState<ChildProfile | null>(null)
  const [isProfileReady, setIsProfileReady] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)
  const [game, setGame] = useState(() => new Chess())
  const [coach, setCoach] = useState<CoachMessage>({
    mood: 'idea',
    text: 'שלום. קודם נגיד לי איך קוראים לילד, ואז נתחיל להתאמן.',
  })
  const [highlightedSquares, setHighlightedSquares] = useState<Record<string, React.CSSProperties>>({})
  const [movesPlayed, setMovesPlayed] = useState(0)
  const [lastMove, setLastMove] = useState<string>('עוד לא התחיל')
  const [cloudGameId, setCloudGameId] = useState<string | undefined>()
  const [isListening, setIsListening] = useState(false)
  const childName = profile?.displayName?.trim() || fallbackKidName
  const currentTrainingTopic = profile?.summary?.weakest_skill_label ?? profile?.summary?.last_training_focus?.topicLabel ?? 'עוד לא נאסף מספיק מידע'

  useEffect(() => {
    let isMounted = true

    async function loadProfile() {
      try {
        const response = await fetch('/api/profile')
        if (!response.ok) throw new Error('Profile fetch failed')
        const data = (await response.json()) as { profile?: ChildProfile | null }
        if (!isMounted) return

        if (data.profile?.displayName) {
          setProfile(data.profile)
          setNameDraft(data.profile.displayName)
          setCoach({
            mood: 'idea',
            text: `שלום ${data.profile.displayName}. תזיז כלי לבן, ואני אלמד אותך תוך כדי משחק.`,
          })
        }
      } catch {
        // The setup form stays available if the profile cannot be loaded.
      } finally {
        if (isMounted) setIsProfileReady(true)
      }
    }

    void loadProfile()
    return () => {
      isMounted = false
    }
  }, [])

  const status = useMemo(() => {
    if (game.isCheckmate()) return game.turn() === 'w' ? 'השחור ניצח' : 'הלבן ניצח'
    if (game.isDraw()) return 'תיקו'
    if (game.isCheck()) return 'שח'
    return game.turn() === 'w' ? 'התור של הלבן' : 'התור של השחור'
  }, [game])

  function applyProfileUpdate(nextProfile: unknown) {
    if (!nextProfile || typeof nextProfile !== 'object') return
    const profileCandidate = nextProfile as ChildProfile
    setProfile((current) => ({
      ...(current ?? {}),
      ...profileCandidate,
    }))
    if (profileCandidate.displayName) setNameDraft(profileCandidate.displayName)
  }

  function updateCoach(message: CoachMessage) {
    setCoach(message)
    speak(message.text)
  }

  async function saveChildName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const displayName = nameDraft.trim()
    if (!displayName) return

    setIsSavingName(true)
    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      })

      if (!response.ok) throw new Error('Profile save failed')
      const data = (await response.json()) as { profile?: ChildProfile }
      if (data.profile) {
        setProfile(data.profile)
        updateCoach({
          mood: 'idea',
          text: `שלום ${data.profile.displayName ?? displayName}. מתחילים להתאמן. קודם נבדוק מה היריב מאיים לקחת.`,
        })
      }
    } catch {
      updateCoach({
        mood: 'careful',
        text: 'לא הצלחתי לשמור את השם עכשיו. נסה שוב בעוד רגע.',
      })
    } finally {
      setIsSavingName(false)
    }
  }

  async function updateCoachFromCloud(
    fallbackMessage: CoachMessage,
    nextGame: Chess,
    playerMove: Move,
    bestBeforeMove: MoveAnalysis | undefined,
    playedAnalysis: MoveAnalysis | undefined,
    nextMoveCount: number,
    blackMove: Move | null,
    lockLocalMessage = false,
  ) {
    const loss =
      bestBeforeMove && playedAnalysis && Number.isFinite(bestBeforeMove.score) && Number.isFinite(playedAnalysis.score)
        ? bestBeforeMove.score - playedAnalysis.score
        : 0
    let fallbackWasSpoken = false
    const fallbackTimer = lockLocalMessage
      ? undefined
      : window.setTimeout(() => {
          fallbackWasSpoken = true
          updateCoach(fallbackMessage)
        }, 1600)

    try {
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'move',
          localMessage: fallbackMessage.text,
          fen: nextGame.fen(),
          pgn: nextGame.pgn(),
          moveCount: nextMoveCount,
          gameId: cloudGameId,
          childName,
          move: {
            from: playerMove.from,
            to: playerMove.to,
            san: playerMove.san,
            color: 'w',
          },
          analysis: {
            bestMove: bestBeforeMove ? `${bestBeforeMove.move.from}${bestBeforeMove.move.to}` : undefined,
            playedMove: `${playerMove.from}${playerMove.to}`,
            bestScore: bestBeforeMove?.score,
            playedScore: playedAnalysis?.score,
            loss,
            safetyPenalty: playedAnalysis?.safetyPenalty,
            scoreLabel: formatScore(evaluateBoard(nextGame)),
          },
          gameStatus: {
            isCheckmate: nextGame.isCheckmate(),
            isDraw: nextGame.isDraw(),
            isCheck: nextGame.isCheck(),
            turn: nextGame.turn(),
            winner: nextGame.isCheckmate() ? (nextGame.turn() === 'w' ? 'black' : 'white') : null,
            blackMove: blackMove
              ? {
                  from: blackMove.from,
                  to: blackMove.to,
                  san: blackMove.san,
                }
              : null,
          },
        }),
      })

      if (!response.ok) throw new Error('Coach API failed')

      const cloudMessage = (await response.json()) as Partial<CoachMessage> & { profile?: unknown }
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      const maybeGameId = (cloudMessage as { gameId?: unknown }).gameId
      if (typeof maybeGameId === 'string') setCloudGameId(maybeGameId)
      applyProfileUpdate(cloudMessage.profile)
      if (lockLocalMessage) return
      if (typeof cloudMessage.text !== 'string') {
        if (!fallbackWasSpoken) updateCoach(fallbackMessage)
        return
      }

      const nextCoach = {
        text: cloudMessage.text,
        mood:
          cloudMessage.mood === 'good' || cloudMessage.mood === 'careful' || cloudMessage.mood === 'idea'
            ? cloudMessage.mood
            : fallbackMessage.mood,
      }

      if (fallbackWasSpoken) {
        setCoach(nextCoach)
      } else {
        updateCoach(nextCoach)
      }
    } catch {
      if (!lockLocalMessage && !fallbackWasSpoken) updateCoach(fallbackMessage)
    } finally {
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
    }
  }

  async function sendVoiceQuestion(transcript: string) {
    const cleanTranscript = transcript.trim()
    if (!cleanTranscript) return

    const thinkingMessage: CoachMessage = {
      mood: 'idea',
      text: `שמעתי: ${cleanTranscript}. אני חושב רגע.`,
    }
    setCoach(thinkingMessage)

    try {
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'chat',
          transcript: cleanTranscript,
          localMessage: 'אני כאן. תשאל אותי שוב בקצרה ואעזור לך במסע הבא.',
          fen: game.fen(),
          pgn: game.pgn(),
          moveCount: movesPlayed,
          gameId: cloudGameId,
          childName,
          analysis: {
            scoreLabel: formatScore(evaluateBoard(game)),
          },
          gameStatus: {
            isCheckmate: game.isCheckmate(),
            isDraw: game.isDraw(),
            isCheck: game.isCheck(),
            turn: game.turn(),
            winner: game.isCheckmate() ? (game.turn() === 'w' ? 'black' : 'white') : null,
            blackMove: null,
          },
        }),
      })

      if (!response.ok) throw new Error('Coach chat failed')

      const answer = (await response.json()) as Partial<CoachMessage> & { gameId?: string; profile?: unknown }
      if (answer.gameId) setCloudGameId(answer.gameId)
      applyProfileUpdate(answer.profile)
      if (typeof answer.text === 'string') {
        updateCoach({
          text: answer.text,
          mood: answer.mood === 'good' || answer.mood === 'careful' || answer.mood === 'idea' ? answer.mood : 'idea',
        })
      }
    } catch {
      updateCoach({
        mood: 'careful',
        text: 'לא הצלחתי לענות עכשיו. נסה שוב בעוד רגע.',
      })
    }
  }

  function startVoiceQuestion() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition

    if (!Recognition) {
      updateCoach({
        mood: 'careful',
        text: 'הדפדפן הזה לא נותן לי לשמוע קול. נסה מכרום בטלפון.',
      })
      return
    }

    const recognition = new Recognition()
    recognition.lang = 'he-IL'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    setIsListening(true)
    setCoach({
      mood: 'idea',
      text: 'אני מקשיב. תגיד לי שאלה קצרה.',
    })

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      void sendVoiceQuestion(transcript)
    }
    recognition.onerror = () => {
      setIsListening(false)
      updateCoach({
        mood: 'careful',
        text: 'לא שמעתי טוב. נסה לדבר שוב קרוב לטלפון.',
      })
    }
    recognition.onend = () => setIsListening(false)
    recognition.start()
  }

  function onPieceDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!targetSquare || game.turn() !== 'w' || game.isGameOver()) return false

    const analysesBeforeMove = analyzeLegalMoves(game, 2)
    const bestBeforeMove = analysesBeforeMove[0]
    const nextGame = new Chess(game.fen())
    let playerMove: Move

    try {
      playerMove = nextGame.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: 'q',
      })
    } catch {
      updateCoach({
        mood: 'careful',
        text: 'המסע הזה לא חוקי. נסה כלי אחר או משבצת אחרת.',
      })
      return false
    }

    const playedAnalysis = findMoveAnalysis(analysesBeforeMove, playerMove)

    const nextMoveCount = movesPlayed + 1
    setMovesPlayed(nextMoveCount)
    setLastMove(`${playerMove.from} אל ${playerMove.to}`)
    setHighlightedSquares({
      [playerMove.from]: { background: '#bfdbfe' },
      [playerMove.to]: { background: '#86efac' },
    })

    let message = getCoachMessage(playerMove, nextGame, bestBeforeMove, playedAnalysis, childName)
    let blackMove: Move | null = null

    if (!nextGame.isGameOver()) {
      blackMove = pickBlackMove(nextGame)
      if (blackMove) {
        nextGame.move({ from: blackMove.from, to: blackMove.to, promotion: 'q' })
        setLastMove(`${playerMove.from} אל ${playerMove.to}; השחור: ${blackMove.from} אל ${blackMove.to}`)
      }
    }

    const terminalMessage = getGameOverMessage(nextGame, childName)
    let lockLocalMessage = Boolean(terminalMessage)
    if (terminalMessage) {
      message = terminalMessage
    } else if (blackMove && nextGame.isCheck()) {
      message = getCheckMessage()
      lockLocalMessage = true
    }

    setGame(nextGame)
    if (lockLocalMessage) {
      updateCoach(message)
    } else {
      setCoach(message)
    }
    void updateCoachFromCloud(message, nextGame, playerMove, bestBeforeMove, playedAnalysis, nextMoveCount, blackMove, lockLocalMessage)
    return true
  }

  function showHint() {
    if (game.turn() !== 'w' || game.isGameOver()) return
    const hint = getHint(game)
    setHighlightedSquares(hint.squares)
    updateCoach({ mood: 'idea', text: hint.text })
  }

  function resetGame() {
    const freshGame = new Chess()
    setGame(freshGame)
    setMovesPlayed(0)
    setCloudGameId(undefined)
    setLastMove('עוד לא התחיל')
    setHighlightedSquares({})
    updateCoach({
      mood: 'idea',
      text: `${childName}, מתחילים משחק חדש. קודם כל, נסה להוציא סוס או רץ למרכז.`,
    })
  }

  if (!isProfileReady) {
    return (
      <main className="app-shell setup-shell" dir="rtl">
        <section className="coach-panel setup-panel" aria-label="טעינת פרופיל">
          <p className="eyebrow">מאמן שחמט קולי לילדים</p>
          <h1>טוען את המאמן</h1>
          <div className="speech-bubble idea">
            <Volume2 aria-hidden="true" />
            <p>בודק אם כבר יש פרופיל שמור לילד.</p>
          </div>
        </section>
      </main>
    )
  }

  if (!profile?.displayName) {
    return (
      <main className="app-shell setup-shell" dir="rtl">
        <section className="coach-panel setup-panel" aria-label="הרשמה למאמן שחמט">
          <div>
            <p className="eyebrow">מאמן שחמט קולי לילדים</p>
            <h1>איך קוראים לילד?</h1>
          </div>
          <form className="name-form" onSubmit={saveChildName}>
            <label htmlFor="child-name">שם הילד</label>
            <input
              id="child-name"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={40}
              autoComplete="given-name"
              autoFocus
              placeholder="לדוגמה: נועם"
            />
            <button type="submit" disabled={isSavingName || !nameDraft.trim()}>
              {isSavingName ? 'שומר' : 'מתחילים'}
            </button>
          </form>
          <div className="speech-bubble idea">
            <Volume2 aria-hidden="true" />
            <p>אחרי שנשמור שם, המאמן יפנה אליו בשם ויתחיל לבנות זיכרון למידה.</p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell" dir="rtl">
      <section className="coach-panel" aria-label="מאמן שחמט קולי">
        <div>
          <p className="eyebrow">מאמן שחמט קולי לילדים</p>
          <h1>שחמט עם מאמן מדבר</h1>
        </div>
        <form className="inline-name-form" onSubmit={saveChildName}>
          <label htmlFor="active-child-name">שם הילד</label>
          <input id="active-child-name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={40} />
          <button type="submit" disabled={isSavingName || !nameDraft.trim()}>
            שמור
          </button>
        </form>

        <div className={`speech-bubble ${coach.mood}`}>
          <Volume2 aria-hidden="true" />
          <p>{coach.text}</p>
        </div>

        <div className="controls" aria-label="פעולות משחק">
          <button type="button" onClick={() => speak(coach.text)} title="השמע שוב">
            <Volume2 aria-hidden="true" />
            <span>שוב</span>
          </button>
          <button type="button" onClick={showHint} title="רמז">
            <Lightbulb aria-hidden="true" />
            <span>רמז</span>
          </button>
          <button type="button" onClick={startVoiceQuestion} title="דבר עם המאמן" className={isListening ? 'listening' : undefined}>
            <Mic aria-hidden="true" />
            <span>{isListening ? 'מקשיב' : 'דבר'}</span>
          </button>
          <button type="button" onClick={resetGame} title="משחק חדש">
            <RefreshCcw aria-hidden="true" />
            <span>חדש</span>
          </button>
        </div>
      </section>

      <section className="board-panel" aria-label="לוח שחמט">
        <div className="board-wrap" dir="ltr">
          <Chessboard
            options={{
              id: 'kid-coach-board',
              position: game.fen(),
              boardOrientation: 'white',
              onPieceDrop,
              allowDrawingArrows: false,
              squareStyles: highlightedSquares,
              darkSquareStyle: { backgroundColor: '#769656' },
              lightSquareStyle: { backgroundColor: '#eeeed2' },
              boardStyle: {
                borderRadius: '8px',
                boxShadow: '0 24px 70px rgba(18, 24, 38, 0.22)',
                overflow: 'hidden',
              },
            }}
          />
        </div>
      </section>

      <aside className="parent-panel" aria-label="מצב להורה">
        <div>
          <span>מצב</span>
          <strong>{status}</strong>
        </div>
        <div>
          <span>מסעים של הילד</span>
          <strong>{movesPlayed}</strong>
        </div>
        <div>
          <span>מסע אחרון</span>
          <strong>{lastMove}</strong>
        </div>
        <div>
          <span>נושא אימון</span>
          <strong>{currentTrainingTopic}</strong>
        </div>
        <button type="button" onClick={resetGame}>
          <RotateCcw aria-hidden="true" />
          התחלה מחדש
        </button>
      </aside>
    </main>
  )
}

export default App
