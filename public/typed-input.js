export function shouldIncludeTypedValue(field, rawValue) {
  return rawValue !== '' || (field.type === 'string' && field.required !== false);
}
