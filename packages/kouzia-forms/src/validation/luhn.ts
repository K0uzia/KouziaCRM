/**
 * Algorithme de Luhn adapté au SIREN/SIRET français.
 * Pour les positions paires (index 1, 3, 5… depuis la droite),
 * le chiffre est doublé ; si le résultat > 9, on soustrait 9.
 */
export function luhnCheck(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length === 0) return false;
  let sum = 0;
  const len = digits.length;
  for (let i = 0; i < len; i++) {
    let n = Number(digits[len - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** SIREN : exactement 9 chiffres + Luhn. */
export function isValidSiren(value: string): boolean {
  const digits = value.replace(/\s/g, "");
  return /^\d{9}$/.test(digits) && luhnCheck(digits);
}

/** SIRET : exactement 14 chiffres + Luhn. */
export function isValidSiret(value: string): boolean {
  const digits = value.replace(/\s/g, "");
  return /^\d{14}$/.test(digits) && luhnCheck(digits);
}
