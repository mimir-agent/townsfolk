// Reading a talk reply while it is still being written. The reply is one JSON object whose first
// key is "line" (TALK_SYSTEM asks for that order), so the NPC's line is complete long before the
// choices are. These helpers find it in the text received so far.

// The decoded "line" string once its closing quote has arrived, else null. Only the first
// "line" key at the top of the object counts; a reply that starts with anything else (a fence,
// prose) still works as long as "line" is the first key of the first object.
export function lineWhenComplete(partial: string): string | null {
  const m = /\{\s*"line"\s*:\s*"/.exec(partial);
  if (m === null) return null;
  const start = m.index + m[0].length;
  for (let i = start; i < partial.length; i++) {
    const ch = partial[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') {
      try {
        return JSON.parse(partial.slice(start - 1, i + 1)) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}
