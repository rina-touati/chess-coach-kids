import OpenAI from 'openai'
import { type ApiRequest, type ApiResponse, getRequiredEnv, handleCorsPreflight, parseJsonBody, setJsonHeaders } from './_shared.js'

type SpeechRequest = {
  text?: string
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  setJsonHeaders(res)
  if (handleCorsPreflight(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { text } = parseJsonBody<SpeechRequest>(req)
    const input = text?.trim().slice(0, 500)

    if (!input) {
      res.status(400).json({ error: 'Missing text' })
      return
    }

    const openai = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })
    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE ?? 'alloy',
      input,
      response_format: 'mp3',
    })

    const arrayBuffer = await speech.arrayBuffer()
    res.setHeader('Content-Type', 'audio/mpeg')
    res.status(200).send(Buffer.from(arrayBuffer))
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unexpected speech error',
    })
  }
}
