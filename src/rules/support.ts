// Small checks the rules share, copied from the dashboard (main ceb53af) with nothing changed:
// isValidCpf from src/lib/attendance.ts, isValidCns from src/lib/professionals.ts and the address
// widths from src/lib/demographics.ts (the widths of the BPA file, the single source for them).
const onlyDigits = (s: string) => s.replace(/\D/g, "");

export function isValidCpf(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const n = d.split("").map(Number);
  const check = (len: number) => {
    const sum = n.slice(0, len).reduce((acc, x, i) => acc + x * (len + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === n[9] && check(10) === n[10];
}

// 15 digits, the first one 1, 2, 7, 8 or 9, weighted sum (15..1) a multiple of 11.
export function isValidCns(input: string): boolean {
  const d = onlyDigits(input);
  if (!/^[12789]\d{14}$/.test(d)) return false;
  return d.split("").reduce((acc, c, i) => acc + Number(c) * (15 - i), 0) % 11 === 0;
}

export const STREET_MAX = 30;
export const NUMBER_MAX = 5;
export const COMPLEMENT_MAX = 10;
export const DISTRICT_MAX = 30;
