/**
 * MODERATION_POLICY_V1. AI checks are advisory pre-screening. They never publish anything: every case
 * goes to a human. A provider that errors or is unavailable raises priority and is recorded, so a gap in
 * automated coverage is visible to the reviewer instead of silently passing (spec invariant 13).
 */
export const MODERATION_POLICY_VERSION = 'MODERATION_POLICY_V1';

export const CATEGORIES = ['profanity', 'sexual', 'nudity', 'violence', 'hate', 'self_harm', 'drugs', 'weapons'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ModerationInput {
  framePaths: string[];      // sampled JPEG frames
  audioPath: string | null;  // mono 16 kHz WAV for speech recognition, if the media has audio
  texts: string[];           // title, description, banner copy
}

export interface ProviderResult {
  provider: string;
  status: 'OK' | 'UNAVAILABLE' | 'ERROR';
  scores?: Partial<Record<Category, number>>;
  transcript?: string;
  notes?: string[];
}

export interface ModerationProvider {
  name: string;
  analyze(input: ModerationInput): Promise<ProviderResult>;
}

/**
 * Deterministic text screen for titles, descriptions, banner copy and transcripts. This is a floor, not a
 * classifier: production must add real speech-to-text plus visual and text classifiers (D-035).
 */
const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'piss', 'whore', 'slut'];
const SEXUAL = ['porn', 'xxx', 'nude', 'nudes', 'onlyfans', 'sex tape', 'explicit'];
const VIOLENCE = ['gore', 'beheading', 'murder video', 'shooting video'];
const DRUGS = ['cocaine', 'heroin', 'meth', 'buy weed'];
const terms = (text: string, list: string[]) => list.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, '\\s+')}([^a-z]|$)`, 'i').test(text));

export function screenText(texts: string[]): ProviderResult {
  const all = texts.join('\n');
  const hits: Record<string, string[]> = { profanity: terms(all, PROFANITY), sexual: terms(all, SEXUAL), violence: terms(all, VIOLENCE), drugs: terms(all, DRUGS) };
  const scores: Partial<Record<Category, number>> = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(hits)) {
    scores[k as Category] = v.length ? 1 : 0;
    if (v.length) notes.push(`${k}: ${v.join(', ')}`);
  }
  return { provider: 'text-screen-v1', status: 'OK', scores, notes };
}

/** Placeholder for the visual/speech classifier until a vendor is chosen (D-035). Always reports UNAVAILABLE. */
export const unavailableVisualProvider: ModerationProvider = {
  name: 'visual-speech-unconfigured',
  analyze: async () => ({ provider: 'visual-speech-unconfigured', status: 'UNAVAILABLE', notes: ['no visual or speech classifier configured; manual review of frames and audio required'] }),
};

export function summarize(results: ProviderResult[]) {
  const scores: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.scores ?? {})) scores[k] = Math.max(scores[k] ?? 0, Math.min(1, Math.max(0, v ?? 0)));
  const max = Math.max(0, ...Object.values(scores));
  const degraded = results.some((r) => r.status !== 'OK');
  const recommendation = max >= 0.85 ? 'LIKELY_VIOLATION' : max >= 0.2 || degraded ? 'NEEDS_REVIEW' : 'LIKELY_OK';
  const priority = recommendation === 'LIKELY_VIOLATION' || degraded ? 'HIGH' : 'NORMAL';
  return { scores, recommendation, priority } as const;
}
