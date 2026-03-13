import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { resolveConfig } from '../config';
import { StructuredLogger } from '../logging/StructuredLogger';
import { AsrResult } from '../types';

interface SessionState {
  chunks: Buffer[];
  sampleRate: number;
}

interface CloudRequest {
  id: string;
  type: 'warmup' | 'transcribe' | 'stream_reset' | 'stream_push' | 'stream_flush' | 'stream_close';
  audioBase64?: string;
  sampleRate?: number;
}

interface OpenAiTranscriptionResponse {
  text?: string;
}

interface OpenAiResponsesResponse {
  output_text?: string;
}

const OPENAI_API_BASE = 'https://api.openai.com/v1';

const send = (socket: WebSocket, id: string, result?: AsrResult, error?: string): void => {
  socket.send(JSON.stringify({ id, result, error }));
};

const decodeAudio = (audioBase64?: string): Buffer => {
  if (!audioBase64) {
    return Buffer.alloc(0);
  }

  return Buffer.from(audioBase64, 'base64');
};

const pcm16ToWav = (pcm: Buffer, sampleRate: number): Buffer => {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
};

const openAiJson = async <T>(path: string, apiKey: string, body: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${OPENAI_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as T;
};

const transcribeWithOpenAi = async (
  apiKey: string,
  model: string,
  audio: Buffer,
  sampleRate: number
): Promise<string> => {
  const wav = pcm16ToWav(audio, sampleRate);
  const wavBytes = new Uint8Array(wav);
  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');

  const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as OpenAiTranscriptionResponse;
  return payload.text?.trim() ?? '';
};

const cleanupTranscript = async (
  apiKey: string,
  model: string,
  transcript: string
): Promise<string> => {
  if (!transcript.trim()) {
    return '';
  }

  const prompt = [
    'You clean up dictated text for a desktop dictation app.',
    'Rules:',
    '- Keep the original meaning.',
    '- Remove obvious filler words and repeated fragments only if they are clearly accidental.',
    '- Add punctuation and capitalization.',
    '- Preserve spoken formatting intent like new line/new paragraph if already rendered into the transcript.',
    '- Do not add extra content.',
    '- Return only the final cleaned text.'
  ].join('\n');

  const response = await openAiJson<OpenAiResponsesResponse>('/responses', apiKey, {
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: prompt }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: transcript }]
      }
    ]
  });

  return response.output_text?.trim() ?? transcript;
};

const main = async (): Promise<void> => {
  const config = resolveConfig();
  const logger = await StructuredLogger.create(process.cwd());

  logger.info('Cloud ASR server booting', {
    port: config.cloudServerPort,
    transcribeModel: config.openaiTranscribeModel,
    cleanupModel: config.openaiCleanupModel
  });

  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, request) => {
    if (config.cloudApiKey) {
      const auth = request.headers.authorization ?? '';
      if (auth !== `Bearer ${config.cloudApiKey}`) {
        socket.close(1008, 'unauthorized');
        return;
      }
    }

    const session: SessionState = {
      chunks: [],
      sampleRate: 16000
    };

    socket.on('message', async (raw) => {
      let message: CloudRequest;
      try {
        message = JSON.parse(raw.toString()) as CloudRequest;
      } catch {
        return;
      }

      try {
        switch (message.type) {
          case 'warmup':
            send(socket, message.id, { text: '' });
            return;
          case 'transcribe': {
            const audio = decodeAudio(message.audioBase64);
            const rawTranscript = await transcribeWithOpenAi(
              config.openaiApiKey,
              config.openaiTranscribeModel,
              audio,
              message.sampleRate ?? 16000
            );
            const cleanedTranscript = await cleanupTranscript(
              config.openaiApiKey,
              config.openaiCleanupModel,
              rawTranscript
            );
            send(socket, message.id, {
              text: cleanedTranscript,
              previewText: rawTranscript,
              committedText: cleanedTranscript
            });
            return;
          }
          case 'stream_reset':
            session.chunks = [];
            session.sampleRate = message.sampleRate ?? 16000;
            send(socket, message.id, { text: '' });
            return;
          case 'stream_push': {
            const audio = decodeAudio(message.audioBase64);
            if (audio.length > 0) {
              session.chunks.push(audio);
            }
            send(socket, message.id, { text: '' });
            return;
          }
          case 'stream_flush': {
            const audio = Buffer.concat(session.chunks);
            if (audio.length === 0) {
              send(socket, message.id, { text: '' });
              return;
            }

            const rawTranscript = await transcribeWithOpenAi(
              config.openaiApiKey,
              config.openaiTranscribeModel,
              audio,
              session.sampleRate
            );
            const cleanedTranscript = await cleanupTranscript(
              config.openaiApiKey,
              config.openaiCleanupModel,
              rawTranscript
            );
            session.chunks = [];
            send(socket, message.id, {
              text: cleanedTranscript,
              previewText: rawTranscript,
              committedText: cleanedTranscript
            });
            return;
          }
          case 'stream_close':
            session.chunks = [];
            send(socket, message.id, { text: '' });
            return;
          default:
            send(socket, message.id, undefined, `Unsupported request type: ${String(message.type)}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error('Cloud ASR request failed', {
          type: message.type,
          detail
        });
        send(socket, message.id, undefined, detail);
      }
    });
  });

  server.listen(config.cloudServerPort, '0.0.0.0', () => {
    logger.info('Cloud ASR server ready', {
      wsUrl: `ws://127.0.0.1:${config.cloudServerPort}`
    });
  });
};

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
