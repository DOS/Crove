// The JSON text of a parser answer in pieces, for the parser process to write one at a time (#653). An archive at
// the limits answers with about 56 MB of base64; JSON.stringify would hold that whole text as one string next to the
// answer itself, and writing it to stdout copies it once more into a Buffer, three copies at the peak. In pieces, only
// the answer and one piece are alive at a time. The pieces joined are exactly JSON.stringify(value) for the plain
// data an answer holds (objects, arrays, strings, numbers, booleans, null, and undefined in optional fields).
const PIECE_CHARS = 1024 * 1024;

function* tokens(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) yield ',';
      // As in JSON.stringify, an array keeps its length: what JSON cannot hold becomes null.
      yield* storable(value[i]) ? tokens(value[i]) : ['null'];
    }
    yield ']';
  } else if (value !== null && typeof value === 'object' && !('toJSON' in value)) {
    yield '{';
    let first = true;
    for (const [key, field] of Object.entries(value)) {
      // As in JSON.stringify, a field JSON cannot hold is left out.
      if (!storable(field)) continue;
      yield `${first ? '' : ','}${JSON.stringify(key)}:`;
      first = false;
      yield* tokens(field);
    }
    yield '}';
  } else {
    yield JSON.stringify(value);
  }
}

const storable = (value: unknown) => value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';

export function* jsonChunks(value: unknown, pieceChars = PIECE_CHARS): Generator<string> {
  let piece = '';
  for (const token of tokens(value)) {
    piece += token;
    if (piece.length >= pieceChars) {
      yield piece;
      piece = '';
    }
  }
  if (piece) yield piece;
}
