/** ImapFlow renvoie parfois des BigInt ; Prisma attend des Int. */
export function toImapInt(value: bigint | number | undefined | null): number {
  if (value == null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

export function toUidValidity(value: bigint | number | undefined | null): number {
  return toImapInt(value);
}

/**
 * Flags IMAP (RFC 3501) insensibles à la casse.
 * ImapFlow expose un Set ; certains serveurs envoient `\Seen`, `\SEEN` ou `Seen`.
 */
export function hasImapFlag(
  flags: Iterable<string> | undefined | null,
  name: string,
): boolean {
  if (!flags) return false;
  const needle = name.replace(/^\\/, "").toLowerCase();
  for (const raw of flags) {
    if (String(raw).replace(/^\\/, "").toLowerCase() === needle) return true;
  }
  return false;
}
