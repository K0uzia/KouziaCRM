export function normalizeSubject(subject: string): string {
  return subject.replace(/^(re|fw|fwd|tr|transfert)\s*:\s*/gi, "").trim().toLowerCase();
}

export function parseAddressList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === "string") return v.toLowerCase();
        if (v && typeof v === "object" && "address" in v) {
          return String((v as { address?: string }).address || "").toLowerCase();
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "object" && value && "value" in value) {
    const list = (value as { value?: Array<{ address?: string }> }).value || [];
    return list.map((v) => (v.address || "").toLowerCase()).filter(Boolean);
  }
  return [];
}

export function buildReferences(
  inReplyTo: string | null | undefined,
  existingReferences: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (existingReferences) {
    parts.push(...existingReferences.split(/\s+/).filter(Boolean));
  }
  if (inReplyTo && !parts.includes(inReplyTo)) {
    parts.push(inReplyTo);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
