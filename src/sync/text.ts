// Search text: no accents, lowercase, single spaces. Used for the columns the
// tablet searches by (street, name, mother's name) and for what the person types.
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
