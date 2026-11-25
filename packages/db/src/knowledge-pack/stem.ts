/** A light English stemmer (plurals and the commonest endings): the same word in two forms counts once. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = undouble(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = undouble(w.slice(0, -2));
  else if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w;
}

function undouble(w: string): string {
  return /([bdgmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}
