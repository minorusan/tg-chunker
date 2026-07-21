// STATE SAVE / RESTORE — checkpoint a long run so a crash or Ctrl-C RESUMES instead of restarting.
//
// INTENTION: THE 17MB-CHAT PROBLEM. Discovery, QA and chunking each slide a window over the WHOLE corpus
// with one LLM call per window; over tens of thousands of messages that is HOURS. If it dies at 90% we
// must not throw that away. So we persist progress after EVERY window to one small file and, on startup,
// resume from the exact window we stopped at.
//
// INTENTION: NEVER RESUME ONTO THE WRONG DATA. The checkpoint is keyed to a SIGNATURE of the input files
// (path+size+mtime). Change the inputs and the stale checkpoint is ignored — fail safe, start fresh.

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Person, Chunk } from './types.ts';

export type Phase = 'discover' | 'merge' | 'qa' | 'chunk' | 'done';

/** The entire resumable state of a run. Small except `chunks`, which grows during the chunk phase. */
export interface Checkpoint {
  sig: string;          // input-set signature — resume only if it still matches
  phase: Phase;         // where the pipeline is
  people: Person[];     // the shared name→token map (grows through discover → qa)
  chunks: Chunk[];      // proposition chunks produced so far (chunk phase accumulator)
  unit: number;         // cursor: chat index (discover/qa) or file index (chunk)
  start: number;        // cursor: window offset within that unit
  qaRound: number;      // which QA round (1..5)
  qaAdded: number;      // leaks caught SO FAR in the current QA round (survives a crash mid-round)
  chunkIndex: number;   // per-file chunk ordinal (chunk phase)
}

const FILE = '.tgchunker-checkpoint.json';

/** Signature of the input set: any change to a file (size/mtime) or the file list invalidates resume. */
export function inputSig(files: string[]): string {
  return files.map((f) => { const s = statSync(f); return `${f}:${s.size}:${Math.trunc(s.mtimeMs)}`; }).join('|');
}

/** Load a checkpoint if one exists AND matches the current inputs; otherwise null (fresh run). */
export function loadCheckpoint(dir: string, sig: string, log: (s: string) => void): Checkpoint | null {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  const ck = JSON.parse(readFileSync(p, 'utf8')) as Checkpoint;
  if (ck.sig !== sig) { log('   ⚠ checkpoint found but input set changed since — ignoring it, starting fresh'); return null; }
  return ck;
}

/** Atomic save: write a temp file then rename over the real one, so a crash mid-write can't corrupt it. */
export function saveCheckpoint(dir: string, ck: Checkpoint): void {
  const p = join(dir, FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(ck), 'utf8');
  renameSync(tmp, p);
}

/** Remove the checkpoint — called on successful completion (nothing left to resume). */
export function clearCheckpoint(dir: string): void {
  const p = join(dir, FILE);
  if (existsSync(p)) unlinkSync(p);
}
