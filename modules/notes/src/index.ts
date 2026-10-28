import { noteCommands, noteQueries } from './notes.ts';
import { systemCommands } from './system.ts';
import { todoCommands, todoQueries } from './todos.ts';

export * from './notes.ts';
export * from './system.ts';
export * from './sort-key.ts';
export * from './todos.ts';

export const notesCommands = [...noteCommands, ...todoCommands, ...systemCommands];
export const notesQueries = [...noteQueries, ...todoQueries];
export { notesManifest } from './manifest.ts';
