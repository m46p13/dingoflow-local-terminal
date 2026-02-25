export interface RealtimeStreamOptions {
  chunkDurationMs: number;
  onChunk: (chunk: Buffer) => void;
}

export interface AudioRecorder {
  isRecording(): boolean;
  startStreaming(options: RealtimeStreamOptions): Promise<void>;
  stop(): Promise<void>;
}
