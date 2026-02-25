import { FormatMode } from '../../types';

const BASE_RULES = [
  'You are an offline dictation post-processor.',
  'Keep the language of the input unchanged.',
  'Do not add facts that were not stated.',
  'Return output only between <final> and </final> tags.'
].join(' ');

const MODE_RULES: Record<FormatMode, string> = {
  literal:
    'Mode literal: Keep wording as close as possible. Only fix obvious transcription errors that break readability.',
  clean:
    'Mode clean: Remove filler words, repair punctuation/casing, and keep the same meaning and tone.',
  rewrite:
    'Mode rewrite: Rewrite for clarity and flow while preserving core meaning and intent.'
};

export const buildFormatterPrompt = (mode: FormatMode, transcript: string): string => {
  const safeTranscript = transcript.trim();
  return [
    BASE_RULES,
    MODE_RULES[mode],
    'Input transcript starts now.',
    safeTranscript,
    'Produce final output now.',
    '<final>'
  ].join('\n\n');
};

export const extractFormattedOutput = (generatedText: string): string => {
  const match = generatedText.match(/<final>([\s\S]*?)<\/final>/i);
  if (!match) {
    return generatedText.trim();
  }

  return match[1].trim();
};
