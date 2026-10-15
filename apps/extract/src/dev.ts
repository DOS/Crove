// Development entry point (`pnpm dev`): a developer's shell holds many variables, so NODE_ENV defaults to
// development here and credential-like names only warn. Inside the image the marker file keeps the allowlist on
// regardless (see main.ts); the image's entry point is main.ts.
process.env.NODE_ENV ??= 'development';
const { start } = await import('./main.ts');
start();
