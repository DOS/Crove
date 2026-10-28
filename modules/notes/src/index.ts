import { noteCommands, noteQueries } from './notes.ts';
import { systemCommands } from './system.ts';

export * from './notes.ts';
export * from './system.ts';

export const notesCommands = [...noteCommands, ...systemCommands];
export const notesQueries = [...noteQueries];
export { notesManifest } from './manifest.ts';
