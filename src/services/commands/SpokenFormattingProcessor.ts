export interface SpokenFormattingResult {
  text: string;
  appliedCommands: number;
}

interface SpokenFormattingRule {
  pattern: RegExp;
  replacement: string;
}

const RULES: SpokenFormattingRule[] = [
  { pattern: /\bnew paragraph\b/gi, replacement: '\n\n' },
  { pattern: /\bnew line\b/gi, replacement: '\n' },
  { pattern: /\bfull stop\b/gi, replacement: '.' },
  { pattern: /\bquestion mark\b/gi, replacement: '?' },
  { pattern: /\bexclamation mark\b/gi, replacement: '!' },
  { pattern: /\bopen parenthesis\b/gi, replacement: '(' },
  { pattern: /\bclose parenthesis\b/gi, replacement: ')' },
  { pattern: /\bopen bracket\b/gi, replacement: '[' },
  { pattern: /\bclose bracket\b/gi, replacement: ']' },
  { pattern: /\bopen quote\b/gi, replacement: '"' },
  { pattern: /\bclose quote\b/gi, replacement: '"' },
  { pattern: /\bsemicolon\b/gi, replacement: ';' },
  { pattern: /\bcolon\b/gi, replacement: ':' },
  { pattern: /\bcomma\b/gi, replacement: ',' },
  { pattern: /\bperiod\b/gi, replacement: '.' }
];

const stripEdgeSpaces = (value: string): string => value.replace(/^[ \t]+|[ \t]+$/g, '');

const normalizeSpacing = (value: string): string => {
  let normalized = value;

  // Collapse repeated spaces but preserve explicit newlines.
  normalized = normalized.replace(/[ \t]{2,}/g, ' ');
  normalized = normalized.replace(/[ \t]*\n[ \t]*/g, '\n');

  // Remove spaces before punctuation/closing symbols.
  normalized = normalized.replace(/[ ]+([,.;:!?)}\]])/g, '$1');

  // Remove spaces right after opening symbols.
  normalized = normalized.replace(/([({\["])\s+/g, '$1');

  // Normalize quote spacing for spoken open/close quote commands.
  normalized = normalized.replace(/"\s+([A-Za-z0-9])/g, '"$1');
  normalized = normalized.replace(/([A-Za-z0-9.,;:!?])\s+"/g, '$1"');

  // Ensure punctuation is followed by a space when next token is a word/symbol.
  normalized = normalized.replace(/([,.;:!?])([^\s\n.,;:!?)}\]])/g, '$1 $2');

  // Keep paragraph boundaries clean.
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  return stripEdgeSpaces(normalized);
};

export class SpokenFormattingProcessor {
  public transform(text: string): SpokenFormattingResult {
    if (!text.trim()) {
      return {
        text: '',
        appliedCommands: 0
      };
    }

    let output = text;
    let appliedCommands = 0;

    for (const rule of RULES) {
      output = output.replace(rule.pattern, () => {
        appliedCommands += 1;
        return rule.replacement;
      });
    }

    output = normalizeSpacing(output);

    return {
      text: output,
      appliedCommands
    };
  }
}
