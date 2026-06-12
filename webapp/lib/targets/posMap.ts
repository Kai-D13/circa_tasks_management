// BI pos_name → POS code mapping (provided by stakeholder 2026-06-12).
// Fallback for store matching: if a normalized pos_name doesn't match any
// stores.name, resolve it through this map → stores.code. Keys are
// normalizeStoreName() outputs (diacritics stripped, uppercased).
export const POS_CODE_BY_NAME: Record<string, string> = {
  'CIRCA THONG NHAT': 'POS0016',
  'CIRCA NAM VIET':   'POS0077',
  'CIRCA EHOME':      'POS0079',
  'CIRCA BELVITA':    'POS0085',
  'CIRCA LUMINA':     'POS0012',
  'CIRCA AKARI':      'POS0080',
  'CIRCA MORA':       'POS0017',
  'CIRCA CITYLAND':   'POS0070',
  'CIRCA ASTORIA':    'POS0062',
  'CIRCA SIGNATURE':  'POS0018',
  'CIRCA ECO GREEN':  'POS0073',
  'CIRCA CENTRAL':    'POS0009',
  'CIRCA SYMPHONY':   'POS0065',
  'CIRCA MIZUKI':     'POS0013',
  'CIRCA URBAN':      'POS0011',
  'CIRCA BEVERLY':    'POS0058',
  'CIRCA RAINBOW':    'POS0069',
  'CIRCA TAM AN':     'POS0060',
  'CIRCA SUNRISE':    'POS0014',
  'CIRCA TAM VIET':   'POS0059',
  'CIRCA CELADON':    'POS0067',
  'CIRCA MEDLY':      'POS0063',
  'CIRCA ELANA':      'POS0015',
  'CIRCA MIRA':       'POS0019',
  'CIRCA PHARMA ONE': 'POS0066',
  'CIRCA FLORITA':    'POS0068',
}
