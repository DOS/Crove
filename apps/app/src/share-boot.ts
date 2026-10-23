// Imported first by main.tsx: a share target's query (#1235) leaves the address before anything else of the app runs.
import { moveShareQueryToFragment } from './lib/social-share.ts';

moveShareQueryToFragment(window);
