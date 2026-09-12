// Türkçe fiyat formatı ("1.799,00 TL") birden fazla markada (H&M, Pull&Bear)
// aynı şekilde geçtiği için tek yerde.
function parseTryPrice(text) {
  if (!text) return { price: null, currency: null };
  const match = text.match(/([\d.,]+)\s*(TL|TRY)?/i);
  if (!match) return { price: null, currency: null };
  const normalized = match[1].replace(/\./g, '').replace(',', '.');
  const price = Number(normalized);
  return { price: Number.isFinite(price) ? price : null, currency: 'TRY' };
}

module.exports = { parseTryPrice };
